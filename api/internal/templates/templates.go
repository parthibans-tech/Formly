package templates

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"path/filepath"
	"strings"
	"time"

	"github.com/docforge/api/internal/auth"
	"github.com/docforge/api/internal/batchdata"
	"github.com/docforge/api/internal/compute"
	"github.com/docforge/api/internal/generate"
	"github.com/docforge/api/internal/generate/acroform"
	gdoc "github.com/docforge/api/internal/generate/doc"
	ghtml "github.com/docforge/api/internal/generate/html"
	gmarkdown "github.com/docforge/api/internal/generate/markdown"
	gstatic "github.com/docforge/api/internal/generate/static"
	"github.com/docforge/api/internal/i18n"
	"github.com/docforge/api/internal/layout"
	"github.com/go-pdf/fpdf"
	"github.com/docforge/api/internal/jobs"
	"github.com/docforge/api/internal/queue"
	"github.com/docforge/api/internal/sharing"
	"github.com/docforge/api/internal/storage"
	"github.com/docforge/api/internal/uploadpolicy"
	"github.com/go-chi/chi/v5"
	"github.com/hibiken/asynq"
	"github.com/jackc/pgx/v5/pgxpool"
)

type Handler struct {
	DB      *pgxpool.Pool
	Storage *storage.Client
	Runner  *generate.Runner
	Queue   *asynq.Client // nil if async is disabled
	// Policy resolves the org's effective upload-policy. Wired from
	// cmd/api so PreviewURL can echo the configured iframe-sandbox
	// token to the frontend (which sets it on `<iframe sandbox="...">`
	// before fetching the preview). Optional — nil falls back to the
	// package-default sandbox value, keeping existing tests/builds
	// that don't configure policy from breaking.
	Policy *uploadpolicy.Service
}

func New(db *pgxpool.Pool, s *storage.Client) *Handler {
	return &Handler{
		DB:      db,
		Storage: s,
		Runner:  &generate.Runner{DB: db, Storage: s},
	}
}

// DetectAndCreate is called after a file finishes uploading.
// PDFs with AcroForm fields → mode=acroform with seeded template_fields.
// PDFs without form fields → mode=static (widgets added later via designer).
// HTML files → mode=html with a config seeded from extracted placeholders.
// Markdown files → mode=markdown with extracted placeholders.
// Images (PNG/JPEG/WebP/GIF/BMP/TIFF) → mode=image so the file opens in
// the image designer (crop / rotate / flip / resize / quality / upscale).
// Anything else → no template.
func (h *Handler) DetectAndCreate(ctx context.Context, fileID, orgID, name, mime, storageKey string) (string, error) {
	// Auto-suffix the template name if another active template in this org
	// already owns it — we never reject an upload over a name collision,
	// the user can rename afterwards. The underlying file keeps its
	// original filename (files.name is independent of templates.name).
	resolved, err := h.resolveUniqueTemplateName(ctx, orgID, name)
	if err != nil {
		return "", err
	}
	switch {
	case isPDF(mime, name):
		return h.detectPDF(ctx, fileID, orgID, resolved, storageKey)
	case isMarkdown(mime, name):
		return h.detectMarkdown(ctx, fileID, orgID, resolved, storageKey)
	case isHTML(mime, name):
		return h.detectHTML(ctx, fileID, orgID, resolved, storageKey)
	case isImage(mime, name):
		return h.detectImage(ctx, fileID, orgID, resolved, storageKey, mime)
	}
	return "", nil
}

// isImage recognises the common raster formats the image designer can
// decode + encode. SVG is intentionally excluded — it's vector and
// has no raster ops (crop/rotate/flip), so it belongs elsewhere.
func isImage(mime, name string) bool {
	m := strings.ToLower(mime)
	if strings.HasPrefix(m, "image/") {
		// Guard against image/svg+xml — vector, no raster pipeline.
		if strings.Contains(m, "svg") {
			return false
		}
		return true
	}
	ext := strings.ToLower(filepath.Ext(name))
	switch ext {
	case ".png", ".jpg", ".jpeg", ".webp", ".gif", ".bmp", ".tif", ".tiff":
		return true
	}
	return false
}

// detectImage seeds a mode=image template pointing at the uploaded raster.
// Unlike the other modes there are no placeholders / fields to extract —
// the whole editing surface is the image bytes themselves. We still stash
// the source mime in config_json so the designer knows whether to default
// the export format (e.g. keep PNG vs re-encode as JPEG for quality slider).
func (h *Handler) detectImage(ctx context.Context, fileID, orgID, name, storageKey, mime string) (string, error) {
	cfg := map[string]interface{}{
		"sourceMime":       mime,
		"sourceStorageKey": storageKey,
	}
	cfgBytes, _ := json.Marshal(cfg)

	tx, err := h.DB.Begin(ctx)
	if err != nil {
		return "", err
	}
	defer tx.Rollback(ctx)

	var tplID string
	if err := tx.QueryRow(ctx,
		`INSERT INTO templates (org_id, file_id, mode, name, config_json) VALUES ($1,$2,'image',$3,$4) RETURNING id`,
		orgID, fileID, name, cfgBytes,
	).Scan(&tplID); err != nil {
		return "", err
	}
	if _, err := tx.Exec(ctx, `UPDATE files SET template_id=$1 WHERE id=$2`, tplID, fileID); err != nil {
		return "", err
	}
	if err := tx.Commit(ctx); err != nil {
		return "", err
	}
	return tplID, nil
}

func (h *Handler) detectPDF(ctx context.Context, fileID, orgID, name, storageKey string) (string, error) {
	data, err := h.Storage.GetBytes(ctx, storageKey)
	if err != nil {
		return "", err
	}
	fields, _ := acroform.Extract(data)
	mode := "acroform"
	if len(fields) == 0 {
		mode = "static"
	}

	tx, err := h.DB.Begin(ctx)
	if err != nil {
		return "", err
	}
	defer tx.Rollback(ctx)

	var tplID string
	if err := tx.QueryRow(ctx,
		`INSERT INTO templates (org_id, file_id, mode, name) VALUES ($1,$2,$3,$4) RETURNING id`,
		orgID, fileID, mode, name,
	).Scan(&tplID); err != nil {
		return "", err
	}

	for _, f := range fields {
		opts, _ := json.Marshal(f.Options)
		if _, err := tx.Exec(ctx,
			`INSERT INTO template_fields (template_id, name, type, page, options) VALUES ($1,$2,$3,$4,$5)`,
			tplID, f.Name, f.Type, f.Page, opts,
		); err != nil {
			return "", err
		}
	}

	if _, err := tx.Exec(ctx, `UPDATE files SET template_id=$1 WHERE id=$2`, tplID, fileID); err != nil {
		return "", err
	}
	if err := tx.Commit(ctx); err != nil {
		return "", err
	}
	return tplID, nil
}

func (h *Handler) detectHTML(ctx context.Context, fileID, orgID, name, storageKey string) (string, error) {
	data, err := h.Storage.GetBytes(ctx, storageKey)
	if err != nil {
		return "", err
	}
	placeholders := ghtml.ExtractPlaceholders(string(data))

	cfg := map[string]interface{}{"placeholders": placeholders}
	cfgBytes, _ := json.Marshal(cfg)

	tx, err := h.DB.Begin(ctx)
	if err != nil {
		return "", err
	}
	defer tx.Rollback(ctx)

	var tplID string
	if err := tx.QueryRow(ctx,
		`INSERT INTO templates (org_id, file_id, mode, name, config_json) VALUES ($1,$2,'html',$3,$4) RETURNING id`,
		orgID, fileID, name, cfgBytes,
	).Scan(&tplID); err != nil {
		return "", err
	}
	if _, err := tx.Exec(ctx, `UPDATE files SET template_id=$1 WHERE id=$2`, tplID, fileID); err != nil {
		return "", err
	}
	if err := tx.Commit(ctx); err != nil {
		return "", err
	}
	return tplID, nil
}

func isHTML(mime, name string) bool {
	if strings.Contains(strings.ToLower(mime), "html") {
		return true
	}
	ext := strings.ToLower(filepath.Ext(name))
	return ext == ".html" || ext == ".htm" || ext == ".hbs" || ext == ".mustache"
}

func isMarkdown(mime, name string) bool {
	m := strings.ToLower(mime)
	if strings.Contains(m, "markdown") || m == "text/x-markdown" {
		return true
	}
	ext := strings.ToLower(filepath.Ext(name))
	switch ext {
	case ".md", ".markdown":
		return true
	}
	// Plain text (.txt / text/plain) intentionally falls through. It
	// used to be treated as markdown here so the markdown designer
	// would pick it up; that conflated "edit text" with "edit a
	// templated markdown document" and surprised users who just wanted
	// to open a .txt. Plain text now routes to the ONLYOFFICE document
	// editor instead (see internal/onlyoffice.IsEditableByOnlyOffice).
	return false
}

// detectMarkdown behaves like detectHTML but stores mode="markdown".
func (h *Handler) detectMarkdown(ctx context.Context, fileID, orgID, name, storageKey string) (string, error) {
	data, err := h.Storage.GetBytes(ctx, storageKey)
	if err != nil {
		return "", err
	}
	placeholders := gmarkdown.ExtractPlaceholders(string(data))

	cfg := map[string]interface{}{"placeholders": placeholders}
	cfgBytes, _ := json.Marshal(cfg)

	tx, err := h.DB.Begin(ctx)
	if err != nil {
		return "", err
	}
	defer tx.Rollback(ctx)

	var tplID string
	if err := tx.QueryRow(ctx,
		`INSERT INTO templates (org_id, file_id, mode, name, config_json) VALUES ($1,$2,'markdown',$3,$4) RETURNING id`,
		orgID, fileID, name, cfgBytes,
	).Scan(&tplID); err != nil {
		return "", err
	}
	if _, err := tx.Exec(ctx, `UPDATE files SET template_id=$1 WHERE id=$2`, tplID, fileID); err != nil {
		return "", err
	}
	if err := tx.Commit(ctx); err != nil {
		return "", err
	}
	return tplID, nil
}

type fieldDTO struct {
	Name     string         `json:"name"`
	Type     string         `json:"type"`
	Page     int            `json:"page"`
	Options  []string       `json:"options,omitempty"`
	Rect     *acroform.Rect `json:"rect,omitempty"`
	PageSize *acroform.Size `json:"pageSize,omitempty"`
	Flags    int            `json:"flags,omitempty"`
	MaxLen   int            `json:"maxLen,omitempty"`
	Tooltip  string         `json:"tooltip,omitempty"`
	ReadOnly bool           `json:"readOnly,omitempty"`
	Required bool           `json:"required,omitempty"`
	Multiline bool          `json:"multiline,omitempty"`
	Password bool           `json:"password,omitempty"`
	Combo    bool           `json:"combo,omitempty"`
	MultiSelect bool        `json:"multiSelect,omitempty"`
}

