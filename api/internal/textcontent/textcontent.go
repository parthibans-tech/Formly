// Package textcontent serves the read/write endpoints behind the
// in-app code editor (CodeMirror). It deliberately handles only plain
// text — anything ONLYOFFICE claims (docx/xlsx/pptx/etc.) is rejected
// at this layer so the two editors never fight over the same file.
//
// Why a dedicated package and not just an extension of files.go
//
// The Files handler treats blobs as opaque — uploads, downloads,
// presigned URLs. The code editor needs raw bytes round-tripped through
// JSON-friendly endpoints with optimistic concurrency, UTF-8
// validation, and explicit size caps that the rest of the file API has
// no business enforcing on (say) a 200MB DOCX. Splitting the concern
// keeps both surfaces small.
//
// Trust model
//
//   - GET reads via CanAccessFile (read-or-better).
//   - PUT writes via CanEditFile (editor-or-better).
//   - PUT requires an If-Match header matching the row's current
//     updated_at (RFC 3339 nanosecond precision). Conflicts return 412
//     so the browser can re-fetch and merge instead of clobbering a
//     concurrent edit.
//   - Editable cap is 5 MiB. Reads up to 50 MiB; beyond that the GET
//     returns 413 and the browser can fall back to "Download".
package textcontent

import (
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"path/filepath"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/docforge/api/internal/auth"
	"github.com/docforge/api/internal/onlyoffice"
	"github.com/docforge/api/internal/sharing"
	"github.com/docforge/api/internal/storage"
	"github.com/go-chi/chi/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

const (
	// MaxEditableBytes is the hard cap for PUTs. Anything larger gets
	// 413 and stays read-only in the editor. Tuned to be generous for
	// hand-edited code (5 MiB ≈ 50k lines of typical source) while
	// keeping the round-trip cheap.
	MaxEditableBytes = 5 * 1024 * 1024
	// MaxReadableBytes guards GET. Beyond this the editor falls back
	// to the download flow — Monaco/CodeMirror handle 50 MiB but the
	// network round-trip and JSON encoding stop being free.
	MaxReadableBytes = 50 * 1024 * 1024
)

type Handler struct {
	DB      *pgxpool.Pool
	Storage *storage.Client
}

func New(db *pgxpool.Pool, store *storage.Client) *Handler {
	return &Handler{DB: db, Storage: store}
}

// IsCodeEditable mirrors the frontend canOpenInCodeEditor predicate.
// We accept anything with a known code/text extension, anything whose
// MIME starts with text/, and reject anything ONLYOFFICE owns so the
// two editors never overlap.
func IsCodeEditable(mime, name string) bool {
	if onlyoffice.IsEditableByOnlyOffice(mime, name) {
		return false
	}
	ext := strings.ToLower(strings.TrimPrefix(filepath.Ext(name), "."))
	if codeExts[ext] {
		return true
	}
	// Some uploads land with no extension (Dockerfile, Makefile,
	// .gitignore). Match by basename for the well-known ones.
	base := strings.ToLower(filepath.Base(name))
	if codeBasenames[base] {
		return true
	}
	m := strings.ToLower(mime)
	if strings.HasPrefix(m, "text/") {
		return true
	}
	switch m {
	case "application/json", "application/xml", "application/javascript",
		"application/typescript", "application/x-sh", "application/x-yaml",
		"application/toml", "application/x-shellscript":
		return true
	}
	return false
}

// codeExts is intentionally broad — the editor degrades gracefully on
// unknown languages (plain text + line numbers), so we'd rather show
// the menu entry than hide it. Markdown sits outside this set because
// it has its own designer.
var codeExts = map[string]bool{
	"js": true, "jsx": true, "ts": true, "tsx": true, "mjs": true, "cjs": true,
	"py": true, "pyi": true, "rb": true, "go": true, "rs": true, "java": true,
	"kt": true, "kts": true, "swift": true, "c": true, "h": true, "cc": true,
	"cpp": true, "cxx": true, "hpp": true, "hh": true, "m": true, "mm": true,
	"cs": true, "php": true, "lua": true, "pl": true, "r": true, "scala": true,
	"clj": true, "ex": true, "exs": true, "erl": true, "hs": true, "ml": true,
	"dart": true, "groovy": true, "vb": true, "f": true, "f90": true,
	"sql": true, "graphql": true, "gql": true, "proto": true,
	"css": true, "scss": true, "sass": true, "less": true,
	"html": true, "htm": true, "xml": true, "svg": true, "vue": true, "svelte": true, "astro": true,
	"json": true, "json5": true, "jsonc": true, "yaml": true, "yml": true,
	"toml": true, "ini": true, "cfg": true, "conf": true, "env": true, "properties": true,
	"sh": true, "bash": true, "zsh": true, "fish": true, "ps1": true, "bat": true, "cmd": true,
	"tf": true, "tfvars": true, "hcl": true, "nix": true,
	"makefile": true, "mk": true,
	"dockerfile": true, "containerfile": true,
	"log": true, "txt": true, // .txt is an editable plain-text file too
	"gitignore": true, "gitattributes": true, "editorconfig": true,
	"lock": true, // package-lock-style files
}

var codeBasenames = map[string]bool{
	"dockerfile":      true,
	"containerfile":   true,
	"makefile":        true,
	"gnumakefile":     true,
	".gitignore":      true,
	".gitattributes":  true,
	".dockerignore":   true,
	".editorconfig":   true,
	".env":            true,
	".npmrc":          true,
	".prettierrc":     true,
	".eslintrc":       true,
	".eslintignore":   true,
	".browserslistrc": true,
	"procfile":        true,
	"rakefile":        true,
	"gemfile":         true,
	"podfile":         true,
}

// Get is GET /v1/files/{id}/content.
//
// Returns the raw text with X-Editable / X-Updated-At headers so the
// browser can decide whether to disable the save controls without a
// second round-trip.
func (h *Handler) Get(w http.ResponseWriter, r *http.Request) {
	c, _ := r.Context().Value(auth.UserCtxKey).(*auth.Claims)
	if c == nil {
		writeErr(w, 401, "unauthorized", "missing claims")
		return
	}
	id := chi.URLParam(r, "id")

	canRead, err := sharing.CanAccessFile(r.Context(), h.DB, c, id)
	if err != nil {
		writeErr(w, 500, "db_error", err.Error())
		return
	}
	if !canRead {
		writeErr(w, 404, "not_found", "file not found")
		return
	}
	canEdit, err := sharing.CanEditFile(r.Context(), h.DB, c, id)
	if err != nil {
		writeErr(w, 500, "db_error", err.Error())
		return
	}

	var (
		name      string
		mime      string
		size      int64
		key       string
		updatedAt time.Time
	)
	if err := h.DB.QueryRow(r.Context(),
		`SELECT name, mime, size, storage_key, updated_at
		   FROM files
		  WHERE id=$1 AND org_id=$2 AND trashed_at IS NULL`,
		id, c.OrgID,
	).Scan(&name, &mime, &size, &key, &updatedAt); err != nil {
		writeErr(w, 404, "not_found", "file not found")
		return
	}

	if !IsCodeEditable(mime, name) {
		writeErr(w, 400, "unsupported_type",
			"this file type is not editable in the code editor")
		return
	}
	if size > MaxReadableBytes {
		writeErr(w, 413, "too_large",
			fmt.Sprintf("file is %d bytes; the code editor caps reads at %d",
				size, MaxReadableBytes))
		return
	}

	data, err := h.Storage.GetBytes(r.Context(), key)
	if err != nil {
		writeErr(w, 502, "storage_error", err.Error())
		return
	}

	// Refuse non-UTF-8 blobs. Editing them as text would silently
	// corrupt the file on save (re-encoded to UTF-8 by the browser).
	// The download endpoint stays available for binary cases.
	if !utf8.Valid(data) {
		writeErr(w, 415, "binary_content",
			"file is not valid UTF-8 text — open via Download instead")
		return
	}

	editable := canEdit && int64(len(data)) <= MaxEditableBytes

	// Updated-at is the concurrency token: the browser echoes it back
	// in If-Match on PUT and we reject if it has moved on. RFC 3339
	// with nanosecond precision keeps quick successive saves
	// distinguishable.
	updated := updatedAt.UTC().Format(time.RFC3339Nano)

	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("X-Editable", boolStr(editable))
	w.Header().Set("X-Updated-At", updated)
	w.Header().Set("X-File-Name", name)
	w.Header().Set("X-File-Size", fmt.Sprintf("%d", len(data)))
	if mime != "" {
		w.Header().Set("X-File-Mime", mime)
	}
	_ = json.NewEncoder(w).Encode(map[string]any{
		"content":   string(data),
		"name":      name,
		"mime":      mime,
		"size":      len(data),
		"editable":  editable,
		"canEdit":   canEdit,
		"updatedAt": updated,
		"limits": map[string]any{
			"maxEditableBytes": MaxEditableBytes,
			"maxReadableBytes": MaxReadableBytes,
		},
	})
}

type putRequest struct {
	// Content is the new full text. We don't accept patches — round-tripping
	// the whole file at < 5 MiB is simpler than maintaining a CRDT.
	Content string `json:"content"`
	// IfMatch is the updated_at the browser believes is current. Pass
	// it via the If-Match header (preferred) or this field for clients
	// that struggle with custom headers; both are checked.
	IfMatch string `json:"ifMatch,omitempty"`
}

// Put is PUT /v1/files/{id}/content.
//
// Writes the supplied UTF-8 text back to storage. Optimistic
// concurrency: If-Match must equal the row's current updated_at, or we
// 412. Storage key stays the same so existing share/download links
// keep pointing at the latest version.
func (h *Handler) Put(w http.ResponseWriter, r *http.Request) {
	c, _ := r.Context().Value(auth.UserCtxKey).(*auth.Claims)
	if c == nil {
		writeErr(w, 401, "unauthorized", "missing claims")
		return
	}
	id := chi.URLParam(r, "id")

	canEdit, err := sharing.CanEditFile(r.Context(), h.DB, c, id)
	if err != nil {
		writeErr(w, 500, "db_error", err.Error())
		return
	}
	if !canEdit {
		// Don't leak existence vs permission — if they can't read it
		// they got 404 from GET; if they can read but not write we
		// return 403 here to surface the precise reason (the editor
		// renders a "view-only" banner using the canEdit flag).
		canRead, _ := sharing.CanAccessFile(r.Context(), h.DB, c, id)
		if !canRead {
			writeErr(w, 404, "not_found", "file not found")
			return
		}
		writeErr(w, 403, "forbidden", "you don't have edit access to this file")
		return
	}

	body, err := io.ReadAll(io.LimitReader(r.Body, MaxEditableBytes+1))
	if err != nil {
		writeErr(w, 400, "bad_request", err.Error())
		return
	}
	defer r.Body.Close()

	var req putRequest
	if err := json.Unmarshal(body, &req); err != nil {
		writeErr(w, 400, "bad_request", err.Error())
		return
	}

	if len(req.Content) > MaxEditableBytes {
		writeErr(w, 413, "too_large",
			fmt.Sprintf("content is %d bytes; cap is %d",
				len(req.Content), MaxEditableBytes))
		return
	}
	if !utf8.ValidString(req.Content) {
		writeErr(w, 400, "invalid_utf8", "content is not valid UTF-8")
		return
	}

	ifMatch := strings.TrimSpace(r.Header.Get("If-Match"))
	if ifMatch == "" {
		ifMatch = strings.TrimSpace(req.IfMatch)
	}
	if ifMatch == "" {
		writeErr(w, 428, "precondition_required",
			"If-Match header (or ifMatch field) is required for PUT")
		return
	}

	var (
		name      string
		mime      string
		key       string
		updatedAt time.Time
	)
	if err := h.DB.QueryRow(r.Context(),
		`SELECT name, mime, storage_key, updated_at
		   FROM files
		  WHERE id=$1 AND org_id=$2 AND trashed_at IS NULL`,
		id, c.OrgID,
	).Scan(&name, &mime, &key, &updatedAt); err != nil {
		writeErr(w, 404, "not_found", "file not found")
		return
	}
	if !IsCodeEditable(mime, name) {
		writeErr(w, 400, "unsupported_type",
			"this file type is not editable in the code editor")
		return
	}

	current := updatedAt.UTC().Format(time.RFC3339Nano)
	if !timesEqual(current, ifMatch) {
		writeErr(w, 412, "conflict",
			"file has changed since you opened it; reload to merge")
		return
	}

	data := []byte(req.Content)
	if err := h.Storage.PutBytes(r.Context(), key, mime, data); err != nil {
		writeErr(w, 502, "storage_error", err.Error())
		return
	}

	var newUpdatedAt time.Time
	if err := h.DB.QueryRow(r.Context(),
		`UPDATE files
		    SET size=$1, updated_at=now()
		  WHERE id=$2
		  RETURNING updated_at`,
		len(data), id,
	).Scan(&newUpdatedAt); err != nil {
		// Row gone between our SELECT and UPDATE — treat as 404 since
		// the alternative (storage write succeeded but row vanished) is
		// only reachable via a race with delete.
		writeErr(w, 404, "not_found", "file not found")
		return
	}

	updated := newUpdatedAt.UTC().Format(time.RFC3339Nano)
	w.Header().Set("X-Updated-At", updated)
	writeJSON(w, 200, map[string]any{
		"size":      len(data),
		"updatedAt": updated,
	})
}

// timesEqual compares two RFC3339Nano strings tolerantly. Different
// JSON encoders trim trailing zeros differently, so we re-parse before
// comparing instead of relying on string equality.
func timesEqual(a, b string) bool {
	if a == b {
		return true
	}
	ta, ea := time.Parse(time.RFC3339Nano, a)
	tb, eb := time.Parse(time.RFC3339Nano, b)
	if ea != nil || eb != nil {
		return false
	}
	return ta.Equal(tb)
}

func boolStr(b bool) string {
	if b {
		return "true"
	}
	return "false"
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

