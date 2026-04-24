package files

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"time"

	"github.com/docforge/api/internal/auth"
	"github.com/docforge/api/internal/events"
	"github.com/docforge/api/internal/sharing"
	"github.com/docforge/api/internal/storage"
	"github.com/go-chi/chi/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

// Detector runs after a file upload completes. It may return a template ID if one was created.
type Detector func(ctx context.Context, fileID, orgID, name, mime, storageKey string) (string, error)

type Handler struct {
	DB       *pgxpool.Pool
	Storage  *storage.Client
	Detector Detector
}

func New(db *pgxpool.Pool, s *storage.Client) *Handler {
	return &Handler{DB: db, Storage: s}
}

type fileDTO struct {
	ID         string    `json:"id"`
	Name       string    `json:"name"`
	Mime       string    `json:"mime"`
	Size       int64     `json:"size"`
	Status     string    `json:"status"`
	TemplateID *string   `json:"templateId,omitempty"`
	FolderID   *string   `json:"folderId,omitempty"`
	CreatedAt  time.Time `json:"createdAt"`
}

type uploadURLReq struct {
	Name string `json:"name"`
	Mime string `json:"mime"`
}

type uploadURLResp struct {
	FileID    string `json:"fileId"`
	UploadURL string `json:"uploadUrl"`
	Key       string `json:"key"`
}

func (h *Handler) CreateUploadURL(w http.ResponseWriter, r *http.Request) {
	c := r.Context().Value(auth.UserCtxKey).(*auth.Claims)
	var req uploadURLReq
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeErr(w, 400, "invalid_body", err.Error())
		return
	}
	if req.Name == "" {
		writeErr(w, 400, "missing_name", "name required")
		return
	}
	if req.Mime == "" {
		req.Mime = "application/octet-stream"
	}

	var id string
	if err := h.DB.QueryRow(r.Context(),
		`INSERT INTO files (org_id, owner_id, name, mime, storage_key) VALUES ($1,$2,$3,$4,'') RETURNING id`,
		c.OrgID, c.UserID, req.Name, req.Mime,
	).Scan(&id); err != nil {
		writeErr(w, 500, "db_error", err.Error())
		return
	}
	key := fmt.Sprintf("orgs/%s/files/%s/%s", c.OrgID, id, req.Name)
	if _, err := h.DB.Exec(r.Context(), `UPDATE files SET storage_key=$1 WHERE id=$2`, key, id); err != nil {
		writeErr(w, 500, "db_error", err.Error())
		return
	}

	url, err := h.Storage.PresignPut(r.Context(), key, 15*time.Minute)
	if err != nil {
		writeErr(w, 500, "presign", err.Error())
		return
	}
	writeJSON(w, 200, uploadURLResp{FileID: id, UploadURL: url, Key: key})
}

func (h *Handler) Complete(w http.ResponseWriter, r *http.Request) {
	c := r.Context().Value(auth.UserCtxKey).(*auth.Claims)
	id := chi.URLParam(r, "id")

	var key, name, mime string
	if err := h.DB.QueryRow(r.Context(),
		`SELECT storage_key, name, mime FROM files WHERE id=$1 AND org_id=$2`, id, c.OrgID,
	).Scan(&key, &name, &mime); err != nil {
		writeErr(w, 404, "not_found", "file not found")
		return
	}

	info, err := h.Storage.StatObject(r.Context(), key)
	if err != nil {
		writeErr(w, 400, "not_uploaded", "object missing from storage")
		return
	}

	if _, err := h.DB.Exec(r.Context(),
		`UPDATE files SET status='active', size=$1, updated_at=now() WHERE id=$2`,
		info.Size, id,
	); err != nil {
		writeErr(w, 500, "db_error", err.Error())
		return
	}

	resp := map[string]any{"ok": true, "size": info.Size}
	if h.Detector != nil {
		tplID, err := h.Detector(r.Context(), id, c.OrgID, name, mime, key)
		if err == nil && tplID != "" {
			resp["templateId"] = tplID
		}
	}
	events.Publish(r.Context(), events.FileUploaded, c.OrgID, map[string]interface{}{
		"fileId":     id,
		"name":       name,
		"mime":       mime,
		"size":       info.Size,
		"templateId": resp["templateId"],
	})
	writeJSON(w, 200, resp)
}