type templateDTO struct {
	ID         string                 `json:"id"`
	FileID     string                 `json:"fileId"`
	Mode       string                 `json:"mode"`
	Name       string                 `json:"name"`
	Version    int                    `json:"version"`
	ConfigJSON map[string]interface{} `json:"config"`
	Fields     []fieldDTO             `json:"fields"`
	Widgets    []gstatic.Widget       `json:"widgets"`
	UpdatedAt  time.Time              `json:"updatedAt"`
	// CanEdit mirrors the server-side role check so the designer UI can
	// go read-only for viewers (banner + disabled Save/Rename) without
	// having to rely on 403s to surface the restriction. Matches the
	// `sharing.CanEditFile` rule: true for owners, editor-shared users,
	// and admins; false for viewer-shared users.
	CanEdit bool `json:"canEdit"`
}

func (h *Handler) Get(w http.ResponseWriter, r *http.Request) {
	c := r.Context().Value(auth.UserCtxKey).(*auth.Claims)
	id := chi.URLParam(r, "id")

	var dto templateDTO
	var cfgRaw []byte
	err := h.DB.QueryRow(r.Context(),
		`SELECT id, file_id, mode, name, version, config_json, updated_at
		 FROM templates WHERE id=$1 AND org_id=$2`, id, c.OrgID,
	).Scan(&dto.ID, &dto.FileID, &dto.Mode, &dto.Name, &dto.Version, &cfgRaw, &dto.UpdatedAt)
	if err != nil {
		writeErr(w, 404, "not_found", "template not found")
		return
	}
	_ = json.Unmarshal(cfgRaw, &dto.ConfigJSON)
	if dto.ConfigJSON == nil {
		dto.ConfigJSON = map[string]interface{}{}
	}

	// For AcroForm templates, re-extract fields directly from the PDF so we
	// return full geometry (rect, pageSize, flags, tooltip, maxLen) needed by
	// the visual designer overlay. Falls back to the DB row shape on error
	// or when re-extraction returns an empty slice (so field names always
	// appear for the binding UI, even if geometry recovery failed).
	if dto.Mode == "acroform" {
		if fields, rerr := reextractAcroformFields(r.Context(), h, id, c.OrgID); rerr == nil && len(fields) > 0 {
			dto.Fields = fields
		}
	}
	if dto.Fields == nil {
		rows, err := h.DB.Query(r.Context(),
			`SELECT name, type, COALESCE(page,0), COALESCE(options,'[]'::jsonb)
			 FROM template_fields WHERE template_id=$1 ORDER BY page, name`, id,
		)
		if err != nil {
			writeErr(w, 500, "db_error", err.Error())
			return
		}
		defer rows.Close()
		for rows.Next() {
			var f fieldDTO
			var optsRaw []byte
			if err := rows.Scan(&f.Name, &f.Type, &f.Page, &optsRaw); err != nil {
				writeErr(w, 500, "db_error", err.Error())
				return
			}
			_ = json.Unmarshal(optsRaw, &f.Options)
			dto.Fields = append(dto.Fields, f)
		}
	}
	if dto.Fields == nil {
		dto.Fields = []fieldDTO{}
	}

	widgets, err := loadWidgets(r.Context(), h.DB, id)
	if err != nil {
		writeErr(w, 500, "db_error", err.Error())
		return
	}
	dto.Widgets = widgets
	if dto.Widgets == nil {
		dto.Widgets = []gstatic.Widget{}
	}

	// Compute edit permission alongside read access so the client can
	// flip to read-only mode up-front instead of letting the user edit
	// locally and hitting a 403 on save. Fail the GET on ACL errors
	// rather than silently downgrading to viewer — a silent downgrade
	// looks identical to a correct viewer-share result, which means
	// owners would see their own files as read-only if the check ever
	// blew up, and we'd have no signal that anything was wrong.
	canEdit, err := sharing.CanEditFile(r.Context(), h.DB, c, dto.FileID)
	if err != nil {
		writeErr(w, 500, "db_error", err.Error())
		return
	}
	dto.CanEdit = canEdit

	writeJSON(w, 200, dto)
}

