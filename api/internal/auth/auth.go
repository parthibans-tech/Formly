package auth

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"os"
	"strings"
	"time"

	"github.com/golang-jwt/jwt/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"golang.org/x/crypto/bcrypt"
)

type ctxKey string

const UserCtxKey ctxKey = "user"

type Claims struct {
	UserID string `json:"uid"`
	OrgID  string `json:"oid"`
	Email  string `json:"email"`
	Role   string `json:"role,omitempty"` // admin | editor | viewer
	jwt.RegisteredClaims
}

// Role constants. Kept as exported values so other packages can reference them
// without re-typing strings.
const (
	RoleAdmin  = "admin"
	RoleEditor = "editor"
	RoleViewer = "viewer"
)

// IsAdmin is a common gate — admin-only settings routes call this on the
// claims attached to the request context.
func (c *Claims) IsAdmin() bool { return c != nil && c.Role == RoleAdmin }

type Handler struct {
	DB     *pgxpool.Pool
	Secret []byte

	// Set by cmd/api after wiring up the security packages. Optional — if nil,
	// MFA/sessions/audit are simply skipped (keeps tests/local dev working
	// before the security migration is applied).
	MFAChallengeRequired func(ctx context.Context, userID string) (bool, error)
	MFAVerifyChallenge   func(ctx context.Context, userID, code string) bool
	OnLogin              func(ctx context.Context, userID, orgID, token, ip, ua string)
	OnLogout             func(ctx context.Context, token string)
	SessionRevokedCheck  func(ctx context.Context, token string) bool
	AuditFn              func(ctx context.Context, action, userID, orgID, email, ip, ua string, meta map[string]any)
}

func New(db *pgxpool.Pool) *Handler {
	secret := os.Getenv("JWT_SECRET")
	if secret == "" {
		secret = "dev-secret-change-me"
	}
	return &Handler{DB: db, Secret: []byte(secret)}
}

type registerReq struct {
	Email    string `json:"email"`
	Password string `json:"password"`
	Name     string `json:"name"`
	OrgName  string `json:"orgName"`
}

type authResp struct {
	Token string `json:"token"`
	User  user   `json:"user"`
}

type user struct {
	ID    string `json:"id"`
	Email string `json:"email"`
	Name  string `json:"name"`
	OrgID string `json:"orgId"`
	Role  string `json:"role,omitempty"`
}

func (h *Handler) Register(w http.ResponseWriter, r *http.Request) {
	var req registerReq
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeErr(w, 400, "invalid_body", err.Error())
		return
	}
	if req.Email == "" || req.Password == "" || req.Name == "" {
		writeErr(w, 400, "missing_fields", "email, password, name required")
		return
	}
	hash, _ := bcrypt.GenerateFromPassword([]byte(req.Password), 12)

	ctx := r.Context()
	tx, err := h.DB.Begin(ctx)
	if err != nil {
		writeErr(w, 500, "db_error", err.Error())
		return
	}
	defer tx.Rollback(ctx)

	orgName := req.OrgName
	if orgName == "" {
		orgName = req.Name + "'s Org"
	}
	var orgID string
	if err := tx.QueryRow(ctx, `INSERT INTO organizations (name) VALUES ($1) RETURNING id`, orgName).Scan(&orgID); err != nil {
		writeErr(w, 500, "org_create", err.Error())
		return
	}
	var userID string
	if err := tx.QueryRow(ctx,
		`INSERT INTO users (org_id, email, password_hash, name, role)
		 VALUES ($1,$2,$3,$4,'admin') RETURNING id`,
		orgID, req.Email, string(hash), req.Name,
	).Scan(&userID); err != nil {
		writeErr(w, 400, "user_create", err.Error())
		return
	}
	if err := tx.Commit(ctx); err != nil {
		writeErr(w, 500, "commit", err.Error())
		return
	}
	token, _ := h.issueToken(userID, orgID, req.Email, RoleAdmin)
	writeJSON(w, 200, authResp{Token: token, User: user{
		ID: userID, Email: req.Email, Name: req.Name, OrgID: orgID, Role: RoleAdmin,
	}})
}

type loginReq struct {
	Email    string `json:"email"`
	Password string `json:"password"`
	MFACode  string `json:"mfaCode"` // optional; supplied after a mfa_required challenge
}

