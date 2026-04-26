// Package autotag is the orchestrator behind the post-upload AI
// auto-tag + auto-rename pipeline. It owns three responsibilities:
//
//  1. Pull the file's text (same plain-text Extractor seam the
//     embeddings package uses; PDF/DOCX extraction plugs in later).
//  2. Ask the chat model for a small JSON object describing the file
//     (tags + a suggested filename) and parse the result robustly —
//     free-form LLM output is unreliable, so we accept JSON wrapped
//     in code fences, prose, or both, and silently drop fields that
//     don't conform.
//  3. Persist the tags, store the rename suggestion, and apply the
//     rename ONLY if the original filename looks generic (LooksGeneric).
//
// Why we don't always overwrite filenames:
//
// Users who name a file "Q3-2026-Renewal-Agreement-FINAL.docx" do not
// want the model to rename it. Users who upload "IMG_4821.pdf" or a
// scanner's "scan.pdf" almost certainly do. The heuristic lives in
// LooksGeneric and is intentionally narrow: false negatives leave a
// suggestion the user can one-click apply, false positives clobber
// intentional names — so we err toward "stash the suggestion, don't
// apply it" and the UI surfaces a rename banner instead.
//
// Failure semantics:
//
//   - Parse errors / blank model output → auto_tag_status='failed'
//     with a helpful message in auto_tag_error. No retry-storm; the
//     asynq budget covers transient transport failures only.
//   - Non-textual or empty bodies → auto_tag_status='skipped'.
//   - DB errors → bubble up so asynq retries the whole job.
package autotag

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"path/filepath"
	"regexp"
	"strings"
	"time"

	"github.com/docforge/api/internal/ai"
	"github.com/docforge/api/internal/embeddings"
	"github.com/docforge/api/internal/storage"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

// Status values match the column docstring + embed_status pattern.
const (
	StatusPending = "pending"
	StatusRunning = "running"
	StatusReady   = "ready"
	StatusFailed  = "failed"
	StatusSkipped = "skipped"
)

// Tunable defaults. Kept conservative so a single auto-tag job never
// monopolises the worker pool — chat completions are slow.
const (
	// MaxTagCount is the hard upper bound on tags we accept from the
	// model. Even a maximally cooperative model that suggests 30 tags
	// would dilute filter UX; 8 is a healthy ceiling for "skim and
	// recognise."
	MaxTagCount = 8
	// MaxTagLength prevents the model from suggesting a sentence as a
	// tag (it happens). Anything longer is silently truncated.
	MaxTagLength = 32
	// MaxPromptChars caps how much of the file we send to the model.
	// Doc-level summarisation works fine off the first ~6KB for most
	// files; sending the whole 8MB cap (per embeddings.MaxBytes) would
	// blow context windows and inflate cost on hosted providers.
	MaxPromptChars = 6000
	// MaxNameLength clips overly creative model suggestions ("This is
	// the Q3 Renewal Invoice For Acme Corp From November.pdf" → too
	// long for any sensible filesystem listing). Real filenames cap
	// at 255 bytes on most systems; we go far stricter for UX.
	MaxNameLength = 96
)

// Tagger is the orchestrator. Constructed once per process and
// shared between any HTTP path that wants to re-tag on demand and the
// worker that handles TaskAutoTagFile.
type Tagger struct {
	DB      *pgxpool.Pool
	Storage *storage.Client
	AI      ai.Client
	Log     *slog.Logger

	// Extract reuses the embeddings package's Extractor seam — same
	// "what counts as text" rule for both pipelines so a file that's
	// embeddable is also taggable, and vice versa. Defaults to
	// embeddings.PlainTextExtractor.
	Extract embeddings.Extractor
}

// New builds a Tagger with sane defaults.
func New(db *pgxpool.Pool, store *storage.Client, c ai.Client, log *slog.Logger) *Tagger {
	return &Tagger{
		DB:      db,
		Storage: store,
		AI:      c,
		Log:     log,
		Extract: embeddings.PlainTextExtractor,
	}
}

