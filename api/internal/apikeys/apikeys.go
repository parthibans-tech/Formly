// Package apikeys implements per-organization API keys for programmatic
// access to the v1 REST API. A key's full value is shown to the user ONCE at
// creation; only a SHA-256 hash + short prefix is persisted.
package apikeys

import (
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"net/http"
	"strings"
	"time"

	"github.com/docforge/api/internal/auth"
	"github.com/go-chi/chi/v5"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

type Handler struct {
	DB *pgxpool.Pool
}

func New(db *pgxpool.Pool) *Handler {
	return &Handler{DB: db}
}

// KeyPrefix is the stable label used to detect API keys vs JWTs in the auth
// middleware. Everything after the prefix is random.
const KeyPrefix = "fk_"

// prefixLen is how many chars of the full key we store for indexed lookup.
// Must be long enough to be unique across the table — 16 chars (≈ 96 bits of
// base64 entropy) is comfortable.
const prefixLen = 16

// Generate returns a (fullKey, prefix, hash) triple. The caller shows the
// fullKey to the user once, stores the prefix + hash in the DB, and discards
// the fullKey from memory.
func Generate() (fullKey, prefix string, hash []byte, err error) {
	var b [24]byte
	if _, err = rand.Read(b[:]); err != nil {
		return
	}
	fullKey = KeyPrefix + base64.RawURLEncoding.EncodeToString(b[:])
	if len(fullKey) < prefixLen {
		prefix = fullKey
	} else {
		prefix = fullKey[:prefixLen]
	}
	h := sha256.Sum256([]byte(fullKey))
	hash = h[:]
	return
}

// -- HTTP handlers ---------------------------------------------------------

type keyDTO struct {
	ID         string  `json:"id"`
	Name       string  `json:"name"`
	Prefix     string  `json:"prefix"`
	CreatedAt  string  `json:"createdAt"`
	LastUsedAt *string `json:"lastUsedAt,omitempty"`
	ExpiresAt  *string `json:"expiresAt,omitempty"`
	Revoked    bool    `json:"revoked"`
}

func (h *Handler) List(w http.ResponseWriter, r *http.Request) {
	c := r.Context().Value(auth.UserCtxKey).(*auth.Claims)
	rows, err := h.DB.Query(r.Context(), `
		SELECT id, name, prefix, created_at, last_used_at, expires_at, revoked_at
		  FROM api_keys
		 WHERE org_id=$1
		 ORDER BY created_at DESC`, c.OrgID)
	if err != nil {
		writeErr(w, 500, "db_error", err.Error())
		return
	}
	defer rows.Close()
	out := []keyDTO{}
	for rows.Next() {
		var (
			id, name, prefix string
			createdAt        time.Time
			lastUsed         *time.Time
			expiresAt        *time.Time
			revokedAt        *time.Time
		)
		if err := rows.Scan(&id, &name, &prefix, &createdAt, &lastUsed, &expiresAt, &revokedAt); err != nil {
			writeErr(w, 500, "db_error", err.Error())
			return
		}
		dto := keyDTO{
			ID:        id,
			Name:      name,
			Prefix:    prefix,
			CreatedAt: createdAt.Format(time.RFC3339),
			Revoked:   revokedAt != nil,
		}
		if lastUsed != nil {
			s := lastUsed.Format(time.RFC3339)
			dto.LastUsedAt = &s
		}
		if expiresAt != nil {
			s := expiresAt.Format(time.RFC3339)
			dto.ExpiresAt = &s
		}
		out = append(out, dto)
	}
	writeJSON(w, 200, map[string]any{"keys": out})
}

type createReq struct {
	Name      string `json:"name"`
	ExpiresIn int    `json:"expiresInDays,omitempty"` // 0 = never
}

type createResp struct {
	ID        string `json:"id"`
	Name      string `json:"name"`
	Prefix    string `json:"prefix"`
	Key       string `json:"key"` // full key — shown exactly once
	CreatedAt string `json:"createdAt"`
	ExpiresAt string `json:"expiresAt,omitempty"`
}

func (h *Handler) Create(w http.ResponseWriter, r *http.Request) {
	c := r.Context().Value(auth.UserCtxKey).(*auth.Claims)
	var req createReq
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeErr(w, 400, "invalid_body", err.Error())
		return
	}
	name := strings.TrimSpace(req.Name)
	if name == "" {
		name = "Untitled key"
	}
	fullKey, prefix, hash, err := Generate()
	if err != nil {
		writeErr(w, 500, "rand", err.Error())
		return
	}
	var expiresAt *time.Time
	if req.ExpiresIn > 0 {
		t := time.Now().AddDate(0, 0, req.ExpiresIn)
		expiresAt = &t
	}

	var id string
	var createdAt time.Time
	err = h.DB.QueryRow(r.Context(), `
		INSERT INTO api_keys (org_id, user_id, name, prefix, hash, expires_at)
		VALUES ($1,$2,$3,$4,$5,$6)
		RETURNING id, created_at
	`, c.OrgID, c.UserID, name, prefix, hash, expiresAt).Scan(&id, &createdAt)
	if err != nil {
		writeErr(w, 500, "db_error", err.Error())
		return
	}

	resp := createResp{
		ID:        id,
		Name:      name,
		Prefix:    prefix,
		Key:       fullKey,
		CreatedAt: createdAt.Format(time.RFC3339),
	}
	if expiresAt != nil {
		resp.ExpiresAt = expiresAt.Format(time.RFC3339)
	}
	writeJSON(w, 200, resp)
}

