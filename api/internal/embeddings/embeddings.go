// Package embeddings is the orchestration layer between the file
// pipeline and the AI embedding endpoint. It owns three responsibilities:
//
//  1. Decide whether a file is embeddable (textual mime, non-zero size,
//     small enough to chunk cheaply). Non-embeddable files are marked
//     `embed_status='skipped'` so operators can tell at a glance which
//     files genuinely got embeddings vs. which were just bypassed.
//  2. Slice the file's text into overlapping chunks small enough to fit
//     the embedder's context window — see Chunk for the why behind
//     character-budget sizing instead of "real" tokenization.
//  3. Persist one row per chunk in `file_chunks` (vector + content + a
//     stable chunk_index) and stamp the parent files row with the
//     final embed_status.
//
// What this package does NOT do:
//
//   - Text extraction from binary formats (PDF/DOCX/etc.). The default
//     implementation is plain-text only; richer extraction (pdfcpu,
//     soffice, OCR) plugs in via the optional Extractor field on
//     Embedder. Keeps the seam thin and the dev-loop fast.
//   - Search ranking. That lives in the search handler — it issues a
//     vector_cosine_ops <-> query against this table and joins back to
//     `files` for ACL / metadata.
//
// Failure semantics:
//
//   - A whole-file failure (extract / first embed call) flips
//     embed_status='failed' and stores the error message in
//     embed_error. The asynq retry budget on TaskEmbedFile (currently
//     2) covers transient Ollama hiccups; persistent failures require
//     operator intervention (re-enqueue, switch model, etc.).
//   - A partial failure (chunk N of 12 fails) bubbles up as the
//     whole-file error; partial INSERTs are rolled back via a single
//     transaction so the file never enters a half-embedded state. This
//     is deliberate: search wants either "indexed" or "not indexed",
//     never "indexed up to chunk 7".
package embeddings

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"strings"
	"unicode/utf8"

	"github.com/docforge/api/internal/ai"
	"github.com/docforge/api/internal/storage"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

// Default chunking parameters. Tuned for nomic-embed-text's 8K-token
// context: ~512 tokens per chunk leaves headroom for the model's prompt
// overhead, and 64-token overlap keeps phrases that straddle the
// boundary searchable from either side.
//
// Why chars and not tokens: a real BPE tokenizer would add ~6 MB of
// embedded vocab data and a runtime dependency we don't otherwise need.
// English averages ~4 chars/token, so 2048 chars ≈ 512 tokens — plenty
// accurate for the chunk-size budget. Worst case (CJK / code) we
// over-chunk slightly, which only hurts INSERT cost, not correctness.
const (
	DefaultChunkChars   = 2048
	DefaultOverlapChars = 256
	// MaxBytes is the upper bound on bytes we'll try to embed for a
	// single file. Above this we mark `skipped` rather than burning
	// tens of minutes on a multi-GB log file. Operator can re-enqueue
	// after slicing.
	MaxBytes = 8 * 1024 * 1024
)

// Extractor turns blob bytes (plus the file's mime) into the plain
// text we'll feed the embedder. Returning an empty string + nil error
// is the canonical "this file is not textual" signal — the orchestrator
// will mark embed_status='skipped' rather than 'failed'.
//
// The default implementation lives in this package and handles
// text/*. Richer extractors (pdf → text via pdfcpu, docx → text via
// soffice, image → text via tesseract) plug in by passing a custom
// Extractor at Embedder construction.
type Extractor func(ctx context.Context, mime string, body []byte) (string, error)

// PlainTextExtractor returns the body verbatim for text/* mimes and
// empty string otherwise. Good enough for txt/md/csv/json/html/code —
// which is the bulk of "AI smart search would help here" content in a
// document drive. Operators wanting PDF / DOCX can wire a custom
// Extractor.
func PlainTextExtractor(_ context.Context, mime string, body []byte) (string, error) {
	if !looksTextual(mime) {
		return "", nil
	}
	if !utf8.Valid(body) {
		// Reject non-UTF8 bytes loudly rather than silently embedding
		// mojibake — better to mark skipped and let an operator
		// transcode than to poison the index with garbage tokens.
		return "", errors.New("body is not valid utf-8")
	}
	return string(body), nil
}

