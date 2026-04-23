package mfa

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"net/http"
	"os"

	"github.com/go-chi/chi/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/docforge/api/internal/audit"
	"github.com/docforge/api/internal/auth"
)

type Handler struct {
	DB   *pgxpool.Pool
	Auth *auth.Handler
}

func New(db *pgxpool.Pool, a *auth.Handler) *Handler {
	return &Handler{DB: db, Auth: a}
}

/* ------------------------- Status ------------------------- */

type statusResp struct {
	Enabled       bool     `json:"enabled"`
	Verified      bool     `json:"verified"`
	RecoveryCodes []string `json:"recoveryCodes,omitempty"`
}

// Status returns whether TOTP is enrolled/verified for the caller.
func (h *Handler) Status(w http.ResponseWriter, r *http.Request) {
	c, _ := r.Context().Value(auth.UserCtxKey).(*auth.Claims)
	if c == nil {
		writeErr(w, 401, "unauthorized", "missing claims")
		return
	}
	var verified *string
	err := h.DB.QueryRow(r.Context(),
		`SELECT verified_at::text FROM two_factor_secrets WHERE user_id=$1`,
		c.UserID,
	).Scan(&verified)
	if err != nil {
		writeJSON(w, 200, statusResp{Enabled: false})
		return
	}
	writeJSON(w, 200, statusResp{Enabled: true, Verified: verified != nil})
}

/* ------------------------- Enroll ------------------------- */

type enrollResp struct {
	Secret      string `json:"secret"`
	OtpauthURL  string `json:"otpauthUrl"`
	AccountName string `json:"accountName"`
	Issuer      string `json:"issuer"`
}

// Enroll generates (or regenerates) a fresh TOTP secret. The secret is stored
// unverified; the user must confirm it via Verify before MFA is considered
// active.
func (h *Handler) Enroll(w http.ResponseWriter, r *http.Request) {
	c, _ := r.Context().Value(auth.UserCtxKey).(*auth.Claims)
	if c == nil {
		writeErr(w, 401, "unauthorized", "missing claims")
		return
	}
	secret, err := NewSecret()
	if err != nil {
		writeErr(w, 500, "rand", err.Error())
		return
	}
	if _, err := h.DB.Exec(r.Context(), `
		INSERT INTO two_factor_secrets (user_id, secret, verified_at)
		VALUES ($1, $2, NULL)
		ON CONFLICT (user_id) DO UPDATE SET secret=EXCLUDED.secret, verified_at=NULL
	`, c.UserID, secret); err != nil {
		writeErr(w, 500, "db", err.Error())
		return
	}
	issuer := os.Getenv("MFA_ISSUER")
	if issuer == "" {
		issuer = "Formly"
	}
	url := OtpauthURL(issuer, c.Email, secret)
	audit.LogHTTP(r, h.DB, "mfa.enroll", "user", c.UserID, nil)
	writeJSON(w, 200, enrollResp{
		Secret: secret, OtpauthURL: url, AccountName: c.Email, Issuer: issuer,
	})
}

/* ------------------------- Verify ------------------------- */

type verifyReq struct {
	Code string `json:"code"`
}

type verifyResp struct {
	Verified      bool     `json:"verified"`
	RecoveryCodes []string `json:"recoveryCodes,omitempty"`
}

// Verify confirms an enrolled user typed a valid code. On first success we
// flip `verified_at` and generate eight recovery codes (returned once).
func (h *Handler) Verify(w http.ResponseWriter, r *http.Request) {
	c, _ := r.Context().Value(auth.UserCtxKey).(*auth.Claims)
	if c == nil {
		writeErr(w, 401, "unauthorized", "missing claims")
		return
	}
	var req verifyReq
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeErr(w, 400, "invalid_body", err.Error())
		return
	}
	var secret string
	var verified *string
	if err := h.DB.QueryRow(r.Context(),
		`SELECT secret, verified_at::text FROM two_factor_secrets WHERE user_id=$1`,
		c.UserID,
	).Scan(&secret, &verified); err != nil {
		writeErr(w, 400, "not_enrolled", "enroll first")
		return
	}
	if !Verify(secret, req.Code) {
		writeErr(w, 400, "invalid_code", "code did not match")
		return
	}

	resp := verifyResp{Verified: true}
	if verified == nil {
		codes, err := generateRecoveryCodes(8)
		if err == nil {
			_, _ = h.DB.Exec(r.Context(),
				`UPDATE two_factor_secrets
				    SET verified_at=now(), recovery_codes=$2
				  WHERE user_id=$1`,
				c.UserID, codes)
			resp.RecoveryCodes = codes
		}
		audit.LogHTTP(r, h.DB, "mfa.verify", "user", c.UserID, nil)
	}
	writeJSON(w, 200, resp)
}