func (h *Handler) Login(w http.ResponseWriter, r *http.Request) {
	var req loginReq
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeErr(w, 400, "invalid_body", err.Error())
		return
	}
	var (
		id, orgID, name, hash, role string
	)
	err := h.DB.QueryRow(r.Context(),
		`SELECT id, org_id, name, password_hash, COALESCE(role,'editor')
		   FROM users WHERE email=$1`, req.Email,
	).Scan(&id, &orgID, &name, &hash, &role)
	if err != nil {
		writeErr(w, 401, "invalid_credentials", "bad email or password")
		return
	}
	if bcrypt.CompareHashAndPassword([]byte(hash), []byte(req.Password)) != nil {
		h.audit(r, "auth.login.failed", "", "", req.Email,
			map[string]any{"reason": "bad_password"})
		writeErr(w, 401, "invalid_credentials", "bad email or password")
		return
	}

	// MFA challenge, if enrolled.
	if h.MFAChallengeRequired != nil {
		required, _ := h.MFAChallengeRequired(r.Context(), id)
		if required {
			if req.MFACode == "" {
				writeJSON(w, 200, map[string]any{
					"mfaRequired": true,
					"userId":      id,
				})
				return
			}
			if h.MFAVerifyChallenge == nil || !h.MFAVerifyChallenge(r.Context(), id, req.MFACode) {
				h.audit(r, "auth.login.mfa_failed", id, orgID, req.Email, nil)
				writeErr(w, 401, "invalid_mfa", "invalid MFA code")
				return
			}
		}
	}

	token, _ := h.issueToken(id, orgID, req.Email, role)
	if h.OnLogin != nil {
		h.OnLogin(r.Context(), id, orgID, token, clientIP(r), r.UserAgent())
	}
	h.audit(r, "auth.login", id, orgID, req.Email, nil)
	writeJSON(w, 200, authResp{Token: token, User: user{
		ID: id, Email: req.Email, Name: name, OrgID: orgID, Role: role,
	}})
}

// Logout revokes the current session token (best-effort audit log too).
func (h *Handler) Logout(w http.ResponseWriter, r *http.Request) {
	c, _ := r.Context().Value(UserCtxKey).(*Claims)
	authz := r.Header.Get("Authorization")
	token := strings.TrimPrefix(authz, "Bearer ")
	if h.OnLogout != nil {
		h.OnLogout(r.Context(), token)
	}
	if c != nil {
		h.audit(r, "auth.logout", c.UserID, c.OrgID, c.Email, nil)
	}
	writeJSON(w, 200, map[string]bool{"ok": true})
}

func (h *Handler) audit(r *http.Request, action, uid, oid, email string, meta map[string]any) {
	if h.AuditFn == nil {
		return
	}
	h.AuditFn(r.Context(), action, uid, oid, email, clientIP(r), r.UserAgent(), meta)
}

func clientIP(r *http.Request) string {
	if v := r.Header.Get("X-Forwarded-For"); v != "" {
		if i := strings.IndexByte(v, ','); i > 0 {
			return strings.TrimSpace(v[:i])
		}
		return strings.TrimSpace(v)
	}
	if v := r.Header.Get("X-Real-IP"); v != "" {
		return v
	}
	return r.RemoteAddr
}

func (h *Handler) Me(w http.ResponseWriter, r *http.Request) {
	c, _ := r.Context().Value(UserCtxKey).(*Claims)
	writeJSON(w, 200, user{ID: c.UserID, Email: c.Email, OrgID: c.OrgID, Role: c.Role})
}

func (h *Handler) issueToken(uid, oid, email, role string) (string, error) {
	c := Claims{
		UserID: uid, OrgID: oid, Email: email, Role: role,
		RegisteredClaims: jwt.RegisteredClaims{
			ExpiresAt: jwt.NewNumericDate(time.Now().Add(24 * time.Hour)),
			IssuedAt:  jwt.NewNumericDate(time.Now()),
		},
	}
	t := jwt.NewWithClaims(jwt.SigningMethodHS256, c)
	return t.SignedString(h.Secret)
}

// IssueTokenForUser is used by the team-invite accept handler to hand the new
// user a session token in the same shape Login produces.
func (h *Handler) IssueTokenForUser(uid, oid, email, role string) (string, error) {
	return h.issueToken(uid, oid, email, role)
}

// APIKeyVerifier resolves a raw API key into (userID, orgID, email, role).
// Supplied by `cmd/api` to avoid an import cycle between auth and apikeys.
type APIKeyVerifier func(r *http.Request, rawKey string) (userID, orgID, email, role string, err error)

// APIKeyInfoCtxKey identifies the API key that authenticated the current
// request (if any). Populated by Middleware when the caller sent a `fk_`
// bearer and the verifier returned success. JWT-authenticated requests do
// not set this key.
type apiKeyCtxKey struct{}

