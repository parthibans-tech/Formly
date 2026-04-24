// Package formlinks implements public "fill this template" URLs. Anyone with
// the link can open an auto-generated form, submit data, and get a rendered
// PDF — no Drive360 account required.
package formlinks

import (
	"context"
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"net/http"
	"strings"
	"time"

	"github.com/docforge/api/internal/auth"
	"github.com/docforge/api/internal/events"
	"github.com/docforge/api/internal/generate"
	"github.com/docforge/api/internal/storage"
	"github.com/go-chi/chi/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

type Handler struct {
	DB      *pgxpool.Pool
	Storage *storage.Client
	Runner  *generate.Runner
}

func New(db *pgxpool.Pool, s *storage.Client, r *generate.Runner) *Handler {
	return &Handler{DB: db, Storage: s, Runner: r}
}

// -- authenticated endpoints ---------------------------------------------

type linkDTO struct {
	ID             string  `json:"id"`
	Token          string  `json:"token"`
	TemplateID     string  `json:"templateId"`
	Title          *string `json:"title"`
	Description    *string `json:"description"`
	SubmitLabel    *string `json:"submitLabel"`
	SuccessMessage *string `json:"successMessage"`
	Active         bool    `json:"active"`
	CreatedAt      string  `json:"createdAt"`
	ExpiresAt      *string `json:"expiresAt"`
}

func (h *Handler) List(w http.ResponseWriter, r *http.Request) {
	c := r.Context().Value(auth.UserCtxKey).(*auth.Claims)
	tplID := chi.URLParam(r, "id")
	rows, err := h.DB.Query(r.Context(), `
		SELECT id, token, template_id, title, description, submit_label,
		       success_message, active, created_at, expires_at
		  FROM form_links
		 WHERE template_id=$1 AND org_id=$2
		 ORDER BY created_at DESC`, tplID, c.OrgID)
	if err != nil {
		writeErr(w, 500, "db_error", err.Error())
		return
	}
	defer rows.Close()
	out := []linkDTO{}
	for rows.Next() {
		var (
			id, token, templateID                     string
			title, desc, submit, success              *string
			active                                    bool
			createdAt                                 time.Time
			expiresAt                                 *time.Time
		)
		if err := rows.Scan(&id, &token, &templateID, &title, &desc, &submit, &success, &active, &createdAt, &expiresAt); err != nil {
			continue
		}
		d := linkDTO{
			ID: id, Token: token, TemplateID: templateID,
			Title: title, Description: desc,
			SubmitLabel: submit, SuccessMessage: success,
			Active: active, CreatedAt: createdAt.Format(time.RFC3339),
		}
		if expiresAt != nil {
			s := expiresAt.Format(time.RFC3339)
			d.ExpiresAt = &s
		}
		out = append(out, d)
	}
	writeJSON(w, 200, map[string]any{"links": out})
}

type createReq struct {
	Title          string `json:"title,omitempty"`
	Description    string `json:"description,omitempty"`
	SubmitLabel    string `json:"submitLabel,omitempty"`
	SuccessMessage string `json:"successMessage,omitempty"`
	ExpiresInDays  int    `json:"expiresInDays,omitempty"`
}

func (h *Handler) Create(w http.ResponseWriter, r *http.Request) {
	c := r.Context().Value(auth.UserCtxKey).(*auth.Claims)
	tplID := chi.URLParam(r, "id")
	// Ownership check.
	var orgOwner string
	if err := h.DB.QueryRow(r.Context(),
		`SELECT org_id FROM templates WHERE id=$1`, tplID).Scan(&orgOwner); err != nil {
		writeErr(w, 404, "not_found", "template not found")
		return
	}
	if orgOwner != c.OrgID {
		writeErr(w, 404, "not_found", "template not found")
		return
	}
	var req createReq
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil && err.Error() != "EOF" {
		writeErr(w, 400, "invalid_body", err.Error())
		return
	}
	tok, err := token()
	if err != nil {
		writeErr(w, 500, "rand", err.Error())
		return
	}
	var expiresAt *time.Time
	if req.ExpiresInDays > 0 {
		t := time.Now().AddDate(0, 0, req.ExpiresInDays)
		expiresAt = &t
	}
	var id string
	var createdAt time.Time
	err = h.DB.QueryRow(r.Context(), `
		INSERT INTO form_links
		  (org_id, template_id, token, title, description, submit_label, success_message, expires_at)
		VALUES ($1,$2,$3,NULLIF($4,''),NULLIF($5,''),NULLIF($6,''),NULLIF($7,''),$8)
		RETURNING id, created_at
	`, c.OrgID, tplID, tok,
		strings.TrimSpace(req.Title),
		strings.TrimSpace(req.Description),
		strings.TrimSpace(req.SubmitLabel),
		strings.TrimSpace(req.SuccessMessage),
		expiresAt,
	).Scan(&id, &createdAt)
	if err != nil {
		writeErr(w, 500, "db_error", err.Error())
		return
	}
	writeJSON(w, 200, map[string]any{
		"id":         id,
		"token":      tok,
		"createdAt":  createdAt.Format(time.RFC3339),
	})
}

type updateReq struct {
	Title          *string `json:"title,omitempty"`
	Description    *string `json:"description,omitempty"`
	SubmitLabel    *string `json:"submitLabel,omitempty"`
	SuccessMessage *string `json:"successMessage,omitempty"`
	Active         *bool   `json:"active,omitempty"`
}

func (h *Handler) Update(w http.ResponseWriter, r *http.Request) {
	c := r.Context().Value(auth.UserCtxKey).(*auth.Claims)
	id := chi.URLParam(r, "id")
	var req updateReq
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeErr(w, 400, "invalid_body", err.Error())
		return
	}
	_, err := h.DB.Exec(r.Context(), `
		UPDATE form_links SET
		  title           = COALESCE($3, title),
		  description     = COALESCE($4, description),
		  submit_label    = COALESCE($5, submit_label),
		  success_message = COALESCE($6, success_message),
		  active          = COALESCE($7, active)
		 WHERE id=$1 AND org_id=$2`,
		id, c.OrgID,
		req.Title, req.Description, req.SubmitLabel, req.SuccessMessage, req.Active,
	)
	if err != nil {
		writeErr(w, 500, "db_error", err.Error())
		return
	}
	writeJSON(w, 200, map[string]any{"ok": true})
}