// Rename updates a template's display name, also syncing the underlying
// files.name so Drive listings don't drift. Route: PATCH /v1/templates/:id.
//
// Uniqueness is enforced per org, case-insensitive, against active
// (non-trashed) templates — a collision returns 409 `name_conflict` so
// the designer can surface a friendly inline error rather than silently
// picking a different name (which rename, unlike create, should never do).
//
// Both rows update in a single tx. files.name is rewritten to preserve the
// original extension the Drive UI uses for icon selection — e.g. renaming
// "Q1 invoice.pdf" to "Q2 summary" yields files.name = "Q2 summary.pdf".
func (h *Handler) Rename(w http.ResponseWriter, r *http.Request) {
	c := r.Context().Value(auth.UserCtxKey).(*auth.Claims)
	id := chi.URLParam(r, "id")

	var req struct {
		Name string `json:"name"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeErr(w, 400, "invalid_body", err.Error())
		return
	}
	trimmed := strings.TrimSpace(req.Name)
	if trimmed == "" {
		writeErr(w, 400, "invalid_name", "name cannot be empty")
		return
	}
	if len(trimmed) > 255 {
		writeErr(w, 400, "invalid_name", "name is too long (max 255 chars)")
		return
	}

	// Look up the existing row so we can (a) verify ownership and (b) keep
	// the current file extension when rewriting files.name.
	var fileID, currentName, currentFileName string
	if err := h.DB.QueryRow(r.Context(),
		`SELECT t.file_id, t.name, f.name
		   FROM templates t
		   JOIN files f ON f.id = t.file_id
		  WHERE t.id = $1 AND t.org_id = $2`,
		id, c.OrgID,
	).Scan(&fileID, &currentName, &currentFileName); err != nil {
		writeErr(w, 404, "not_found", "template not found")
		return
	}

	// Viewer-scoped shares can SELECT this row but must not be able to
	// mutate it. Block here before we start a write tx. 404 (not 403) so
	// we don't leak that the template exists to a non-viewer.
	if ok, err := sharing.CanEditFile(r.Context(), h.DB, c, fileID); err != nil {
		writeErr(w, 500, "db_error", err.Error())
		return
	} else if !ok {
		writeErr(w, 403, "forbidden", "you don't have edit access to this template")
		return
	}

	// Early out when the user submits the same name — avoids a spurious
	// uniqueness false-positive against the template's own row.
	if trimmed == currentName {
		writeJSON(w, 200, map[string]any{"id": id, "name": currentName, "fileName": currentFileName})
		return
	}

	if err := h.ensureUniqueTemplateName(r.Context(), c.OrgID, trimmed, id); err != nil {
		if errors.Is(err, errNameConflict) {
			writeErr(w, 409, "name_conflict", err.Error())
			return
		}
		writeErr(w, 500, "db_error", err.Error())
		return
	}

	// Keep the existing file extension on files.name so Drive's icon/mime
	// inference doesn't flip. If the current filename had no extension (rare)
	// we just use the trimmed name verbatim.
	ext := filepath.Ext(currentFileName)
	newFileName := trimmed
	if ext != "" && !strings.HasSuffix(strings.ToLower(trimmed), strings.ToLower(ext)) {
		newFileName = trimmed + ext
	}

	tx, err := h.DB.Begin(r.Context())
	if err != nil {
		writeErr(w, 500, "db_error", err.Error())
		return
	}
	defer tx.Rollback(r.Context())

	if _, err := tx.Exec(r.Context(),
		`UPDATE templates SET name=$1, updated_at=now() WHERE id=$2 AND org_id=$3`,
		trimmed, id, c.OrgID,
	); err != nil {
		writeErr(w, 500, "db_error", err.Error())
		return
	}
	if _, err := tx.Exec(r.Context(),
		`UPDATE files SET name=$1, updated_at=now() WHERE id=$2 AND org_id=$3`,
		newFileName, fileID, c.OrgID,
	); err != nil {
		writeErr(w, 500, "db_error", err.Error())
		return
	}
	if err := tx.Commit(r.Context()); err != nil {
		writeErr(w, 500, "db_error", err.Error())
		return
	}

	writeJSON(w, 200, map[string]any{
		"id":       id,
		"name":     trimmed,
		"fileName": newFileName,
	})
}

type configReq struct {
	Config          map[string]interface{} `json:"config"`
	ExpectedVersion *int                   `json:"expectedVersion,omitempty"`
}

func (h *Handler) UpdateConfig(w http.ResponseWriter, r *http.Request) {
	c := r.Context().Value(auth.UserCtxKey).(*auth.Claims)
	id := chi.URLParam(r, "id")
	var req configReq
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeErr(w, 400, "invalid_body", err.Error())
		return
	}
	cfgBytes, _ := json.Marshal(req.Config)

	ctx := r.Context()

	// Gate on edit permission before we even open the tx. Viewers can
	// GET the template (CanAccessFile permits it) but must not mutate
	// its config_json.
	var fileID string
	if err := h.DB.QueryRow(ctx,
		`SELECT file_id FROM templates WHERE id=$1 AND org_id=$2`,
		id, c.OrgID,
	).Scan(&fileID); err != nil {
		writeErr(w, 404, "not_found", "template not found")
		return
	}
	if ok, err := sharing.CanEditFile(ctx, h.DB, c, fileID); err != nil {
		writeErr(w, 500, "db_error", err.Error())
		return
	} else if !ok {
		writeErr(w, 403, "forbidden", "you don't have edit access to this template")
		return
	}

	tx, err := h.DB.Begin(ctx)
	if err != nil {
		writeErr(w, 500, "db_error", err.Error())
		return
	}
	defer tx.Rollback(ctx)

	// Optimistic-locking guard: if the client told us which version they saw,
	// bounce the write when someone else has saved since.
	if req.ExpectedVersion != nil {
		var currentVersion int
		if err := tx.QueryRow(ctx,
			`SELECT version FROM templates WHERE id=$1 AND org_id=$2 FOR UPDATE`,
			id, c.OrgID,
		).Scan(&currentVersion); err != nil {
			writeErr(w, 404, "not_found", "template not found")
			return
		}
		if currentVersion != *req.ExpectedVersion {
			writeJSON(w, 409, map[string]any{
				"error": map[string]any{
					"code":            "version_conflict",
					"message":         "another collaborator saved this template while you were editing",
					"currentVersion":  currentVersion,
					"expectedVersion": *req.ExpectedVersion,
				},
			})
			return
		}
	}

	var newVersion int
	err = tx.QueryRow(ctx,
		`UPDATE templates SET config_json=$1, version=version+1, updated_at=now()
		 WHERE id=$2 AND org_id=$3 RETURNING version`,
		cfgBytes, id, c.OrgID,
	).Scan(&newVersion)
	if err != nil {
		writeErr(w, 404, "not_found", "template not found")
		return
	}
	if _, err := tx.Exec(ctx,
		`INSERT INTO template_versions (template_id, version, config_snapshot, author_id)
		 VALUES ($1,$2,$3,$4)`, id, newVersion, cfgBytes, c.UserID,
	); err != nil {
		writeErr(w, 500, "db_error", err.Error())
		return
	}
	if err := tx.Commit(ctx); err != nil {
		writeErr(w, 500, "db_error", err.Error())
		return
	}
	writeJSON(w, 200, map[string]any{"version": newVersion})
}

type generateReq struct {
	Data map[string]interface{} `json:"data"`
	// Flatten is *bool so the request can distinguish "unset, fall
	// back to the template's output.flattenDefault" (omitted from JSON
	// → nil) from "explicitly false, don't flatten" (`"flatten": false`
	// → &false). Older clients that always sent `"flatten": false`
	// continue to work — the runner just sees an explicit false and
	// skips the template default.
	Flatten *bool `json:"flatten,omitempty"`
	Async   bool  `json:"async"`
	// Preview routes the request through Runner.RunPreview instead of
	// Runner.Run: the render is uploaded to a deterministic per-(user,
	// template) temp key and returned as an inline-disposition presigned
	// URL, with NO files row created. This is what the playground "Run"
	// button and the view-only template page use — they want to iframe
	// the output without polluting the user's Drive with a new file on
	// every click. The explicit "Save to Drive" action in the playground
	// omits this flag to take the persist path instead.
	Preview bool `json:"preview"`

	// OutputName overrides the filename the generated file is saved as.
	// Both the literal value and any {{key}} placeholders inside it are
	// supported — placeholders are resolved against `data` using the
	// same rules as the template's config_json.output.filenameTemplate.
	// When omitted, the template's config drives the name (or the
	// "<name>-filled-<timestamp>.pdf" fallback when neither is set).
	OutputName string `json:"outputName,omitempty"`

	// OutputPath overrides the logical sub-folder under the org's
	// outputs/ prefix. Same {{key}} substitution rules. Useful for
	// integrators routing per-tenant or per-customer output trees
	// without baking the path into the template config.
	OutputPath string `json:"outputPath,omitempty"`

	// SaveToDrive controls whether the rendered PDF lands in the user's
	// Drive (files table + storage). Pointer so we distinguish "unset"
	// (nil → defaults to true to preserve legacy integrator behaviour —
	// the API has always saved) from "explicit false" (skip persistence,
	// return only an ephemeral presigned download URL). The web designer
	// sends `false` for ad-hoc test renders so authors can iterate
	// without polluting their file list.
	SaveToDrive *bool `json:"saveToDrive,omitempty"`

	// Security overrides the template-level config_json.security block
	// for this single render. Mirrors the generate.SecurityOverride
	// shape. Omit to use the template's policy. Pass an empty
	// `{ "userPassword":"", "ownerPassword":"" }` to render unprotected
	// even when the template would normally encrypt.
	Security *generate.SecurityOverride `json:"security,omitempty"`
}

type generateResp struct {
	OutputFileID string `json:"outputFileId,omitempty"`
	OutputName   string `json:"outputName,omitempty"`
	DownloadURL  string `json:"downloadUrl,omitempty"`
	Bytes        int    `json:"bytes,omitempty"`
	JobID        string `json:"jobId,omitempty"`
	Status       string `json:"status,omitempty"`
}

func (h *Handler) Generate(w http.ResponseWriter, r *http.Request) {
	c := r.Context().Value(auth.UserCtxKey).(*auth.Claims)
	id := chi.URLParam(r, "id")

	var req generateReq
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeErr(w, 400, "invalid_body", err.Error())
		return
	}
	if req.Data == nil {
		req.Data = map[string]interface{}{}
	}

	if !h.ownsTemplate(r.Context(), id, c.OrgID) {
		writeErr(w, 404, "not_found", "template not found")
		return
	}

	// Preview path: render-only, no Drive pollution. Uploads the bytes
	// to a per-user-per-template temp key (overwrites on each call so
	// nothing piles up), returns an inline-disposition presigned URL so
	// the browser renders in an iframe instead of downloading. Async
	// mode is irrelevant for previews — they're always sync.
	if req.Preview {
		res, err := h.Runner.RunPreview(r.Context(), c.OrgID, c.UserID, id, req.Data, req.Flatten)
		if err != nil {
			var fe *acroform.FillErrors
			if errors.As(err, &fe) && fe != nil && len(fe.Errors) > 0 {
				writeValidationErr(w, fe.Errors)
				return
			}
			writeErr(w, 400, "fill_failed", err.Error())
			return
		}
		writeJSON(w, 200, generateResp{DownloadURL: res.URL, Bytes: res.Bytes})
		return
	}

	if req.Async {
		if h.Queue == nil {
			writeErr(w, 503, "queue_unavailable", "async dispatch disabled (no queue client)")
			return
		}
		// Ephemeral + async is a paradox: ephemeral means "don't persist
		// — return a 10-minute presigned URL", but async means "come
		// back later via job polling for the result". The job record
		// has no place to stash the ephemeral URL today (would need a
		// schema column), so reject the combo with a clear hint instead
		// of silently saving to Drive (the legacy bug) or silently
		// dropping the output. Sync renders cover the use case.
		if req.SaveToDrive != nil && !*req.SaveToDrive {
			writeErr(w, 400, "incompatible_options",
				"saveToDrive=false is only supported for sync renders (drop async=true to use ephemeral output)")
			return
		}
		jobID, err := jobs.Create(r.Context(), h.DB, c.OrgID, c.UserID, id, "single", 1)
		if err != nil {
			writeErr(w, 500, "db_error", err.Error())
			return
		}
		// Re-marshal the security override so it rides along inside the
		// queue payload as raw JSON. Avoids leaking the generate package
		// type through queue's API surface; the worker decodes back into
		// generate.SecurityOverride before calling RunOptions.Security.
		var secRaw json.RawMessage
		if req.Security != nil {
			b, mErr := json.Marshal(req.Security)
			if mErr == nil {
				secRaw = b
			}
		}
		task, err := queue.NewGenerateOne(queue.GenerateOnePayload{
			JobID: jobID, OrgID: c.OrgID, UserID: c.UserID, TemplateID: id,
			Data: req.Data, Flatten: req.Flatten,
			OutputName: req.OutputName, OutputPath: req.OutputPath,
			// Without these, async renders ignored the dialog's
			// "Save to Drive" toggle and the per-call password fields —
			// every async PDF unconditionally landed in Drive in cleartext.
			SaveToDrive: req.SaveToDrive,
			Security:    secRaw,
		})
		if err != nil {
			writeErr(w, 500, "enqueue", err.Error())
			return
		}
		if _, err := h.Queue.EnqueueContext(r.Context(), task); err != nil {
			writeErr(w, 500, "enqueue", err.Error())
			return
		}
		writeJSON(w, 202, generateResp{JobID: jobID, Status: "queued"})
		return
	}

	// Sync path: delegate to the shared Runner. Per-call output naming,
	// flatten, security, and persist toggle ride along via RunWithOpts.
	res, err := h.Runner.RunWithOpts(r.Context(), c.OrgID, c.UserID, id, req.Data, &generate.RunOptions{
		OutputName: req.OutputName,
		OutputPath: req.OutputPath,
		Flatten:    req.Flatten,
		Persist:    req.SaveToDrive,
		Security:   req.Security,
	})
	if err != nil {
		// Validation failures are a 422 with a structured `fields` list so
		// the client can render inline per-field messages rather than
		// trying to parse a concatenated string. Everything else is a 400
		// (bad input) — preserving the legacy shape for non-validation
		// failures like PDF read errors.
		var fe *acroform.FillErrors
		if errors.As(err, &fe) && fe != nil && len(fe.Errors) > 0 {
			writeValidationErr(w, fe.Errors)
			return
		}
		writeErr(w, 400, "fill_failed", err.Error())
		return
	}
	// Ephemeral path: when SaveToDrive=false the runner already
	// uploaded to a temp blob and produced a presigned download URL —
	// no files row was created, so we forward that URL straight to the
	// client and OutputFileID is empty (the browser uses the URL alone
	// and shows no "open in Drive" affordance).
	if res.OutputFileID == "" {
		writeJSON(w, 200, generateResp{OutputName: res.OutputName, DownloadURL: res.DownloadURL, Bytes: res.Bytes})
		return
	}

	// Persisted path: re-presign for short-lived browser download. The
	// long-lived URL on res.DownloadURL goes to webhooks; the response
	// to a direct API call gets a shorter TTL since the client is sitting
	// right in front of the browser anyway.
	url, err := h.Storage.PresignGet(r.Context(), res.OutputKey, "application/pdf", res.OutputName, 10*time.Minute)
	if err != nil {
		writeErr(w, 500, "presign", err.Error())
		return
	}
	writeJSON(w, 200, generateResp{OutputFileID: res.OutputFileID, OutputName: res.OutputName, DownloadURL: url, Bytes: res.Bytes})
}

// Batch accepts a multipart upload (csv, xlsx, or tsv) and enqueues a batch
// job that produces a ZIP of generated PDFs. The form field can be either
// `file` (preferred) or `csv` (legacy) to stay backward-compatible with
// existing integrations.
func (h *Handler) Batch(w http.ResponseWriter, r *http.Request) {
	c := r.Context().Value(auth.UserCtxKey).(*auth.Claims)
	id := chi.URLParam(r, "id")
	if h.Queue == nil {
		writeErr(w, 503, "queue_unavailable", "batch requires async queue")
		return
	}
	if !h.ownsTemplate(r.Context(), id, c.OrgID) {
		writeErr(w, 404, "not_found", "template not found")
		return
	}
	if err := r.ParseMultipartForm(64 << 20); err != nil {
		writeErr(w, 400, "invalid_body", err.Error())
		return
	}
	file, hdr, err := r.FormFile("file")
	if err != nil {
		// Fall back to the legacy field name.
		file, hdr, err = r.FormFile("csv")
		if err != nil {
			writeErr(w, 400, "missing_file", "expected form field 'file' (csv/xlsx/tsv)")
			return
		}
	}
	defer file.Close()
	body, err := io.ReadAll(file)
	if err != nil {
		writeErr(w, 400, "read_file", err.Error())
		return
	}
	kind := batchdata.Detect(hdr.Filename)

	jobID, err := jobs.Create(r.Context(), h.DB, c.OrgID, c.UserID, id, "batch", 0)
	if err != nil {
		writeErr(w, 500, "db_error", err.Error())
		return
	}
	// hdr.Filename is multipart-attacker-controllable; slugify before
	// it lands in an object key. The display form is irrelevant here —
	// nothing surfaces this path back to the user.
	storageKey := fmt.Sprintf("orgs/%s/batch-input/%s/%s",
		c.OrgID, jobID, uploadpolicy.SafeStorageSlug(hdr.Filename))
	contentType := mimeForKind(kind)
	if err := h.Storage.PutBytes(r.Context(), storageKey, contentType, body); err != nil {
		writeErr(w, 500, "storage", err.Error())
		return
	}
	baseName := strings.TrimSuffix(hdr.Filename, filepath.Ext(hdr.Filename))
	outName := baseName + "-batch-" + time.Now().Format("20060102-150405") + ".zip"

	task, err := queue.NewGenerateBatch(queue.GenerateBatchPayload{
		JobID: jobID, OrgID: c.OrgID, UserID: c.UserID, TemplateID: id,
		CSVKey: storageKey, Kind: kind, OutputName: outName,
	})
	if err != nil {
		writeErr(w, 500, "enqueue", err.Error())
		return
	}
	if _, err := h.Queue.EnqueueContext(r.Context(), task); err != nil {
		writeErr(w, 500, "enqueue", err.Error())
		return
	}
	writeJSON(w, 202, generateResp{JobID: jobID, Status: "queued"})
}

// BatchSheet accepts a public Google Sheets URL, fetches its CSV export, and
// enqueues the same batch job. Sheets must be publicly readable ("Anyone with
// the link") — private sheets require OAuth and are deferred to a later pass.
func (h *Handler) BatchSheet(w http.ResponseWriter, r *http.Request) {
	c := r.Context().Value(auth.UserCtxKey).(*auth.Claims)
	id := chi.URLParam(r, "id")
	if h.Queue == nil {
		writeErr(w, 503, "queue_unavailable", "batch requires async queue")
		return
	}
	if !h.ownsTemplate(r.Context(), id, c.OrgID) {
		writeErr(w, 404, "not_found", "template not found")
		return
	}
	var req struct {
		URL string `json:"url"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeErr(w, 400, "invalid_body", err.Error())
		return
	}
	csvURL, err := batchdata.GoogleSheetCSVURL(req.URL)
	if err != nil {
		writeErr(w, 400, "bad_url", err.Error())
		return
	}
	body, err := batchdata.FetchPublic(r.Context(), csvURL)
	if err != nil {
		writeErr(w, 400, "fetch_failed", "couldn't download sheet: "+err.Error())
		return
	}

	jobID, err := jobs.Create(r.Context(), h.DB, c.OrgID, c.UserID, id, "batch", 0)
	if err != nil {
		writeErr(w, 500, "db_error", err.Error())
		return
	}
	filename := "google-sheet.csv"
	storageKey := fmt.Sprintf("orgs/%s/batch-input/%s/%s", c.OrgID, jobID, filename)
	if err := h.Storage.PutBytes(r.Context(), storageKey, "text/csv", body); err != nil {
		writeErr(w, 500, "storage", err.Error())
		return
	}
	outName := "sheet-batch-" + time.Now().Format("20060102-150405") + ".zip"
	task, err := queue.NewGenerateBatch(queue.GenerateBatchPayload{
		JobID: jobID, OrgID: c.OrgID, UserID: c.UserID, TemplateID: id,
		CSVKey: storageKey, Kind: "csv", OutputName: outName,
	})
	if err != nil {
		writeErr(w, 500, "enqueue", err.Error())
		return
	}
	if _, err := h.Queue.EnqueueContext(r.Context(), task); err != nil {
		writeErr(w, 500, "enqueue", err.Error())
		return
	}
	writeJSON(w, 202, generateResp{JobID: jobID, Status: "queued"})
}

