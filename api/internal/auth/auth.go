package auth

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"os"
	"strings"
	"time"

	"github.com/docforge/api/internal/clientinfo"
	"github.com/golang-jwt/jwt/v5"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"
	"golang.org/x/crypto/bcrypt"
)

// PostRegisterDB is the slim pgx interface that OnRegister hooks
// receive — pool or tx both satisfy it. Kept here to avoid an import
// cycle (billing imports nothing, but auth shouldn't import billing).
type PostRegisterDB interface {
	Exec(ctx context.Context, sql string, args ...any) (pgconn.CommandTag, error)
	QueryRow(ctx context.Context, sql string, args ...any) pgx.Row
}

type ctxKey string

const UserCtxKey ctxKey = "user"

type Claims struct {
	UserID  string `json:"uid"`
	OrgID   string `json:"oid"`
	Email   string `json:"email"`
	Role    string `json:"role,omitempty"` // admin | editor | viewer
	IsSuper bool   `json:"sa,omitempty"`   // mirrors users.is_super_admin
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

// IsSuperAdmin on Claims is the canonical check — it reads the bit
// minted into the JWT at login from users.is_super_admin (migration 049).
//
// Why a column, not env var: the previous model derived super-admin from
// PLATFORM_ROOT_ORG_ID, which had to be backfilled AFTER the first
// signup created the platform org. Until then every admin became super-
// admin, which is a security footgun. The column-backed model boots
// secure on a fresh DB (the migration seeds exactly one operator).
func (c *Claims) IsSuperAdmin() bool {
	return c != nil && c.IsSuper
}

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
	// OnRegister fires inside the registration transaction once the
	// org + user rows have been created. Use this to provision
	// per-org defaults (subscription trial, default folders, etc.).
	// Returning an error rolls back the registration.
	OnRegister func(ctx context.Context, q PostRegisterDB, orgID string) error

	// TenantAnnotator is invoked from the auth middleware AFTER Claims
	// have been attached to the request context but BEFORE the inner
	// chain runs. The hook resolves the caller's billing tier and
	// stashes it in metrics' request-scoped slot (see
	// internal/metrics/tenant.go) so the outer metrics middleware can
	// label the request when the chain returns. Optional — when nil,
	// the metrics middleware just uses the default "anon" tier.
	TenantAnnotator func(r *http.Request)

	// OnLoginAttempt fires from each authentication entry point with a
	// stable kind ∈ {login, register, mfa_verify} and a result ∈
	// {success, failed}. Wired in cmd/api to the metrics package's
	// AuthAttempts counter — a sustained spike in (login, failed)
	// while (login, success) is flat is the canonical credential-
	// stuffing signal. Kept package-agnostic so auth doesn't import
	// prometheus.
	OnLoginAttempt func(ctx context.Context, kind, result string)
}

// loginAttempt is the tiny helper that emits the OnLoginAttempt hook
// when one is wired. Inline-call sites would have to nil-check
// everywhere; this keeps the call sites a single line.
func (h *Handler) loginAttempt(ctx context.Context, kind, result string) {
	if h == nil || h.OnLoginAttempt == nil {
		return
	}
	h.OnLoginAttempt(ctx, kind, result)
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
	// Personal=true creates a sealed single-member workspace ("Just me"
	// signup). The org row is tagged kind='personal'; CreateInvite
	// refuses against it with 409 personal_org_no_invites. Users in a
	// personal org can still ACCEPT invites to other team orgs — the
	// personal workspace just stays read-only-membership-wise on its
	// own. When false (default) we create a regular kind='team' org
	// using OrgName (or "<name>'s Org" if blank), the same as before.
	Personal bool `json:"personal"`
}

type authResp struct {
	Token string `json:"token"`
	User  user   `json:"user"`
	// ForcePasswordReset is set when a super-admin has flagged this
	// user via /v1/admin/users/:id/force-password-reset. The web app
	// honors it by routing the user straight to /set-password.
	ForcePasswordReset bool `json:"forcePasswordReset,omitempty"`
}