// Suggestion is what we extract from the model's JSON. Each field is
// optional; the orchestrator decides what to do with the parts the
// model fills in.
type Suggestion struct {
	Tags []string `json:"tags"`
	// Name is the suggested filename (no path). Always stored in
	// auto_rename_suggestion; only applied when LooksGeneric(original).
	Name string `json:"name"`
}

// TagFile is the worker's main entry point. It mirrors
// embeddings.Embedder.EmbedFile so the worker handlers stay symmetric.
func (t *Tagger) TagFile(ctx context.Context, orgID, fileID, storageKey, mime, originalName string) error {
	if t == nil || t.AI == nil || !t.AI.Enabled() {
		return t.markStatus(ctx, fileID, StatusSkipped, "ai disabled")
	}
	if !t.AI.Capabilities().Chat {
		return t.markStatus(ctx, fileID, StatusSkipped, "provider lacks chat capability")
	}

	if err := t.markStatus(ctx, fileID, StatusRunning, ""); err != nil {
		return fmt.Errorf("mark running: %w", err)
	}

	body, err := t.Storage.GetBytes(ctx, storageKey)
	if err != nil {
		_ = t.markStatus(ctx, fileID, StatusFailed, "fetch blob: "+err.Error())
		return fmt.Errorf("fetch blob: %w", err)
	}
	if len(body) == 0 {
		return t.markStatus(ctx, fileID, StatusSkipped, "empty body")
	}
	if len(body) > embeddings.MaxBytes {
		return t.markStatus(ctx, fileID, StatusSkipped,
			fmt.Sprintf("body %d bytes exceeds cap %d", len(body), embeddings.MaxBytes))
	}

	extract := t.Extract
	if extract == nil {
		extract = embeddings.PlainTextExtractor
	}
	text, err := extract(ctx, mime, body)
	if err != nil {
		_ = t.markStatus(ctx, fileID, StatusFailed, "extract: "+err.Error())
		return fmt.Errorf("extract: %w", err)
	}
	if strings.TrimSpace(text) == "" {
		return t.markStatus(ctx, fileID, StatusSkipped, "no extractable text")
	}

	// Ask the model. We pass the original filename as a soft hint —
	// "user already called this X, propose Y or stick with X" — and
	// the model uses it well in practice on llama3.1:8b.
	sug, err := t.askModel(ctx, originalName, mime, text)
	if err != nil {
		_ = t.markStatus(ctx, fileID, StatusFailed, "model: "+err.Error())
		// Don't bubble parse errors to asynq retry — the model would
		// likely return the same garbage. Transport errors get a
		// distinct prefix so the worker layer can recognise them.
		if errors.Is(err, errBadJSON) {
			return nil
		}
		return err
	}

	tags := normaliseTags(sug.Tags)
	suggestedName := normaliseName(sug.Name, originalName)

	// Decide whether to apply the rename. We only override files.name
	// when the user's original looks generic (IMG_*, scan.pdf,
	// untitled.txt, …) AND the model's suggestion is meaningfully
	// different from the original. Otherwise we record the suggestion
	// for the UI.
	apply := suggestedName != "" &&
		LooksGeneric(originalName) &&
		!equalsIgnoreCaseAndExt(suggestedName, originalName)

	if err := t.persist(ctx, fileID, tags, suggestedName, originalName, apply); err != nil {
		return fmt.Errorf("persist: %w", err)
	}

	if t.Log != nil {
		t.Log.Info("autotag done",
			"file", fileID,
			"tags", len(tags),
			"renamed", apply,
			"suggested", suggestedName,
		)
	}
	return nil
}

// errBadJSON is the sentinel we wrap when the model's output can't be
// coerced into a Suggestion. Used to skip asynq retries for that case.
var errBadJSON = errors.New("model returned unparseable output")