func mimeForKind(kind string) string {
	switch kind {
	case "xlsx", "xlsm":
		return "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
	case "tsv":
		return "text/tab-separated-values"
	default:
		return "text/csv"
	}
}

func loadWidgets(ctx context.Context, db *pgxpool.Pool, tplID string) ([]gstatic.Widget, error) {
	rows, err := db.Query(ctx,
		`SELECT id, type, page, x, y, w, h, data_key, z_index, props_json
		 FROM template_widgets WHERE template_id=$1 ORDER BY page, z_index`, tplID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []gstatic.Widget{}
	for rows.Next() {
		var w gstatic.Widget
		var propsRaw []byte
		if err := rows.Scan(&w.ID, &w.Type, &w.Page, &w.X, &w.Y, &w.W, &w.H, &w.DataKey, &w.ZIndex, &propsRaw); err != nil {
			return nil, err
		}
		_ = json.Unmarshal(propsRaw, &w.Props)
		out = append(out, w)
	}
	return out, nil
}

type widgetInput struct {
	Type    string                 `json:"type"`
	Page    int                    `json:"page"`
	X       float64                `json:"x"`
	Y       float64                `json:"y"`
	W       float64                `json:"w"`
	H       float64                `json:"h"`
	DataKey string                 `json:"dataKey"`
	ZIndex  int                    `json:"zIndex"`
	Props   map[string]interface{} `json:"props"`
}

// ListWidgets returns all widgets for a template.
func (h *Handler) ListWidgets(w http.ResponseWriter, r *http.Request) {
	c := r.Context().Value(auth.UserCtxKey).(*auth.Claims)
	id := chi.URLParam(r, "id")
	if !h.ownsTemplate(r.Context(), id, c.OrgID) {
		writeErr(w, 404, "not_found", "template not found")
		return
	}
	widgets, err := loadWidgets(r.Context(), h.DB, id)
	if err != nil {
		writeErr(w, 500, "db_error", err.Error())
		return
	}
	writeJSON(w, 200, map[string]any{"widgets": widgets})
}

// ReplaceWidgets atomically replaces the widget set for a template.
// Simpler than per-widget CRUD and matches the designer's "save full layout" UX.
func (h *Handler) ReplaceWidgets(w http.ResponseWriter, r *http.Request) {
	c := r.Context().Value(auth.UserCtxKey).(*auth.Claims)
	id := chi.URLParam(r, "id")
	var req struct {
		Widgets []widgetInput `json:"widgets"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeErr(w, 400, "invalid_body", err.Error())
		return
	}

	if !h.ownsTemplate(r.Context(), id, c.OrgID) {
		writeErr(w, 404, "not_found", "template not found")
		return
	}

	tx, err := h.DB.Begin(r.Context())
	if err != nil {
		writeErr(w, 500, "db_error", err.Error())
		return
	}
	defer tx.Rollback(r.Context())

	if _, err := tx.Exec(r.Context(), `DELETE FROM template_widgets WHERE template_id=$1`, id); err != nil {
		writeErr(w, 500, "db_error", err.Error())
		return
	}
	for _, widget := range req.Widgets {
		props, _ := json.Marshal(widget.Props)
		if props == nil {
			props = []byte("{}")
		}
		if _, err := tx.Exec(r.Context(),
			`INSERT INTO template_widgets (template_id, type, page, x, y, w, h, data_key, z_index, props_json)
			 VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
			id, widget.Type, widget.Page, widget.X, widget.Y, widget.W, widget.H,
			widget.DataKey, widget.ZIndex, props,
		); err != nil {
			writeErr(w, 500, "db_error", err.Error())
			return
		}
	}
	// Bump version + snapshot in template_versions (re-using config field as widget metadata is implicit).
	if _, err := tx.Exec(r.Context(),
		`UPDATE templates SET version=version+1, updated_at=now() WHERE id=$1`, id,
	); err != nil {
		writeErr(w, 500, "db_error", err.Error())
		return
	}
	if err := tx.Commit(r.Context()); err != nil {
		writeErr(w, 500, "db_error", err.Error())
		return
	}
	writeJSON(w, 200, map[string]any{"count": len(req.Widgets)})
}

