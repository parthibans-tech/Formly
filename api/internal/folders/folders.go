package folders

import (
	"context"
	"encoding/json"
	"net/http"
	"time"

	"github.com/docforge/api/internal/auth"
	"github.com/go-chi/chi/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

type Handler struct{ DB *pgxpool.Pool }

func New(db *pgxpool.Pool) *Handler { return &Handler{DB: db} }

type folderDTO struct {
	ID        string    `json:"id"`
	ParentID  *string   `json:"parentId"`
	Name      string    `json:"name"`
	CreatedAt time.Time `json:"createdAt"`
}

type createReq struct {
	Name     string  `json:"name"`
	ParentID *string `json:"parentId"`
}

func (h *Handler) Create(w http.ResponseWriter, r *http.Request) {
	c := r.Context().Value(auth.UserCtxKey).(*auth.Claims)
	var req createReq
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeErr(w, 400, "invalid_body", err.Error())
		return
	}
	if req.Name == "" {
		writeErr(w, 400, "missing_name", "name required")
		return
	}
	// If parent given, verify it belongs to the same org.
	if req.ParentID != nil {
		var ok bool
		_ = h.DB.QueryRow(r.Context(),
			`SELECT EXISTS(SELECT 1 FROM folders WHERE id=$1 AND org_id=$2)`, *req.ParentID, c.OrgID,
		).Scan(&ok)
		if !ok {
			writeErr(w, 400, "bad_parent", "parent folder not found")
			return
		}
	}
	var id string
	err := h.DB.QueryRow(r.Context(),
		`INSERT INTO folders (org_id, parent_id, name, owner_id) VALUES ($1,$2,$3,$4) RETURNING id`,
		c.OrgID, req.ParentID, req.Name, c.UserID,
	).Scan(&id)
	if err != nil {
		writeErr(w, 500, "db_error", err.Error())
		return
	}
	writeJSON(w, 200, folderDTO{ID: id, ParentID: req.ParentID, Name: req.Name, CreatedAt: time.Now()})
}

func (h *Handler) List(w http.ResponseWriter, r *http.Request) {
	c := r.Context().Value(auth.UserCtxKey).(*auth.Claims)
	parent := r.URL.Query().Get("parent") // empty = root
	rows, err := h.DB.Query(r.Context(),
		`SELECT id, parent_id, name, created_at FROM folders
		 WHERE org_id=$1 AND (($2='' AND parent_id IS NULL) OR parent_id::text=$2)
		 ORDER BY name`, c.OrgID, parent,
	)
	if err != nil {
		writeErr(w, 500, "db_error", err.Error())
		return
	}
	defer rows.Close()
	out := []folderDTO{}
	for rows.Next() {
		var f folderDTO
		if err := rows.Scan(&f.ID, &f.ParentID, &f.Name, &f.CreatedAt); err != nil {
			writeErr(w, 500, "db_error", err.Error())
			return
		}
		out = append(out, f)
	}
	writeJSON(w, 200, map[string]any{"folders": out})
}

// Breadcrumbs returns the folder + all ancestors up to root.
func (h *Handler) Breadcrumbs(w http.ResponseWriter, r *http.Request) {
	c := r.Context().Value(auth.UserCtxKey).(*auth.Claims)
	id := chi.URLParam(r, "id")
	rows, err := h.DB.Query(r.Context(),
		`WITH RECURSIVE chain AS (
			SELECT id, parent_id, name, 0 AS depth FROM folders WHERE id=$1 AND org_id=$2
			UNION ALL
			SELECT f.id, f.parent_id, f.name, c.depth+1
			FROM folders f JOIN chain c ON f.id=c.parent_id
		) SELECT id, parent_id, name FROM chain ORDER BY depth DESC`, id, c.OrgID,
	)
	if err != nil {
		writeErr(w, 500, "db_error", err.Error())
		return
	}
	defer rows.Close()
	out := []folderDTO{}
	for rows.Next() {
		var f folderDTO
		if err := rows.Scan(&f.ID, &f.ParentID, &f.Name); err != nil {
			writeErr(w, 500, "db_error", err.Error())
			return
		}
		out = append(out, f)
	}
	writeJSON(w, 200, map[string]any{"breadcrumbs": out})
}

