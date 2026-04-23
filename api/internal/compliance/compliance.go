// Package compliance handles data-classification labels (public / internal /
// confidential / restricted) and legal holds that prevent deletion of files
// flagged by compliance or legal teams.
//
// Endpoints are admin-only; the classification/hold fields live on the
// `files` table itself (see migration 018).
package compliance

import (
	"encoding/json"
	"net/http"

	"github.com/go-chi/chi/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/docforge/api/internal/audit"
	"github.com/docforge/api/internal/auth"
)

type Handler struct {
	DB *pgxpool.Pool
}

func New(db *pgxpool.Pool) *Handler { return &Handler{DB: db} }

// ValidClassifications are the only accepted label values.
var ValidClassifications = map[string]bool{
	"public":       true,
	"internal":     true,
	"confidential": true,
	"restricted":   true,
}

/* ---------- Classification ---------- */

type classifyReq struct {
	Classification string `json:"classification"`
}

// SetClassification labels a file. Editors+ may downgrade; only admins may
// set a file to "restricted" or remove that label.
func (h *Handler) SetClassification(w http.ResponseWriter, r *http.Request) {
	c, _ := r.Context().Value(auth.UserCtxKey).(*auth.Claims)
	if c == nil {
		writeErr(w, 401, "unauthorized", "missing claims")
		return
	}
	fileID := chi.URLParam(r, "id")
	var req classifyReq
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeErr(w, 400, "invalid_body", err.Error())
		return
	}
	if !ValidClassifications[req.Classification] {
		writeErr(w, 400, "invalid_classification",
			"classification must be public|internal|confidential|restricted")
		return
	}
	// Admin required to touch restricted.
	if req.Classification == "restricted" && !c.IsAdmin() {
		writeErr(w, 403, "admin_only", "restricted classification is admin-only")
		return
	}

	var currentClass string
	err := h.DB.QueryRow(r.Context(),
		`SELECT classification FROM files WHERE id=$1 AND org_id=$2`,
		fileID, c.OrgID,
	).Scan(&currentClass)
	if err != nil {
		writeErr(w, 404, "not_found", "file not found")
		return
	}
	if currentClass == "restricted" && !c.IsAdmin() {
		writeErr(w, 403, "admin_only",
			"only admins can re-classify a restricted file")
		return
	}

	if _, err := h.DB.Exec(r.Context(),
		`UPDATE files SET classification=$1 WHERE id=$2 AND org_id=$3`,
		req.Classification, fileID, c.OrgID,
	); err != nil {
		writeErr(w, 500, "db_error", err.Error())
		return
	}
	audit.LogHTTP(r, h.DB, "file.classify", "file", fileID, map[string]any{
		"from": currentClass, "to": req.Classification,
	})
	writeJSON(w, 200, map[string]any{
		"id": fileID, "classification": req.Classification,
	})
}

/* ---------- Legal hold ---------- */

type holdReq struct {
	Enabled bool   `json:"enabled"`
	Reason  string `json:"reason"`
}

// SetLegalHold flips the hold flag on a file. Admin-only because a hold
// disables delete/move to trash for compliance/litigation reasons.
func (h *Handler) SetLegalHold(w http.ResponseWriter, r *http.Request) {
	c, _ := r.Context().Value(auth.UserCtxKey).(*auth.Claims)
	if c == nil || !c.IsAdmin() {
		writeErr(w, 403, "admin_only", "legal hold is admin-only")
		return
	}
	fileID := chi.URLParam(r, "id")
	var req holdReq
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeErr(w, 400, "invalid_body", err.Error())
		return
	}
	if req.Enabled {
		if req.Reason == "" {
			writeErr(w, 400, "reason_required", "reason is required when enabling hold")
			return
		}
		ct, err := h.DB.Exec(r.Context(), `
			UPDATE files
			   SET legal_hold=TRUE,
			       legal_hold_reason=$1,
			       legal_hold_by=$2::uuid,
			       legal_hold_at=now()
			 WHERE id=$3 AND org_id=$4`,
			req.Reason, c.UserID, fileID, c.OrgID)
		if err != nil || ct.RowsAffected() == 0 {
			writeErr(w, 404, "not_found", "file not found")
			return
		}
		audit.LogHTTP(r, h.DB, "file.legalhold.apply", "file", fileID,
			map[string]any{"reason": req.Reason})
	} else {
		ct, err := h.DB.Exec(r.Context(), `
			UPDATE files
			   SET legal_hold=FALSE,
			       legal_hold_reason=NULL,
			       legal_hold_by=NULL,
			       legal_hold_at=NULL
			 WHERE id=$1 AND org_id=$2`,
			fileID, c.OrgID)
		if err != nil || ct.RowsAffected() == 0 {
			writeErr(w, 404, "not_found", "file not found")
			return
		}
		audit.LogHTTP(r, h.DB, "file.legalhold.release", "file", fileID, nil)
	}
	writeJSON(w, 200, map[string]any{"id": fileID, "legalHold": req.Enabled})
}