func (h *Handler) ownsTemplate(ctx context.Context, tplID, orgID string) bool {
	var exists bool
	_ = h.DB.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM templates WHERE id=$1 AND org_id=$2)`, tplID, orgID).Scan(&exists)
	return exists
}

type versionDTO struct {
	Version   int             `json:"version"`
	AuthorID  *string         `json:"authorId,omitempty"`
	CreatedAt time.Time       `json:"createdAt"`
	Config    json.RawMessage `json:"config"`
}

func (h *Handler) ListVersions(w http.ResponseWriter, r *http.Request) {
	c := r.Context().Value(auth.UserCtxKey).(*auth.Claims)
	id := chi.URLParam(r, "id")
	if !h.ownsTemplate(r.Context(), id, c.OrgID) {
		writeErr(w, 404, "not_found", "template not found")
		return
	}
	rows, err := h.DB.Query(r.Context(),
		`SELECT version, author_id, created_at, config_snapshot
		 FROM template_versions WHERE template_id=$1
		 ORDER BY version DESC`, id,
	)
	if err != nil {
		writeErr(w, 500, "db_error", err.Error())
		return
	}
	defer rows.Close()
	out := []versionDTO{}
	for rows.Next() {
		var v versionDTO
		var raw []byte
		if err := rows.Scan(&v.Version, &v.AuthorID, &v.CreatedAt, &raw); err != nil {
			writeErr(w, 500, "db_error", err.Error())
			return
		}
		v.Config = raw
		out = append(out, v)
	}
	writeJSON(w, 200, map[string]any{"versions": out})
}

func (h *Handler) RestoreVersion(w http.ResponseWriter, r *http.Request) {
	c := r.Context().Value(auth.UserCtxKey).(*auth.Claims)
	id := chi.URLParam(r, "id")
	ver := chi.URLParam(r, "ver")

	if !h.ownsTemplate(r.Context(), id, c.OrgID) {
		writeErr(w, 404, "not_found", "template not found")
		return
	}

	var snapshot []byte
	err := h.DB.QueryRow(r.Context(),
		`SELECT config_snapshot FROM template_versions
		 WHERE template_id=$1 AND version=$2`, id, ver,
	).Scan(&snapshot)
	if err != nil {
		writeErr(w, 404, "not_found", "version not found")
		return
	}

	tx, err := h.DB.Begin(r.Context())
	if err != nil {
		writeErr(w, 500, "db_error", err.Error())
		return
	}
	defer tx.Rollback(r.Context())

	var newVersion int
	err = tx.QueryRow(r.Context(),
		`UPDATE templates SET config_json=$1, version=version+1, updated_at=now()
		 WHERE id=$2 RETURNING version`, snapshot, id,
	).Scan(&newVersion)
	if err != nil {
		writeErr(w, 500, "db_error", err.Error())
		return
	}
	if _, err := tx.Exec(r.Context(),
		`INSERT INTO template_versions (template_id, version, config_snapshot, author_id)
		 VALUES ($1,$2,$3,$4)`, id, newVersion, snapshot, c.UserID,
	); err != nil {
		writeErr(w, 500, "db_error", err.Error())
		return
	}
	if err := tx.Commit(r.Context()); err != nil {
		writeErr(w, 500, "db_error", err.Error())
		return
	}
	writeJSON(w, 200, map[string]any{"version": newVersion, "restoredFrom": ver})
}

// FormBuilderField is one entry in the form-builder request payload. The layout
// is auto-flow vertical, so x/y aren't user-supplied — the backend sizes + lays
// out each field nicely using its type + label.
type FormBuilderField struct {
	Name     string   `json:"name"`
	Label    string   `json:"label"`
	Type     string   `json:"type"` // text | multiline | date | number | currency | checkbox | dropdown | radio
	Options  []string `json:"options,omitempty"`
	Required bool     `json:"required,omitempty"`
}

// CreateFormTemplate builds a form PDF (labels + input boxes auto-arranged on
// the page) AND inserts matching static-mode widgets so the template is
// immediately fillable. User lands in the designer with every field already
// mapped — no drag-and-drop required.
func (h *Handler) CreateFormTemplate(w http.ResponseWriter, r *http.Request) {
	c := r.Context().Value(auth.UserCtxKey).(*auth.Claims)
	var req struct {
		Name        string             `json:"name"`
		PageSize    string             `json:"pageSize"`
		Orientation string             `json:"orientation"`
		Title       string             `json:"title,omitempty"`
		Subtitle    string             `json:"subtitle,omitempty"`
		Fields      []FormBuilderField `json:"fields"`
		FolderID    string             `json:"folderId,omitempty"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeErr(w, 400, "invalid_body", err.Error())
		return
	}
	if req.Name == "" {
		req.Name = "Untitled form"
	}
	if !strings.HasSuffix(strings.ToLower(req.Name), ".pdf") {
		req.Name += ".pdf"
	}
	// Ensure the final name doesn't collide with another active template in
	// the org — we auto-suffix "Untitled form.pdf" → "Untitled form (2).pdf"
	// rather than rejecting the create, because the user is mid-flow.
	unique, err := h.resolveUniqueTemplateName(r.Context(), c.OrgID, req.Name)
	if err != nil {
		writeErr(w, 500, "db_error", err.Error())
		return
	}
	req.Name = unique
	if len(req.Fields) == 0 {
		writeErr(w, 400, "no_fields", "at least one field is required")
		return
	}
	if len(req.Fields) > 100 {
		writeErr(w, 400, "too_many_fields", "max 100 fields per form")
		return
	}

	size := normalizePageSize(req.PageSize)
	orient := "P"
	if strings.EqualFold(req.Orientation, "landscape") {
		orient = "L"
	}

	// Build the PDF + collect widget positions at the same time.
	pdf, widgets, err := buildFormPDF(orient, size, req.Title, req.Subtitle, req.Fields)
	if err != nil {
		writeErr(w, 400, "build_error", err.Error())
		return
	}
	var buf bytes.Buffer
	if err := pdf.Output(&buf); err != nil {
		writeErr(w, 500, "pdf_build", err.Error())
		return
	}

	// Insert file row.
	var fileID string
	if err := h.DB.QueryRow(r.Context(),
		`INSERT INTO files (org_id, owner_id, name, mime, size, storage_key, status)
		 VALUES ($1,$2,$3,'application/pdf',$4,'','active') RETURNING id`,
		c.OrgID, c.UserID, req.Name, buf.Len(),
	).Scan(&fileID); err != nil {
		writeErr(w, 500, "db_error", err.Error())
		return
	}
	key := fmt.Sprintf("orgs/%s/files/%s/%s",
		c.OrgID, fileID, uploadpolicy.SafeStorageSlug(req.Name))
	if _, err := h.DB.Exec(r.Context(),
		`UPDATE files SET storage_key=$1 WHERE id=$2`, key, fileID,
	); err != nil {
		writeErr(w, 500, "db_error", err.Error())
		return
	}
	if err := h.Storage.PutBytes(r.Context(), key, "application/pdf", buf.Bytes()); err != nil {
		writeErr(w, 500, "storage", err.Error())
		return
	}

	// Create static-mode template + matching widgets atomically.
	tx, err := h.DB.Begin(r.Context())
	if err != nil {
		writeErr(w, 500, "db_error", err.Error())
		return
	}
	defer tx.Rollback(r.Context())

	var tplID string
	if err := tx.QueryRow(r.Context(),
		`INSERT INTO templates (org_id, file_id, mode, name) VALUES ($1,$2,'static',$3) RETURNING id`,
		c.OrgID, fileID, req.Name,
	).Scan(&tplID); err != nil {
		writeErr(w, 500, "db_error", err.Error())
		return
	}
	if _, err := tx.Exec(r.Context(),
		`UPDATE files SET template_id=$1 WHERE id=$2`, tplID, fileID,
	); err != nil {
		writeErr(w, 500, "db_error", err.Error())
		return
	}
	for i, wd := range widgets {
		propsRaw, _ := json.Marshal(wd.Props)
		if _, err := tx.Exec(r.Context(),
			`INSERT INTO template_widgets (id, template_id, type, page, x, y, w, h, data_key, z_index, props_json)
			 VALUES (gen_random_uuid(), $1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
			tplID, wd.Type, wd.Page, wd.X, wd.Y, wd.W, wd.H, wd.DataKey, i, propsRaw,
		); err != nil {
			writeErr(w, 500, "db_error", err.Error())
			return
		}
	}
	if err := tx.Commit(r.Context()); err != nil {
		writeErr(w, 500, "db_error", err.Error())
		return
	}

	if req.FolderID != "" {
		_, _ = h.DB.Exec(r.Context(),
			`UPDATE files SET folder_id=$1 WHERE id=$2 AND org_id=$3`,
			req.FolderID, fileID, c.OrgID)
	}

	writeJSON(w, 200, map[string]any{
		"fileId":     fileID,
		"templateId": tplID,
	})
}

// buildFormPDF draws form labels + input boxes top-to-bottom on the page and
// returns the matching widget specs in PDF space (bottom-left origin).
func buildFormPDF(orient, size, title, subtitle string, fields []FormBuilderField) (*fpdf.Fpdf, []gstatic.Widget, error) {
	pdf := fpdf.New(orient, "pt", size, "")
	pdf.SetAutoPageBreak(false, 0)
	pdf.AddPage()
	pageW, pageH := pdf.GetPageSize()

	// Margins in points.
	const margin = 48.0
	const gap = 10.0
	const labelH = 12.0

	contentW := pageW - margin*2
	y := margin

	// Header.
	if title == "" {
		title = "Form"
	}
	pdf.SetFont("Helvetica", "B", 20)
	pdf.SetTextColor(17, 24, 39)
	pdf.SetXY(margin, y)
	pdf.Cell(contentW, 24, title)
	y += 28
	if subtitle != "" {
		pdf.SetFont("Helvetica", "", 11)
		pdf.SetTextColor(120, 120, 120)
		pdf.SetXY(margin, y)
		pdf.Cell(contentW, 14, subtitle)
		y += 18
	}
	y += 6

	widgets := make([]gstatic.Widget, 0, len(fields))
	page := 1

	for _, f := range fields {
		if f.Name == "" {
			return nil, nil, fmt.Errorf("field name is required")
		}
		h := inputHeightForType(f.Type)
		blockH := labelH + 4 + h + gap

		// Page break if this block doesn't fit.
		if y+blockH > pageH-margin {
			pdf.AddPage()
			page++
			y = margin
		}

		// Label (+ red asterisk if required).
		pdf.SetFont("Helvetica", "", 10)
		pdf.SetTextColor(90, 90, 90)
		pdf.SetXY(margin, y)
		label := f.Label
		if label == "" {
			label = f.Name
		}
		if f.Required {
			label += " *"
		}
		pdf.Cell(contentW, labelH, label)

		// Draw the input box directly under the label.
		boxY := y + labelH + 4
		boxX := margin
		boxW := contentW
		boxH := h
		if f.Type == "checkbox" {
			boxW = 14
			boxH = 14
		}
		pdf.SetDrawColor(210, 210, 210)
		pdf.SetLineWidth(0.6)
		pdf.Rect(boxX, boxY, boxW, boxH, "D")

		// Placeholder hint inside the box.
		if f.Type == "dropdown" && len(f.Options) > 0 {
			pdf.SetFont("Helvetica", "", 9)
			pdf.SetTextColor(180, 180, 180)
			pdf.SetXY(boxX+6, boxY)
			pdf.CellFormat(boxW-12, boxH, "Select: "+strings.Join(f.Options, " / "), "", 0, "L", false, 0, "")
		}

		// Translate to PDF space (origin bottom-left).
		widget := gstatic.Widget{
			Type:    widgetTypeFor(f.Type),
			Page:    page,
			X:       boxX,
			Y:       pageH - (boxY + boxH),
			W:       boxW,
			H:       boxH,
			DataKey: f.Name,
			Props: map[string]any{
				"fontSize":   12,
				"fontFamily": "Helvetica",
				"color":      "#111827",
				"align":      "L",
			},
		}
		widgets = append(widgets, widget)

		y += blockH
	}

	// Footer note on page 1 only (re-emit if multi-page: skip for simplicity).
	pdf.SetFont("Helvetica", "I", 8)
	pdf.SetTextColor(180, 180, 180)
	pdf.SetXY(margin, pageH-margin+14)
	pdf.Cell(contentW, 10, "Created with Drive360")

	return pdf, widgets, nil
}

func inputHeightForType(t string) float64 {
	switch t {
	case "multiline":
		return 60
	case "checkbox":
		return 14
	default:
		return 20
	}
}

func widgetTypeFor(t string) string {
	switch t {
	case "multiline", "checkbox", "date", "number", "currency":
		return t
	case "dropdown", "radio":
		return "text" // render the chosen value as plain text for MVP
	default:
		return "text"
	}
}

// CreateBlankPDF generates a blank PDF of a given page size, registers it as a
// file + static-mode template, and returns the new IDs. Lets users start a
// static PDF template without having to upload one from disk.
func (h *Handler) CreateBlankPDF(w http.ResponseWriter, r *http.Request) {
	c := r.Context().Value(auth.UserCtxKey).(*auth.Claims)
	var req struct {
		Name        string `json:"name"`
		PageSize    string `json:"pageSize"`    // A4 | Letter | Legal
		Orientation string `json:"orientation"` // portrait | landscape
		Pages       int    `json:"pages"`
		FolderID    string `json:"folderId,omitempty"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeErr(w, 400, "invalid_body", err.Error())
		return
	}
	if req.Name == "" {
		req.Name = "Untitled PDF"
	}
	if !strings.HasSuffix(strings.ToLower(req.Name), ".pdf") {
		req.Name += ".pdf"
	}
	// Auto-suffix if the chosen name collides with another active template.
	unique, err := h.resolveUniqueTemplateName(r.Context(), c.OrgID, req.Name)
	if err != nil {
		writeErr(w, 500, "db_error", err.Error())
		return
	}
	req.Name = unique
	if req.Pages < 1 {
		req.Pages = 1
	}
	if req.Pages > 20 {
		req.Pages = 20
	}
	size := normalizePageSize(req.PageSize)
	orient := "P"
	if strings.EqualFold(req.Orientation, "landscape") {
		orient = "L"
	}

	pdf := fpdf.New(orient, "pt", size, "")
	for i := 0; i < req.Pages; i++ {
		pdf.AddPage()
	}
	var buf bytes.Buffer
	if err := pdf.Output(&buf); err != nil {
		writeErr(w, 500, "pdf_build", err.Error())
		return
	}

	// Insert file row.
	var fileID string
	if err := h.DB.QueryRow(r.Context(),
		`INSERT INTO files (org_id, owner_id, name, mime, size, storage_key, status)
		 VALUES ($1,$2,$3,'application/pdf',$4,'','active') RETURNING id`,
		c.OrgID, c.UserID, req.Name, buf.Len(),
	).Scan(&fileID); err != nil {
		writeErr(w, 500, "db_error", err.Error())
		return
	}
	key := fmt.Sprintf("orgs/%s/files/%s/%s",
		c.OrgID, fileID, uploadpolicy.SafeStorageSlug(req.Name))
	if _, err := h.DB.Exec(r.Context(),
		`UPDATE files SET storage_key=$1 WHERE id=$2`, key, fileID,
	); err != nil {
		writeErr(w, 500, "db_error", err.Error())
		return
	}
	if err := h.Storage.PutBytes(r.Context(), key, "application/pdf", buf.Bytes()); err != nil {
		writeErr(w, 500, "storage", err.Error())
		return
	}

	// Create the static-mode template.
	tplID, err := h.detectPDF(r.Context(), fileID, c.OrgID, req.Name, key)
	if err != nil {
		writeErr(w, 500, "detect", err.Error())
		return
	}

	// Optional: move into the given folder.
	if req.FolderID != "" {
		_, _ = h.DB.Exec(r.Context(),
			`UPDATE files SET folder_id=$1 WHERE id=$2 AND org_id=$3`,
			req.FolderID, fileID, c.OrgID)
	}

	writeJSON(w, 200, map[string]any{
		"fileId":     fileID,
		"templateId": tplID,
	})
}