/* ------------------------- Disable ------------------------- */

type disableReq struct {
	Code string `json:"code"`
}

// Disable deletes the TOTP secret. Requires a valid current code (or one of
// the user's recovery codes) so that a stolen session can't silently turn off
// 2FA.
func (h *Handler) Disable(w http.ResponseWriter, r *http.Request) {
	c, _ := r.Context().Value(auth.UserCtxKey).(*auth.Claims)
	if c == nil {
		writeErr(w, 401, "unauthorized", "missing claims")
		return
	}
	var req disableReq
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeErr(w, 400, "invalid_body", err.Error())
		return
	}
	if !h.verifyCodeOrRecovery(r.Context(), c.UserID, req.Code) {
		writeErr(w, 400, "invalid_code", "bad code")
		return
	}
	_, _ = h.DB.Exec(r.Context(),
		`DELETE FROM two_factor_secrets WHERE user_id=$1`, c.UserID)
	audit.LogHTTP(r, h.DB, "mfa.disable", "user", c.UserID, nil)
	writeJSON(w, 200, map[string]bool{"ok": true})
}

/* ------------------------- Login challenge ------------------------- */

// ChallengeRequired returns true (with the challenge token) if a user has
// MFA enabled. Called from the auth login handler before issuing the session
// token.
func (h *Handler) ChallengeRequired(ctx context.Context, userID string) (bool, error) {
	var verified *string
	err := h.DB.QueryRow(ctx,
		`SELECT verified_at::text FROM two_factor_secrets WHERE user_id=$1`,
		userID,
	).Scan(&verified)
	if err != nil {
		// No row → no MFA configured.
		return false, nil
	}
	return verified != nil, nil
}

// VerifyChallenge validates a code during login. Accepts either a live TOTP
// code or a one-shot recovery code.
func (h *Handler) VerifyChallenge(ctx context.Context, userID, code string) bool {
	return h.verifyCodeOrRecovery(ctx, userID, code)
}

/* ------------------------- Routes ------------------------- */

// Mount attaches the MFA routes behind the normal auth middleware.
func (h *Handler) Mount(r chi.Router) {
	r.Get("/v1/mfa/status", h.Status)
	r.Post("/v1/mfa/enroll", h.Enroll)
	r.Post("/v1/mfa/verify", h.Verify)
	r.Post("/v1/mfa/disable", h.Disable)
}

/* ------------------------- helpers ------------------------- */

func (h *Handler) verifyCodeOrRecovery(ctx context.Context, userID, code string) bool {
	var secret string
	var recovery []string
	if err := h.DB.QueryRow(ctx,
		`SELECT secret, recovery_codes FROM two_factor_secrets WHERE user_id=$1`,
		userID,
	).Scan(&secret, &recovery); err != nil {
		return false
	}
	if Verify(secret, code) {
		return true
	}
	// Recovery code — if it matches, burn it.
	for i, rc := range recovery {
		if rc == code {
			remaining := append([]string{}, recovery[:i]...)
			remaining = append(remaining, recovery[i+1:]...)
			_, _ = h.DB.Exec(ctx,
				`UPDATE two_factor_secrets SET recovery_codes=$2 WHERE user_id=$1`,
				userID, remaining)
			return true
		}
	}
	return false
}

func generateRecoveryCodes(n int) ([]string, error) {
	codes := make([]string, n)
	for i := 0; i < n; i++ {
		b := make([]byte, 5)
		if _, err := rand.Read(b); err != nil {
			return nil, err
		}
		codes[i] = hex.EncodeToString(b)
	}
	return codes, nil
}

func writeJSON(w http.ResponseWriter, code int, v interface{}) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(code)
	_ = json.NewEncoder(w).Encode(v)
}
func writeErr(w http.ResponseWriter, code int, slug, msg string) {
	writeJSON(w, code, map[string]any{"error": map[string]string{"code": slug, "message": msg}})
}