type patchReq struct {
	Name     *string `json:"name"`
	ParentID *string `json:"parentId"` // nil means no change; "" means root
}

func (h *Handler) Patch(w http.ResponseWriter, r *http.Request) {
	c := r.Context().Value(auth.UserCtxKey).(*auth.Claims)
	id := chi.URLParam(r, "id")
	var req patchReq
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeErr(w, 400, "invalid_body", err.Error())
		return
	}
	if req.Name != nil && *req.Name != "" {
		if _, err := h.DB.Exec(r.Context(),
			`UPDATE folders SET name=$1, updated_at=now() WHERE id=$2 AND org_id=$3`, *req.Name, id, c.OrgID,
		); err != nil {
			writeErr(w, 500, "db_error", err.Error())
			return
		}
	}
	if req.ParentID != nil {
		var parentArg interface{}
		if *req.ParentID == "" {
			parentArg = nil
		} else {
			cyclic, err := createsCycle(r.Context(), h.DB, id, *req.ParentID)
			if err != nil {
				writeErr(w, 500, "db_error", err.Error())
				return
			}
			if cyclic {
				writeErr(w, 400, "cyclic_move", "cannot move folder into its own subtree")
				return
			}
			parentArg = *req.ParentID
		}
		if _, err := h.DB.Exec(r.Context(),
			`UPDATE folders SET parent_id=$1, updated_at=now() WHERE id=$2 AND org_id=$3`,
			parentArg, id, c.OrgID,
		); err != nil {
			writeErr(w, 500, "db_error", err.Error())
			return
		}
	}
	writeJSON(w, 200, map[string]any{"ok": true})
}

// Delete only succeeds if the folder is empty (no subfolders, no files).
func (h *Handler) Delete(w http.ResponseWriter, r *http.Request) {
	c := r.Context().Value(auth.UserCtxKey).(*auth.Claims)
	id := chi.URLParam(r, "id")
	var childCount, fileCount int
	_ = h.DB.QueryRow(r.Context(), `SELECT COUNT(*) FROM folders WHERE parent_id=$1`, id).Scan(&childCount)
	_ = h.DB.QueryRow(r.Context(),
		`SELECT COUNT(*) FROM files WHERE folder_id=$1 AND trashed_at IS NULL`, id,
	).Scan(&fileCount)
	if childCount+fileCount > 0 {
		writeErr(w, 400, "not_empty", "folder must be empty to delete")
		return
	}
	tag, err := h.DB.Exec(r.Context(),
		`DELETE FROM folders WHERE id=$1 AND org_id=$2`, id, c.OrgID)
	if err != nil {
		writeErr(w, 500, "db_error", err.Error())
		return
	}
	if tag.RowsAffected() == 0 {
		writeErr(w, 404, "not_found", "folder not found")
		return
	}
	writeJSON(w, 200, map[string]any{"ok": true})
}

func createsCycle(ctx context.Context, db *pgxpool.Pool, folderID, newParent string) (bool, error) {
	// Walk from newParent upward. If we hit folderID, moving creates a cycle.
	cur := newParent
	for i := 0; i < 100 && cur != ""; i++ {
		if cur == folderID {
			return true, nil
		}
		var parent *string
		err := db.QueryRow(ctx, `SELECT parent_id FROM folders WHERE id=$1`, cur).Scan(&parent)
		if err != nil {
			return false, err
		}
		if parent == nil {
			return false, nil
		}
		cur = *parent
	}
	return false, nil
}

func writeJSON(w http.ResponseWriter, code int, v interface{}) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(code)
	_ = json.NewEncoder(w).Encode(v)
}
func writeErr(w http.ResponseWriter, code int, slug, msg string) {
	writeJSON(w, code, map[string]any{"error": map[string]string{"code": slug, "message": msg}})
}
