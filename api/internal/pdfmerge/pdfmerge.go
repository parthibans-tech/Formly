// Package pdfmerge implements the "stitch documents together" feature:
// merge N source files into a single PDF, or insert pages from one
// source into the middle of an existing PDF, optionally extracting /
// removing / rotating ranges. It is intentionally side-effect-free
// outside of the two write moments (storage PutBytes + INSERT/UPDATE
// files row), so a partial failure leaves no orphan rows.
//
// Why a dedicated package
//
// pdfcpu is the workhorse, but the user-facing flow is very different
// from "files plumbing":
//   - Inputs may be heterogeneous (DOCX, RTF, ODT, images) — anything
//     that isn't already a PDF gets normalised via internal/docconvert
//     (LibreOffice headless) before pdfcpu sees it.
//   - Page selection lives in user-typed strings ("1-3,5,7-9") that we
//     hand straight to pdfcpu's range parser, with our own pre-validator
//     so we can return a 400 with a useful message before launching a
//     worker.
//   - Output is a brand-new file owned by the caller; it has no
//     relationship to its inputs in the files table (unlike preview-pdf,
//     which is a sibling of one specific source).
//
// Sync vs async
//
// The fast path (≤5 small native PDFs, no soffice conversion) runs
// inline and returns 201 with the new fileId; anything else enqueues
// an asynq job (TaskMergePDF) and returns 202 + jobId. The split
// keeps the request thread snappy for the common case (two PDFs +
// "merge them") while still handling 50-page-deck mass-merges that
// would otherwise tie up an HTTP worker for tens of seconds.
//
// Trust model
//
//   - Every source fileId in a merge request is checked with
//     CanAccessFile (read-or-better). We don't require edit on the
//     sources — merging is a read operation against them; the *output*
//     is owned by the caller.
//   - For Insert (pages added into an existing target PDF), the target
//     requires CanEditFile.
//   - PageOps (rotate / remove / extract on a single PDF) requires edit
//     on that PDF — except `extract`, which produces a new file and
//     therefore only needs read on the source.

package pdfmerge

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"time"

	"github.com/docforge/api/internal/auth"
	"github.com/docforge/api/internal/docconvert"
	"github.com/docforge/api/internal/queue"
	"github.com/docforge/api/internal/sharing"
	"github.com/docforge/api/internal/storage"
	"github.com/go-chi/chi/v5"
	"github.com/hibiken/asynq"
	"github.com/jackc/pgx/v5/pgxpool"

	pdfcpuapi "github.com/pdfcpu/pdfcpu/pkg/api"
	pdfcpulib "github.com/pdfcpu/pdfcpu/pkg/pdfcpu"
)

// Limits — tuned for "drive feature, not document warehouse". The
// per-source cap is generous enough for a 200-page contract; the total
// cap keeps a misconfigured client from accidentally allocating 2 GiB.
const (
	// MaxSourceBytes is the hard ceiling on any single input file. Above
	// this we 413 the merge request rather than load the bytes.
	MaxSourceBytes = 200 * 1024 * 1024

	// MaxTotalBytes is the sum across all inputs in a single merge.
	// pdfcpu holds inputs in memory while writing the output, so this is
	// what actually constrains worker RAM.
	MaxTotalBytes = 500 * 1024 * 1024

	// SyncSourceLimit is the largest input set we process inline.
	// Anything past this routes through asynq.
	SyncSourceLimit = 5

	// SyncBytesLimit is the largest cumulative input size we process
	// inline. ~25 MiB ≈ a typical "merge two scanned PDFs" interaction
	// in well under a second; bigger jobs go async.
	SyncBytesLimit = 25 * 1024 * 1024

	// SyncSofficeAllowed is whether we ever do soffice conversions
	// inline. soffice cold-start is 3-5s — too slow for an HTTP request,
	// so heterogeneous merges always go async even at small sizes.
	SyncSofficeAllowed = false
)

// Handler binds the merge endpoints to their dependencies. Queue may be
// nil; in that case we simply refuse merges that would have been async
// (returning 503) and process the rest inline.
type Handler struct {
	DB      *pgxpool.Pool
	Storage *storage.Client
	Queue   *asynq.Client
}

func New(db *pgxpool.Pool, store *storage.Client, q *asynq.Client) *Handler {
	return &Handler{DB: db, Storage: store, Queue: q}
}

// MergeSource is one row in a merge request — the file to read from and
// optionally a subset of pages. Empty / "all" means the whole file.
type MergeSource struct {
	FileID string `json:"fileId"`
	Pages  string `json:"pages,omitempty"`
}

type mergeRequest struct {
	// Name of the output file. ".pdf" is appended if missing. Empty
	// gets a sensible default ("Merged document.pdf").
	Name string `json:"name"`
	// FolderID is the destination folder. Empty / null = root.
	FolderID string `json:"folderId,omitempty"`
	// Sources is the ordered list of files to stitch together. Order
	// matters; the resulting PDF concatenates pages in this order.
	Sources []MergeSource `json:"sources"`
}

type insertRequest struct {
	// SourceID is the file whose (subset of) pages we splice in. If
	// it's not a PDF we run docconvert first.
	SourceID string `json:"sourceId"`
	// SourcePages selects which pages of the source to insert. Empty
	// or "all" inserts every page.
	SourcePages string `json:"sourcePages,omitempty"`
	// AfterPage is the 1-based page in the target PDF after which to
	// insert. 0 means "at the very beginning"; -1 / omitted means "at
	// the end". Out-of-range values clamp.
	AfterPage int `json:"afterPage"`
}