// CreateDocTemplate creates a new template in doc mode. The body may seed the
// initial AST; if omitted we create a one-paragraph skeleton so the editor
// opens cleanly instead of blank.
//
// The source bytes are stored as a JSON envelope in the files table so the
// rest of the system (versioning, storage, dedupe) treats doc-mode sources
// identically to html/markdown sources — just a different content-type.
func (h *Handler) CreateDocTemplate(w http.ResponseWriter, r *http.Request) {
	c := r.Context().Value(auth.UserCtxKey).(*auth.Claims)
	var req struct {
		Name     string          `json:"name"`
		Doc      json.RawMessage `json:"doc,omitempty"`      // optional seed AST; expected shape: {type:"doc", content:[…]}
		ThemeCss string          `json:"themeCss,omitempty"` // optional per-template CSS; prepended to preview/render
		FolderID string          `json:"folderId,omitempty"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeErr(w, 400, "invalid_body", err.Error())
		return
	}
	if req.Name == "" {
		req.Name = "Untitled document"
	}
	// Auto-suffix if another active template in this org already claims the
	// same name (case-insensitive). Applies to the authored name, not the
	// normalised .docast filename.
	if uniq, err := h.resolveUniqueTemplateName(r.Context(), c.OrgID, req.Name); err != nil {
		writeErr(w, 500, "db_error", err.Error())
		return
	} else {
		req.Name = uniq
	}

	// Seed the envelope: use the caller's doc if valid, otherwise an empty
	// doc with one paragraph so the editor has something to land on. The
	// themeCss field rides alongside the AST — never inside it — so edits
	// to styling don't invalidate node IDs or diagnostics.
	var envelope []byte
	if len(req.Doc) > 0 {
		// Validate the seed so we never persist an envelope that won't parse
		// on subsequent Preview/Render calls. We wrap it in the versioned
		// outer envelope — the client only supplies the inner `doc` tree.
		envMap := map[string]any{
			"version": gdoc.ASTVersion,
			"doc":     req.Doc,
		}
		if req.ThemeCss != "" {
			envMap["themeCss"] = req.ThemeCss
		}
		envelope, _ = json.Marshal(envMap)
		if _, err := gdoc.ParseStoredDoc(envelope); err != nil {
			writeErr(w, 400, "invalid_doc", err.Error())
			return
		}
	} else if req.ThemeCss != "" {
		envelope, _ = json.Marshal(map[string]any{
			"version":  gdoc.ASTVersion,
			"doc":      map[string]any{"type": "doc", "content": []any{map[string]any{"type": "paragraph", "content": []any{map[string]any{"type": "text", "text": ""}}}}},
			"themeCss": req.ThemeCss,
		})
	} else {
		envelope = []byte(`{"version":1,"doc":{"type":"doc","content":[{"type":"paragraph","content":[{"type":"text","text":""}]}]}}`)
	}

	// Insert the file row first so we have a file_id for the template row.
	name := req.Name
	// Normalize a .docast extension purely for human identification in file
	// listings; the mode column is the source of truth for how to render.
	if !strings.HasSuffix(strings.ToLower(name), ".docast") {
		name += ".docast"
	}
	var fileID string
	if err := h.DB.QueryRow(r.Context(),
		`INSERT INTO files (org_id, owner_id, name, mime, size, storage_key, status)
		 VALUES ($1,$2,$3,'application/json',$4,'','active') RETURNING id`,
		c.OrgID, c.UserID, name, len(envelope),
	).Scan(&fileID); err != nil {
		writeErr(w, 500, "db_error", err.Error())
		return
	}
	key := fmt.Sprintf("orgs/%s/files/%s/%s",
		c.OrgID, fileID, uploadpolicy.SafeStorageSlug(name))
	if _, err := h.DB.Exec(r.Context(),
		`UPDATE files SET storage_key=$1 WHERE id=$2`, key, fileID,
	); err != nil {
		writeErr(w, 500, "db_error", err.Error())
		return
	}
	if err := h.Storage.PutBytes(r.Context(), key, "application/json", envelope); err != nil {
		writeErr(w, 500, "storage", err.Error())
		return
	}

	// Seed placeholders from whatever the AST references so the schema
	// sidebar is populated immediately.
	placeholders := gdoc.ExtractPlaceholders(string(envelope))
	cfgBytes, _ := json.Marshal(map[string]any{"placeholders": placeholders})

	tx, err := h.DB.Begin(r.Context())
	if err != nil {
		writeErr(w, 500, "db_error", err.Error())
		return
	}
	defer tx.Rollback(r.Context())

	var tplID string
	if err := tx.QueryRow(r.Context(),
		`INSERT INTO templates (org_id, file_id, mode, name, config_json) VALUES ($1,$2,'doc',$3,$4) RETURNING id`,
		c.OrgID, fileID, req.Name, cfgBytes,
	).Scan(&tplID); err != nil {
		writeErr(w, 500, "db_error", err.Error())
		return
	}
	if _, err := tx.Exec(r.Context(),
		`UPDATE files SET template_id=$1 WHERE id=$2`, tplID, fileID,
	); err != nil {
		writeErr(w, 500, "db_error", err.Error())
		return
	}
	if err := tx.Commit(r.Context()); err != nil {
		writeErr(w, 500, "db_error", err.Error())
		return
	}

	if req.FolderID != "" {
		_, _ = h.DB.Exec(r.Context(),
			`UPDATE files SET folder_id=$1 WHERE id=$2 AND org_id=$3`,
			req.FolderID, fileID, c.OrgID)
	}

	writeJSON(w, 200, map[string]any{
		"fileId":     fileID,
		"templateId": tplID,
	})
}

func normalizePageSize(s string) string {
	switch strings.ToLower(strings.TrimSpace(s)) {
	case "a4":
		return "A4"
	case "legal":
		return "Legal"
	case "a3":
		return "A3"
	case "a5":
		return "A5"
	case "letter", "":
		fallthrough
	default:
		return "Letter"
	}
}

// Preview renders an HTML template against user-supplied data and returns the
// resulting HTML. Used by the designer's live preview. Never writes anything
// to storage. Falls back gracefully on syntax errors so the iframe always
// shows *something* while the author is typing.
func (h *Handler) Preview(w http.ResponseWriter, r *http.Request) {
	c := r.Context().Value(auth.UserCtxKey).(*auth.Claims)
	id := chi.URLParam(r, "id")

	var req struct {
		Data   map[string]interface{} `json:"data"`
		Source *string                `json:"source,omitempty"` // optional override for unsaved edits
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeErr(w, 400, "invalid_body", err.Error())
		return
	}
	if req.Data == nil {
		req.Data = map[string]interface{}{}
	}

	var mode, storageKey string
	var cfgRaw []byte
	err := h.DB.QueryRow(r.Context(),
		`SELECT t.mode, t.config_json, f.storage_key FROM templates t JOIN files f ON f.id=t.file_id
		 WHERE t.id=$1 AND t.org_id=$2`, id, c.OrgID,
	).Scan(&mode, &cfgRaw, &storageKey)
	if err != nil {
		writeErr(w, 404, "not_found", "template not found")
		return
	}
	if mode != "html" && mode != "markdown" && mode != "doc" {
		writeErr(w, 400, "wrong_mode", "preview is only supported for html/markdown/doc templates")
		return
	}
	pageLayout := layout.FromConfig(cfgRaw)
	i18nCfg := i18n.FromConfig(cfgRaw)
	locale := i18n.ResolveLocale(i18nCfg, req.Data)

	// Evaluate computed fields against the user-supplied data so templates can
	// reference e.g. {{ .subtotal }} without repeating the sum() math.
	mergedData, computeErrors := compute.Eval(compute.FromConfig(cfgRaw), req.Data)

	var srcStr string
	if req.Source != nil {
		srcStr = *req.Source
	} else {
		data, err := h.Storage.GetBytes(r.Context(), storageKey)
		if err != nil {
			writeErr(w, 500, "storage", err.Error())
			return
		}
		srcStr = string(data)
	}

	// The html/markdown preview renderers now return BEST-EFFORT html
	// alongside any execute-time error, so the designer iframe can show a
	// partial render (simple `{{ .field }}` refs resolved via regex) even
	// when a single pipe or comparison fails. The UI banner carries the
	// error text so the author sees precisely which expression tripped.
	var (
		out         string
		previewE    error
		docDiags    []gdoc.Diagnostic
	)
	switch mode {
	case "markdown":
		out, previewE = gmarkdown.PreviewWithLocale(srcStr, mergedData, pageLayout, locale, i18nCfg)
	case "doc":
		out, docDiags, previewE = gdoc.PreviewWithLocale(srcStr, mergedData, pageLayout, locale, i18nCfg)
	default:
		out, previewE = ghtml.PreviewWithLocale(srcStr, mergedData, pageLayout, locale, i18nCfg)
	}
	resp := map[string]any{"html": out}
	if previewE != nil {
		resp["error"] = previewE.Error()
	}
	if len(docDiags) > 0 {
		// Attach structured per-node diagnostics so the designer can pin
		// warnings to specific blocks in the editor outline.
		resp["diagnostics"] = docDiags
	}
	if len(computeErrors) > 0 {
		resp["computeErrors"] = computeErrors
	}
	writeJSON(w, 200, resp)
}

// Source returns the raw source bytes for a template (used by the HTML designer).
func (h *Handler) Source(w http.ResponseWriter, r *http.Request) {
	c := r.Context().Value(auth.UserCtxKey).(*auth.Claims)
	id := chi.URLParam(r, "id")
	var storageKey, mime string
	err := h.DB.QueryRow(r.Context(),
		`SELECT f.storage_key, f.mime FROM templates t JOIN files f ON f.id=t.file_id
		 WHERE t.id=$1 AND t.org_id=$2`, id, c.OrgID,
	).Scan(&storageKey, &mime)
	if err != nil {
		writeErr(w, 404, "not_found", "template not found")
		return
	}
	data, err := h.Storage.GetBytes(r.Context(), storageKey)
	if err != nil {
		writeErr(w, 500, "storage", err.Error())
		return
	}
	writeJSON(w, 200, map[string]any{"source": string(data), "mime": mime})
}

// UpdateSource overwrites the source bytes for an HTML template and re-extracts
// placeholders into config_json.placeholders.
func (h *Handler) UpdateSource(w http.ResponseWriter, r *http.Request) {
	c := r.Context().Value(auth.UserCtxKey).(*auth.Claims)
	id := chi.URLParam(r, "id")
	var req struct {
		Source          string `json:"source"`
		ExpectedVersion *int   `json:"expectedVersion,omitempty"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeErr(w, 400, "invalid_body", err.Error())
		return
	}
	var mode, storageKey, fileID string
	var cfgRaw []byte
	var currentVersion int
	err := h.DB.QueryRow(r.Context(),
		`SELECT t.mode, t.config_json, t.version, f.storage_key, t.file_id
		 FROM templates t JOIN files f ON f.id=t.file_id
		 WHERE t.id=$1 AND t.org_id=$2`, id, c.OrgID,
	).Scan(&mode, &cfgRaw, &currentVersion, &storageKey, &fileID)
	if err != nil {
		writeErr(w, 404, "not_found", "template not found")
		return
	}
	// Viewer shares can read the source but must not overwrite it.
	if ok, err := sharing.CanEditFile(r.Context(), h.DB, c, fileID); err != nil {
		writeErr(w, 500, "db_error", err.Error())
		return
	} else if !ok {
		writeErr(w, 403, "forbidden", "you don't have edit access to this template")
		return
	}
	if req.ExpectedVersion != nil && *req.ExpectedVersion != currentVersion {
		writeJSON(w, 409, map[string]any{
			"error": map[string]any{
				"code":            "version_conflict",
				"message":         "another collaborator saved this template while you were editing",
				"currentVersion":  currentVersion,
				"expectedVersion": *req.ExpectedVersion,
			},
		})
		return
	}
	if mode != "html" && mode != "markdown" && mode != "doc" {
		writeErr(w, 400, "wrong_mode", "source edits only supported for html/markdown/doc templates")
		return
	}

	// Overwrite the file in MinIO.
	contentType := "text/html"
	switch mode {
	case "markdown":
		contentType = "text/markdown"
	case "doc":
		// doc mode stores a JSON envelope, not HTML.
		contentType = "application/json"
	}
	if err := h.Storage.PutBytes(r.Context(), storageKey, contentType, []byte(req.Source)); err != nil {
		writeErr(w, 500, "storage", err.Error())
		return
	}

	// Re-extract placeholders and merge into config.
	cfg := map[string]interface{}{}
	_ = json.Unmarshal(cfgRaw, &cfg)
	switch mode {
	case "markdown":
		cfg["placeholders"] = gmarkdown.ExtractPlaceholders(req.Source)
	case "doc":
		cfg["placeholders"] = gdoc.ExtractPlaceholders(req.Source)
	default:
		cfg["placeholders"] = ghtml.ExtractPlaceholders(req.Source)
	}
	newCfg, _ := json.Marshal(cfg)

	tx, err := h.DB.Begin(r.Context())
	if err != nil {
		writeErr(w, 500, "db_error", err.Error())
		return
	}
	defer tx.Rollback(r.Context())

	var newVer int
	if err := tx.QueryRow(r.Context(),
		`UPDATE templates SET config_json=$1, version=version+1, updated_at=now()
		 WHERE id=$2 RETURNING version`, newCfg, id,
	).Scan(&newVer); err != nil {
		writeErr(w, 500, "db_error", err.Error())
		return
	}
	if _, err := tx.Exec(r.Context(),
		`INSERT INTO template_versions (template_id, version, config_snapshot, author_id) VALUES ($1,$2,$3,$4)`,
		id, newVer, newCfg, c.UserID,
	); err != nil {
		writeErr(w, 500, "db_error", err.Error())
		return
	}
	if _, err := tx.Exec(r.Context(),
		`UPDATE files SET size=$1, updated_at=now() WHERE id=(SELECT file_id FROM templates WHERE id=$2)`,
		len(req.Source), id,
	); err != nil {
		writeErr(w, 500, "db_error", err.Error())
		return
	}
	if err := tx.Commit(r.Context()); err != nil {
		writeErr(w, 500, "db_error", err.Error())
		return
	}
	writeJSON(w, 200, map[string]any{
		"version":      newVer,
		"placeholders": cfg["placeholders"],
	})
}

