package folders

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"time"

	"github.com/docforge/api/internal/auth"
	"github.com/docforge/api/internal/sharing"
	"github.com/docforge/api/internal/vault"
	"github.com/go-chi/chi/v5"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

type Handler struct{ DB *pgxpool.Pool }

func New(db *pgxpool.Pool) *Handler { return &Handler{DB: db} }

type folderDTO struct {
	ID        string    `json:"id"`
	ParentID  *string   `json:"parentId"`
	Name      string    `json:"name"`
	CreatedAt time.Time `json:"createdAt"`
	// Locked = folder is part of the vault. The web UI uses this to
	// render the lock chip and decide whether to prompt for re-auth on
	// click. Listing children of a locked folder still requires the
	// caller to have an active vault session — see vault.RequireUnlocked.
	Locked   bool   `json:"locked"`
	LockedAt string `json:"lockedAt,omitempty"`
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

type ensurePathReq struct {
	ParentID *string `json:"parentId"`
	Path     string  `json:"path"`
}

// EnsurePath walks/creates a "/"-separated folder chain under the given
// parent (or root) and returns the leaf folder id. Idempotent: existing
// segments are reused by name. Used by the folder-upload pipeline so the
// client can mirror an OS directory tree in one round-trip per branch.
func (h *Handler) EnsurePath(w http.ResponseWriter, r *http.Request) {
	c := r.Context().Value(auth.UserCtxKey).(*auth.Claims)
	var req ensurePathReq
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeErr(w, 400, "invalid_body", err.Error())
		return
	}
	folderID, err := EnsurePath(r.Context(), h.DB, c.OrgID, c.UserID, req.Path, req.ParentID)
	if err != nil {
		// EnsurePath returns ErrBadParent when the supplied parent isn't
		// in the caller's org — surface that as 400, everything else as 500.
		if errors.Is(err, ErrBadParent) {
			writeErr(w, 400, "bad_parent", err.Error())
			return
		}
		writeErr(w, 500, "db_error", err.Error())
		return
	}
	writeJSON(w, 200, map[string]any{"folderId": folderID})
}

// ErrBadParent is returned by EnsurePath when the supplied parentID
// doesn't exist in the caller's org. Callers that surface this to HTTP
// should map it to 400; internal callers (the generate runner) treat it
// as a configuration error and bail out of the render.
var ErrBadParent = errors.New("parent folder not found")

// EnsurePath walks `path` segment-by-segment, finding or creating each
// folder under `parentID` (or root when parentID is nil/empty), and
// returns the leaf folder id. Idempotent — existing segments are reused
// by name. Path may use either "/" or "\" as separator; empty segments
// (leading / trailing / repeated separators) are skipped.
//
// Returns (nil, nil) when the resolved path has zero segments AND no
// parent was supplied — i.e. the caller wanted "root", which we represent
// as a NULL folder_id on files.
//
// Used by the HTTP EnsurePath handler and by the generate runner to
// route output PDFs into a Drive folder hierarchy on save. Pulling the
// logic out of the handler avoids duplicating the find-or-create loop
// in two places — they would inevitably drift.
func EnsurePath(
	ctx context.Context,
	db *pgxpool.Pool,
	orgID, userID, path string,
	parentID *string,
) (*string, error) {
	segs := splitFolderPath(path)
	var current *string
	if parentID != nil && *parentID != "" {
		var ok bool
		_ = db.QueryRow(ctx,
			`SELECT EXISTS(SELECT 1 FROM folders WHERE id=$1 AND org_id=$2)`, *parentID, orgID,
		).Scan(&ok)
		if !ok {
			return nil, ErrBadParent
		}
		current = parentID
	}
	if len(segs) == 0 {
		return current, nil
	}
	for _, name := range segs {
		var id string
		var err error
		if current == nil {
			err = db.QueryRow(ctx,
				`SELECT id FROM folders WHERE org_id=$1 AND parent_id IS NULL AND name=$2 LIMIT 1`,
				orgID, name).Scan(&id)
		} else {
			err = db.QueryRow(ctx,
				`SELECT id FROM folders WHERE org_id=$1 AND parent_id=$2 AND name=$3 LIMIT 1`,
				orgID, *current, name).Scan(&id)
		}
		if errors.Is(err, pgx.ErrNoRows) {
			if err = db.QueryRow(ctx,
				`INSERT INTO folders (org_id, parent_id, name, owner_id) VALUES ($1,$2,$3,$4) RETURNING id`,
				orgID, current, name, userID,
			).Scan(&id); err != nil {
				return nil, err
			}
		} else if err != nil {
			return nil, err
		}
		next := id
		current = &next
	}
	return current, nil
}