// APIKeyInfo describes the API key behind the current request — used by
// observability middleware (to log per-key traffic) and by the scope guard
// (to enforce the key's allow-list).
type APIKeyInfo struct {
	ID     string
	Scopes []string
}

var APIKeyInfoCtxKey = apiKeyCtxKey{}

// APIKeyFrom returns the API key info attached to the request context, if
// the request was authenticated with an API key.
func APIKeyFrom(ctx context.Context) *APIKeyInfo {
	v, _ := ctx.Value(APIKeyInfoCtxKey).(*APIKeyInfo)
	return v
}

// APIKeyVerifierV2 is the richer verifier that also returns the key ID and
// its scope list. Kept alongside the legacy signature so existing callers
// that only need identity still compile.
type APIKeyVerifierV2 func(r *http.Request, rawKey string) (userID, orgID, email, role, keyID string, scopes []string, err error)

var apiKeyVerifierV2 APIKeyVerifierV2

// RegisterAPIKeyVerifierV2 installs the richer verifier. If registered, it
// takes precedence over the legacy one.
func RegisterAPIKeyVerifierV2(fn APIKeyVerifierV2) {
	apiKeyVerifierV2 = fn
}

// APIKeyVerifier is registered at boot by cmd/api. Zero value means API-key
// auth is disabled and only JWTs are accepted.
var apiKeyVerifier APIKeyVerifier

// RegisterAPIKeyVerifier installs the function the middleware will call to
// validate API keys. Must be called before Middleware handles any request.
func RegisterAPIKeyVerifier(fn APIKeyVerifier) {
	apiKeyVerifier = fn
}

// APIKeyPrefix is the stable label that tells the middleware to dispatch to
// the API key verifier instead of parsing as JWT.
const APIKeyPrefix = "fk_"

func (h *Handler) Middleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		authz := r.Header.Get("Authorization")
		if !strings.HasPrefix(authz, "Bearer ") {
			writeErr(w, 401, "no_token", "missing bearer token")
			return
		}
		raw := strings.TrimPrefix(authz, "Bearer ")

		// API key path — short-circuit JWT parsing.
		if strings.HasPrefix(raw, APIKeyPrefix) {
			// Prefer the richer verifier when registered so we can thread
			// the key ID + scopes through context.
			if apiKeyVerifierV2 != nil {
				uid, oid, email, role, keyID, scopes, err := apiKeyVerifierV2(r, raw)
				if err != nil {
					writeErr(w, 401, "invalid_api_key", err.Error())
					return
				}
				claims := &Claims{UserID: uid, OrgID: oid, Email: email, Role: role}
				ctx := context.WithValue(r.Context(), UserCtxKey, claims)
				ctx = context.WithValue(ctx, APIKeyInfoCtxKey, &APIKeyInfo{ID: keyID, Scopes: scopes})
				next.ServeHTTP(w, r.WithContext(ctx))
				return
			}
			if apiKeyVerifier == nil {
				writeErr(w, 401, "apikey_disabled", "api keys are not enabled")
				return
			}
			uid, oid, email, role, err := apiKeyVerifier(r, raw)
			if err != nil {
				writeErr(w, 401, "invalid_api_key", err.Error())
				return
			}
			claims := &Claims{UserID: uid, OrgID: oid, Email: email, Role: role}
			ctx := context.WithValue(r.Context(), UserCtxKey, claims)
			next.ServeHTTP(w, r.WithContext(ctx))
			return
		}

		// JWT path.
		claims := &Claims{}
		_, err := jwt.ParseWithClaims(raw, claims, func(t *jwt.Token) (interface{}, error) {
			if _, ok := t.Method.(*jwt.SigningMethodHMAC); !ok {
				return nil, errors.New("bad signing method")
			}
			return h.Secret, nil
		})
		if err != nil {
			writeErr(w, 401, "invalid_token", err.Error())
			return
		}
		// Session revocation check (short-circuits JWT validity).
		if h.SessionRevokedCheck != nil && h.SessionRevokedCheck(r.Context(), raw) {
			writeErr(w, 401, "session_revoked", "session has been revoked")
			return
		}
		ctx := context.WithValue(r.Context(), UserCtxKey, claims)
		next.ServeHTTP(w, r.WithContext(ctx))
	})
}

func writeJSON(w http.ResponseWriter, code int, v interface{}) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(code)
	_ = json.NewEncoder(w).Encode(v)
}

func writeErr(w http.ResponseWriter, code int, slug, msg string) {
	writeJSON(w, code, map[string]any{"error": map[string]string{"code": slug, "message": msg}})
}