type pageOpsRequest struct {
	// Op is "rotate" | "remove" | "extract".
	//   rotate  → in-place rotate of the listed pages by `degrees`
	//             (must be 90, 180, or 270).
	//   remove  → in-place delete of the listed pages.
	//   extract → write a NEW file containing only the listed pages;
	//             leaves the original untouched.
	Op string `json:"op"`
	// Pages selects which pages the op applies to.
	Pages string `json:"pages"`
	// Degrees is required when Op == "rotate".
	Degrees int `json:"degrees,omitempty"`
	// Name is the output name when Op == "extract". Defaults to
	// "<source>-pages.pdf".
	Name string `json:"name,omitempty"`
	// FolderID is the destination folder for extract. Empty / null = root.
	FolderID string `json:"folderId,omitempty"`
}

// JobStatus is GET /v1/merge-jobs/{id}. Lets the browser poll an
// async merge to completion. The row is ACL'd to its creator's org;
// users only see jobs they've started themselves.
func (h *Handler) JobStatus(w http.ResponseWriter, r *http.Request) {
	c, _ := r.Context().Value(auth.UserCtxKey).(*auth.Claims)
	if c == nil {
		writeErr(w, 401, "unauthorized", "missing claims")
		return
	}
	id := chi.URLParam(r, "id")

	var (
		status   string
		fileID   *string
		errMsg   *string
		updated  time.Time
	)
	if err := h.DB.QueryRow(r.Context(),
		`SELECT status, file_id::text, error, updated_at
		   FROM merge_jobs
		  WHERE id=$1 AND org_id=$2 AND user_id=$3`,
		id, c.OrgID, c.UserID,
	).Scan(&status, &fileID, &errMsg, &updated); err != nil {
		writeErr(w, 404, "not_found", "merge job not found")
		return
	}
	resp := map[string]any{
		"jobId":     id,
		"status":    status,
		"updatedAt": updated.UTC().Format(time.RFC3339Nano),
	}
	if fileID != nil {
		resp["fileId"] = *fileID
	}
	if errMsg != nil {
		resp["error"] = *errMsg
	}
	writeJSON(w, 200, resp)
}

// Merge is POST /v1/files/merge.
func (h *Handler) Merge(w http.ResponseWriter, r *http.Request) {
	c, _ := r.Context().Value(auth.UserCtxKey).(*auth.Claims)
	if c == nil {
		writeErr(w, 401, "unauthorized", "missing claims")
		return
	}

	var req mergeRequest
	if err := json.NewDecoder(io.LimitReader(r.Body, 1<<20)).Decode(&req); err != nil {
		writeErr(w, 400, "bad_request", err.Error())
		return
	}
	if len(req.Sources) < 2 {
		writeErr(w, 400, "bad_request", "at least two sources are required for a merge")
		return
	}

	// Pre-flight: permission + metadata + size + page-range syntax.
	// We collect everything we need before touching storage so a 4xx
	// reply lands fast.
	srcs, totalBytes, needsConvert, err := h.preflightSources(r.Context(), c, req.Sources)
	if err != nil {
		writeErrFromPreflight(w, err)
		return
	}

	outName := normaliseOutputName(req.Name, "Merged document.pdf")
	folderArg := folderArgOf(req.FolderID)

	if needsConvert || len(srcs) > SyncSourceLimit || totalBytes > SyncBytesLimit {
		// Async path — enqueue and return.
		if h.Queue == nil {
			writeErr(w, 503, "queue_unavailable",
				"merge job too large for inline processing and worker queue is not configured")
			return
		}
		jobID, err := h.kickoffAsyncMerge(r.Context(), c, asyncMerge{
			Name:     outName,
			FolderID: req.FolderID,
			Sources:  req.Sources,
		})
		if err != nil {
			writeErr(w, 500, "queue_error", err.Error())
			return
		}
		writeJSON(w, 202, map[string]any{
			"async": true,
			"jobId": jobID,
		})
		return
	}

	// Sync path — load bytes, merge, upload.
	pdfBytes, _, err := h.assembleMerge(r.Context(), srcs)
	if err != nil {
		writeErr(w, 500, "merge_failed", err.Error())
		return
	}

	fileID, err := h.persistNewPDF(r.Context(), c, outName, folderArg, pdfBytes)
	if err != nil {
		writeErr(w, 500, "persist_failed", err.Error())
		return
	}
	writeJSON(w, 201, map[string]any{
		"async":  false,
		"fileId": fileID,
		"name":   outName,
		"size":   len(pdfBytes),
	})
}

