package templates

import (
	"bytes"
	"context"
	"encoding/json"
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
	ghtml "github.com/docforge/api/internal/generate/html"
	gmarkdown "github.com/docforge/api/internal/generate/markdown"
	gstatic "github.com/docforge/api/internal/generate/static"
	"github.com/docforge/api/internal/i18n"
	"github.com/docforge/api/internal/layout"
	"github.com/go-pdf/fpdf"
	"github.com/docforge/api/internal/jobs"
	"github.com/docforge/api/internal/queue"
	"github.com/docforge/api/internal/storage"
	"github.com/go-chi/chi/v5"
	"github.com/hibiken/asynq"
	"github.com/jackc/pgx/v5/pgxpool"
)

type Handler struct {
	DB      *pgxpool.Pool
	Storage *storage.Client
	Runner  *generate.Runner
	Queue   *asynq.Client // nil if async is disabled
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
// Anything else → no template.
func (h *Handler) DetectAndCreate(ctx context.Context, fileID, orgID, name, mime, storageKey string) (string, error) {
	switch {
	case isPDF(mime, name):
		return h.detectPDF(ctx, fileID, orgID, name, storageKey)
	case isMarkdown(mime, name):
		return h.detectMarkdown(ctx, fileID, orgID, name, storageKey)
	case isHTML(mime, name):
		return h.detectHTML(ctx, fileID, orgID, name, storageKey)
	}
	return "", nil
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
	return ext == ".md" || ext == ".markdown"
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
	Name    string   `json:"name"`
	Type    string   `json:"type"`
	Page    int      `json:"page"`
	Options []string `json:"options,omitempty"`
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

	writeJSON(w, 200, dto)
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
	Data    map[string]interface{} `json:"data"`
	Flatten bool                   `json:"flatten"`
	Async   bool                   `json:"async"`
}

type generateResp struct {
	OutputFileID string `json:"outputFileId,omitempty"`
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

	if req.Async {
		if h.Queue == nil {
			writeErr(w, 503, "queue_unavailable", "async dispatch disabled (no queue client)")
			return
		}
		jobID, err := jobs.Create(r.Context(), h.DB, c.OrgID, c.UserID, id, "single", 1)
		if err != nil {
			writeErr(w, 500, "db_error", err.Error())
			return
		}
		task, err := queue.NewGenerateOne(queue.GenerateOnePayload{
			JobID: jobID, OrgID: c.OrgID, UserID: c.UserID, TemplateID: id,
			Data: req.Data, Flatten: req.Flatten,
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

	// Sync path: delegate to the shared Runner.
	res, err := h.Runner.Run(r.Context(), c.OrgID, c.UserID, id, req.Data, req.Flatten)
	if err != nil {
		writeErr(w, 400, "fill_failed", err.Error())
		return
	}
	url, err := h.Storage.PresignGet(r.Context(), res.OutputKey, res.OutputName, 10*time.Minute)
	if err != nil {
		writeErr(w, 500, "presign", err.Error())
		return
	}
	writeJSON(w, 200, generateResp{OutputFileID: res.OutputFileID, DownloadURL: url, Bytes: res.Bytes})
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
	storageKey := fmt.Sprintf("orgs/%s/batch-input/%s/%s", c.OrgID, jobID, hdr.Filename)
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
	key := fmt.Sprintf("orgs/%s/files/%s/%s", c.OrgID, fileID, req.Name)
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
	pdf.Cell(contentW, 10, "Created with Formly")

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
	key := fmt.Sprintf("orgs/%s/files/%s/%s", c.OrgID, fileID, req.Name)
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
	if mode != "html" && mode != "markdown" {
		writeErr(w, 400, "wrong_mode", "preview is only supported for html/markdown templates")
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

	var (
		out string
	)
	if mode == "markdown" {
		rendered, mderr := gmarkdown.PreviewWithLocale(srcStr, mergedData, pageLayout, locale, i18nCfg)
		if mderr != nil {
			writeJSON(w, 200, map[string]any{"html": "", "error": mderr.Error()})
			return
		}
		out = rendered
	} else {
		rendered, herr := ghtml.PreviewWithLocale(srcStr, mergedData, pageLayout, locale, i18nCfg)
		if herr != nil {
			writeJSON(w, 200, map[string]any{"html": "", "error": herr.Error()})
			return
		}
		out = rendered
	}
	resp := map[string]any{"html": out}
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
	var mode, storageKey string
	var cfgRaw []byte
	var currentVersion int
	err := h.DB.QueryRow(r.Context(),
		`SELECT t.mode, t.config_json, t.version, f.storage_key
		 FROM templates t JOIN files f ON f.id=t.file_id
		 WHERE t.id=$1 AND t.org_id=$2`, id, c.OrgID,
	).Scan(&mode, &cfgRaw, &currentVersion, &storageKey)
	if err != nil {
		writeErr(w, 404, "not_found", "template not found")
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
	if mode != "html" && mode != "markdown" {
		writeErr(w, 400, "wrong_mode", "source edits only supported for html/markdown templates")
		return
	}

	// Overwrite the file in MinIO.
	contentType := "text/html"
	if mode == "markdown" {
		contentType = "text/markdown"
	}
	if err := h.Storage.PutBytes(r.Context(), storageKey, contentType, []byte(req.Source)); err != nil {
		writeErr(w, 500, "storage", err.Error())
		return
	}

	// Re-extract placeholders and merge into config.
	cfg := map[string]interface{}{}
	_ = json.Unmarshal(cfgRaw, &cfg)
	if mode == "markdown" {
		cfg["placeholders"] = gmarkdown.ExtractPlaceholders(req.Source)
	} else {
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
	var key, name string
	err := h.DB.QueryRow(r.Context(),
		`SELECT f.storage_key, f.name FROM templates t
		 JOIN files f ON f.id=t.file_id
		 WHERE t.id=$1 AND t.org_id=$2`, id, c.OrgID,
	).Scan(&key, &name)
	if err != nil {
		writeErr(w, 404, "not_found", "template not found")
		return
	}
	url, err := h.Storage.PresignGet(r.Context(), key, "", 10*time.Minute)
	if err != nil {
		writeErr(w, 500, "presign", err.Error())
		return
	}
	writeJSON(w, 200, map[string]string{"url": url, "name": name})
}

func isPDF(mime, name string) bool {
	if strings.Contains(mime, "pdf") {
		return true
	}
	return strings.EqualFold(filepath.Ext(name), ".pdf")
}

func writeJSON(w http.ResponseWriter, code int, v interface{}) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(code)
	_ = json.NewEncoder(w).Encode(v)
}

func writeErr(w http.ResponseWriter, code int, slug, msg string) {
	writeJSON(w, code, map[string]any{"error": map[string]string{"code": slug, "message": msg}})
}
