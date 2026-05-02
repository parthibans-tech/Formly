package sharing

import (
	"context"
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"net/http"
	"os"
	"time"

	"golang.org/x/crypto/bcrypt"

	"github.com/docforge/api/internal/audit"
	"github.com/docforge/api/internal/auth"
	"github.com/docforge/api/internal/events"
	"github.com/docforge/api/internal/scanner"
	"github.com/docforge/api/internal/storage"
	"github.com/go-chi/chi/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

type Handler struct {
	DB      *pgxpool.Pool
	Storage *storage.Client

	// Mailer is optional — when wired, the access-request flow sends
	// notifications (file → owner inbox; approve/deny → requester) via
	// the central Mailer so audit + provider routing stay consistent.
	// If nil, the SQL changes still happen but no email goes out, which
	// keeps tests and CLI tooling that construct a Handler directly
	// from working without a Mailer dependency.
	Mailer Notifier
}

// Notifier is the small slice of mail.Mailer that sharing actually
// uses. We declare it here as an interface so the import direction
// stays sharing → (no mail package), which avoids the import cycle
// that would land if sharing imported mail and mail imported sharing
// (which it doesn't today, but easy to slip into).
type Notifier interface {
	Send(ctx context.Context, opts NotifyOptions) (string, error)
}

// NotifyOptions mirrors mail.SendOptions but without a hard dep on the
// email package — sharing only needs to-address + subject + body. The
// concrete mail.Mailer satisfies this via a tiny adapter wired up in
// cmd/api/main.go.
type NotifyOptions struct {
	OrgID    string
	UserID   string
	Kind     string
	Source   string
	To       []string
	Subject  string
	HTMLBody string
	TextBody string
	Metadata map[string]any
}

func New(db *pgxpool.Pool, s *storage.Client) *Handler {
	return &Handler{DB: db, Storage: s}
}

type shareDTO struct {
	ID               string     `json:"id"`
	Token            string     `json:"token"`
	Role             string     `json:"role"`
	ExpiresAt        *time.Time `json:"expiresAt,omitempty"`
	CreatedAt        time.Time  `json:"createdAt"`
	PasswordProtect  bool       `json:"passwordProtected"`
	OneTime          bool       `json:"oneTime"`
	DownloadLimit    *int       `json:"downloadLimit,omitempty"`
	DownloadCount    int        `json:"downloadCount"`
}

type createReq struct {
	Role          string `json:"role"`          // viewer | downloader
	ExpiresIn     int    `json:"expiresIn"`     // seconds; 0 = no expiry
	Password      string `json:"password"`      // optional; empty = no password
	OneTime       bool   `json:"oneTime"`       // single-use link
	DownloadLimit int    `json:"downloadLimit"` // 0 = unlimited
}

// Create issues a new share link for a file. The token is a URL-safe random string.
func (h *Handler) Create(w http.ResponseWriter, r *http.Request) {
	c := r.Context().Value(auth.UserCtxKey).(*auth.Claims)
	fileID := chi.URLParam(r, "id")

	// Ownership check via org.
	var exists bool
	_ = h.DB.QueryRow(r.Context(),
		`SELECT EXISTS(SELECT 1 FROM files WHERE id=$1 AND org_id=$2 AND trashed_at IS NULL)`,
		fileID, c.OrgID,
	).Scan(&exists)
	if !exists {
		writeErr(w, 404, "not_found", "file not found")
		return
	}

	var req createReq
	_ = json.NewDecoder(r.Body).Decode(&req)
	if req.Role == "" {
		req.Role = "viewer"
	}
	if req.Role != "viewer" && req.Role != "downloader" {
		writeErr(w, 400, "invalid_role", "role must be viewer or downloader")
		return
	}

	token, err := randomToken(24)
	if err != nil {
		writeErr(w, 500, "rand", err.Error())
		return
	}

	var expires *time.Time
	if req.ExpiresIn > 0 {
		t := time.Now().Add(time.Duration(req.ExpiresIn) * time.Second)
		expires = &t
	}

	var passwordHash *string
	if req.Password != "" {
		h2, err := bcrypt.GenerateFromPassword([]byte(req.Password), 12)
		if err != nil {
			writeErr(w, 500, "hash", err.Error())
			return
		}
		s := string(h2)
		passwordHash = &s
	}
	var dlLimit *int
	if req.DownloadLimit > 0 {
		n := req.DownloadLimit
		dlLimit = &n
	}

	var id string
	err = h.DB.QueryRow(r.Context(),
		`INSERT INTO share_links
		   (org_id, file_id, token, role, expires_at, created_by,
		    password_hash, one_time, download_limit)
		 VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`,
		c.OrgID, fileID, token, req.Role, expires, c.UserID,
		passwordHash, req.OneTime, dlLimit,
	).Scan(&id)
	if err != nil {
		writeErr(w, 500, "db_error", err.Error())
		return
	}
	audit.LogHTTP(r, h.DB, "share.create", "share", id, map[string]any{
		"fileId":            fileID,
		"role":              req.Role,
		"expiresIn":         req.ExpiresIn,
		"passwordProtected": passwordHash != nil,
		"oneTime":           req.OneTime,
		"downloadLimit":     req.DownloadLimit,
	})
	writeJSON(w, 200, shareDTO{
		ID: id, Token: token, Role: req.Role,
		ExpiresAt: expires, CreatedAt: time.Now(),
		PasswordProtect: passwordHash != nil,
		OneTime:         req.OneTime,
		DownloadLimit:   dlLimit,
	})
}

// InternalCreateOptions is the input shape for CreateInternal — the
// non-HTTP path used by background flows (e.g. the auto-share-link
// produced by generate.delivery on every successful render).
//
// Mirrors createReq + the surrounding HTTP-handler context (orgID,
// fileID, userID) so background callers don't have to fabricate
// request/response objects to mint a link.
type InternalCreateOptions struct {
	OrgID         string
	UserID        string // creator; "" for system-generated links
	FileID        string
	Role          string // viewer | downloader; defaults to viewer
	ExpiresIn     int    // seconds; 0 = no expiry
	Password      string
	OneTime       bool
	DownloadLimit int
}

// InternalCreateResult carries enough back to render a public URL
// and stash IDs in event payloads. The URL itself is built from
// APP_URL + "/share/<token>" so the caller doesn't have to know
// the public path layout.
type InternalCreateResult struct {
	ShareID string
	Token   string
	URL     string
}

// CreateInternal mints a share link without an HTTP request — the
// counterpart to Create() for background callers like the post-render
// auto-share-link flow.  All policy logic (role validation, password
// hashing, expiry calculation) is identical to the HTTP path; the
// only difference is who's reporting the audit row (no http.Request
// → audit row is skipped here, since there's no actor IP / UA to
// capture; the caller's own audit trail covers the higher-level
// "render produced a share link" event).
func (h *Handler) CreateInternal(ctx context.Context, opts InternalCreateOptions) (InternalCreateResult, error) {
	role := opts.Role
	if role == "" {
		role = "viewer"
	}
	if role != "viewer" && role != "downloader" {
		return InternalCreateResult{}, errInvalidRole
	}

	token, err := randomToken(24)
	if err != nil {
		return InternalCreateResult{}, err
	}

	var expires *time.Time
	if opts.ExpiresIn > 0 {
		t := time.Now().Add(time.Duration(opts.ExpiresIn) * time.Second)
		expires = &t
	}

	var passwordHash *string
	if opts.Password != "" {
		ph, err := bcrypt.GenerateFromPassword([]byte(opts.Password), 12)
		if err != nil {
			return InternalCreateResult{}, err
		}
		s := string(ph)
		passwordHash = &s
	}
	var dlLimit *int
	if opts.DownloadLimit > 0 {
		n := opts.DownloadLimit
		dlLimit = &n
	}

	// NULLIF(...) on UserID so we can record "system-generated"
	// links cleanly — created_by is nullable in the schema.
	var createdBy any
	if opts.UserID != "" {
		createdBy = opts.UserID
	}

	var id string
	err = h.DB.QueryRow(ctx,
		`INSERT INTO share_links
		   (org_id, file_id, token, role, expires_at, created_by,
		    password_hash, one_time, download_limit)
		 VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`,
		opts.OrgID, opts.FileID, token, role, expires, createdBy,
		passwordHash, opts.OneTime, dlLimit,
	).Scan(&id)
	if err != nil {
		return InternalCreateResult{}, err
	}

	return InternalCreateResult{
		ShareID: id,
		Token:   token,
		URL:     publicShareURL(token),
	}, nil
}

// errInvalidRole is the sentinel returned by CreateInternal when the
// role isn't one of the two allowed values. Exported via Errors()
// helpers if callers need to discriminate, but most just propagate.
var errInvalidRole = invalidRoleError("role must be viewer or downloader")

type invalidRoleError string

func (e invalidRoleError) Error() string { return string(e) }

// publicShareURL builds the public link from APP_URL. Mirrors the
// access-request appURL helper (kept duplicated rather than shared
// to avoid a cross-file dependency for one-line getenv lookup).
func publicShareURL(token string) string {
	base := osGetenv("APP_URL")
	if base == "" {
		base = "http://localhost:3000"
	}
	return base + "/share/" + token
}

// osGetenv is a thin pass-through so tests can stub APP_URL without
// touching process env. Keeps tests deterministic when run in
// parallel with other code that may also touch APP_URL.
var osGetenv = func(k string) string {
	return os.Getenv(k)
}

func (h *Handler) List(w http.ResponseWriter, r *http.Request) {
	c := r.Context().Value(auth.UserCtxKey).(*auth.Claims)
	fileID := chi.URLParam(r, "id")
	rows, err := h.DB.Query(r.Context(),
		`SELECT id, token, role, expires_at, created_at,
		        (password_hash IS NOT NULL), one_time,
		        download_limit, download_count
		   FROM share_links
		  WHERE file_id=$1 AND org_id=$2 AND revoked_at IS NULL
		  ORDER BY created_at DESC`, fileID, c.OrgID,
	)
	if err != nil {
		writeErr(w, 500, "db_error", err.Error())
		return
	}
	defer rows.Close()
	out := []shareDTO{}
	for rows.Next() {
		var s shareDTO
		if err := rows.Scan(
			&s.ID, &s.Token, &s.Role, &s.ExpiresAt, &s.CreatedAt,
			&s.PasswordProtect, &s.OneTime, &s.DownloadLimit, &s.DownloadCount,
		); err != nil {
			writeErr(w, 500, "db_error", err.Error())
			return
		}
		out = append(out, s)
	}
	writeJSON(w, 200, map[string]any{"shares": out})
}

func (h *Handler) Revoke(w http.ResponseWriter, r *http.Request) {
	c := r.Context().Value(auth.UserCtxKey).(*auth.Claims)
	id := chi.URLParam(r, "shareId")
	tag, err := h.DB.Exec(r.Context(),
		`UPDATE share_links SET revoked_at=now() WHERE id=$1 AND org_id=$2 AND revoked_at IS NULL`,
		id, c.OrgID,
	)
	if err != nil {
		writeErr(w, 500, "db_error", err.Error())
		return
	}
	if tag.RowsAffected() == 0 {
		writeErr(w, 404, "not_found", "share not found")
		return
	}
	writeJSON(w, 200, map[string]any{"ok": true})
}

type publicResolveResp struct {
	FileName    string `json:"fileName"`
	Mime        string `json:"mime"`
	Size        int64  `json:"size"`
	DownloadURL string `json:"downloadUrl"`
	Role        string `json:"role"`
}

type publicInfoResp struct {
	FileName           string     `json:"fileName"`
	Mime               string     `json:"mime"`
	Size               int64      `json:"size"`
	Role               string     `json:"role"`
	ExpiresAt          *time.Time `json:"expiresAt,omitempty"`
	PasswordProtect    bool       `json:"passwordProtected"`
	OneTime            bool       `json:"oneTime"`
	DownloadsRemaining *int       `json:"downloadsRemaining,omitempty"`
	Consumed           bool       `json:"consumed"`
}

// Info returns non-sensitive metadata about a share token (is a password
// required? is it one-time? already used?). Does NOT return a download URL.
func (h *Handler) Info(w http.ResponseWriter, r *http.Request) {
	token := chi.URLParam(r, "token")
	var (
		name, mime, role string
		size             int64
		expiresAt, used  *time.Time
		hasPassword      bool
		oneTime          bool
		dlLimit          *int
		dlCount          int
	)
	err := h.DB.QueryRow(r.Context(), `
		SELECT f.name, f.mime, f.size, s.role, s.expires_at, s.used_at,
		       (s.password_hash IS NOT NULL),
		       s.one_time, s.download_limit, s.download_count
		  FROM share_links s JOIN files f ON f.id=s.file_id
		 WHERE s.token=$1 AND s.revoked_at IS NULL AND f.trashed_at IS NULL`,
		token,
	).Scan(&name, &mime, &size, &role, &expiresAt, &used,
		&hasPassword, &oneTime, &dlLimit, &dlCount)
	if err != nil {
		writeErr(w, 404, "not_found", "share not found or revoked")
		return
	}
	resp := publicInfoResp{
		FileName: name, Mime: mime, Size: size, Role: role,
		ExpiresAt: expiresAt, PasswordProtect: hasPassword,
		OneTime: oneTime, Consumed: oneTime && used != nil,
	}
	if dlLimit != nil {
		remaining := *dlLimit - dlCount
		if remaining < 0 {
			remaining = 0
		}
		resp.DownloadsRemaining = &remaining
	}
	writeJSON(w, 200, resp)
}

type resolveReq struct {
	Password string `json:"password"`
	Action   string `json:"action"` // "view" | "download"
}

// Resolve is unauthenticated — resolves a share token into a pre-signed download URL.
// Accepts an optional POST body with password + action.
func (h *Handler) Resolve(w http.ResponseWriter, r *http.Request) {
	token := chi.URLParam(r, "token")

	var req resolveReq
	if r.Method == http.MethodPost {
		_ = json.NewDecoder(r.Body).Decode(&req)
	} else {
		req.Password = r.URL.Query().Get("password")
		req.Action = r.URL.Query().Get("action")
	}
	if req.Action != "download" {
		req.Action = "view"
	}

	var (
		shareID, orgID, fileID       string
		name, mime, storageKey, role string
		size                         int64
		expiresAt, usedAt            *time.Time
		passwordHash                 *string
		oneTime                      bool
		dlLimit                      *int
		dlCount                      int
		scanStatus, scanSig          string
	)
	err := h.DB.QueryRow(r.Context(), `
		SELECT s.id, f.org_id, f.id, f.name, f.mime, f.size, f.storage_key,
		       s.role, s.expires_at, s.used_at, s.password_hash,
		       s.one_time, s.download_limit, s.download_count,
		       COALESCE(f.scan_status, 'skipped'), COALESCE(f.scan_signature, '')
		  FROM share_links s JOIN files f ON f.id=s.file_id
		 WHERE s.token=$1 AND s.revoked_at IS NULL AND f.trashed_at IS NULL`,
		token,
	).Scan(&shareID, &orgID, &fileID, &name, &mime, &size, &storageKey,
		&role, &expiresAt, &usedAt, &passwordHash,
		&oneTime, &dlLimit, &dlCount,
		&scanStatus, &scanSig)
	if err != nil {
		writeErr(w, 404, "not_found", "share not found or revoked")
		return
	}
	if expiresAt != nil && expiresAt.Before(time.Now()) {
		writeErr(w, 410, "expired", "share link has expired")
		return
	}
	if oneTime && usedAt != nil {
		writeErr(w, 410, "consumed", "one-time link has already been used")
		return
	}
	if dlLimit != nil && dlCount >= *dlLimit {
		writeErr(w, 410, "limit_reached", "download limit reached")
		return
	}
	if passwordHash != nil {
		if req.Password == "" {
			writeErr(w, 401, "password_required", "this link is password-protected")
			return
		}
		if bcrypt.CompareHashAndPassword([]byte(*passwordHash), []byte(req.Password)) != nil {
			writeErr(w, 401, "bad_password", "incorrect password")
			return
		}
	}

	// AV gate. Public share links are the largest blast radius for an
	// infected payload — anyone with the URL can grab it. Refuse
	// release on anything other than 'clean' / 'skipped' regardless of
	// the share's other allowances. See scanner.GateBlock for the
	// full status → response mapping.
	if msg, status, code, blocked := scanner.GateBlock(scanStatus, scanSig); blocked {
		writeErr(w, status, code, msg)
		return
	}

	// Pass `mime` so the storage layer forces `attachment` for risky
	// renderable types regardless of caller intent — public share links
	// are the highest-risk download path for stored-XSS.
	url, err := h.Storage.PresignGet(r.Context(), storageKey, mime, name, 10*time.Minute)
	if err != nil {
		writeErr(w, 500, "presign", err.Error())
		return
	}

	// Log access + bump counters for download actions.
	_, _ = h.DB.Exec(r.Context(),
		`INSERT INTO share_access_log (share_id, file_id, ip_addr, user_agent, action)
		 VALUES ($1, $2, $3::inet, NULLIF($4,''), $5)`,
		shareID, fileID, cleanIP(clientIP(r)), r.UserAgent(), req.Action)

	if req.Action == "download" {
		_, _ = h.DB.Exec(r.Context(),
			`UPDATE share_links
			    SET download_count = download_count + 1,
			        used_at = COALESCE(used_at, CASE WHEN one_time THEN now() END)
			  WHERE id = $1`,
			shareID)
	}

	events.Publish(r.Context(), events.ShareAccessed, orgID, map[string]interface{}{
		"shareId":   shareID,
		"fileId":    fileID,
		"fileName":  name,
		"role":      role,
		"action":    req.Action,
		"ip":        clientIP(r),
		"userAgent": r.UserAgent(),
	})
	writeJSON(w, 200, publicResolveResp{FileName: name, Mime: mime, Size: size, DownloadURL: url, Role: role})
}

func cleanIP(ip string) string {
	if ip == "" {
		return "0.0.0.0"
	}
	// Strip port
	for i := len(ip) - 1; i >= 0; i-- {
		if ip[i] == ':' {
			return ip[:i]
		}
	}
	return ip
}

func clientIP(r *http.Request) string {
	if v := r.Header.Get("X-Forwarded-For"); v != "" {
		return v
	}
	return r.RemoteAddr
}

func randomToken(n int) (string, error) {
	b := make([]byte, n)
	if _, err := rand.Read(b); err != nil {
		return "", err
	}
	return base64.RawURLEncoding.EncodeToString(b), nil
}

func writeJSON(w http.ResponseWriter, code int, v interface{}) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(code)
	_ = json.NewEncoder(w).Encode(v)
}
func writeErr(w http.ResponseWriter, code int, slug, msg string) {
	writeJSON(w, code, map[string]any{"error": map[string]string{"code": slug, "message": msg}})
}