// looksTextual matches the mimes our PlainTextExtractor handles. Kept
// permissive on purpose — false positives just produce poor embeddings,
// not a crash.
func looksTextual(mime string) bool {
	mime = strings.ToLower(strings.TrimSpace(mime))
	if mime == "" {
		return false
	}
	if strings.HasPrefix(mime, "text/") {
		return true
	}
	switch mime {
	case "application/json", "application/xml", "application/yaml",
		"application/x-yaml", "application/javascript",
		"application/x-sh", "application/x-toml":
		return true
	}
	// Many code mimes come through as application/*+xml or +json — handle
	// the common suffixes generically.
	if strings.HasSuffix(mime, "+json") || strings.HasSuffix(mime, "+xml") {
		return true
	}
	return false
}

// Embedder is the orchestrator. One instance is shared across the HTTP
// API and the worker — same code path on either side keeps the
// "synchronous embed for tiny files" optimisation (not implemented yet
// but reserved) byte-identical to the async path.
type Embedder struct {
	DB      *pgxpool.Pool
	Storage *storage.Client
	AI      ai.Client
	Log     *slog.Logger

	// Extract is optional — defaults to PlainTextExtractor. Tests and
	// PDF-aware deployments override this.
	Extract Extractor

	// ChunkChars / OverlapChars override the defaults. Zero values use
	// the package constants.
	ChunkChars   int
	OverlapChars int
}

// New builds an Embedder with sane defaults. The caller supplies the
// minimum set of dependencies; everything else (chunk size, extractor)
// has a working fallback so a one-liner constructor in main.go doesn't
// need to know the tuning knobs.
func New(db *pgxpool.Pool, store *storage.Client, client ai.Client, log *slog.Logger) *Embedder {
	return &Embedder{
		DB:      db,
		Storage: store,
		AI:      client,
		Log:     log,
		Extract: PlainTextExtractor,
	}
}

// Status values mirror the migration's docstring. Stringly-typed in the
// DB; constants here keep callers from drifting.
const (
	StatusPending = "pending"
	StatusRunning = "running"
	StatusReady   = "ready"
	StatusFailed  = "failed"
	StatusSkipped = "skipped"
)