// Insert is POST /v1/files/{id}/insert. Splices pages from a source
// file into a target PDF in-place (the target's storage_key is
// preserved so existing share links keep working).
func (h *Handler) Insert(w http.ResponseWriter, r *http.Request) {
	c, _ := r.Context().Value(auth.UserCtxKey).(*auth.Claims)
	if c == nil {
		writeErr(w, 401, "unauthorized", "missing claims")
		return
	}
	targetID := chi.URLParam(r, "id")

	canEdit, err := sharing.CanEditFile(r.Context(), h.DB, c, targetID)
	if err != nil {
		writeErr(w, 500, "db_error", err.Error())
		return
	}
	if !canEdit {
		writeErr(w, 403, "forbidden", "you don't have edit access to this PDF")
		return
	}

	var req insertRequest
	if err := json.NewDecoder(io.LimitReader(r.Body, 1<<20)).Decode(&req); err != nil {
		writeErr(w, 400, "bad_request", err.Error())
		return
	}
	if req.SourceID == "" {
		writeErr(w, 400, "bad_request", "sourceId is required")
		return
	}

	target, err := h.loadFileMeta(r.Context(), c.OrgID, targetID)
	if err != nil {
		writeErr(w, 404, "not_found", "target file not found")
		return
	}
	if !isPDF(target.Mime, target.Name) {
		writeErr(w, 400, "not_pdf", "target file is not a PDF")
		return
	}
	if target.Size > MaxSourceBytes {
		writeErr(w, 413, "too_large", "target PDF exceeds the merge size limit")
		return
	}

	// Source — read access only; we don't mutate it.
	srcs, _, _, err := h.preflightSources(r.Context(), c,
		[]MergeSource{{FileID: req.SourceID, Pages: req.SourcePages}})
	if err != nil {
		writeErrFromPreflight(w, err)
		return
	}

	targetBytes, err := h.Storage.GetBytes(r.Context(), target.StorageKey)
	if err != nil {
		writeErr(w, 502, "storage_error", err.Error())
		return
	}
	totalPages, err := pageCount(targetBytes)
	if err != nil {
		writeErr(w, 400, "bad_pdf", "target PDF is unreadable: "+err.Error())
		return
	}
	at := req.AfterPage
	if at < 0 || at > totalPages {
		at = totalPages // append
	}

	// Build the merge order: target[1..at] + source(pages) + target[at+1..]
	headPages := pageRangeStr(1, at)
	tailPages := pageRangeStr(at+1, totalPages)

	composed := []MergeSource{}
	if at > 0 {
		composed = append(composed, MergeSource{FileID: targetID, Pages: headPages})
	}
	composed = append(composed, MergeSource{FileID: req.SourceID, Pages: req.SourcePages})
	if at < totalPages {
		composed = append(composed, MergeSource{FileID: targetID, Pages: tailPages})
	}

	bound, _, _, err := h.preflightSources(r.Context(), c, composed)
	if err != nil {
		writeErrFromPreflight(w, err)
		return
	}
	// Force native bytes for the target slices we already have in
	// memory — saves two storage round-trips.
	for i := range bound {
		if bound[i].FileID == targetID {
			bound[i].cachedPDF = targetBytes
		}
		if bound[i].FileID == req.SourceID && len(srcs) == 1 {
			bound[i].cachedPDF = srcs[0].cachedPDF
		}
	}

	mergedBytes, _, err := h.assembleMerge(r.Context(), bound)
	if err != nil {
		writeErr(w, 500, "merge_failed", err.Error())
		return
	}

	// In-place: keep the same storage_key so share links don't break.
	if err := h.Storage.PutBytes(r.Context(), target.StorageKey, "application/pdf", mergedBytes); err != nil {
		writeErr(w, 502, "storage_error", err.Error())
		return
	}
	if _, err := h.DB.Exec(r.Context(),
		`UPDATE files SET size=$1, updated_at=now() WHERE id=$2`,
		len(mergedBytes), targetID,
	); err != nil {
		writeErr(w, 500, "db_error", err.Error())
		return
	}
	writeJSON(w, 200, map[string]any{
		"fileId": targetID,
		"size":   len(mergedBytes),
		"pages":  totalPages, // pre-insert; the client refetches if it needs the new count
	})
}