type user struct {
	ID    string `json:"id"`
	Email string `json:"email"`
	Name  string `json:"name"`
	OrgID string `json:"orgId"`
	Role  string `json:"role,omitempty"`
	// IsSuperAdmin mirrors users.is_super_admin — surfaced so the web
	// client can gate platform-only UI without making a second call.
	IsSuperAdmin bool `json:"isSuperAdmin,omitempty"`
	// OrgKind is "team" (default) or "personal". Surfaced on the login
	// response so the web app's first paint already knows whether to
	// render team-only navigation (Team page, "Manage team" buttons,
	// invite affordances). The same field appears on /v1/me/profile
	// for pages that don't have access to the cached user blob.
	OrgKind string `json:"orgKind,omitempty"`
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

	// Branch on the personal-workspace flag. Personal signups override
	// any org name the form sent (the form hides the field anyway) and
	// stamp the org as kind='personal' so the invite-create endpoint
	// will refuse for this org. Team signups keep the legacy fallback
	// of "<name>'s Org" when OrgName is blank.
	orgName := req.OrgName
	orgKind := "team"
	if req.Personal {
		orgName = "Personal workspace"
		orgKind = "personal"
	} else if orgName == "" {
		orgName = req.Name + "'s Org"
	}
	var orgID string
	if err := tx.QueryRow(ctx,
		`INSERT INTO organizations (name, kind) VALUES ($1,$2) RETURNING id`,
		orgName, orgKind,
	).Scan(&orgID); err != nil {
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
	// Mirror the user into org_memberships so the multi-org code paths
	// (membership listing, /v1/me/switch-org, seat counting) see this
	// signup the same way they see invite-accept and admin-attached
	// memberships. Migration 030 backfills existing users; this keeps
	// the invariant going forward. Idempotent — ON CONFLICT in case the
	// migration already covered the row through some other code path.
	if _, err := tx.Exec(ctx,
		`INSERT INTO org_memberships (user_id, org_id, role, source)
		 VALUES ($1,$2,'admin','primary')
		 ON CONFLICT (user_id, org_id) DO NOTHING`,
		userID, orgID,
	); err != nil {
		writeErr(w, 500, "membership_create", err.Error())
		return
	}
	if h.OnRegister != nil {
		if err := h.OnRegister(ctx, tx, orgID); err != nil {
			writeErr(w, 500, "post_register", err.Error())
			return
		}
	}
	if err := tx.Commit(ctx); err != nil {
		writeErr(w, 500, "commit", err.Error())
		return
	}
	// New signups never become super-admin. Promotion is a deliberate
	// platform-operator action (or the seed migration), not a side
	// effect of self-service registration.
	token, _ := h.issueTokenSuper(userID, orgID, req.Email, RoleAdmin, false)
	h.loginAttempt(ctx, "register", "success")
	writeJSON(w, 200, authResp{Token: token, User: user{
		ID: userID, Email: req.Email, Name: req.Name, OrgID: orgID, Role: RoleAdmin,
		// OrgKind is known at register-time without a re-read because
		// we set it ourselves a few lines up. Mirroring it here keeps
		// the response shape identical to /v1/auth/login so the web
		// app's session-bootstrap path treats both the same.
		OrgKind: orgKind,
	}})
}

type loginReq struct {
	Email    string `json:"email"`
	Password string `json:"password"`
	MFACode  string `json:"mfaCode"` // optional; supplied after a mfa_required challenge

	// Optional browser-supplied geolocation. The web client asks for
	// `navigator.geolocation` permission on the login form and forwards
	// the result here. Server falls back to IP-based lookup when this
	// is missing or the user denied permission.
	ClientGeo *clientinfo.BrowserGeo `json:"clientGeo,omitempty"`
}

func (h *Handler) Login(w http.ResponseWriter, r *http.Request) {
	var req loginReq
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeErr(w, 400, "invalid_body", err.Error())
		return
	}
	// Enrich every auth audit row from this call with parsed UA + best-
	// effort geo. Built once per login attempt; merged into each emit
	// (failure, lock, mfa_failed, success) via withClient(...).
	ci := clientinfo.FromRequest(r.Context(), r, req.ClientGeo)
	withClient := func(extra map[string]any) map[string]any {
		m := ci.ToMeta()
		for k, v := range extra {
			m[k] = v
		}
		return m
	}

	var (
		id, orgID, name, hash, role string
		orgKind                     string
		isSuper                     bool
		lockedAt                    *time.Time
		lockedReason                *string
		forcePwReset                bool
		orgDeletedAt                *time.Time
	)
	err := h.DB.QueryRow(r.Context(),
		`SELECT u.id, u.org_id, u.name, u.password_hash, COALESCE(u.role,'editor'),
		        COALESCE(u.is_super_admin, FALSE),
		        u.locked_at, u.locked_reason, u.force_pw_reset,
		        o.deleted_at, COALESCE(o.kind,'team')
		   FROM users u
		   LEFT JOIN organizations o ON o.id = u.org_id
		  WHERE u.email=$1`, req.Email,
	).Scan(&id, &orgID, &name, &hash, &role, &isSuper, &lockedAt, &lockedReason,
		&forcePwReset, &orgDeletedAt, &orgKind)
	if err != nil {
		// Unknown email gets the same metric label as a bad password —
		// from the abuse-detection perspective they're indistinguishable
		// (and we deliberately want to keep them indistinguishable so a
		// metric scrape can't be used to enumerate users).
		h.loginAttempt(r.Context(), "login", "failed")
		writeErr(w, 401, "invalid_credentials", "bad email or password")
		return
	}
	if bcrypt.CompareHashAndPassword([]byte(hash), []byte(req.Password)) != nil {
		h.audit(r, "auth.login.failed", "", "", req.Email,
			withClient(map[string]any{"reason": "bad_password"}))
		h.loginAttempt(r.Context(), "login", "failed")
		writeErr(w, 401, "invalid_credentials", "bad email or password")
		return
	}
	// Org soft-delete (Phase 3): refuse to mint a session for a user
	// whose home org has been tombstoned. Existing sessions are killed
	// at delete time; this catches any stale-credential login attempt.
	if orgDeletedAt != nil {
		h.audit(r, "auth.login.org_deleted", id, orgID, req.Email, withClient(nil))
		h.loginAttempt(r.Context(), "login", "failed")
		writeErr(w, 410, "org_deleted",
			"this workspace has been deleted — contact support")
		return
	}
	// Lock check happens AFTER password verification so an attacker
	// can't enumerate locked accounts via the response code — they get
	// the same "invalid_credentials" path until they prove the password,
	// then learn the account is frozen.
	if lockedAt != nil {
		reason := ""
		if lockedReason != nil {
			reason = *lockedReason
		}
		h.audit(r, "auth.login.locked", id, orgID, req.Email,
			withClient(map[string]any{"reason": reason}))
		h.loginAttempt(r.Context(), "login", "failed")
		writeErr(w, 403, "account_locked",
			"this account is temporarily locked — contact support")
		return
	}

	// MFA challenge, if enrolled. The mfa_verify counter is separate
	// from login — a user fat-fingering a TOTP code is a different
	// signal from password stuffing.
	if h.MFAChallengeRequired != nil {
		required, _ := h.MFAChallengeRequired(r.Context(), id)
		if required {
			if req.MFACode == "" {
				// Challenge issued; the caller will re-POST with a
				// code. Don't count it as login-success yet.
				writeJSON(w, 200, map[string]any{
					"mfaRequired": true,
					"userId":      id,
				})
				return
			}
			if h.MFAVerifyChallenge == nil || !h.MFAVerifyChallenge(r.Context(), id, req.MFACode) {
				h.audit(r, "auth.login.mfa_failed", id, orgID, req.Email, withClient(nil))
				h.loginAttempt(r.Context(), "mfa_verify", "failed")
				writeErr(w, 401, "invalid_mfa", "invalid MFA code")
				return
			}
			h.loginAttempt(r.Context(), "mfa_verify", "success")
		}
	}

	token, _ := h.issueTokenSuper(id, orgID, req.Email, role, isSuper)
	h.loginAttempt(r.Context(), "login", "success")
	if h.OnLogin != nil {
		h.OnLogin(r.Context(), id, orgID, token, clientIP(r), r.UserAgent())
	}
	h.audit(r, "auth.login", id, orgID, req.Email,
		withClient(map[string]any{"forcePasswordReset": forcePwReset}))
	writeJSON(w, 200, authResp{
		Token: token,
		User: user{
			ID: id, Email: req.Email, Name: name, OrgID: orgID, Role: role,
			IsSuperAdmin: isSuper,
			OrgKind:      orgKind,
		},
		ForcePasswordReset: forcePwReset,
	})
}