// askModel sends the prompt and decodes the response. Returns
// errBadJSON when the output is uninterpretable so the caller knows
// not to retry.
func (t *Tagger) askModel(ctx context.Context, originalName, mime, text string) (Suggestion, error) {
	prompt := buildPrompt(originalName, mime, text)
	// Low temperature: we want consistent, conservative tags, not
	// creative ones. The system message pins the JSON contract.
	resp, err := t.AI.Chat(ctx, ai.ChatRequest{
		Temperature: 0.1,
		MaxTokens:   400,
		Messages: []ai.ChatMessage{
			{Role: "system", Content: systemPrompt},
			{Role: "user", Content: prompt},
		},
	})
	if err != nil {
		return Suggestion{}, err
	}
	sug, ok := parseSuggestion(resp.Content)
	if !ok {
		return Suggestion{}, fmt.Errorf("%w: %q", errBadJSON, truncateForLog(resp.Content, 200))
	}
	return sug, nil
}

// persist applies the result inside one transaction so the row never
// has tags-without-status or status-without-tags.
func (t *Tagger) persist(ctx context.Context, fileID string, tags []string, suggested, original string, applyRename bool) error {
	tx, err := t.DB.BeginTx(ctx, pgx.TxOptions{})
	if err != nil {
		_ = t.markStatus(ctx, fileID, StatusFailed, "begin tx: "+err.Error())
		return err
	}
	defer func() { _ = tx.Rollback(ctx) }()

	// tags column has a NOT NULL DEFAULT '{}' so passing an empty
	// slice is valid — the file just gets cleared of any prior tags
	// (idempotent re-runs are a feature).
	if _, err := tx.Exec(ctx,
		`UPDATE files
		    SET tags                   = $1,
		        auto_rename_suggestion = NULLIF($2, ''),
		        updated_at             = now()
		  WHERE id = $3`,
		tags, suggested, fileID,
	); err != nil {
		_ = t.markStatus(ctx, fileID, StatusFailed, "update tags: "+err.Error())
		return err
	}

	if applyRename {
		// Preserve the user's original in original_name so the UI can
		// offer a "revert" affordance. We never overwrite original_name
		// on a re-run — once captured, it's the canonical "what the
		// user uploaded" record.
		if _, err := tx.Exec(ctx,
			`UPDATE files
			    SET name          = $1,
			        original_name = COALESCE(original_name, $2),
			        updated_at    = now()
			  WHERE id = $3`,
			suggested, original, fileID,
		); err != nil {
			_ = t.markStatus(ctx, fileID, StatusFailed, "apply rename: "+err.Error())
			return err
		}
	}

	if _, err := tx.Exec(ctx,
		`UPDATE files
		    SET auto_tag_status = 'ready',
		        auto_tag_error  = NULL,
		        tagged_at       = now(),
		        updated_at      = now()
		  WHERE id = $1`,
		fileID,
	); err != nil {
		return err
	}
	return tx.Commit(ctx)
}

func (t *Tagger) markStatus(ctx context.Context, fileID, status, errMsg string) error {
	_, err := t.DB.Exec(ctx, `
		UPDATE files
		   SET auto_tag_status = $1,
		       auto_tag_error  = NULLIF($2, ''),
		       updated_at      = now()
		 WHERE id = $3`,
		status, errMsg, fileID,
	)
	return err
}

/* ---------------------------- prompting ---------------------------- */

const systemPrompt = `You are a precise document classifier. Given the filename, MIME type, and the text contents of a single document, propose:
  1. up to 5 short, lowercase, descriptive tags (single words or short hyphenated phrases) that would help someone find this file later;
  2. a concise human-friendly filename (with extension) describing what the document IS, not its layout.

Respond with a single JSON object on one line, no prose, no code fences:
{"tags":["..."],"name":"..."}

Rules:
  - Tags must be concrete (e.g. "invoice", "renewal", "q3-2026", "acme-corp"); never use "document", "file", or generic stop-words.
  - The suggested name must keep the original extension when the original had one. Use spaces or hyphens, not underscores.
  - If you cannot identify the document confidently, return empty arrays/strings rather than guessing.`