func (h *Handler) Delete(w http.ResponseWriter, r *http.Request) {
	c := r.Context().Value(auth.UserCtxKey).(*auth.Claims)
	id := chi.URLParam(r, "id")
	tag, err := h.DB.Exec(r.Context(),
		`DELETE FROM form_links WHERE id=$1 AND org_id=$2`, id, c.OrgID)
	if err != nil {
		writeErr(w, 500, "db_error", err.Error())
		return
	}
	if tag.RowsAffected() == 0 {
		writeErr(w, 404, "not_found", "form link not found")
		return
	}
	writeJSON(w, 200, map[string]any{"ok": true})
}

// -- public (unauthenticated) endpoints ----------------------------------

type resolveResp struct {
	Token          string   `json:"token"`
	Title          string   `json:"title"`
	Description    string   `json:"description,omitempty"`
	SubmitLabel    string   `json:"submitLabel"`
	SuccessMessage string   `json:"successMessage,omitempty"`
	TemplateName   string   `json:"templateName"`
	Placeholders   []string `json:"placeholders"`
}

// Resolve returns the public form schema for a given token.
func (h *Handler) Resolve(w http.ResponseWriter, r *http.Request) {
	token := chi.URLParam(r, "token")
	var (
		formID, orgID, templateID, templateName string
		title, desc, submit, success            *string
		active                                  bool
		expiresAt                               *time.Time
		cfgRaw                                  []byte
	)
	err := h.DB.QueryRow(r.Context(), `
		SELECT fl.id, fl.org_id, fl.template_id, t.name, fl.title, fl.description,
		       fl.submit_label, fl.success_message, fl.active, fl.expires_at, t.config_json
		  FROM form_links fl JOIN templates t ON t.id = fl.template_id
		 WHERE fl.token=$1`, token,
	).Scan(&formID, &orgID, &templateID, &templateName, &title, &desc, &submit, &success, &active, &expiresAt, &cfgRaw)
	if err != nil {
		writeErr(w, 404, "not_found", "form not found")
		return
	}
	if !active {
		writeErr(w, 410, "inactive", "form is not active")
		return
	}
	if expiresAt != nil && expiresAt.Before(time.Now()) {
		writeErr(w, 410, "expired", "form link has expired")
		return
	}
	// Extract placeholders from config_json if present.
	var cfg struct {
		Placeholders []string `json:"placeholders"`
	}
	_ = json.Unmarshal(cfgRaw, &cfg)

	resp := resolveResp{
		Token:        token,
		TemplateName: templateName,
		Placeholders: cfg.Placeholders,
		SubmitLabel:  valueOr(submit, "Submit"),
	}
	if title != nil {
		resp.Title = *title
	} else {
		resp.Title = templateName
	}
	if desc != nil {
		resp.Description = *desc
	}
	if success != nil {
		resp.SuccessMessage = *success
	}
	writeJSON(w, 200, resp)
}