// SetPassword lets a user change their own password. Used by:
//   - the regular "change password" form in /settings/security
//   - the forced-reset flow after a super-admin flips force_pw_reset
//
// We require the current password EXCEPT when the force-reset flag is
// set — in that case the previous password is, by definition, no
// longer trusted. The flag is cleared atomically with the new hash so
// a window where both are set can't exist.
func (h *Handler) SetPassword(w http.ResponseWriter, r *http.Request) {
	c, _ := r.Context().Value(UserCtxKey).(*Claims)
	if c == nil {
		writeErr(w, 401, "unauthorized", "missing claims")
		return
	}
	var req struct {
		CurrentPassword string `json:"currentPassword"`
		NewPassword     string `json:"newPassword"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeErr(w, 400, "invalid_body", err.Error())
		return
	}
	if len(req.NewPassword) < 8 {
		writeErr(w, 400, "short_password", "password must be at least 8 characters")
		return
	}

	var hash string
	var forcePwReset bool
	if err := h.DB.QueryRow(r.Context(),
		`SELECT password_hash, force_pw_reset FROM users WHERE id=$1`,
		c.UserID,
	).Scan(&hash, &forcePwReset); err != nil {
		writeErr(w, 500, "db_error", err.Error())
		return
	}

	// Skip the current-password check when this is a forced reset —
	// the user can't possibly know it's still valid (and may not be
	// the one who set it, e.g. password handed out by support).
	if !forcePwReset {
		if bcrypt.CompareHashAndPassword([]byte(hash), []byte(req.CurrentPassword)) != nil {
			h.audit(r, "auth.set_password.failed", c.UserID, c.OrgID, c.Email,
				map[string]any{"reason": "bad_current_password"})
			writeErr(w, 401, "invalid_credentials", "current password is wrong")
			return
		}
	}

	newHash, err := bcrypt.GenerateFromPassword([]byte(req.NewPassword), 12)
	if err != nil {
		writeErr(w, 500, "hash", err.Error())
		return
	}
	if _, err := h.DB.Exec(r.Context(), `
		UPDATE users
		   SET password_hash=$1,
		       force_pw_reset=false,
		       updated_at=now()
		 WHERE id=$2`, string(newHash), c.UserID); err != nil {
		writeErr(w, 500, "db_error", err.Error())
		return
	}

	h.audit(r, "auth.set_password", c.UserID, c.OrgID, c.Email,
		map[string]any{"forced": forcePwReset})
	writeJSON(w, 200, map[string]any{"ok": true})
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
		ci := clientinfo.FromRequest(r.Context(), r, nil)
		h.audit(r, "auth.logout", c.UserID, c.OrgID, c.Email, ci.ToMeta())
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
	writeJSON(w, 200, user{
		ID: c.UserID, Email: c.Email, OrgID: c.OrgID, Role: c.Role,
		IsSuperAdmin: c.IsSuperAdmin(),
	})
}

func (h *Handler) issueToken(uid, oid, email, role string) (string, error) {
	return h.issueTokenSuper(uid, oid, email, role, false)
}

func (h *Handler) issueTokenSuper(uid, oid, email, role string, isSuper bool) (string, error) {
	c := Claims{
		UserID: uid, OrgID: oid, Email: email, Role: role, IsSuper: isSuper,
		RegisteredClaims: jwt.RegisteredClaims{
			ExpiresAt: jwt.NewNumericDate(time.Now().Add(24 * time.Hour)),
			IssuedAt:  jwt.NewNumericDate(time.Now()),
		},
	}
	t := jwt.NewWithClaims(jwt.SigningMethodHS256, c)
	return t.SignedString(h.Secret)
}

// IssueTokenForUser is used by the team-invite accept handler to hand the new
// user a session token in the same shape Login produces. Invitees never
// arrive as super-admins — that bit is set by migration or platform action.
func (h *Handler) IssueTokenForUser(uid, oid, email, role string) (string, error) {
	return h.issueToken(uid, oid, email, role)
}

// ParseToken validates a raw JWT against this handler's secret and returns
// the decoded claims. Public endpoints that aren't behind Middleware (e.g.
// the invite-accept handler) call this when they want to opportunistically
// recognise a signed-in caller — the request still works without a Bearer,
// but if one is present and valid we can skip a redundant password prompt.
//
// Returns (nil, err) for any parse / signature / expiry failure. The
// session-revocation hook is intentionally NOT consulted here: this helper
// is only used to authenticate identity for a one-shot "are you who you
// say you are" check, not to grant a fresh authorization scope.
func (h *Handler) ParseToken(raw string) (*Claims, error) {
	claims := &Claims{}
	_, err := jwt.ParseWithClaims(raw, claims, func(t *jwt.Token) (interface{}, error) {
		if _, ok := t.Method.(*jwt.SigningMethodHMAC); !ok {
			return nil, errors.New("bad signing method")
		}
		return h.Secret, nil
	})
	if err != nil {
		return nil, err
	}
	return claims, nil
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
				r = r.WithContext(ctx)
				h.annotateTenant(r)
				next.ServeHTTP(w, r)
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
			r = r.WithContext(ctx)
			h.annotateTenant(r)
			next.ServeHTTP(w, r)
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
		r = r.WithContext(ctx)
		h.annotateTenant(r)
		next.ServeHTTP(w, r)
	})
}

// annotateTenant hands the request to the optional TenantAnnotator
// hook — wired in cmd/api to a (cached) plan resolver that writes the
// tier into metrics' request-scoped slot. nil-checked so unit tests
// that exercise auth.Middleware in isolation don't need to wire it.
func (h *Handler) annotateTenant(r *http.Request) {
	if h == nil || h.TenantAnnotator == nil {
		return
	}
	h.TenantAnnotator(r)
}

func writeJSON(w http.ResponseWriter, code int, v interface{}) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(code)
	_ = json.NewEncoder(w).Encode(v)
}

func writeErr(w http.ResponseWriter, code int, slug, msg string) {
	writeJSON(w, code, map[string]any{"error": map[string]string{"code": slug, "message": msg}})
}