// PageOps is POST /v1/files/{id}/pages — rotate / remove / extract.
func (h *Handler) PageOps(w http.ResponseWriter, r *http.Request) {
	c, _ := r.Context().Value(auth.UserCtxKey).(*auth.Claims)
	if c == nil {
		writeErr(w, 401, "unauthorized", "missing claims")
		return
	}
	id := chi.URLParam(r, "id")

	var req pageOpsRequest
	if err := json.NewDecoder(io.LimitReader(r.Body, 1<<20)).Decode(&req); err != nil {
		writeErr(w, 400, "bad_request", err.Error())
		return
	}
	op := strings.ToLower(strings.TrimSpace(req.Op))
	pages := strings.TrimSpace(req.Pages)
	if pages == "" {
		writeErr(w, 400, "bad_request", "pages is required")
		return
	}
	if err := validatePageRange(pages); err != nil {
		writeErr(w, 400, "bad_pages", err.Error())
		return
	}

	// extract = read; rotate / remove = write.
	if op == "extract" {
		canRead, err := sharing.CanAccessFile(r.Context(), h.DB, c, id)
		if err != nil || !canRead {
			writeErr(w, 404, "not_found", "file not found")
			return
		}
	} else {
		canEdit, err := sharing.CanEditFile(r.Context(), h.DB, c, id)
		if err != nil {
			writeErr(w, 500, "db_error", err.Error())
			return
		}
		if !canEdit {
			writeErr(w, 403, "forbidden", "you don't have edit access to this file")
			return
		}
	}

	meta, err := h.loadFileMeta(r.Context(), c.OrgID, id)
	if err != nil {
		writeErr(w, 404, "not_found", "file not found")
		return
	}
	if !isPDF(meta.Mime, meta.Name) {
		writeErr(w, 400, "not_pdf", "page operations require a PDF")
		return
	}
	if meta.Size > MaxSourceBytes {
		writeErr(w, 413, "too_large", "PDF exceeds the size limit")
		return
	}

	src, err := h.Storage.GetBytes(r.Context(), meta.StorageKey)
	if err != nil {
		writeErr(w, 502, "storage_error", err.Error())
		return
	}

	switch op {
	case "rotate":
		if req.Degrees != 90 && req.Degrees != 180 && req.Degrees != 270 {
			writeErr(w, 400, "bad_request", "degrees must be 90, 180, or 270")
			return
		}
		out, err := rotatePDF(src, pages, req.Degrees)
		if err != nil {
			writeErr(w, 500, "rotate_failed", err.Error())
			return
		}
		if err := h.Storage.PutBytes(r.Context(), meta.StorageKey, "application/pdf", out); err != nil {
			writeErr(w, 502, "storage_error", err.Error())
			return
		}
		if _, err := h.DB.Exec(r.Context(),
			`UPDATE files SET size=$1, updated_at=now() WHERE id=$2`, len(out), id,
		); err != nil {
			writeErr(w, 500, "db_error", err.Error())
			return
		}
		writeJSON(w, 200, map[string]any{"fileId": id, "size": len(out)})

	case "remove":
		out, err := removePages(src, pages)
		if err != nil {
			writeErr(w, 500, "remove_failed", err.Error())
			return
		}
		if err := h.Storage.PutBytes(r.Context(), meta.StorageKey, "application/pdf", out); err != nil {
			writeErr(w, 502, "storage_error", err.Error())
			return
		}
		if _, err := h.DB.Exec(r.Context(),
			`UPDATE files SET size=$1, updated_at=now() WHERE id=$2`, len(out), id,
		); err != nil {
			writeErr(w, 500, "db_error", err.Error())
			return
		}
		writeJSON(w, 200, map[string]any{"fileId": id, "size": len(out)})

	case "extract":
		out, err := extractPages(src, pages)
		if err != nil {
			writeErr(w, 500, "extract_failed", err.Error())
			return
		}
		name := normaliseOutputName(req.Name,
			strings.TrimSuffix(meta.Name, filepath.Ext(meta.Name))+"-pages.pdf")
		newID, err := h.persistNewPDF(r.Context(), c, name, folderArgOf(req.FolderID), out)
		if err != nil {
			writeErr(w, 500, "persist_failed", err.Error())
			return
		}
		writeJSON(w, 201, map[string]any{
			"fileId": newID,
			"name":   name,
			"size":   len(out),
		})

	default:
		writeErr(w, 400, "bad_request", "op must be rotate, remove, or extract")
	}
}

// =====================================================================
//   Helpers
// =====================================================================

type fileMeta struct {
	Name       string
	Mime       string
	Size       int64
	StorageKey string
}

type boundSource struct {
	MergeSource
	Mime         string
	Name         string
	Size         int64
	StorageKey   string
	NeedsConvert bool
	cachedPDF    []byte // populated only by callers that already have the bytes
}

func (h *Handler) preflightSources(ctx context.Context, c *auth.Claims, in []MergeSource) ([]boundSource, int64, bool, error) {
	if len(in) == 0 {
		return nil, 0, false, &userError{status: 400, code: "bad_request", msg: "sources is required"}
	}
	out := make([]boundSource, 0, len(in))
	var total int64
	needsConvert := false

	for i, s := range in {
		if s.FileID == "" {
			return nil, 0, false, &userError{status: 400, code: "bad_request",
				msg: fmt.Sprintf("sources[%d].fileId is required", i)}
		}
		if s.Pages != "" {
			if err := validatePageRange(s.Pages); err != nil {
				return nil, 0, false, &userError{status: 400, code: "bad_pages",
					msg: fmt.Sprintf("sources[%d]: %s", i, err.Error())}
			}
		}
		canRead, err := sharing.CanAccessFile(ctx, h.DB, c, s.FileID)
		if err != nil {
			return nil, 0, false, &userError{status: 500, code: "db_error", msg: err.Error()}
		}
		if !canRead {
			return nil, 0, false, &userError{status: 404, code: "not_found",
				msg: fmt.Sprintf("sources[%d]: file not found", i)}
		}
		meta, err := h.loadFileMeta(ctx, c.OrgID, s.FileID)
		if err != nil {
			return nil, 0, false, &userError{status: 404, code: "not_found",
				msg: fmt.Sprintf("sources[%d]: file not found", i)}
		}
		if meta.Size > MaxSourceBytes {
			return nil, 0, false, &userError{status: 413, code: "too_large",
				msg: fmt.Sprintf("sources[%d] exceeds the per-file size limit (%d MiB)", i, MaxSourceBytes/(1024*1024))}
		}
		total += meta.Size
		if total > MaxTotalBytes {
			return nil, 0, false, &userError{status: 413, code: "too_large",
				msg: fmt.Sprintf("combined input size exceeds %d MiB", MaxTotalBytes/(1024*1024))}
		}
		nc := !isPDF(meta.Mime, meta.Name)
		if nc {
			if !docconvert.IsConvertible(meta.Mime, meta.Name) && !isImage(meta.Mime, meta.Name) {
				return nil, 0, false, &userError{status: 400, code: "unsupported_type",
					msg: fmt.Sprintf("sources[%d] (%s): cannot be merged — only PDF, Word/RTF/ODT, and images are supported",
						i, meta.Name)}
			}
			needsConvert = true
		}
		out = append(out, boundSource{
			MergeSource:  s,
			Mime:         meta.Mime,
			Name:         meta.Name,
			Size:         meta.Size,
			StorageKey:   meta.StorageKey,
			NeedsConvert: nc,
		})
	}
	return out, total, needsConvert, nil
}

