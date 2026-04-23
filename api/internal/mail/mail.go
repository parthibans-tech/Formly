// Package mail wraps the email package with HTTP handlers and persistence.
// Separate from `internal/email` (the provider layer) so the frontend-facing
// routes stay cohesive alongside DB audit logging.
package mail

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"strings"
	"time"

	"github.com/docforge/api/internal/auth"
	"github.com/docforge/api/internal/email"
	"github.com/docforge/api/internal/events"
	"github.com/docforge/api/internal/generate"
	"github.com/docforge/api/internal/storage"
	"github.com/go-chi/chi/v5"
	"github.com/jackc/pgx/v5"
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

// -- settings endpoints --------------------------------------------------

type settingsDTO struct {
	Provider      string                 `json:"provider"`
	FromName      string                 `json:"fromName,omitempty"`
	FromEmail     string                 `json:"fromEmail,omitempty"`
	ReplyTo       string                 `json:"replyTo,omitempty"`
	Config        map[string]interface{} `json:"config,omitempty"`
	UpdatedAt     string                 `json:"updatedAt,omitempty"`
	IsConfigured  bool                   `json:"isConfigured"`
}

func (h *Handler) GetSettings(w http.ResponseWriter, r *http.Request) {
	c := r.Context().Value(auth.UserCtxKey).(*auth.Claims)
	var (
		provider, fromName, fromEmail, replyTo string
		cfg                                    []byte
		updatedAt                              time.Time
	)
	err := h.DB.QueryRow(r.Context(), `
		SELECT provider, COALESCE(from_name,''), from_email, COALESCE(reply_to,''), config, updated_at
		  FROM email_settings WHERE org_id=$1`, c.OrgID,
	).Scan(&provider, &fromName, &fromEmail, &replyTo, &cfg, &updatedAt)
	if err != nil {
		if err == pgx.ErrNoRows {
			writeJSON(w, 200, settingsDTO{Provider: "", IsConfigured: false})
			return
		}
		writeErr(w, 500, "db_error", err.Error())
		return
	}
	var extra map[string]interface{}
	_ = json.Unmarshal(cfg, &extra)
	// Redact obvious secrets.
	if extra != nil {
		for _, k := range []string{"password", "apiKey", "secret"} {
			if _, ok := extra[k]; ok {
				extra[k] = "●●●●●●"
			}
		}
	}
	writeJSON(w, 200, settingsDTO{
		Provider: provider, FromName: fromName, FromEmail: fromEmail,
		ReplyTo: replyTo, Config: extra,
		UpdatedAt: updatedAt.Format(time.RFC3339), IsConfigured: true,
	})
}

type saveSettingsReq struct {
	Provider  string                 `json:"provider"`
	FromName  string                 `json:"fromName"`
	FromEmail string                 `json:"fromEmail"`
	ReplyTo   string                 `json:"replyTo"`
	Config    map[string]interface{} `json:"config"`
}

func (h *Handler) SaveSettings(w http.ResponseWriter, r *http.Request) {
	c := r.Context().Value(auth.UserCtxKey).(*auth.Claims)
	var req saveSettingsReq
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeErr(w, 400, "invalid_body", err.Error())
		return
	}
	req.Provider = strings.ToLower(strings.TrimSpace(req.Provider))
	if req.Provider == "" {
		writeErr(w, 400, "missing_provider", "provider is required")
		return
	}
	if req.FromEmail == "" {
		writeErr(w, 400, "missing_from", "from email is required")
		return
	}

	// Merge redacted secrets from the existing row — clients may round-trip
	// placeholders like `●●●●●●` from GET; we should preserve the actual value.
	if req.Config != nil {
		var existing []byte
		_ = h.DB.QueryRow(r.Context(),
			`SELECT config FROM email_settings WHERE org_id=$1`, c.OrgID).Scan(&existing)
		if len(existing) > 0 {
			var ex map[string]interface{}
			_ = json.Unmarshal(existing, &ex)
			for k, v := range req.Config {
				if s, ok := v.(string); ok && strings.Trim(s, "●") == "" {
					if orig, ok := ex[k]; ok {
						req.Config[k] = orig
					}
				}
			}
		}
	}

	// Validate the provider builds with the supplied config.
	if _, err := email.Build(email.Config{
		Provider: req.Provider, FromEmail: req.FromEmail, FromName: req.FromName,
		ReplyTo: req.ReplyTo, Extra: req.Config,
	}); err != nil {
		writeErr(w, 400, "bad_config", err.Error())
		return
	}
	cfgBytes, _ := json.Marshal(req.Config)

	_, err := h.DB.Exec(r.Context(), `
		INSERT INTO email_settings (org_id, provider, from_name, from_email, reply_to, config, updated_by)
		VALUES ($1,$2,NULLIF($3,''),$4,NULLIF($5,''),$6,$7)
		ON CONFLICT (org_id) DO UPDATE
		  SET provider=EXCLUDED.provider,
		      from_name=EXCLUDED.from_name,
		      from_email=EXCLUDED.from_email,
		      reply_to=EXCLUDED.reply_to,
		      config=EXCLUDED.config,
		      updated_at=now(),
		      updated_by=EXCLUDED.updated_by`,
		c.OrgID, req.Provider, req.FromName, req.FromEmail, req.ReplyTo, cfgBytes, c.UserID,
	)
	if err != nil {
		writeErr(w, 500, "db_error", err.Error())
		return
	}
	writeJSON(w, 200, map[string]any{"ok": true})
}