func (h *Handler) Revoke(w http.ResponseWriter, r *http.Request) {
	c := r.Context().Value(auth.UserCtxKey).(*auth.Claims)
	id := chi.URLParam(r, "id")
	tag, err := h.DB.Exec(r.Context(), `
		UPDATE api_keys SET revoked_at=now()
		 WHERE id=$1 AND org_id=$2 AND revoked_at IS NULL`, id, c.OrgID)
	if err != nil {
		writeErr(w, 500, "db_error", err.Error())
		return
	}
	if tag.RowsAffected() == 0 {
		writeErr(w, 404, "not_found", "key not found or already revoked")
		return
	}
	writeJSON(w, 200, map[string]any{"ok": true})
}

// -- shared helpers --------------------------------------------------------

func prefixOf(k string) string {
	if len(k) < prefixLen {
		return k
	}
	return k[:prefixLen]
}

// VerifyAndLoad is called by the auth middleware. Returns (userID, orgID, email, role)
// when the key is valid.
func VerifyAndLoad(db *pgxpool.Pool, r *http.Request, raw string) (userID, orgID, email, role string, err error) {
	pfx := prefixOf(raw)
	var (
		keyID                     string
		storedHash                []byte
		uid, oid, userEmail, rle  string
		revokedAt, expiresAt      *time.Time
	)
	err = db.QueryRow(r.Context(), `
		SELECT k.id, k.hash, k.user_id, k.org_id, u.email, COALESCE(u.role,'editor'),
		       k.revoked_at, k.expires_at
		  FROM api_keys k JOIN users u ON u.id = k.user_id
		 WHERE k.prefix=$1`, pfx,
	).Scan(&keyID, &storedHash, &uid, &oid, &userEmail, &rle, &revokedAt, &expiresAt)
	if err != nil {
		if err == pgx.ErrNoRows {
			return "", "", "", "", ErrInvalidKey
		}
		return "", "", "", "", err
	}
	if revokedAt != nil {
		return "", "", "", "", ErrRevokedKey
	}
	if expiresAt != nil && expiresAt.Before(time.Now()) {
		return "", "", "", "", ErrExpiredKey
	}
	h := sha256.Sum256([]byte(raw))
	if subtle.ConstantTimeCompare(h[:], storedHash) != 1 {
		return "", "", "", "", ErrInvalidKey
	}
	// Best-effort "last used" update. Fire-and-forget so we don't block requests.
	go func() {
		_, _ = db.Exec(r.Context(), `UPDATE api_keys SET last_used_at=now() WHERE id=$1`, keyID)
	}()
	return uid, oid, userEmail, rle, nil
}

// Debug helper used by tests.
func HashHex(b []byte) string { return hex.EncodeToString(b) }

// -- errors ---------------------------------------------------------------

type apikeyError string

func (e apikeyError) Error() string { return string(e) }

const (
	ErrInvalidKey apikeyError = "invalid api key"
	ErrRevokedKey apikeyError = "api key revoked"
	ErrExpiredKey apikeyError = "api key expired"
)

// -- tiny helpers ---------------------------------------------------------

func writeJSON(w http.ResponseWriter, code int, v interface{}) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(code)
	_ = json.NewEncoder(w).Encode(v)
}

func writeErr(w http.ResponseWriter, code int, slug, msg string) {
	writeJSON(w, code, map[string]any{"error": map[string]string{"code": slug, "message": msg}})
}