// EmbedFile is the worker's main entry point. It takes the metadata
// from the queue payload (the worker pre-decoded it) and runs through
// extract → chunk → embed → persist. All status transitions on `files`
// happen inside this method so the call-site is a single function call.
func (e *Embedder) EmbedFile(ctx context.Context, orgID, fileID, storageKey, mime string) error {
	if e == nil || e.AI == nil || !e.AI.Enabled() {
		// Defensive: the worker shouldn't enqueue when AI is off, but
		// payloads that survived a config flip would otherwise loop on
		// retries. Skip without error.
		return e.markStatus(ctx, fileID, StatusSkipped, "ai disabled")
	}
	caps := e.AI.Capabilities()
	if !caps.Embed {
		return e.markStatus(ctx, fileID, StatusSkipped, "provider lacks embed capability")
	}

	if err := e.markStatus(ctx, fileID, StatusRunning, ""); err != nil {
		return fmt.Errorf("mark running: %w", err)
	}

	// Fetch bytes. We use GetBytes (not GetReader) because the chunker
	// needs the whole text in memory anyway and the MaxBytes cap above
	// keeps that bounded.
	body, err := e.Storage.GetBytes(ctx, storageKey)
	if err != nil {
		_ = e.markStatus(ctx, fileID, StatusFailed, "fetch blob: "+err.Error())
		return fmt.Errorf("fetch blob: %w", err)
	}
	if len(body) == 0 {
		return e.markStatus(ctx, fileID, StatusSkipped, "empty body")
	}
	if len(body) > MaxBytes {
		return e.markStatus(ctx, fileID, StatusSkipped,
			fmt.Sprintf("body %d bytes exceeds cap %d", len(body), MaxBytes))
	}

	extract := e.Extract
	if extract == nil {
		extract = PlainTextExtractor
	}
	text, err := extract(ctx, mime, body)
	if err != nil {
		_ = e.markStatus(ctx, fileID, StatusFailed, "extract: "+err.Error())
		return fmt.Errorf("extract: %w", err)
	}
	if strings.TrimSpace(text) == "" {
		return e.markStatus(ctx, fileID, StatusSkipped, "no extractable text")
	}

	chunks := Chunk(text, e.chunkSize(), e.overlap())
	if len(chunks) == 0 {
		return e.markStatus(ctx, fileID, StatusSkipped, "no chunks produced")
	}

	// Embed each chunk. We embed before opening the transaction so a
	// flaky model doesn't hold a DB lock, and a partial failure aborts
	// without leaving an in-progress write to roll back.
	type embedded struct {
		idx     int
		content string
		vec     []float32
	}
	out := make([]embedded, 0, len(chunks))
	model := ""
	for i, c := range chunks {
		resp, err := e.AI.Embed(ctx, ai.EmbedRequest{Input: c})
		if err != nil {
			_ = e.markStatus(ctx, fileID, StatusFailed,
				fmt.Sprintf("embed chunk %d/%d: %v", i+1, len(chunks), err))
			return fmt.Errorf("embed chunk %d: %w", i, err)
		}
		if model == "" {
			model = resp.Model
		}
		out = append(out, embedded{idx: i, content: c, vec: resp.Embedding})
	}

	// Single transaction: drop any previous chunks for this file (so
	// re-embeds are idempotent) and INSERT the new set. Failure here
	// flips status to 'failed' but preserves the prior chunks because
	// we only DELETE inside the same tx.
	tx, err := e.DB.BeginTx(ctx, pgx.TxOptions{})
	if err != nil {
		_ = e.markStatus(ctx, fileID, StatusFailed, "begin tx: "+err.Error())
		return err
	}
	defer func() { _ = tx.Rollback(ctx) }()

	if _, err := tx.Exec(ctx, `DELETE FROM file_chunks WHERE file_id=$1`, fileID); err != nil {
		_ = e.markStatus(ctx, fileID, StatusFailed, "clear chunks: "+err.Error())
		return err
	}

	for _, ch := range out {
		if _, err := tx.Exec(ctx, `
			INSERT INTO file_chunks (file_id, org_id, chunk_index, content, embedding, model)
			VALUES ($1, $2, $3, $4, $5, $6)`,
			fileID, orgID, ch.idx, ch.content, vectorLiteral(ch.vec), model,
		); err != nil {
			_ = e.markStatus(ctx, fileID, StatusFailed,
				fmt.Sprintf("insert chunk %d: %v", ch.idx, err))
			return err
		}
	}
	if err := tx.Commit(ctx); err != nil {
		_ = e.markStatus(ctx, fileID, StatusFailed, "commit: "+err.Error())
		return err
	}

	if err := e.markReady(ctx, fileID); err != nil {
		return fmt.Errorf("mark ready: %w", err)
	}

	if e.Log != nil {
		e.Log.Info("embed done",
			"file", fileID, "chunks", len(out), "model", model,
			"text_chars", len(text), "body_bytes", len(body),
		)
	}
	return nil
}

// EmbedQuery is the search-time helper. The caller has the user's query
// string and wants a vector to feed `<-> $vec` against file_chunks. We
// don't persist anything — the result is consumed once and discarded.
func (e *Embedder) EmbedQuery(ctx context.Context, q string) ([]float32, error) {
	if e == nil || e.AI == nil || !e.AI.Enabled() {
		return nil, ai.ErrDisabled
	}
	if !e.AI.Capabilities().Embed {
		return nil, fmt.Errorf("embed: %w", ai.ErrUnsupported)
	}
	resp, err := e.AI.Embed(ctx, ai.EmbedRequest{Input: q})
	if err != nil {
		return nil, err
	}
	return resp.Embedding, nil
}

func (e *Embedder) chunkSize() int {
	if e.ChunkChars > 0 {
		return e.ChunkChars
	}
	return DefaultChunkChars
}

func (e *Embedder) overlap() int {
	if e.OverlapChars > 0 {
		return e.OverlapChars
	}
	return DefaultOverlapChars
}

