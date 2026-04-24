// Package mail wraps the email package with HTTP handlers and persistence.
// Separate from `internal/email` (the provider layer) so the frontend-facing
// routes stay cohesive alongside the audit log + super-admin tracking.
//
// The actual send-and-audit pipeline lives in mailer.go (Mailer struct).
// Every other package — sharing.access_requests, team.invites, mfa,
// scheduled.runs — should call Mailer.Send rather than building an
// email.Provider themselves so audit + env fallback stay consistent.
package mail

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/docforge/api/internal/auth"
	"github.com/docforge/api/internal/email"
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

	// Mailer is the shared sender every other package can reach via
	// the public Send method. We keep it on the handler so the HTTP
	// routes (TestSend, SendTemplate) and the package's helpers
	// share one configured instance.
	Mailer *Mailer
}

func New(db *pgxpool.Pool, s *storage.Client, r *generate.Runner) *Handler {
	return &Handler{DB: db, Storage: s, Runner: r, Mailer: NewMailer(db)}
}

// -- settings endpoints --------------------------------------------------

type settingsDTO struct {
	Provider     string                 `json:"provider"`
	FromName     string                 `json:"fromName,omitempty"`
	FromEmail    string                 `json:"fromEmail,omitempty"`
	ReplyTo      string                 `json:"replyTo,omitempty"`
	Config       map[string]interface{} `json:"config,omitempty"`
	UpdatedAt    string                 `json:"updatedAt,omitempty"`
	IsConfigured bool                   `json:"isConfigured"`

	// EnvFallback exposes whether the system has an env-based default
	// the org will use when this row is missing. The settings page
	// surfaces this so admins know mail will work even if they don't
	// configure anything per-org.
	EnvFallback *envFallbackDTO `json:"envFallback,omitempty"`
}

type envFallbackDTO struct {
	Provider  string `json:"provider"`
	FromEmail string `json:"fromEmail"`
	FromName  string `json:"fromName,omitempty"`
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
			writeJSON(w, 200, settingsDTO{
				Provider: "", IsConfigured: false,
				EnvFallback: h.envFallbackDTO(),
			})
			return
		}
		writeErr(w, 500, "db_error", err.Error())
		return
	}
	var extra map[string]interface{}
	_ = json.Unmarshal(cfg, &extra)
	// Redact obvious secrets before sending the row back to the browser.
	if extra != nil {
		for _, k := range []string{"password", "apiKey", "secret", "secretKey"} {
			if _, ok := extra[k]; ok {
				extra[k] = "●●●●●●"
			}
		}
	}
	writeJSON(w, 200, settingsDTO{
		Provider: provider, FromName: fromName, FromEmail: fromEmail,
		ReplyTo: replyTo, Config: extra,
		UpdatedAt: updatedAt.Format(time.RFC3339), IsConfigured: true,
		EnvFallback: h.envFallbackDTO(),
	})
}