func (h *Handler) loadFileMeta(ctx context.Context, orgID, fileID string) (*fileMeta, error) {
	m := &fileMeta{}
	err := h.DB.QueryRow(ctx,
		`SELECT name, mime, COALESCE(size, 0), storage_key
		   FROM files
		  WHERE id=$1 AND org_id=$2 AND trashed_at IS NULL`,
		fileID, orgID,
	).Scan(&m.Name, &m.Mime, &m.Size, &m.StorageKey)
	if err != nil {
		return nil, err
	}
	return m, nil
}

// assembleMerge fetches the bytes for each bound source (converting to
// PDF if needed), then runs pdfcpu's merge on the assembled stack.
// Returns the combined PDF and any soft warnings (e.g. "macros stripped"
// from a docconvert step).
func (h *Handler) assembleMerge(ctx context.Context, srcs []boundSource) ([]byte, []string, error) {
	tmp, err := os.MkdirTemp("", "pdfmerge-*")
	if err != nil {
		return nil, nil, fmt.Errorf("mktemp: %w", err)
	}
	defer os.RemoveAll(tmp)

	var warnings []string
	pdfPaths := make([]string, 0, len(srcs))

	for i, s := range srcs {
		var pdfBytes []byte
		switch {
		case len(s.cachedPDF) > 0:
			pdfBytes = s.cachedPDF
		case isPDF(s.Mime, s.Name):
			b, err := h.Storage.GetBytes(ctx, s.StorageKey)
			if err != nil {
				return nil, nil, fmt.Errorf("source %d: %w", i, err)
			}
			pdfBytes = b
		case isImage(s.Mime, s.Name):
			raw, err := h.Storage.GetBytes(ctx, s.StorageKey)
			if err != nil {
				return nil, nil, fmt.Errorf("source %d: %w", i, err)
			}
			pdfBytes, err = imageToPDF(raw, s.Name)
			if err != nil {
				return nil, nil, fmt.Errorf("source %d (image→pdf): %w", i, err)
			}
		default:
			// docconvert path
			raw, err := h.Storage.GetBytes(ctx, s.StorageKey)
			if err != nil {
				return nil, nil, fmt.Errorf("source %d: %w", i, err)
			}
			res, err := docconvert.Convert(ctx, raw, s.Name)
			if err != nil {
				return nil, nil, fmt.Errorf("source %d (convert): %w", i, err)
			}
			if res.Warning != "" {
				warnings = append(warnings, fmt.Sprintf("%s: %s", s.Name, res.Warning))
			}
			pdfBytes = res.PDF
		}

		// If the user picked a subset, trim the PDF to those pages
		// before merging. pdfcpu doesn't expose a per-input page-filter
		// in the merge API, so we materialise each subset as its own
		// temporary file.
		if pages := strings.TrimSpace(s.Pages); pages != "" && !isAllPages(pages) {
			trimmed, err := extractPages(pdfBytes, pages)
			if err != nil {
				return nil, nil, fmt.Errorf("source %d (extract %q): %w", i, pages, err)
			}
			pdfBytes = trimmed
		}

		path := filepath.Join(tmp, fmt.Sprintf("part-%04d.pdf", i))
		if err := os.WriteFile(path, pdfBytes, 0o600); err != nil {
			return nil, nil, fmt.Errorf("source %d (write tmp): %w", i, err)
		}
		pdfPaths = append(pdfPaths, path)
	}

	outPath := filepath.Join(tmp, "merged.pdf")
	// MergeCreateFile concatenates the inputs into a fresh PDF. The
	// nil config uses pdfcpu's "relaxed" defaults — fine for the
	// drive use case, where users care about page fidelity, not
	// strict-spec validation.
	if err := pdfcpuapi.MergeCreateFile(pdfPaths, outPath, false, nil); err != nil {
		return nil, nil, fmt.Errorf("pdfcpu merge: %w", err)
	}
	out, err := os.ReadFile(outPath)
	if err != nil {
		return nil, nil, err
	}
	return out, warnings, nil
}

// persistNewPDF inserts a new files row owned by the caller, uploads
// the bytes, and marks the row active. Mirrors the upload-flow used in
// internal/files (INSERT empty key → UPDATE storage_key → UPDATE
// status='active') so rows look identical in the DB whether created by
// merge or by ordinary upload.
func (h *Handler) persistNewPDF(ctx context.Context, c *auth.Claims, name string, folderArg any, data []byte) (string, error) {
	var id string
	if err := h.DB.QueryRow(ctx,
		`INSERT INTO files (org_id, owner_id, name, mime, storage_key, folder_id)
		 VALUES ($1, $2, $3, 'application/pdf', '', $4)
		 RETURNING id`,
		c.OrgID, c.UserID, name, folderArg,
	).Scan(&id); err != nil {
		return "", err
	}
	key := fmt.Sprintf("orgs/%s/files/%s/%s", c.OrgID, id, name)
	if _, err := h.DB.Exec(ctx, `UPDATE files SET storage_key=$1 WHERE id=$2`, key, id); err != nil {
		return "", err
	}
	if err := h.Storage.PutBytes(ctx, key, "application/pdf", data); err != nil {
		// Best-effort cleanup of the row so the user doesn't see a
		// zombie 0-byte file in their drive.
		_, _ = h.DB.Exec(ctx, `DELETE FROM files WHERE id=$1`, id)
		return "", err
	}
	if _, err := h.DB.Exec(ctx,
		`UPDATE files SET status='active', size=$1, updated_at=now() WHERE id=$2`,
		len(data), id,
	); err != nil {
		return "", err
	}
	return id, nil
}