// markStatus stamps embed_status + embed_error on the files row. Used
// for non-terminal transitions (running) and terminal ones except
// 'ready' (which clears embed_error and sets embedded_at via
// markReady).
func (e *Embedder) markStatus(ctx context.Context, fileID, status, errMsg string) error {
	_, err := e.DB.Exec(ctx, `
		UPDATE files
		   SET embed_status = $1,
		       embed_error  = NULLIF($2, ''),
		       updated_at   = now()
		 WHERE id = $3`,
		status, errMsg, fileID,
	)
	return err
}

// markReady is the success-path companion to markStatus. It clears
// embed_error (a previous failure shouldn't shadow a successful re-run)
// and stamps embedded_at so operators can audit "when did this file
// get indexed".
func (e *Embedder) markReady(ctx context.Context, fileID string) error {
	_, err := e.DB.Exec(ctx, `
		UPDATE files
		   SET embed_status = 'ready',
		       embed_error  = NULL,
		       embedded_at  = now(),
		       updated_at   = now()
		 WHERE id = $1`,
		fileID,
	)
	return err
}

// vectorLiteral renders a Go slice in pgvector's text input format —
// "[0.1,0.2,...]". We use this rather than a pgx custom-type
// registration because pgx's type registry doesn't ship a vector codec
// out of the box, and INSERT-time text serialization is plenty fast for
// our chunk volumes.
func vectorLiteral(v []float32) string {
	if len(v) == 0 {
		return "[]"
	}
	var b strings.Builder
	b.Grow(len(v) * 12)
	b.WriteByte('[')
	for i, f := range v {
		if i > 0 {
			b.WriteByte(',')
		}
		// %g picks the shortest accurate float representation, which
		// keeps the literal compact without losing precision.
		fmt.Fprintf(&b, "%g", f)
	}
	b.WriteByte(']')
	return b.String()
}

// Chunk slices `text` into overlapping windows of approximately
// `size` characters with `overlap` characters of trailing carry into
// the next chunk. A chunk boundary is nudged backwards to the nearest
// sentence-ish or whitespace break inside the last 10% of the window
// so we don't split mid-word — embeddings degrade noticeably when the
// chunk text is mid-token.
//
// Returned slices are independent strings (no shared backing array)
// so callers can hand them to goroutines without coordinating
// lifetimes.
func Chunk(text string, size, overlap int) []string {
	if size <= 0 {
		size = DefaultChunkChars
	}
	if overlap < 0 {
		overlap = 0
	}
	if overlap >= size {
		overlap = size / 4
	}
	runes := []rune(text)
	if len(runes) == 0 {
		return nil
	}
	if len(runes) <= size {
		return []string{strings.TrimSpace(string(runes))}
	}

	out := make([]string, 0, len(runes)/(size-overlap)+1)
	start := 0
	for start < len(runes) {
		end := start + size
		if end >= len(runes) {
			tail := strings.TrimSpace(string(runes[start:]))
			if tail != "" {
				out = append(out, tail)
			}
			break
		}
		// Look back up to 10% of the window for a clean break — sentence
		// terminator, newline, or whitespace, in that order. Bounded
		// search keeps Chunk linear in input length.
		breakAt := end
		minBreak := end - size/10
		for i := end; i > minBreak && i > start; i-- {
			r := runes[i-1]
			if r == '.' || r == '!' || r == '?' || r == '\n' {
				breakAt = i
				break
			}
		}
		if breakAt == end {
			for i := end; i > minBreak && i > start; i-- {
				if isSpace(runes[i-1]) {
					breakAt = i
					break
				}
			}
		}
		piece := strings.TrimSpace(string(runes[start:breakAt]))
		if piece != "" {
			out = append(out, piece)
		}
		// Advance with overlap so context that straddles the boundary
		// is recoverable on either side.
		next := breakAt - overlap
		if next <= start {
			// Pathological case: tiny chunk + huge overlap. Move
			// forward at least one rune to guarantee progress.
			next = start + 1
		}
		start = next
	}
	return out
}

func isSpace(r rune) bool {
	switch r {
	case ' ', '\t', '\n', '\r', '\v', '\f':
		return true
	}
	return false
}