// Submit accepts the filled form payload, generates a PDF, and returns a
// signed download URL. The generation runs synchronously so the browser can
// redirect to the download immediately.
func (h *Handler) Submit(w http.ResponseWriter, r *http.Request) {
	token := chi.URLParam(r, "token")
	var req struct {
		Data map[string]interface{} `json:"data"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeErr(w, 400, "invalid_body", err.Error())
		return
	}
	if req.Data == nil {
		req.Data = map[string]interface{}{}
	}

	var (
		formID, orgID, templateID string
		active                    bool
		expiresAt                 *time.Time
	)
	err := h.DB.QueryRow(r.Context(), `
		SELECT id, org_id, template_id, active, expires_at
		  FROM form_links WHERE token=$1`, token,
	).Scan(&formID, &orgID, &templateID, &active, &expiresAt)
	if err != nil {
		writeErr(w, 404, "not_found", "form not found")
		return
	}
	if !active {
		writeErr(w, 410, "inactive", "form is not active")
		return
	}
	if expiresAt != nil && expiresAt.Before(time.Now()) {
		writeErr(w, 410, "expired", "form link has expired")
		return
	}

	// The submitter isn't authenticated. Attribute the generation to whichever
	// user in the org owns the form link so the files table's FK is satisfied.
	var ownerUser string
	if err := h.DB.QueryRow(r.Context(),
		`SELECT id FROM users WHERE org_id=$1 ORDER BY created_at ASC LIMIT 1`, orgID,
	).Scan(&ownerUser); err != nil {
		writeErr(w, 500, "no_owner", "no users in org")
		return
	}

	res, err := h.Runner.Run(r.Context(), orgID, ownerUser, templateID, req.Data, false)
	if err != nil {
		writeErr(w, 500, "render", err.Error())
		return
	}

	// Pre-signed download URL valid for 10m.
	dl, err := h.Storage.PresignGet(r.Context(), res.OutputKey, res.OutputName, 10*time.Minute)
	if err != nil {
		writeErr(w, 500, "presign", err.Error())
		return
	}

	ip := clientIP(r)
	ua := r.UserAgent()
	dataJSON, _ := json.Marshal(req.Data)
	_, _ = h.DB.Exec(r.Context(), `
		INSERT INTO form_submissions (form_link_id, template_id, data, output_file_id, ip, user_agent)
		VALUES ($1,$2,$3,$4,$5,$6)
	`, formID, templateID, dataJSON, res.OutputFileID, ip, ua)

	events.Publish(r.Context(), "form.submitted", orgID, map[string]interface{}{
		"formLinkId":   formID,
		"templateId":   templateID,
		"outputFileId": res.OutputFileID,
	})

	writeJSON(w, 200, map[string]any{
		"downloadUrl":  dl,
		"outputFileId": res.OutputFileID,
		"outputName":   res.OutputName,
	})
}

// -- helpers -------------------------------------------------------------

func token() (string, error) {
	var b [18]byte
	if _, err := rand.Read(b[:]); err != nil {
		return "", err
	}
	return base64.RawURLEncoding.EncodeToString(b[:]), nil
}

func valueOr(p *string, def string) string {
	if p == nil || *p == "" {
		return def
	}
	return *p
}

func clientIP(r *http.Request) string {
	if v := r.Header.Get("X-Forwarded-For"); v != "" {
		return v
	}
	return r.RemoteAddr
}

// Used to silence the unused import warning if this file ever drops ctx.
var _ = context.Background

func writeJSON(w http.ResponseWriter, code int, v interface{}) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(code)
	_ = json.NewEncoder(w).Encode(v)
}

func writeErr(w http.ResponseWriter, code int, slug, msg string) {
	writeJSON(w, code, map[string]any{"error": map[string]string{"code": slug, "message": msg}})
}