// TestSend fires a plaintext email to the caller to verify delivery works.
func (h *Handler) TestSend(w http.ResponseWriter, r *http.Request) {
	c := r.Context().Value(auth.UserCtxKey).(*auth.Claims)
	var req struct {
		To string `json:"to"`
	}
	_ = json.NewDecoder(r.Body).Decode(&req)
	if req.To == "" {
		req.To = c.Email
	}
	cfg, err := h.loadConfig(r.Context(), c.OrgID)
	if err != nil {
		writeErr(w, 400, "no_settings", "email settings are not configured")
		return
	}
	prov, err := email.Build(cfg)
	if err != nil {
		writeErr(w, 400, "bad_config", err.Error())
		return
	}
	if _, err := prov.Send(r.Context(), email.Message{
		From: cfg.FromEmail, FromName: cfg.FromName, ReplyTo: cfg.ReplyTo,
		To: []string{req.To}, Subject: "Formly test email",
		TextBody: "This is a test from Formly — your email settings are working.",
		HTMLBody: "<p>This is a test from <strong>Formly</strong> — your email settings are working.</p>",
	}); err != nil {
		writeErr(w, 502, "send_failed", err.Error())
		return
	}
	writeJSON(w, 200, map[string]any{"ok": true, "to": req.To})
}

// -- send endpoint -------------------------------------------------------

type sendReq struct {
	Data     map[string]interface{} `json:"data"`
	To       []string               `json:"to"`
	CC       []string               `json:"cc,omitempty"`
	BCC      []string               `json:"bcc,omitempty"`
	Subject  string                 `json:"subject"`
	Body     string                 `json:"body,omitempty"`
	HTMLBody string                 `json:"htmlBody,omitempty"`
	Filename string                 `json:"filename,omitempty"`
}