// =====================================================================
//   Public inline assembly — used by the merge-recipes runner, which
//   has already produced/loaded each component's bytes in memory.
// =====================================================================

// InlineSource is one component of an in-memory merge. The runner
// (mergerecipes) produces these by either rendering a template (Bytes
// = generate output) or fetching a stored file (Bytes = storage read).
// We accept raw bytes plus a hint about the format so the same code
// path that handles user uploads (DOCX → PDF, image → PDF) keeps
// working for static-file components in a recipe.
type InlineSource struct {
	// Bytes is the source content. Required.
	Bytes []byte
	// Name is used for extension sniffing (image type, .docx, etc.) and
	// for error messages. Empty is allowed for PDF bytes.
	Name string
	// Mime is the canonical MIME type when known. Either Mime or Name's
	// extension is enough — both are checked.
	Mime string
	// Pages is the optional page subset, same grammar as MergeSource.Pages.
	Pages string
}

// AssembleInline stitches the given in-memory sources into a single
// PDF. Non-PDF sources go through docconvert (DOCX/RTF/ODT) or pdfcpu's
// image importer. Returns the merged PDF and any soft warnings (e.g.
// "macros stripped" from a Word doc).
//
// This is the entry point used by the merge-recipes Run handler: each
// component has its bytes already (template render or storage fetch),
// so we skip the per-source DB/permission preflight that the public
// /v1/files/merge endpoint runs.
func (h *Handler) AssembleInline(ctx context.Context, sources []InlineSource) ([]byte, []string, error) {
	if len(sources) == 0 {
		return nil, nil, fmt.Errorf("no sources to merge")
	}
	bound := make([]boundSource, 0, len(sources))
	for i, s := range sources {
		if len(s.Bytes) == 0 {
			return nil, nil, fmt.Errorf("source %d: empty bytes", i)
		}
		if s.Pages != "" {
			if err := validatePageRange(s.Pages); err != nil {
				return nil, nil, fmt.Errorf("source %d: %w", i, err)
			}
		}
		mime := s.Mime
		name := s.Name
		bs := boundSource{
			MergeSource: MergeSource{Pages: s.Pages},
			Mime:        mime,
			Name:        name,
			Size:        int64(len(s.Bytes)),
		}
		switch {
		case isPDF(mime, name):
			bs.cachedPDF = s.Bytes
		case isImage(mime, name):
			pdf, err := imageToPDF(s.Bytes, name)
			if err != nil {
				return nil, nil, fmt.Errorf("source %d (image→pdf): %w", i, err)
			}
			bs.cachedPDF = pdf
		case docconvert.IsConvertible(mime, name):
			res, err := docconvert.Convert(ctx, s.Bytes, name)
			if err != nil {
				return nil, nil, fmt.Errorf("source %d (convert): %w", i, err)
			}
			bs.cachedPDF = res.PDF
		default:
			return nil, nil, fmt.Errorf("source %d (%s): unsupported type for merge", i, name)
		}
		bound = append(bound, bs)
	}
	return h.assembleMerge(ctx, bound)
}

// =====================================================================
//   Worker entry point — invoked by the asynq handler on TaskMergePDF.
// =====================================================================

// JobInput is the worker-side view of a merge request. The cmd/worker
// process already has DB + Storage wiring; we keep this method on the
// same Handler that serves the HTTP routes so both surfaces share the
// preflight + assemble + persist code path.
type JobInput struct {
	JobID    string
	OrgID    string
	UserID   string
	Name     string
	FolderID string
	Sources  []MergeSource
}

// RunQueuedMerge is the worker handler body for a single merge job.
// Returns nil on success (after marking the row 'done' with the new
// file_id), or an error after marking the row 'failed' with a
// user-readable message. asynq's retry policy decides whether to
// re-deliver; we mark 'failed' eagerly so the UI sees a terminal
// state even if the next retry succeeds (it'll flip back to 'done').
func (h *Handler) RunQueuedMerge(ctx context.Context, in JobInput) error {
	if _, err := h.DB.Exec(ctx,
		`UPDATE merge_jobs SET status='running', updated_at=now()
		   WHERE id=$1 AND status IN ('queued', 'running', 'failed')`,
		in.JobID,
	); err != nil {
		return err
	}

	// Synthetic claims so the same preflight (which calls
	// sharing.CanAccessFile) works in the worker. The user/org came
	// from the original HTTP request; the worker re-validates rather
	// than trusting the payload blindly so a revoked share or trashed
	// file is caught before bytes flow.
	claims := &auth.Claims{UserID: in.UserID, OrgID: in.OrgID}

	srcs, _, _, perr := h.preflightSources(ctx, claims, in.Sources)
	if perr != nil {
		_ = h.markJobFailed(ctx, in.JobID, perr.Error())
		return perr
	}

	pdfBytes, _, err := h.assembleMerge(ctx, srcs)
	if err != nil {
		_ = h.markJobFailed(ctx, in.JobID, err.Error())
		return err
	}

	name := normaliseOutputName(in.Name, "Merged document.pdf")
	fileID, err := h.persistNewPDF(ctx, claims, name, folderArgOf(in.FolderID), pdfBytes)
	if err != nil {
		_ = h.markJobFailed(ctx, in.JobID, err.Error())
		return err
	}

	if _, err := h.DB.Exec(ctx,
		`UPDATE merge_jobs SET status='done', file_id=$1, error=NULL, updated_at=now()
		   WHERE id=$2`,
		fileID, in.JobID,
	); err != nil {
		return err
	}
	return nil
}