func (h *Handler) PreviewURL(w http.ResponseWriter, r *http.Request) {
	c := r.Context().Value(auth.UserCtxKey).(*auth.Claims)
	id := chi.URLParam(r, "id")
	var key, name, mime string
	err := h.DB.QueryRow(r.Context(),
		`SELECT f.storage_key, f.name, COALESCE(f.mime, '') FROM templates t
		 JOIN files f ON f.id=t.file_id
		 WHERE t.id=$1 AND t.org_id=$2`, id, c.OrgID,
	).Scan(&key, &name, &mime)
	if err != nil {
		writeErr(w, 404, "not_found", "template not found")
		return
	}
	// Preview UI iframes the result, so we want inline disposition for
	// safe MIMEs (PDFs, plain images). PresignGetInline carries the
	// risky-MIME override that flips HTML/SVG/JS back to attachment
	// — same end state as the old PresignGet behaviour, but expressed
	// through the explicit-inline primitive instead of relying on
	// PresignGet's defaults (which now always force attachment).
	url, err := h.Storage.PresignGetInline(r.Context(), key, mime, 10*time.Minute)
	if err != nil {
		writeErr(w, 500, "presign", err.Error())
		return
	}
	// Echo the org's configured iframe-sandbox token so the frontend can
	// apply `<iframe sandbox={iframeSandbox}>` consistent with policy.
	// Fallback to the package default when policy isn't wired (keeps
	// existing tests/setups working). The CSP knob is enforced by the
	// proxy endpoint (/v1/files/{id}/inline-preview) — presigned URLs
	// can't carry response headers, so the frontend should prefer that
	// route for HTML/SVG content while this stays in place for PDFs.
	sandbox := uploadpolicy.DefaultPreviewIframeSandbox
	if h.Policy != nil {
		if p, perr := h.Policy.Effective(r.Context(), c.OrgID); perr == nil {
			sandbox = p.PreviewIframeSandbox
		}
	}
	writeJSON(w, 200, map[string]any{
		"url":           url,
		"name":          name,
		"iframeSandbox": sandbox,
	})
}

func isPDF(mime, name string) bool {
	if strings.Contains(mime, "pdf") {
		return true
	}
	return strings.EqualFold(filepath.Ext(name), ".pdf")
}

// errNameConflict is the sentinel returned by ensureUniqueTemplateName when
// another active (non-trashed) template in the same org already carries the
// given name. Handlers surface it as HTTP 409 `name_conflict`.
var errNameConflict = errors.New("a template with this name already exists in this workspace")

