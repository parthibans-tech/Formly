package templates

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"path/filepath"
	"strings"
	"time"

	"github.com/docforge/api/internal/auth"
	"github.com/docforge/api/internal/generate"
	"github.com/docforge/api/internal/generate/acroform"
	ghtml "github.com/docforge/api/internal/generate/html"
	gstatic "github.com/docforge/api/internal/generate/static"
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
// Anything else → no template.
func (h *Handler) DetectAndCreate(ctx context.Context, fileID, orgID, name, mime, storageKey string) (string, error) {
	switch {
	case isPDF(mime, name):
		return h.detectPDF(ctx, fileID, orgID, name, storageKey)
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
	Config map[string]interface{} `json:"config"`
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

// Batch accepts a multipart CSV upload and enqueues a batch job that produces a ZIP.
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
	file, hdr, err := r.FormFile("csv")
	if err != nil {
		writeErr(w, 400, "missing_csv", "expected form field 'csv'")
		return
	}
	defer file.Close()
	body, err := io.ReadAll(file)
	if err != nil {
		writeErr(w, 400, "read_csv", err.Error())
		return
	}

	jobID, err := jobs.Create(r.Context(), h.DB, c.OrgID, c.UserID, id, "batch", 0)
	if err != nil {
		writeErr(w, 500, "db_error", err.Error())
		return
	}
	csvKey := fmt.Sprintf("orgs/%s/batch-input/%s/%s", c.OrgID, jobID, hdr.Filename)
	if err := h.Storage.PutBytes(r.Context(), csvKey, "text/csv", body); err != nil {
		writeErr(w, 500, "storage", err.Error())
		return
	}
	baseName := strings.TrimSuffix(hdr.Filename, filepath.Ext(hdr.Filename))
	outName := baseName + "-batch-" + time.Now().Format("20060102-150405") + ".zip"

	task, err := queue.NewGenerateBatch(queue.GenerateBatchPayload{
		JobID: jobID, OrgID: c.OrgID, UserID: c.UserID, TemplateID: id,
		CSVKey: csvKey, OutputName: outName,
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
		Source string `json:"source"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeErr(w, 400, "invalid_body", err.Error())
		return
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
	if mode != "html" {
		writeErr(w, 400, "wrong_mode", "source edits only supported for html templates")
		return
	}

	// Overwrite the file in MinIO.
	if err := h.Storage.PutBytes(r.Context(), storageKey, "text/html", []byte(req.Source)); err != nil {
		writeErr(w, 500, "storage", err.Error())
		return
	}

	// Re-extract placeholders and merge into config.
	cfg := map[string]interface{}{}
	_ = json.Unmarshal(cfgRaw, &cfg)
	cfg["placeholders"] = ghtml.ExtractPlaceholders(req.Source)
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