func (h *Handler) markJobFailed(ctx context.Context, jobID, msg string) error {
	// Truncate ridiculous messages so a stack-trace from soffice
	// doesn't bloat the row beyond what jsonb is happy with.
	if len(msg) > 4000 {
		msg = msg[:4000]
	}
	_, err := h.DB.Exec(ctx,
		`UPDATE merge_jobs SET status='failed', error=$1, updated_at=now() WHERE id=$2`,
		msg, jobID,
	)
	return err
}

// =====================================================================
//   Async kickoff
// =====================================================================

type asyncMerge struct {
	Name     string        `json:"name"`
	FolderID string        `json:"folderId,omitempty"`
	Sources  []MergeSource `json:"sources"`
}

func (h *Handler) kickoffAsyncMerge(ctx context.Context, c *auth.Claims, m asyncMerge) (string, error) {
	// Job tracking row — same shape as generation_jobs would be a
	// stretch; we use a lightweight scheme on `merge_jobs` (created in
	// the migration that ships with this feature). The handler returns
	// the job ID; the worker updates status/result.
	var jobID string
	err := h.DB.QueryRow(ctx,
		`INSERT INTO merge_jobs (org_id, user_id, status, payload)
		 VALUES ($1, $2, 'queued', $3::jsonb)
		 RETURNING id`,
		c.OrgID, c.UserID, mustJSON(m),
	).Scan(&jobID)
	if err != nil {
		return "", err
	}

	task, err := queue.NewMergePDF(queue.MergePDFPayload{
		JobID:    jobID,
		OrgID:    c.OrgID,
		UserID:   c.UserID,
		Name:     m.Name,
		FolderID: m.FolderID,
		Sources:  toQueueSources(m.Sources),
	})
	if err != nil {
		return "", err
	}
	if _, err := h.Queue.EnqueueContext(ctx, task); err != nil {
		return "", err
	}
	return jobID, nil
}

func toQueueSources(s []MergeSource) []queue.MergePDFSource {
	out := make([]queue.MergePDFSource, len(s))
	for i, x := range s {
		out[i] = queue.MergePDFSource{FileID: x.FileID, Pages: x.Pages}
	}
	return out
}

// =====================================================================
//   pdfcpu wrappers (sync, in-memory)
// =====================================================================

func pageCount(pdf []byte) (int, error) {
	n, err := pdfcpuapi.PageCount(bytes.NewReader(pdf), nil)
	if err != nil {
		return 0, err
	}
	return n, nil
}

func extractPages(pdf []byte, pages string) ([]byte, error) {
	tmp, err := os.MkdirTemp("", "pdfmerge-extract-*")
	if err != nil {
		return nil, err
	}
	defer os.RemoveAll(tmp)

	in := filepath.Join(tmp, "in.pdf")
	if err := os.WriteFile(in, pdf, 0o600); err != nil {
		return nil, err
	}
	out := filepath.Join(tmp, "out.pdf")
	selected, err := splitPageRange(pages)
	if err != nil {
		return nil, err
	}
	if err := pdfcpuapi.TrimFile(in, out, selected, nil); err != nil {
		return nil, fmt.Errorf("pdfcpu trim: %w", err)
	}
	return os.ReadFile(out)
}

func removePages(pdf []byte, pages string) ([]byte, error) {
	tmp, err := os.MkdirTemp("", "pdfmerge-remove-*")
	if err != nil {
		return nil, err
	}
	defer os.RemoveAll(tmp)

	in := filepath.Join(tmp, "in.pdf")
	if err := os.WriteFile(in, pdf, 0o600); err != nil {
		return nil, err
	}
	out := filepath.Join(tmp, "out.pdf")
	selected, err := splitPageRange(pages)
	if err != nil {
		return nil, err
	}
	if err := pdfcpuapi.RemovePagesFile(in, out, selected, nil); err != nil {
		return nil, fmt.Errorf("pdfcpu remove: %w", err)
	}
	return os.ReadFile(out)
}

func rotatePDF(pdf []byte, pages string, degrees int) ([]byte, error) {
	tmp, err := os.MkdirTemp("", "pdfmerge-rotate-*")
	if err != nil {
		return nil, err
	}
	defer os.RemoveAll(tmp)

	in := filepath.Join(tmp, "in.pdf")
	if err := os.WriteFile(in, pdf, 0o600); err != nil {
		return nil, err
	}
	out := filepath.Join(tmp, "out.pdf")
	selected, err := splitPageRange(pages)
	if err != nil {
		return nil, err
	}
	if err := pdfcpuapi.RotateFile(in, out, degrees, selected, nil); err != nil {
		return nil, fmt.Errorf("pdfcpu rotate: %w", err)
	}
	return os.ReadFile(out)
}

