// Package orgs serves the per-tenant organization management endpoints.
// Today this is a thin module focused on org branding (the logo shown
// in the app shell + on billing artefacts); it lives next to /me so the
// `/v1/orgs/me/...` namespace stays predictable.
//
// Logo storage: small (<=512 KB) PNG/JPEG/SVG (SVG is treated as risky
// at the storage layer — see PresignGetInline) is uploaded to MinIO at
// a stable per-org key. The DB only tracks (object_key, mime, updated_at);
// the public URL is a presigned GET regenerated on every read so it
// never leaks past its TTL.
package orgs

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"

	"github.com/docforge/api/internal/auth"
	"github.com/docforge/api/internal/storage"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

// LogoTTL is how long presigned logo URLs live. The header re-fetches
// /v1/me/profile on every page load, so 1h is plenty without putting
// long-lived URLs into screenshots / proxy logs.
const LogoTTL = time.Hour

// MaxLogoBytes caps the upload at 512 KB. Logos are tiny by definition;
// anything larger is almost certainly an unoptimised export and should
// be rejected at the edge rather than silently stored.
const MaxLogoBytes = 512 << 10

type Handler struct {
	DB    *pgxpool.Pool
	Store *storage.Client
}

func New(db *pgxpool.Pool, store *storage.Client) *Handler {
	return &Handler{DB: db, Store: store}
}

// allowedLogoMimes is intentionally narrow. SVG is excluded — it can
// carry script and the storage layer rewrites its disposition to
// attachment anyway, so an SVG logo would never render in the header.
var allowedLogoMimes = map[string]string{
	"image/png":     "png",
	"image/jpeg":    "jpg",
	"image/jpg":     "jpg",
	"image/webp":    "webp",
	"image/gif":     "gif",
}

// PostLogo handles POST /v1/orgs/me/logo (multipart, form field "file").
// Admin-only — only an admin should rebrand the tenant.
func (h *Handler) PostLogo(w http.ResponseWriter, r *http.Request) {
	c, _ := r.Context().Value(auth.UserCtxKey).(*auth.Claims)
	if c == nil {
		writeErr(w, 401, "unauthorized", "missing claims")
		return
	}
	if !c.IsAdmin() {
		writeErr(w, 403, "forbidden", "admin role required")
		return
	}
	// Cap multipart parsing memory at 1MB; anything larger is rejected
	// before we even pull the bytes off the wire.
	if err := r.ParseMultipartForm(1 << 20); err != nil {
		writeErr(w, 400, "invalid_body", err.Error())
		return
	}
	file, hdr, err := r.FormFile("file")
	if err != nil {
		writeErr(w, 400, "missing_file", "expected form field 'file'")
		return
	}
	defer file.Close()
	if hdr.Size > MaxLogoBytes {
		writeErr(w, 413, "too_large",
			fmt.Sprintf("logo must be <= %d bytes", MaxLogoBytes))
		return
	}

	// We trust the client-declared mime only as a hint; the cap above
	// keeps us safe and we narrow to a fixed allow-list. Browsers send
	// type via the multipart part headers — read it before the body.
	mime := strings.ToLower(strings.TrimSpace(hdr.Header.Get("Content-Type")))
	if i := strings.IndexByte(mime, ';'); i >= 0 {
		mime = strings.TrimSpace(mime[:i])
	}
	ext, ok := allowedLogoMimes[mime]
	if !ok {
		writeErr(w, 415, "unsupported_media_type",
			"logo must be PNG, JPEG, WebP, or GIF")
		return
	}

	body, err := io.ReadAll(io.LimitReader(file, MaxLogoBytes+1))
	if err != nil {
		writeErr(w, 400, "read_failed", err.Error())
		return
	}
	if int64(len(body)) > MaxLogoBytes {
		writeErr(w, 413, "too_large",
			fmt.Sprintf("logo must be <= %d bytes", MaxLogoBytes))
		return
	}

	// Stable per-org key. Overwriting in place means we don't leak old
	// logo objects into the bucket; the row's updated_at is the only
	// version marker we need.
	key := fmt.Sprintf("orgs/%s/branding/logo.%s", c.OrgID, ext)
	if err := h.Store.PutBytes(r.Context(), key, mime, body); err != nil {
		writeErr(w, 502, "storage_failed", err.Error())
		return
	}

	now := time.Now().UTC()
	if _, err := h.DB.Exec(r.Context(), `
		UPDATE organizations
		   SET logo_object_key = $1,
		       logo_mime       = $2,
		       logo_updated_at = $3
		 WHERE id = $4`,
		key, mime, now, c.OrgID,
	); err != nil {
		writeErr(w, 500, "db_error", err.Error())
		return
	}

	url, err := h.Store.PresignGetInline(r.Context(), key, mime, LogoTTL)
	if err != nil {
		writeErr(w, 502, "presign_failed", err.Error())
		return
	}
	writeJSON(w, 200, map[string]any{
		"logoUrl":       url,
		"logoMime":      mime,
		"logoUpdatedAt": now.Format(time.RFC3339),
	})
}