// ensureUniqueTemplateName verifies no other active template in the same
// org holds `name` (case-insensitive). Trashed files are excluded so a user
// can always reclaim a name they recently deleted. Pass `excludeID` to skip
// the template being renamed — "" for create.
//
// Check is done against the live pool before the create/update tx opens.
// There's a tiny race window where two parallel creates could both see
// "free"; we accept it because templates are created interactively and the
// second save surfaces a clean 409 to the user. Promote to a DB UNIQUE
// index if contention ever appears (requires de-duping existing rows first).
func (h *Handler) ensureUniqueTemplateName(ctx context.Context, orgID, name, excludeID string) error {
	trimmed := strings.TrimSpace(name)
	if trimmed == "" {
		return fmt.Errorf("template name cannot be empty")
	}
	var excl any // NULL when creating; the template's own id when renaming
	if excludeID != "" {
		excl = excludeID
	}
	var exists bool
	if err := h.DB.QueryRow(ctx, `
		SELECT EXISTS(
			SELECT 1 FROM templates t
			JOIN files f ON f.id = t.file_id
			WHERE t.org_id = $1
			  AND lower(t.name) = lower($2)
			  AND f.trashed_at IS NULL
			  AND ($3::uuid IS NULL OR t.id <> $3::uuid)
		)`, orgID, trimmed, excl).Scan(&exists); err != nil {
		return err
	}
	if exists {
		return errNameConflict
	}
	return nil
}

// resolveUniqueTemplateName picks a name guaranteed not to collide with an
// existing active template in `orgID`. When `name` is free we return it as
// given; otherwise we append " (2)" / " (3)" / ... before the extension
// until we find a free slot. Extension handling keeps `.pdf` / `.docast`
// on the end so file listings stay tidy.
//
// Used by create flows (explicit + auto-detect) where auto-suffixing is a
// better UX than rejecting — the user already committed to creating the
// file by the time we land here.
func (h *Handler) resolveUniqueTemplateName(ctx context.Context, orgID, name string) (string, error) {
	trimmed := strings.TrimSpace(name)
	if trimmed == "" {
		return "", fmt.Errorf("template name cannot be empty")
	}
	// Split base/extension so we can insert the counter before the dot.
	ext := filepath.Ext(trimmed)
	base := strings.TrimSuffix(trimmed, ext)
	candidate := trimmed
	for i := 2; i < 1000; i++ {
		err := h.ensureUniqueTemplateName(ctx, orgID, candidate, "")
		if err == nil {
			return candidate, nil
		}
		if !errors.Is(err, errNameConflict) {
			return "", err
		}
		candidate = fmt.Sprintf("%s (%d)%s", base, i, ext)
	}
	return "", fmt.Errorf("could not find a unique template name after 1000 tries")
}

func writeJSON(w http.ResponseWriter, code int, v interface{}) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(code)
	_ = json.NewEncoder(w).Encode(v)
}

func writeErr(w http.ResponseWriter, code int, slug, msg string) {
	writeJSON(w, code, map[string]any{"error": map[string]string{"code": slug, "message": msg}})
}

// writeValidationErr emits a 422 with the per-field error list kept
// structured so clients can render inline messages. Shape:
//
//	{
//	  "error": {
//	    "code":    "validation_failed",
//	    "message": "validation failed (N fields)",
//	    "fields":  [{ "field","dataKey","message" }, ...]
//	  }
//	}
//
// Message is a short human summary; `fields` is the source of truth.
func writeValidationErr(w http.ResponseWriter, errs []acroform.ValidationError) {
	writeJSON(w, 422, map[string]any{
		"error": map[string]any{
			"code":    "validation_failed",
			"message": fmt.Sprintf("validation failed (%d field%s)", len(errs), plural(len(errs))),
			"fields":  errs,
		},
	})
}

func plural(n int) string {
	if n == 1 {
		return ""
	}
	return "s"
}

// reextractAcroformFields pulls the current PDF blob for a template and runs a
// fresh acroform.Extract, returning DTO-shaped rich fields (rect, flags, …).
func reextractAcroformFields(ctx context.Context, h *Handler, tplID, orgID string) ([]fieldDTO, error) {
	var storageKey string
	err := h.DB.QueryRow(ctx,
		`SELECT f.storage_key FROM templates t
		 JOIN files f ON f.id=t.file_id
		 WHERE t.id=$1 AND t.org_id=$2`, tplID, orgID,
	).Scan(&storageKey)
	if err != nil {
		return nil, err
	}
	data, err := h.Storage.GetBytes(ctx, storageKey)
	if err != nil {
		return nil, err
	}
	fields, err := acroform.Extract(data)
	if err != nil {
		return nil, err
	}
	out := make([]fieldDTO, 0, len(fields))
	for _, f := range fields {
		out = append(out, fieldDTO{
			Name:        f.Name,
			Type:        f.Type,
			Page:        f.Page,
			Options:     f.Options,
			Rect:        f.Rect,
			PageSize:    f.PageSize,
			Flags:       f.Flags,
			MaxLen:      f.MaxLen,
			Tooltip:     f.Tooltip,
			ReadOnly:    f.ReadOnly,
			Required:    f.Required,
			Multiline:   f.Multiline,
			Password:    f.Password,
			Combo:       f.Combo,
			MultiSelect: f.MultiSelect,
		})
	}
	return out, nil
}

type acroStructureReq struct {
	Patches         []acroform.StructurePatch `json:"patches"`
	ExpectedVersion *int                      `json:"expectedVersion,omitempty"`
}

// UpdateAcroformStructure applies a batch of structure patches to the PDF
// blob backing a template, writes the modified PDF back to storage, updates
// the `template_fields` mirror, bumps the template version, and returns the
// refreshed rich fields + a new preview URL.
func (h *Handler) UpdateAcroformStructure(w http.ResponseWriter, r *http.Request) {
	c := r.Context().Value(auth.UserCtxKey).(*auth.Claims)
	id := chi.URLParam(r, "id")

	var req acroStructureReq
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeErr(w, 400, "invalid_body", err.Error())
		return
	}
	if len(req.Patches) == 0 {
		writeErr(w, 400, "no_patches", "at least one patch is required")
		return
	}

	ctx := r.Context()

	var mode, fileID, storageKey string
	var currentVersion int
	err := h.DB.QueryRow(ctx,
		`SELECT t.mode, t.file_id, t.version, f.storage_key
		 FROM templates t JOIN files f ON f.id=t.file_id
		 WHERE t.id=$1 AND t.org_id=$2`, id, c.OrgID,
	).Scan(&mode, &fileID, &currentVersion, &storageKey)
	if err != nil {
		writeErr(w, 404, "not_found", "template not found")
		return
	}
	// Structure patches rewrite the backing PDF — strictly an editor op.
	if ok, err := sharing.CanEditFile(ctx, h.DB, c, fileID); err != nil {
		writeErr(w, 500, "db_error", err.Error())
		return
	} else if !ok {
		writeErr(w, 403, "forbidden", "you don't have edit access to this template")
		return
	}
	if mode != "acroform" {
		writeErr(w, 400, "wrong_mode", "template is not an acroform")
		return
	}
	if req.ExpectedVersion != nil && *req.ExpectedVersion != currentVersion {
		writeJSON(w, 409, map[string]any{
			"error": map[string]any{
				"code":            "version_conflict",
				"message":         "another collaborator saved this template while you were editing",
				"currentVersion":  currentVersion,
				"expectedVersion": *req.ExpectedVersion,
			},
		})
		return
	}

	pdfBytes, err := h.Storage.GetBytes(ctx, storageKey)
	if err != nil {
		writeErr(w, 500, "storage", err.Error())
		return
	}

	modified, err := acroform.ApplyStructurePatches(pdfBytes, req.Patches)
	if err != nil {
		writeErr(w, 400, "patch_failed", err.Error())
		return
	}

	// Persist the modified PDF back to the SAME storage key so the preview URL
	// and downstream fill operations always see the latest structure.
	if err := h.Storage.PutBytes(ctx, storageKey, "application/pdf", modified); err != nil {
		writeErr(w, 500, "storage", err.Error())
		return
	}

	// Re-extract fields from the modified PDF and refresh the mirror table.
	fresh, err := acroform.Extract(modified)
	if err != nil {
		writeErr(w, 500, "reextract", err.Error())
		return
	}

	tx, err := h.DB.Begin(ctx)
	if err != nil {
		writeErr(w, 500, "db_error", err.Error())
		return
	}
	defer tx.Rollback(ctx)

	if _, err := tx.Exec(ctx, `DELETE FROM template_fields WHERE template_id=$1`, id); err != nil {
		writeErr(w, 500, "db_error", err.Error())
		return
	}
	for _, f := range fresh {
		opts, _ := json.Marshal(f.Options)
		if _, err := tx.Exec(ctx,
			`INSERT INTO template_fields (template_id, name, type, page, options)
			 VALUES ($1,$2,$3,$4,$5)`, id, f.Name, f.Type, f.Page, opts,
		); err != nil {
			writeErr(w, 500, "db_error", err.Error())
			return
		}
	}

	var newVersion int
	if err := tx.QueryRow(ctx,
		`UPDATE templates SET version=version+1, updated_at=now()
		 WHERE id=$1 AND org_id=$2 RETURNING version`, id, c.OrgID,
	).Scan(&newVersion); err != nil {
		writeErr(w, 500, "db_error", err.Error())
		return
	}
	if err := tx.Commit(ctx); err != nil {
		writeErr(w, 500, "db_error", err.Error())
		return
	}

	// PDF only — the AcroForm pipeline writes only PDFs, so the preview
	// is always safe to render inline. PresignGet now always forces
	// attachment, so use PresignGetInline for the iframe path.
	previewURL, _ := h.Storage.PresignGetInline(ctx, storageKey, "application/pdf", 10*time.Minute)

	// Build DTO fields for response.
	dtos := make([]fieldDTO, 0, len(fresh))
	for _, f := range fresh {
		dtos = append(dtos, fieldDTO{
			Name:        f.Name,
			Type:        f.Type,
			Page:        f.Page,
			Options:     f.Options,
			Rect:        f.Rect,
			PageSize:    f.PageSize,
			Flags:       f.Flags,
			MaxLen:      f.MaxLen,
			Tooltip:     f.Tooltip,
			ReadOnly:    f.ReadOnly,
			Required:    f.Required,
			Multiline:   f.Multiline,
			Password:    f.Password,
			Combo:       f.Combo,
			MultiSelect: f.MultiSelect,
		})
	}

	writeJSON(w, 200, map[string]any{
		"version":    newVersion,
		"fields":     dtos,
		"previewUrl": previewURL,
	})
}