func splitFolderPath(p string) []string {
	out := []string{}
	cur := ""
	flush := func() {
		if cur != "" {
			out = append(out, cur)
			cur = ""
		}
	}
	for _, r := range p {
		if r == '/' || r == '\\' {
			flush()
			continue
		}
		cur += string(r)
	}
	flush()
	return out
}

func (h *Handler) List(w http.ResponseWriter, r *http.Request) {
	c := r.Context().Value(auth.UserCtxKey).(*auth.Claims)
	q := r.URL.Query()
	parent := q.Get("parent") // empty = root
	orgWide := c.IsAdmin() && q.Get("scope") == "org"

	// Listing children of a locked folder requires an unlocked vault.
	// Root listings (parent="") are always allowed — they only show
	// folder *names* (and a `locked` flag the UI can chip), not contents.
	if parent != "" {
		if err := vault.RequireUnlocked(r.Context(), h.DB, c.UserID, parent); err != nil {
			if errors.Is(err, vault.ErrLocked) {
				vault.WriteLockedError(w)
				return
			}
			writeErr(w, 500, "db_error", err.Error())
			return
		}
	}

	sql := `SELECT id, parent_id, name, created_at, locked_at FROM folders
		 WHERE org_id=$1 AND (($2='' AND parent_id IS NULL) OR parent_id::text=$2)`
	args := []any{c.OrgID, parent}
	if !orgWide {
		clause, vargs := sharing.FolderVisibilityClause("folders", c.UserID, 3)
		sql += " AND " + clause
		args = append(args, vargs...)
	}
	sql += " ORDER BY name"
	rows, err := h.DB.Query(r.Context(), sql, args...)
	if err != nil {
		writeErr(w, 500, "db_error", err.Error())
		return
	}
	defer rows.Close()
	out := []folderDTO{}
	for rows.Next() {
		var f folderDTO
		var lockedAt *time.Time
		if err := rows.Scan(&f.ID, &f.ParentID, &f.Name, &f.CreatedAt, &lockedAt); err != nil {
			writeErr(w, 500, "db_error", err.Error())
			return
		}
		if lockedAt != nil {
			f.Locked = true
			f.LockedAt = lockedAt.UTC().Format(time.RFC3339)
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
	// Only the owner (or an admin) can rename / move a folder.
	if !c.IsAdmin() {
		var owns bool
		if err := h.DB.QueryRow(r.Context(),
			`SELECT EXISTS(SELECT 1 FROM folders WHERE id=$1 AND org_id=$2 AND owner_id=$3)`,
			id, c.OrgID, c.UserID).Scan(&owns); err != nil {
			writeErr(w, 500, "db_error", err.Error())
			return
		}
		if !owns {
			writeErr(w, 403, "forbidden", "only the owner can modify this folder")
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
	// Only the owner (or an admin) can delete.
	ownerFilter := "AND owner_id=$3"
	delArgs := []any{id, c.OrgID, c.UserID}
	if c.IsAdmin() {
		ownerFilter = ""
		delArgs = delArgs[:2]
	}
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
		`DELETE FROM folders WHERE id=$1 AND org_id=$2 `+ownerFilter, delArgs...)
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