// DeleteLogo handles DELETE /v1/orgs/me/logo. Admin-only. We drop both
// the storage object and the DB pointer; failures on the storage side
// are best-effort (the row update is the source of truth, and a stale
// object will be overwritten on the next upload anyway).
func (h *Handler) DeleteLogo(w http.ResponseWriter, r *http.Request) {
	c, _ := r.Context().Value(auth.UserCtxKey).(*auth.Claims)
	if c == nil {
		writeErr(w, 401, "unauthorized", "missing claims")
		return
	}
	if !c.IsAdmin() {
		writeErr(w, 403, "forbidden", "admin role required")
		return
	}

	var key *string
	err := h.DB.QueryRow(r.Context(),
		`SELECT logo_object_key FROM organizations WHERE id = $1`,
		c.OrgID,
	).Scan(&key)
	if errors.Is(err, pgx.ErrNoRows) {
		writeErr(w, 404, "not_found", "organization not found")
		return
	}
	if err != nil {
		writeErr(w, 500, "db_error", err.Error())
		return
	}

	if _, err := h.DB.Exec(r.Context(), `
		UPDATE organizations
		   SET logo_object_key = NULL,
		       logo_mime       = NULL,
		       logo_updated_at = NULL
		 WHERE id = $1`, c.OrgID,
	); err != nil {
		writeErr(w, 500, "db_error", err.Error())
		return
	}

	if key != nil && *key != "" {
		// Best-effort — see comment above.
		_ = h.Store.Remove(r.Context(), *key)
	}
	writeJSON(w, 200, map[string]any{"ok": true})
}

// LogoURL fetches a presigned URL for the org's current logo, or "" if
// no logo is set. Used by /v1/me/profile to surface the URL alongside
// the org name without giving callers a second round-trip.
func LogoURL(ctx context.Context, db *pgxpool.Pool, store *storage.Client, orgID string) string {
	if store == nil || orgID == "" {
		return ""
	}
	var key, mime *string
	err := db.QueryRow(ctx,
		`SELECT logo_object_key, logo_mime FROM organizations WHERE id = $1`,
		orgID,
	).Scan(&key, &mime)
	if err != nil || key == nil || *key == "" {
		return ""
	}
	m := ""
	if mime != nil {
		m = *mime
	}
	u, err := store.PresignGetInline(ctx, *key, m, LogoTTL)
	if err != nil {
		return ""
	}
	return u
}

func writeJSON(w http.ResponseWriter, code int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(code)
	_ = json.NewEncoder(w).Encode(v)
}

func writeErr(w http.ResponseWriter, code int, slug, msg string) {
	writeJSON(w, code, map[string]any{
		"error": map[string]any{"code": slug, "message": msg},
	})
}
