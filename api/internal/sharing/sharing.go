package sharing

import (
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"net/http"
	"time"

	"github.com/docforge/api/internal/auth"
	"github.com/docforge/api/internal/storage"
	"github.com/go-chi/chi/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

type Handler struct {
	DB      *pgxpool.Pool
	Storage *storage.Client
}

func New(db *pgxpool.Pool, s *storage.Client) *Handler {
	return &Handler{DB: db, Storage: s}
}

type shareDTO struct {
	ID        string     `json:"id"`
	Token     string     `json:"token"`
	Role      string     `json:"role"`
	ExpiresAt *time.Time `json:"expiresAt,omitempty"`
	CreatedAt time.Time  `json:"createdAt"`
}

type createReq struct {
	Role       string `json:"role"`       // viewer | downloader
	ExpiresIn  int    `json:"expiresIn"`  // seconds; 0 = no expiry
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

	var id string
	err = h.DB.QueryRow(r.Context(),
		`INSERT INTO share_links (org_id, file_id, token, role, expires_at, created_by)
		 VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
		c.OrgID, fileID, token, req.Role, expires, c.UserID,
	).Scan(&id)
	if err != nil {
		writeErr(w, 500, "db_error", err.Error())
		return
	}
	writeJSON(w, 200, shareDTO{ID: id, Token: token, Role: req.Role, ExpiresAt: expires, CreatedAt: time.Now()})
}

func (h *Handler) List(w http.ResponseWriter, r *http.Request) {
	c := r.Context().Value(auth.UserCtxKey).(*auth.Claims)
	fileID := chi.URLParam(r, "id")
	rows, err := h.DB.Query(r.Context(),
		`SELECT id, token, role, expires_at, created_at FROM share_links
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
		if err := rows.Scan(&s.ID, &s.Token, &s.Role, &s.ExpiresAt, &s.CreatedAt); err != nil {
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

// Resolve is unauthenticated — resolves a share token into a pre-signed download URL.
func (h *Handler) Resolve(w http.ResponseWriter, r *http.Request) {
	token := chi.URLParam(r, "token")
	var (
		name, mime, storageKey, role string
		size                         int64
		expiresAt                    *time.Time
	)
	err := h.DB.QueryRow(r.Context(),
		`SELECT f.name, f.mime, f.size, f.storage_key, s.role, s.expires_at
		 FROM share_links s JOIN files f ON f.id=s.file_id
		 WHERE s.token=$1 AND s.revoked_at IS NULL AND f.trashed_at IS NULL`, token,
	).Scan(&name, &mime, &size, &storageKey, &role, &expiresAt)
	if err != nil {
		writeErr(w, 404, "not_found", "share not found or revoked")
		return
	}
	if expiresAt != nil && expiresAt.Before(time.Now()) {
		writeErr(w, 410, "expired", "share link has expired")
		return
	}
	url, err := h.Storage.PresignGet(r.Context(), storageKey, name, 10*time.Minute)
	if err != nil {
		writeErr(w, 500, "presign", err.Error())
		return
	}
	writeJSON(w, 200, publicResolveResp{FileName: name, Mime: mime, Size: size, DownloadURL: url, Role: role})
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