// buildPrompt frames the user-side message: original filename + mime
// + a clipped excerpt. The hint about the original is deliberately
// presented as context (not an instruction) — that nudges the model
// toward "preserve when meaningful" without hand-coding the heuristic
// twice (we still re-check on the orchestrator side).
func buildPrompt(originalName, mime, text string) string {
	excerpt := text
	if len(excerpt) > MaxPromptChars {
		excerpt = excerpt[:MaxPromptChars] + "\n…[truncated]"
	}
	return fmt.Sprintf(
		"Original filename: %s\nMIME: %s\n\n--- begin document ---\n%s\n--- end document ---",
		originalName, mime, excerpt,
	)
}

// parseSuggestion tolerates the three failure modes we see in
// practice: (1) the model returns clean JSON, (2) it wraps the JSON
// in ```json fences, (3) it prepends or appends a sentence of prose.
// We extract the first balanced {...} block and unmarshal that.
func parseSuggestion(raw string) (Suggestion, bool) {
	s := strings.TrimSpace(raw)
	if s == "" {
		return Suggestion{}, false
	}
	// Strip any fenced block. The model often emits ```json\n{...}\n```.
	if strings.HasPrefix(s, "```") {
		s = strings.TrimPrefix(s, "```")
		if i := strings.Index(s, "\n"); i >= 0 {
			s = s[i+1:]
		}
		if i := strings.LastIndex(s, "```"); i >= 0 {
			s = s[:i]
		}
		s = strings.TrimSpace(s)
	}
	// Find the first {...} block — covers the "prose then JSON" case.
	start := strings.Index(s, "{")
	end := strings.LastIndex(s, "}")
	if start < 0 || end <= start {
		return Suggestion{}, false
	}
	var sug Suggestion
	if err := json.Unmarshal([]byte(s[start:end+1]), &sug); err != nil {
		return Suggestion{}, false
	}
	return sug, true
}

/* ----------------------- normalisation ----------------------------- */

// normaliseTags lower-cases, trims, dedupes, and clips both per-tag
// length and total count. Models occasionally produce tags like
// "  Invoice  " or "Invoice." — we strip those without rejecting the
// suggestion outright. Empty tags after trimming are dropped.
func normaliseTags(in []string) []string {
	if len(in) == 0 {
		return []string{}
	}
	seen := make(map[string]struct{}, len(in))
	out := make([]string, 0, len(in))
	for _, raw := range in {
		t := strings.ToLower(strings.TrimSpace(raw))
		// Strip trailing punctuation that the model occasionally adds.
		t = strings.TrimRight(t, ".,;:!?")
		if t == "" {
			continue
		}
		if len(t) > MaxTagLength {
			// Trim on rune boundary to avoid mid-codepoint cuts.
			runes := []rune(t)
			if len(runes) > MaxTagLength {
				runes = runes[:MaxTagLength]
			}
			t = string(runes)
		}
		if _, dup := seen[t]; dup {
			continue
		}
		// Reject the universal stop-words the system prompt forbids
		// in case the model ignored the rule. Cheap belt-and-braces.
		switch t {
		case "document", "file", "files", "documents", "untitled":
			continue
		}
		seen[t] = struct{}{}
		out = append(out, t)
		if len(out) >= MaxTagCount {
			break
		}
	}
	return out
}