// imageToPDF wraps a raster image (jpg/png/etc.) in a one-page PDF.
// pdfcpu's ImportImagesFile expects file paths so we round-trip through
// a tempdir.
func imageToPDF(img []byte, name string) ([]byte, error) {
	tmp, err := os.MkdirTemp("", "pdfmerge-img-*")
	if err != nil {
		return nil, err
	}
	defer os.RemoveAll(tmp)

	// Preserve the original extension so pdfcpu picks the right decoder.
	ext := strings.ToLower(filepath.Ext(name))
	if ext == "" {
		ext = ".jpg"
	}
	in := filepath.Join(tmp, "in"+ext)
	if err := os.WriteFile(in, img, 0o600); err != nil {
		return nil, err
	}
	out := filepath.Join(tmp, "out.pdf")
	imp := pdfcpulib.DefaultImportConfig()
	if err := pdfcpuapi.ImportImagesFile([]string{in}, out, imp, nil); err != nil {
		return nil, fmt.Errorf("pdfcpu import image: %w", err)
	}
	return os.ReadFile(out)
}

// splitPageRange converts a "1-3,5,7-9" string (or "all", "odd",
// "even") into the slice pdfcpu's API expects. We accept the same
// grammar pdfcpu does — including "even" / "odd" — but normalise
// upstream.
func splitPageRange(s string) ([]string, error) {
	s = strings.TrimSpace(s)
	if s == "" || isAllPages(s) {
		return nil, nil // nil = all pages, per pdfcpu convention
	}
	parts := strings.Split(s, ",")
	out := make([]string, 0, len(parts))
	for _, p := range parts {
		p = strings.TrimSpace(p)
		if p == "" {
			continue
		}
		out = append(out, p)
	}
	return out, nil
}

// =====================================================================
//   Validation / formatting helpers
// =====================================================================

var pageRangeRE = regexp.MustCompile(`^\s*\d+\s*(-\s*\d+\s*)?$`)

func validatePageRange(s string) error {
	s = strings.TrimSpace(s)
	if s == "" {
		return nil
	}
	low := strings.ToLower(s)
	if low == "all" || low == "even" || low == "odd" {
		return nil
	}
	for _, part := range strings.Split(s, ",") {
		part = strings.TrimSpace(part)
		if !pageRangeRE.MatchString(part) {
			return fmt.Errorf("page range %q is not understood; use forms like 'all', '1-3,5,7-9', 'odd', 'even'", s)
		}
		// If it's a range, the start must be <= end.
		if strings.Contains(part, "-") {
			ab := strings.SplitN(part, "-", 2)
			a, _ := strconv.Atoi(strings.TrimSpace(ab[0]))
			b, _ := strconv.Atoi(strings.TrimSpace(ab[1]))
			if a < 1 || b < a {
				return fmt.Errorf("page range %q: %d-%d is not a valid forward range", s, a, b)
			}
		} else {
			n, _ := strconv.Atoi(part)
			if n < 1 {
				return fmt.Errorf("page range %q: pages start at 1", s)
			}
		}
	}
	return nil
}

func isAllPages(s string) bool {
	return strings.EqualFold(strings.TrimSpace(s), "all")
}

// pageRangeStr formats a forward [a..b] range as "a-b" (or "a" for a
// single page). Used by Insert() to produce head / tail slices around
// the splice point. Returns "" if the range is empty.
func pageRangeStr(a, b int) string {
	if b < a {
		return ""
	}
	if a == b {
		return strconv.Itoa(a)
	}
	return fmt.Sprintf("%d-%d", a, b)
}

func isPDF(mime, name string) bool {
	if strings.EqualFold(mime, "application/pdf") {
		return true
	}
	return strings.EqualFold(filepath.Ext(name), ".pdf")
}

func isImage(mime, name string) bool {
	if strings.HasPrefix(strings.ToLower(mime), "image/") {
		return true
	}
	switch strings.ToLower(filepath.Ext(name)) {
	case ".jpg", ".jpeg", ".png", ".tif", ".tiff", ".gif", ".bmp", ".webp":
		return true
	}
	return false
}

func normaliseOutputName(name, fallback string) string {
	name = strings.TrimSpace(name)
	if name == "" {
		name = fallback
	}
	if !strings.HasSuffix(strings.ToLower(name), ".pdf") {
		name += ".pdf"
	}
	return name
}

func folderArgOf(id string) any {
	id = strings.TrimSpace(id)
	if id == "" {
		return nil
	}
	return id
}

func mustJSON(v any) []byte {
	b, _ := json.Marshal(v)
	return b
}

// =====================================================================
//   Error plumbing
// =====================================================================

type userError struct {
	status int
	code   string
	msg    string
}

func (e *userError) Error() string { return e.msg }

func writeErrFromPreflight(w http.ResponseWriter, err error) {
	if ue, ok := err.(*userError); ok {
		writeErr(w, ue.status, ue.code, ue.msg)
		return
	}
	writeErr(w, 500, "internal", err.Error())
}

func writeJSON(w http.ResponseWriter, code int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(code)
	_ = json.NewEncoder(w).Encode(v)
}

func writeErr(w http.ResponseWriter, code int, slug, msg string) {
	writeJSON(w, code, map[string]any{
		"error": map[string]any{"code": slug, "message": msg},
	})
}

// Pin time to silence "imported and not used" if we ever drop the
// timestamp helpers. Kept as a build-time anchor; cheap and harmless.
var _ = time.Now