func (h *Handler) envFallbackDTO() *envFallbackDTO {
	if !h.Mailer.envHasFrom {
		return nil
	}
	return &envFallbackDTO{
		Provider:  h.Mailer.envCfg.Provider,
		FromEmail: h.Mailer.envCfg.FromEmail,
		FromName:  h.Mailer.envCfg.FromName,
	}
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
// Routes through the Mailer so it's audited like every other send and the
// admin can see "yes, the test attempt did go out and got providerID X."
func (h *Handler) TestSend(w http.ResponseWriter, r *http.Request) {
	c := r.Context().Value(auth.UserCtxKey).(*auth.Claims)
	var req struct {
		To string `json:"to"`
	}
	_ = json.NewDecoder(r.Body).Decode(&req)
	if req.To == "" {
		req.To = c.Email
	}

	_, err := h.Mailer.Send(r.Context(), SendOptions{
		OrgID:  c.OrgID,
		UserID: c.UserID,
		Kind:   "test",
		Source: "mail.test",
		Message: email.Message{
			To:       []string{req.To},
			Subject:  "Drive360 test email",
			TextBody: "This is a test from Drive360 — your email settings are working.",
			HTMLBody: "<p>This is a test from <strong>Drive360</strong> — your email settings are working.</p>",
		},
	})
	if err != nil {
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
		req.Subject = "Your document from Drive360"
	}

	// Generate the PDF first so send failures don't lose the file —
	// the audit row will reference the OutputFileID either way.
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

	sendID, sendErr := h.Mailer.Send(r.Context(), SendOptions{
		OrgID:        c.OrgID,
		UserID:       c.UserID,
		Kind:         "template",
		Source:       "mail.send_template",
		TemplateID:   tplID,
		OutputFileID: res.OutputFileID,
		Metadata: map[string]any{
			"outputName": res.OutputName,
		},
		Message: email.Message{
			To: req.To, CC: req.CC, BCC: req.BCC,
			Subject:  req.Subject,
			TextBody: req.Body,
			HTMLBody: req.HTMLBody,
			Attachments: []email.Attachment{{
				Filename:    filename,
				ContentType: "application/pdf",
				Data:        pdfBytes,
			}},
		},
	})
	if sendErr != nil {
		writeErr(w, 502, "send_failed", sendErr.Error())
		return
	}

	writeJSON(w, 200, map[string]any{
		"emailId":      sendID,
		"outputFileId": res.OutputFileID,
		"outputName":   res.OutputName,
	})
}

// -- audit list ----------------------------------------------------------

// ListSends returns the org-scoped audit log. Filterable by ?kind, ?status,
// and ?source so the settings page can show "just my access-request mails."
func (h *Handler) ListSends(w http.ResponseWriter, r *http.Request) {
	c := r.Context().Value(auth.UserCtxKey).(*auth.Claims)
	rows, err := h.querySends(r.Context(), querySendsOpts{
		OrgID:  c.OrgID,
		Kind:   r.URL.Query().Get("kind"),
		Source: r.URL.Query().Get("source"),
		Status: r.URL.Query().Get("status"),
		Limit:  parseLimit(r.URL.Query().Get("limit"), 100, 500),
	})
	if err != nil {
		writeErr(w, 500, "db_error", err.Error())
		return
	}
	writeJSON(w, 200, map[string]any{"sends": rows})
}

// ListSendsAdmin is the super-admin / cross-org view. Returns sends from
// every org in the platform with the same filters as ListSends plus an
// optional ?orgId=… for narrowing. Gated to admin role — for a true
// super-admin role you'd add an extra check, but we treat org admins as
// platform admins in single-tenant deployments.
func (h *Handler) ListSendsAdmin(w http.ResponseWriter, r *http.Request) {
	c := r.Context().Value(auth.UserCtxKey).(*auth.Claims)
	if !c.IsAdmin() {
		writeErr(w, 403, "forbidden", "admin role required")
		return
	}
	rows, err := h.querySends(r.Context(), querySendsOpts{
		AllOrgs: true,
		OrgID:   r.URL.Query().Get("orgId"),
		Kind:    r.URL.Query().Get("kind"),
		Source:  r.URL.Query().Get("source"),
		Status:  r.URL.Query().Get("status"),
		Limit:   parseLimit(r.URL.Query().Get("limit"), 200, 1000),
	})
	if err != nil {
		writeErr(w, 500, "db_error", err.Error())
		return
	}
	writeJSON(w, 200, map[string]any{"sends": rows})
}

type querySendsOpts struct {
	OrgID, Kind, Source, Status string
	AllOrgs                     bool
	Limit                       int
}

// querySends builds the SELECT dynamically because we want optional
// filters but don't want a goose-egg query plan from a half-empty
// query. Each filter contributes at most one positional arg.
func (h *Handler) querySends(ctx context.Context, q querySendsOpts) ([]map[string]any, error) {
	var (
		clauses []string
		args    []any
	)
	addArg := func(v any) string {
		args = append(args, v)
		return fmt.Sprintf("$%d", len(args))
	}
	if !q.AllOrgs {
		clauses = append(clauses, "org_id="+addArg(q.OrgID))
	} else if q.OrgID != "" {
		clauses = append(clauses, "org_id="+addArg(q.OrgID))
	}
	if q.Kind != "" {
		clauses = append(clauses, "kind="+addArg(q.Kind))
	}
	if q.Source != "" {
		clauses = append(clauses, "source="+addArg(q.Source))
	}
	if q.Status != "" {
		clauses = append(clauses, "status="+addArg(q.Status))
	}
	where := ""
	if len(clauses) > 0 {
		where = "WHERE " + strings.Join(clauses, " AND ")
	}
	limit := q.Limit
	if limit <= 0 {
		limit = 100
	}

	sqlStr := `
		SELECT id, org_id, user_id, template_id, output_file_id,
		       recipients, cc, bcc, subject,
		       provider, status, provider_id, error,
		       kind, source, metadata, COALESCE(from_email,''), COALESCE(from_name,''),
		       created_at
		  FROM email_sends ` + where + `
		 ORDER BY created_at DESC
		 LIMIT ` + strconv.Itoa(limit)
	rows, err := h.DB.Query(ctx, sqlStr, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	out := []map[string]any{}
	for rows.Next() {
		var (
			id, orgID                                 string
			userID, templateID, outputFileID          *string
			recipients, cc, bcc                       []string
			subject, provider, status                 string
			providerID, errStr                        *string
			kind, source                              string
			metadata                                  []byte
			fromEmail, fromName                       string
			createdAt                                 time.Time
		)
		if err := rows.Scan(
			&id, &orgID, &userID, &templateID, &outputFileID,
			&recipients, &cc, &bcc, &subject,
			&provider, &status, &providerID, &errStr,
			&kind, &source, &metadata, &fromEmail, &fromName,
			&createdAt,
		); err != nil {
			continue
		}
		var meta map[string]any
		_ = json.Unmarshal(metadata, &meta)
		out = append(out, map[string]any{
			"id":           id,
			"orgId":        orgID,
			"userId":       userID,
			"templateId":   templateID,
			"outputFileId": outputFileID,
			"recipients":   recipients,
			"cc":           cc,
			"bcc":          bcc,
			"subject":      subject,
			"provider":     provider,
			"status":       status,
			"providerId":   providerID,
			"error":        errStr,
			"kind":         kind,
			"source":       source,
			"metadata":     meta,
			"fromEmail":    fromEmail,
			"fromName":     fromName,
			"createdAt":    createdAt.Format(time.RFC3339),
		})
	}
	return out, nil
}

func parseLimit(raw string, def, max int) int {
	if raw == "" {
		return def
	}
	n, err := strconv.Atoi(raw)
	if err != nil || n <= 0 {
		return def
	}
	if n > max {
		return max
	}
	return n
}

func writeJSON(w http.ResponseWriter, code int, v interface{}) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(code)
	_ = json.NewEncoder(w).Encode(v)
}

func writeErr(w http.ResponseWriter, code int, slug, msg string) {
	writeJSON(w, code, map[string]any{"error": map[string]string{"code": slug, "message": msg}})
}