/* ---------- Security settings ---------- */

type settingsDTO struct {
	RequireMFA                bool  `json:"requireMfa"`
	SessionTTLHours           int   `json:"sessionTtlHours"`
	MinPasswordLength         int   `json:"minPasswordLength"`
	RequirePasswordComplexity bool  `json:"requirePasswordComplexity"`
	RetentionDays             *int  `json:"retentionDays,omitempty"`
}

// GetSettings returns the org's security settings. Any authenticated user
// can read (so UI can show "MFA required" prompts); admins can write.
func (h *Handler) GetSettings(w http.ResponseWriter, r *http.Request) {
	c, _ := r.Context().Value(auth.UserCtxKey).(*auth.Claims)
	if c == nil {
		writeErr(w, 401, "unauthorized", "missing claims")
		return
	}
	var s settingsDTO
	err := h.DB.QueryRow(r.Context(), `
		SELECT require_mfa, session_ttl_hours, min_password_length,
		       require_password_complexity, retention_days
		  FROM org_security_settings WHERE org_id=$1`,
		c.OrgID,
	).Scan(&s.RequireMFA, &s.SessionTTLHours, &s.MinPasswordLength,
		&s.RequirePasswordComplexity, &s.RetentionDays)
	if err != nil {
		// Defaults when no row yet.
		s = settingsDTO{
			RequireMFA: false, SessionTTLHours: 24,
			MinPasswordLength: 8, RequirePasswordComplexity: true,
		}
	}
	writeJSON(w, 200, s)
}

// UpdateSettings is admin-only. Upserts the row.
func (h *Handler) UpdateSettings(w http.ResponseWriter, r *http.Request) {
	c, _ := r.Context().Value(auth.UserCtxKey).(*auth.Claims)
	if c == nil || !c.IsAdmin() {
		writeErr(w, 403, "admin_only", "security settings are admin-only")
		return
	}
	var s settingsDTO
	if err := json.NewDecoder(r.Body).Decode(&s); err != nil {
		writeErr(w, 400, "invalid_body", err.Error())
		return
	}
	if s.SessionTTLHours <= 0 {
		s.SessionTTLHours = 24
	}
	if s.MinPasswordLength < 6 {
		s.MinPasswordLength = 8
	}
	if _, err := h.DB.Exec(r.Context(), `
		INSERT INTO org_security_settings
		  (org_id, require_mfa, session_ttl_hours, min_password_length,
		   require_password_complexity, retention_days, updated_by, updated_at)
		VALUES ($1,$2,$3,$4,$5,$6,$7,now())
		ON CONFLICT (org_id) DO UPDATE SET
		  require_mfa = EXCLUDED.require_mfa,
		  session_ttl_hours = EXCLUDED.session_ttl_hours,
		  min_password_length = EXCLUDED.min_password_length,
		  require_password_complexity = EXCLUDED.require_password_complexity,
		  retention_days = EXCLUDED.retention_days,
		  updated_by = EXCLUDED.updated_by,
		  updated_at = EXCLUDED.updated_at`,
		c.OrgID, s.RequireMFA, s.SessionTTLHours, s.MinPasswordLength,
		s.RequirePasswordComplexity, s.RetentionDays, c.UserID,
	); err != nil {
		writeErr(w, 500, "db_error", err.Error())
		return
	}
	audit.LogHTTP(r, h.DB, "security.settings.update", "org", c.OrgID,
		map[string]any{"settings": s})
	writeJSON(w, 200, s)
}

func (h *Handler) Mount(r chi.Router) {
	r.Post("/v1/files/{id}/classification", h.SetClassification)
	r.Post("/v1/files/{id}/legal-hold", h.SetLegalHold)
	r.Get("/v1/security/settings", h.GetSettings)
	r.Put("/v1/security/settings", h.UpdateSettings)
}

/* ------------------------- helpers ------------------------- */

func writeJSON(w http.ResponseWriter, code int, v interface{}) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(code)
	_ = json.NewEncoder(w).Encode(v)
}
func writeErr(w http.ResponseWriter, code int, slug, msg string) {
	writeJSON(w, code, map[string]any{"error": map[string]string{"code": slug, "message": msg}})
}