func (h *Handler) List(w http.ResponseWriter, r *http.Request) {
	c := r.Context().Value(auth.UserCtxKey).(*auth.Claims)
	q := r.URL.Query()
	view := q.Get("view")

	// Admins can opt into the old org-wide view with `?scope=org`;
	// otherwise every list is filtered to files the caller owns or
	// has been shared on (directly or via a folder share).
	orgWide := c.IsAdmin() && q.Get("scope") == "org"

	// Build the visibility AND-clause once. Non-admins always get it;
	// admins get it unless they passed `?scope=org`. Placeholder
	// numbering starts after the query's static args so each branch
	// can compute its own base offset.
	visClause := func(startIdx int) (string, []any) {
		if orgWide {
			return "", nil
		}
		clause, vargs := sharing.FileVisibilityClause("files", c.UserID, startIdx)
		return " AND " + clause, vargs
	}

	var sql string
	var args []any
	switch view {
	case "trashed":
		vis, vargs := visClause(2)
		sql = `SELECT id, name, mime, size, status, template_id, folder_id, created_at
		       FROM files
		       WHERE org_id=$1 AND trashed_at IS NOT NULL` + vis + `
		       ORDER BY created_at DESC
		       LIMIT 200`
		args = append([]any{c.OrgID}, vargs...)
	case "templates":
		vis, vargs := visClause(2)
		sql = `SELECT id, name, mime, size, status, template_id, folder_id, created_at
		       FROM files
		       WHERE org_id=$1 AND trashed_at IS NULL AND template_id IS NOT NULL` + vis + `
		       ORDER BY created_at DESC
		       LIMIT 200`
		args = append([]any{c.OrgID}, vargs...)
	case "recent":
		vis, vargs := visClause(2)
		sql = `SELECT id, name, mime, size, status, template_id, folder_id, created_at
		       FROM files
		       WHERE org_id=$1 AND trashed_at IS NULL` + vis + `
		       ORDER BY created_at DESC
		       LIMIT 50`
		args = append([]any{c.OrgID}, vargs...)
	default:
		folder := q.Get("folder") // "" = root
		vis, vargs := visClause(3)
		sql = `SELECT id, name, mime, size, status, template_id, folder_id, created_at
		       FROM files
		       WHERE org_id=$1 AND trashed_at IS NULL
		         AND (($2='' AND folder_id IS NULL) OR folder_id::text=$2)` + vis + `
		       ORDER BY created_at DESC`
		args = append([]any{c.OrgID, folder}, vargs...)
	}

	rows, err := h.DB.Query(r.Context(), sql, args...)
	if err != nil {
		writeErr(w, 500, "db_error", err.Error())
		return
	}
	defer rows.Close()
	out := []fileDTO{}
	for rows.Next() {
		var f fileDTO
		if err := rows.Scan(&f.ID, &f.Name, &f.Mime, &f.Size, &f.Status, &f.TemplateID, &f.FolderID, &f.CreatedAt); err != nil {
			writeErr(w, 500, "db_error", err.Error())
			return
		}
		out = append(out, f)
	}
	writeJSON(w, 200, map[string]any{"files": out})
}

// Restore un-trashes a file that was soft-deleted via the Delete endpoint.
func (h *Handler) Restore(w http.ResponseWriter, r *http.Request) {
	c := r.Context().Value(auth.UserCtxKey).(*auth.Claims)
	id := chi.URLParam(r, "id")
	tag, err := h.DB.Exec(r.Context(),
		`UPDATE files SET trashed_at=NULL, updated_at=now()
		 WHERE id=$1 AND org_id=$2 AND trashed_at IS NOT NULL`,
		id, c.OrgID,
	)
	if err != nil {
		writeErr(w, 500, "db_error", err.Error())
		return
	}
	if tag.RowsAffected() == 0 {
		writeErr(w, 404, "not_found", "file not found or not trashed")
		return
	}
	writeJSON(w, 200, map[string]any{"ok": true})
}

func (h *Handler) Get(w http.ResponseWriter, r *http.Request) {
	c := r.Context().Value(auth.UserCtxKey).(*auth.Claims)
	id := chi.URLParam(r, "id")
	// Access gate before reading the row so we don't leak metadata via
	// a 200 vs 404 split — CanAccessFile already returns a consistent
	// "is in org AND visible to me" signal.
	ok, err := sharing.CanAccessFile(r.Context(), h.DB, c, id)
	if err != nil {
		writeErr(w, 500, "db_error", err.Error())
		return
	}
	if !ok {
		writeErr(w, 404, "not_found", "file not found")
		return
	}
	var f fileDTO
	if err := h.DB.QueryRow(r.Context(),
		`SELECT id, name, mime, size, status, template_id, folder_id, created_at FROM files
		 WHERE id=$1 AND org_id=$2 AND trashed_at IS NULL`, id, c.OrgID,
	).Scan(&f.ID, &f.Name, &f.Mime, &f.Size, &f.Status, &f.TemplateID, &f.FolderID, &f.CreatedAt); err != nil {
		writeErr(w, 404, "not_found", "file not found")
		return
	}
	writeJSON(w, 200, f)
}