// normaliseName cleans up the model's filename suggestion. If the
// suggestion has no extension, we re-attach the original's extension
// so the UI / downloads stay sane. If the model returned just an
// empty string we propagate that (the orchestrator treats empty as
// "no rename").
func normaliseName(suggested, original string) string {
	s := strings.TrimSpace(suggested)
	if s == "" {
		return ""
	}
	// Reject path separators — the model occasionally suggests
	// "invoices/q3-renewal.pdf". We only want a leaf filename.
	s = filepath.Base(s)
	if s == "." || s == "/" || s == `\` {
		return ""
	}
	// Cap length on rune boundary.
	if r := []rune(s); len(r) > MaxNameLength {
		s = string(r[:MaxNameLength])
	}
	// Re-attach the original extension if the model dropped it.
	if filepath.Ext(s) == "" {
		if ext := filepath.Ext(original); ext != "" {
			s = s + ext
		}
	}
	return s
}

func equalsIgnoreCaseAndExt(a, b string) bool {
	stripExt := func(s string) string {
		ext := filepath.Ext(s)
		if ext == "" {
			return s
		}
		return s[:len(s)-len(ext)]
	}
	return strings.EqualFold(stripExt(a), stripExt(b))
}

/* ----------------------- generic-name heuristic -------------------- */

// genericNamePatterns matches filenames that almost certainly weren't
// chosen with intent — phone-camera defaults, scanner defaults, OS
// "New Document" defaults, common no-name uploads. The list is
// deliberately conservative: when in doubt, we DO NOT auto-apply, we
// just record a suggestion the user can accept with one click.
//
// The patterns are case-insensitive. Anchored to the full base name
// (sans extension) where it makes sense, partial-match where the
// pattern carries enough signal on its own (IMG_*, scan_*).
var genericNamePatterns = []*regexp.Regexp{
	// Phone cameras
	regexp.MustCompile(`(?i)^img[_-]?\d{2,}.*$`),
	regexp.MustCompile(`(?i)^dsc[_-]?\d{2,}.*$`),
	regexp.MustCompile(`(?i)^pxl[_-]?\d.*$`),
	regexp.MustCompile(`(?i)^photo[_\- ]?\d.*$`),
	// Scanners + multi-function devices
	regexp.MustCompile(`(?i)^scan(ned)?[_\- ]?\d*.*$`),
	regexp.MustCompile(`(?i)^scanned[_\- ]?document.*$`),
	regexp.MustCompile(`(?i)^scan_\d+_\d+.*$`),
	// Operating-system / office defaults
	regexp.MustCompile(`(?i)^document\s*\d*$`),
	regexp.MustCompile(`(?i)^untitled.*$`),
	regexp.MustCompile(`(?i)^new\s+(document|text\s+document|microsoft\s+(word|excel)\s+document).*$`),
	regexp.MustCompile(`(?i)^file[_\- ]?\d*$`),
	// Pure-numeric or extremely short stems (e.g. "123.pdf", "a.pdf")
	regexp.MustCompile(`^\d{1,8}$`),
	regexp.MustCompile(`^[a-z]{1,2}$`),
	// Common "downloaded from" defaults
	regexp.MustCompile(`(?i)^download(ed)?(\s*\(\d+\))?$`),
}

// LooksGeneric reports whether the filename looks like an auto-
// generated default that the user almost certainly wants improved.
// Returns true only when the *stem* (filename without extension)
// matches one of the genericNamePatterns; the extension itself never
// affects the verdict.
func LooksGeneric(name string) bool {
	stem := strings.TrimSpace(name)
	if stem == "" {
		return true
	}
	stem = strings.TrimSuffix(stem, filepath.Ext(stem))
	stem = strings.TrimSpace(stem)
	if stem == "" {
		return true
	}
	for _, re := range genericNamePatterns {
		if re.MatchString(stem) {
			return true
		}
	}
	return false
}

/* ----------------------------- helpers ----------------------------- */

func truncateForLog(s string, max int) string {
	s = strings.ReplaceAll(s, "\n", " ")
	if len(s) <= max {
		return s
	}
	return s[:max] + "…"
}

// Suppress the unused-import warning when we ship without time-based
// metrics later; keeps the import in place so a future "tagged_at"-
// driven SLO check can be added without re-importing.
var _ = time.Now