func (h *Handler) SendTemplate(w http.ResponseWriter, r *http.Request) {
	c := r.Context().Value(auth.UserCtxKey).(*auth.Claims)
	tplID := chi.URLParam(r, "id")
	var req sendReq
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeErr(w, 400, "invalid_body", err.Error())
		return
	}
	if len(req.To) == 0 {
		writeErr(w, 400, "no_recipients", "at least one recipient is required")
		return
	}
	if strings.TrimSpace(req.Subject) == "" {
		req.Subject = "Your document from Formly"
	}

	cfg, err := h.loadConfig(r.Context(), c.OrgID)
	if err != nil {
		writeErr(w, 400, "no_settings", "email is not configured for this organization")
		return
	}
	prov, err := email.Build(cfg)
	if err != nil {
		writeErr(w, 400, "bad_config", err.Error())
		return
	}

	// Generate the PDF first so send failures don't lose the file.
	res, err := h.Runner.Run(r.Context(), c.OrgID, c.UserID, tplID, req.Data, false)
	if err != nil {
		writeErr(w, 500, "render", err.Error())
		return
	}
	pdfBytes, err := h.Storage.GetBytes(r.Context(), res.OutputKey)
	if err != nil {
		writeErr(w, 500, "storage", err.Error())
		return
	}

	filename := req.Filename
	if filename == "" {
		filename = res.OutputName
	}

	msg := email.Message{
		From: cfg.FromEmail, FromName: cfg.FromName, ReplyTo: cfg.ReplyTo,
		To: req.To, CC: req.CC, BCC: req.BCC,
		Subject:  req.Subject,
		TextBody: req.Body,
		HTMLBody: req.HTMLBody,
		Attachments: []email.Attachment{{
			Filename:    filename,
			ContentType: "application/pdf",
			Data:        pdfBytes,
		}},
	}
	sendRes, sendErr := prov.Send(r.Context(), msg)

	status := "sent"
	providerID := sendRes.ProviderID
	var errStr *string
	if sendErr != nil {
		status = "failed"
		s := sendErr.Error()
		errStr = &s
	}
	var sendID string
	_ = h.DB.QueryRow(r.Context(), `
		INSERT INTO email_sends
		  (org_id, user_id, template_id, output_file_id, recipients, cc, bcc, subject, provider, status, provider_id, error)
		VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
		RETURNING id
	`, c.OrgID, c.UserID, tplID, res.OutputFileID, req.To, req.CC, req.BCC, req.Subject, cfg.Provider, status, providerID, errStr).Scan(&sendID)

	if sendErr != nil {
		events.Publish(r.Context(), "email.failed", c.OrgID, map[string]interface{}{
			"templateId":   tplID,
			"outputFileId": res.OutputFileID,
			"error":        sendErr.Error(),
			"recipients":   req.To,
		})
		writeErr(w, 502, "send_failed", sendErr.Error())
		return
	}

	events.Publish(r.Context(), "email.sent", c.OrgID, map[string]interface{}{
		"emailId":      sendID,
		"templateId":   tplID,
		"outputFileId": res.OutputFileID,
		"recipients":   req.To,
		"provider":     cfg.Provider,
		"providerId":   providerID,
	})

	writeJSON(w, 200, map[string]any{
		"emailId":      sendID,
		"outputFileId": res.OutputFileID,
		"outputName":   res.OutputName,
		"provider":     cfg.Provider,
		"providerId":   providerID,
	})
}

// -- audit list ----------------------------------------------------------

func (h *Handler) ListSends(w http.ResponseWriter, r *http.Request) {
	c := r.Context().Value(auth.UserCtxKey).(*auth.Claims)
	rows, err := h.DB.Query(r.Context(), `
		SELECT id, template_id, output_file_id, recipients, subject, provider, status, provider_id, error, created_at
		  FROM email_sends WHERE org_id=$1 ORDER BY created_at DESC LIMIT 100`, c.OrgID)
	if err != nil {
		writeErr(w, 500, "db_error", err.Error())
		return
	}
	defer rows.Close()
	out := []map[string]any{}
	for rows.Next() {
		var (
			id                                  string
			templateID, outputFileID            *string
			recipients                          []string
			subject, provider, status           string
			providerID, errStr                  *string
			createdAt                           time.Time
		)
		if err := rows.Scan(&id, &templateID, &outputFileID, &recipients, &subject, &provider, &status, &providerID, &errStr, &createdAt); err != nil {
			continue
		}
		out = append(out, map[string]any{
			"id":           id,
			"templateId":   templateID,
			"outputFileId": outputFileID,
			"recipients":   recipients,
			"subject":      subject,
			"provider":     provider,
			"status":       status,
			"providerId":   providerID,
			"error":        errStr,
			"createdAt":    createdAt.Format(time.RFC3339),
		})
	}
	writeJSON(w, 200, map[string]any{"sends": out})
}

// -- internals -----------------------------------------------------------

func (h *Handler) loadConfig(ctx context.Context, orgID string) (email.Config, error) {
	var cfg email.Config
	var extra []byte
	err := h.DB.QueryRow(ctx, `
		SELECT provider, COALESCE(from_name,''), from_email, COALESCE(reply_to,''), config
		  FROM email_settings WHERE org_id=$1`, orgID,
	).Scan(&cfg.Provider, &cfg.FromName, &cfg.FromEmail, &cfg.ReplyTo, &extra)
	if err != nil {
		return email.Config{}, err
	}
	_ = json.Unmarshal(extra, &cfg.Extra)
	return cfg, nil
}

func writeJSON(w http.ResponseWriter, code int, v interface{}) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(code)
	_ = json.NewEncoder(w).Encode(v)
}

func writeErr(w http.ResponseWriter, code int, slug, msg string) {
	writeJSON(w, code, map[string]any{"error": map[string]string{"code": slug, "message": msg}})
}

// Silence unused-import warning in edge cases.
var _ = fmt.Sprintf