func (h *Handler) Download(w http.ResponseWriter, r *http.Request) {
	c := r.Context().Value(auth.UserCtxKey).(*auth.Claims)
	id := chi.URLParam(r, "id")
	ok, err := sharing.CanAccessFile(r.Context(), h.DB, c, id)
	if err != nil {
		writeErr(w, 500, "db_error", err.Error())
		return
	}
	if !ok {
		writeErr(w, 404, "not_found", "file not found")
		return
	}
	var key, name string
	if err := h.DB.QueryRow(r.Context(),
		`SELECT storage_key, name FROM files WHERE id=$1 AND org_id=$2 AND trashed_at IS NULL`, id, c.OrgID,
	).Scan(&key, &name); err != nil {
		writeErr(w, 404, "not_found", "file not found")
		return
	}
	url, err := h.Storage.PresignGet(r.Context(), key, name, 5*time.Minute)
	if err != nil {
		writeErr(w, 500, "presign", err.Error())
		return
	}
	writeJSON(w, 200, map[string]string{"downloadUrl": url})
}

type patchReq struct {
	Name     *string `json:"name"`
	FolderID *string `json:"folderId"` // "" = root
}

func (h *Handler) Patch(w http.ResponseWriter, r *http.Request) {
	c := r.Context().Value(auth.UserCtxKey).(*auth.Claims)
	id := chi.URLParam(r, "id")
	// Only the owner (or an admin) can rename / move.
	if !c.IsAdmin() {
		var owns bool
		if err := h.DB.QueryRow(r.Context(),
			`SELECT EXISTS(SELECT 1 FROM files WHERE id=$1 AND org_id=$2 AND owner_id=$3 AND trashed_at IS NULL)`,
			id, c.OrgID, c.UserID).Scan(&owns); err != nil {
			writeErr(w, 500, "db_error", err.Error())
			return
		}
		if !owns {
			writeErr(w, 403, "forbidden", "only the owner can modify this file")
			return
		}
	}
	var req patchReq
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeErr(w, 400, "invalid_body", err.Error())
		return
	}
	if req.Name != nil && *req.Name != "" {
		if _, err := h.DB.Exec(r.Context(),
			`UPDATE files SET name=$1, updated_at=now() WHERE id=$2 AND org_id=$3`,
			*req.Name, id, c.OrgID,
		); err != nil {
			writeErr(w, 500, "db_error", err.Error())
			return
		}
	}
	if req.FolderID != nil {
		var arg interface{}
		if *req.FolderID == "" {
			arg = nil
		} else {
			var ok bool
			_ = h.DB.QueryRow(r.Context(),
				`SELECT EXISTS(SELECT 1 FROM folders WHERE id=$1 AND org_id=$2)`,
				*req.FolderID, c.OrgID,
			).Scan(&ok)
			if !ok {
				writeErr(w, 400, "bad_folder", "folder not found")
				return
			}
			arg = *req.FolderID
		}
		if _, err := h.DB.Exec(r.Context(),
			`UPDATE files SET folder_id=$1, updated_at=now() WHERE id=$2 AND org_id=$3`,
			arg, id, c.OrgID,
		); err != nil {
			writeErr(w, 500, "db_error", err.Error())
			return
		}
	}
	writeJSON(w, 200, map[string]any{"ok": true})
}

func (h *Handler) Delete(w http.ResponseWriter, r *http.Request) {
	c := r.Context().Value(auth.UserCtxKey).(*auth.Claims)
	id := chi.URLParam(r, "id")
	// Only the owner (or an admin) can trash. Shared-with viewers/editors
	// can't delete resources they don't own.
	ownerFilter := "AND owner_id=$3"
	args := []any{id, c.OrgID, c.UserID}
	if c.IsAdmin() {
		ownerFilter = ""
		args = args[:2]
	}
	tag, err := h.DB.Exec(r.Context(),
		`UPDATE files SET trashed_at=now() WHERE id=$1 AND org_id=$2 `+ownerFilter+` AND trashed_at IS NULL`,
		args...,
	)
	if err != nil {
		writeErr(w, 500, "db_error", err.Error())
		return
	}
	if tag.RowsAffected() == 0 {
		writeErr(w, 404, "not_found", "file not found")
		return
	}
	writeJSON(w, 200, map[string]any{"ok": true})
}

func writeJSON(w http.ResponseWriter, code int, v interface{}) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(code)
	_ = json.NewEncoder(w).Encode(v)
}

func writeErr(w http.ResponseWriter, code int, slug, msg string) {
	writeJSON(w, code, map[string]any{"error": map[string]string{"code": slug, "message": msg}})
}
