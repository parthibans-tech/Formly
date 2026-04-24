package sharing

// Per-user and per-group ACL for files and folders.
//
// The existing share handlers in sharing.go deal with public token
// links (an unauthenticated visitor pastes a URL, downloads). This
// file deals with the *authenticated* ACL: a user in the org wants to
// grant another user (or a group of users) access to a specific file
// or folder.
//
// Storage shape comes from migration 022_sharing.sql:
//   - `resource_shares` — one row per (resource, principal) with a role.
//   - `groups` / `group_members` — named collections of users.
//
// Visibility rules enforced here:
//   owner   — files.owner_id / folders.owner_id = me
//   direct  — resource_shares row with user_id=me or group_id in my groups
//   folder  — file's folder_id (or any ancestor) has such a row
//
// `ResourceVisibilitySQL` returns a small SQL snippet + args that the
// files / folders list handlers bolt onto their WHERE clause so every
// listing stays consistent. Doing this centrally means we only ever
// have to change the visibility rules in one place.

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"strings"
	"time"

	"github.com/docforge/api/internal/auth"
	"github.com/go-chi/chi/v5"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
)

// ----- Visibility SQL --------------------------------------------------------

// FileVisibilityClause returns a SQL clause (to be AND-ed into a WHERE) and
// the args it needs, constraining `files` rows to the ones the user is
// allowed to see. The caller supplies the table alias (usually `files`
// or `f`) for the `owner_id` / `id` / `folder_id` columns so the clause
// can plug into arbitrary queries.
//
// Args returned must be appended to the caller's args slice in order, and
// the placeholders in the returned SQL start at `startIdx` (1-based to
// match pgx's $1 / $2 style).
//
// The clause evaluates to:
//   <alias>.owner_id = $userID
//   OR <alias>.id IN (<files shared directly with me or my groups>)
//   OR <alias>.folder_id IN (<folders shared (incl. via ancestor)>)
func FileVisibilityClause(alias string, userID string, startIdx int) (string, []any) {
	// userID is used three times in the clause; we only push one arg and
	// reference it by the same placeholder in each branch.
	p := fmt.Sprintf("$%d", startIdx)
	clause := fmt.Sprintf(`(
		%[1]s.owner_id = %[2]s::uuid
		OR %[1]s.id IN (
			SELECT rs.resource_id FROM resource_shares rs
			WHERE rs.resource_type = 'file'
			  AND (
				  rs.user_id = %[2]s::uuid
				  OR rs.group_id IN (SELECT gm.group_id FROM group_members gm WHERE gm.user_id = %[2]s::uuid)
			  )
		)
		OR %[1]s.folder_id IN (
			WITH RECURSIVE shared_folders AS (
				SELECT rs.resource_id AS id FROM resource_shares rs
				WHERE rs.resource_type = 'folder'
				  AND (
					  rs.user_id = %[2]s::uuid
					  OR rs.group_id IN (SELECT gm.group_id FROM group_members gm WHERE gm.user_id = %[2]s::uuid)
				  )
				UNION
				SELECT f.id FROM folders f JOIN shared_folders sf ON f.parent_id = sf.id
			)
			SELECT id FROM shared_folders
		)
	)`, alias, p)
	return clause, []any{userID}
}

// FolderVisibilityClause is the folder equivalent. A folder is visible if:
//   owner_id = me, OR
//   a resource_shares row grants it (directly or via an ancestor).
func FolderVisibilityClause(alias string, userID string, startIdx int) (string, []any) {
	p := fmt.Sprintf("$%d", startIdx)
	clause := fmt.Sprintf(`(
		%[1]s.owner_id = %[2]s::uuid
		OR %[1]s.id IN (
			WITH RECURSIVE shared_folders AS (
				SELECT rs.resource_id AS id FROM resource_shares rs
				WHERE rs.resource_type = 'folder'
				  AND (
					  rs.user_id = %[2]s::uuid
					  OR rs.group_id IN (SELECT gm.group_id FROM group_members gm WHERE gm.user_id = %[2]s::uuid)
				  )
				UNION
				SELECT f.id FROM folders f JOIN shared_folders sf ON f.parent_id = sf.id
			)
			SELECT id FROM shared_folders
		)
	)`, alias, p)
	return clause, []any{userID}
}

// ----- Can-access helpers ----------------------------------------------------

// CanAccessFile returns true if the user can see the given file.
// Used by handlers like Download / Get / Generate that accept a file
// id directly and need to verify access before running the op.
//
// Admins bypass the check (they can always see everything in their
// org); non-admins go through the full visibility tree.
func CanAccessFile(ctx context.Context, db pgxDB, claims *auth.Claims, fileID string) (bool, error) {
	if claims.IsAdmin() {
		var exists bool
		if err := db.QueryRow(ctx,
			`SELECT EXISTS(SELECT 1 FROM files WHERE id=$1 AND org_id=$2)`,
			fileID, claims.OrgID).Scan(&exists); err != nil {
			return false, err
		}
		return exists, nil
	}
	clause, args := FileVisibilityClause("f", claims.UserID, 2)
	q := "SELECT EXISTS(SELECT 1 FROM files f WHERE f.id=$1 AND f.org_id=$3 AND " + clause + ")"
	// Note: placeholder order is $1=fileID, $2=userID (from clause), $3=orgID
	var exists bool
	if err := db.QueryRow(ctx, q, append([]any{fileID}, append(args, claims.OrgID)...)...).Scan(&exists); err != nil {
		return false, err
	}
	return exists, nil
}

// CanAccessFolder — same idea for folders.
func CanAccessFolder(ctx context.Context, db pgxDB, claims *auth.Claims, folderID string) (bool, error) {
	if claims.IsAdmin() {
		var exists bool
		if err := db.QueryRow(ctx,
			`SELECT EXISTS(SELECT 1 FROM folders WHERE id=$1 AND org_id=$2)`,
			folderID, claims.OrgID).Scan(&exists); err != nil {
			return false, err
		}
		return exists, nil
	}
	clause, args := FolderVisibilityClause("f", claims.UserID, 2)
	q := "SELECT EXISTS(SELECT 1 FROM folders f WHERE f.id=$1 AND f.org_id=$3 AND " + clause + ")"
	var exists bool
	if err := db.QueryRow(ctx, q, append([]any{folderID}, append(args, claims.OrgID)...)...).Scan(&exists); err != nil {
		return false, err
	}
	return exists, nil
}

// pgxDB is the minimal pgx surface the ACL helpers need. Narrows the
// dependency so tests can stub it without importing the full pool.
type pgxDB interface {
	QueryRow(ctx context.Context, sql string, args ...any) pgx.Row
	Query(ctx context.Context, sql string, args ...any) (pgx.Rows, error)
	Exec(ctx context.Context, sql string, args ...any) (pgconn.CommandTag, error)
}

// ----- DTOs ------------------------------------------------------------------

// resourceShareDTO is the JSON shape returned by list/create endpoints.
// Either UserID or GroupID is set; the other is empty.
type resourceShareDTO struct {
	ID          string    `json:"id"`
	ResourceID  string    `json:"resourceId"`
	UserID      string    `json:"userId,omitempty"`
	UserEmail   string    `json:"userEmail,omitempty"`
	GroupID     string    `json:"groupId,omitempty"`
	GroupName   string    `json:"groupName,omitempty"`
	Role        string    `json:"role"`
	CreatedAt   time.Time `json:"createdAt"`
}

type grantReq struct {
	UserID  string `json:"userId,omitempty"`  // pick one of userId / groupId
	GroupID string `json:"groupId,omitempty"`
	Role    string `json:"role,omitempty"`    // "viewer" (default) | "editor"
}

// ----- Grant / Revoke / List per resource -----------------------------------

// GrantFile: POST /v1/files/:id/access — owner grants access to a user/group.
func (h *Handler) GrantFile(w http.ResponseWriter, r *http.Request) {
	h.grantOn(w, r, "file", chi.URLParam(r, "id"))
}

// GrantFolder: POST /v1/folders/:id/access.
func (h *Handler) GrantFolder(w http.ResponseWriter, r *http.Request) {
	h.grantOn(w, r, "folder", chi.URLParam(r, "id"))
}

func (h *Handler) grantOn(w http.ResponseWriter, r *http.Request, resType, resID string) {
	c := r.Context().Value(auth.UserCtxKey).(*auth.Claims)
	var req grantReq
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeErr(w, 400, "invalid_body", err.Error())
		return
	}
	if (req.UserID == "") == (req.GroupID == "") {
		writeErr(w, 400, "invalid_principal",
			"provide exactly one of userId or groupId")
		return
	}
	role := strings.ToLower(strings.TrimSpace(req.Role))
	if role == "" {
		role = "viewer"
	}
	if role != "viewer" && role != "editor" {
		writeErr(w, 400, "invalid_role", "role must be viewer or editor")
		return
	}

	// Only the owner (or an admin) can grant.
	if !c.IsAdmin() {
		owns, err := h.ownsResource(r.Context(), resType, resID, c.UserID, c.OrgID)
		if err != nil {
			writeErr(w, 500, "db_error", err.Error())
			return
		}
		if !owns {
			writeErr(w, 403, "forbidden", "only the owner can share this resource")
			return
		}
	}

	// Validate the principal exists and is in the same org.
	if req.UserID != "" {
		var ok bool
		if err := h.DB.QueryRow(r.Context(),
			`SELECT EXISTS(SELECT 1 FROM users WHERE id=$1 AND org_id=$2)`,
			req.UserID, c.OrgID).Scan(&ok); err != nil {
			writeErr(w, 500, "db_error", err.Error())
			return
		}
		if !ok {
			writeErr(w, 404, "user_not_found", "user not in this org")
			return
		}
	} else {
		var ok bool
		if err := h.DB.QueryRow(r.Context(),
			`SELECT EXISTS(SELECT 1 FROM groups WHERE id=$1 AND org_id=$2)`,
			req.GroupID, c.OrgID).Scan(&ok); err != nil {
			writeErr(w, 500, "db_error", err.Error())
			return
		}
		if !ok {
			writeErr(w, 404, "group_not_found", "group not in this org")
			return
		}
	}

	// Upsert — if a row exists for (resource, principal) update the role,
	// else insert. The two partial unique indexes guarantee at most one
	// row per principal so ON CONFLICT picks the right target.
	var id string
	if req.UserID != "" {
		err := h.DB.QueryRow(r.Context(),
			`INSERT INTO resource_shares
				(org_id, resource_type, resource_id, user_id, role, created_by)
			 VALUES ($1, $2, $3, $4, $5, $6)
			 ON CONFLICT (resource_type, resource_id, user_id) WHERE user_id IS NOT NULL
			 DO UPDATE SET role = EXCLUDED.role
			 RETURNING id`,
			c.OrgID, resType, resID, req.UserID, role, c.UserID,
		).Scan(&id)
		if err != nil {
			writeErr(w, 500, "db_error", err.Error())
			return
		}
	} else {
		err := h.DB.QueryRow(r.Context(),
			`INSERT INTO resource_shares
				(org_id, resource_type, resource_id, group_id, role, created_by)
			 VALUES ($1, $2, $3, $4, $5, $6)
			 ON CONFLICT (resource_type, resource_id, group_id) WHERE group_id IS NOT NULL
			 DO UPDATE SET role = EXCLUDED.role
			 RETURNING id`,
			c.OrgID, resType, resID, req.GroupID, role, c.UserID,
		).Scan(&id)
		if err != nil {
			writeErr(w, 500, "db_error", err.Error())
			return
		}
	}
	writeJSON(w, 200, map[string]any{"id": id, "role": role})
}

// RevokeFile: DELETE /v1/files/:id/access/:shareId.
func (h *Handler) RevokeFile(w http.ResponseWriter, r *http.Request) {
	h.revokeOn(w, r, "file", chi.URLParam(r, "id"), chi.URLParam(r, "shareId"))
}

// RevokeFolder: DELETE /v1/folders/:id/access/:shareId.
func (h *Handler) RevokeFolder(w http.ResponseWriter, r *http.Request) {
	h.revokeOn(w, r, "folder", chi.URLParam(r, "id"), chi.URLParam(r, "shareId"))
}

func (h *Handler) revokeOn(w http.ResponseWriter, r *http.Request, resType, resID, shareID string) {
	c := r.Context().Value(auth.UserCtxKey).(*auth.Claims)
	if !c.IsAdmin() {
		owns, err := h.ownsResource(r.Context(), resType, resID, c.UserID, c.OrgID)
		if err != nil {
			writeErr(w, 500, "db_error", err.Error())
			return
		}
		if !owns {
			writeErr(w, 403, "forbidden", "only the owner can revoke shares on this resource")
			return
		}
	}
	tag, err := h.DB.Exec(r.Context(),
		`DELETE FROM resource_shares
		 WHERE id=$1 AND org_id=$2 AND resource_type=$3 AND resource_id=$4`,
		shareID, c.OrgID, resType, resID)
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

// ListFileShares: GET /v1/files/:id/access.
func (h *Handler) ListFileShares(w http.ResponseWriter, r *http.Request) {
	h.listShares(w, r, "file", chi.URLParam(r, "id"))
}

// ListFolderShares: GET /v1/folders/:id/access.
func (h *Handler) ListFolderShares(w http.ResponseWriter, r *http.Request) {
	h.listShares(w, r, "folder", chi.URLParam(r, "id"))
}

func (h *Handler) listShares(w http.ResponseWriter, r *http.Request, resType, resID string) {
	c := r.Context().Value(auth.UserCtxKey).(*auth.Claims)
	// Anyone who can see the resource can see who it's shared with.
	var allowed bool
	var err error
	if resType == "file" {
		allowed, err = CanAccessFile(r.Context(), h.DB, c, resID)
	} else {
		allowed, err = CanAccessFolder(r.Context(), h.DB, c, resID)
	}
	if err != nil {
		writeErr(w, 500, "db_error", err.Error())
		return
	}
	if !allowed {
		writeErr(w, 404, "not_found", "resource not found")
		return
	}
	rows, err := h.DB.Query(r.Context(),
		`SELECT rs.id, rs.resource_id, rs.user_id, rs.group_id, rs.role, rs.created_at,
		        u.email, g.name
		   FROM resource_shares rs
		   LEFT JOIN users  u ON u.id  = rs.user_id
		   LEFT JOIN groups g ON g.id  = rs.group_id
		  WHERE rs.org_id=$1 AND rs.resource_type=$2 AND rs.resource_id=$3
		  ORDER BY rs.created_at DESC`,
		c.OrgID, resType, resID)
	if err != nil {
		writeErr(w, 500, "db_error", err.Error())
		return
	}
	defer rows.Close()
	out := []resourceShareDTO{}
	for rows.Next() {
		var d resourceShareDTO
		var uid, gid, email, gname *string
		if err := rows.Scan(&d.ID, &d.ResourceID, &uid, &gid, &d.Role, &d.CreatedAt, &email, &gname); err != nil {
			writeErr(w, 500, "db_error", err.Error())
			return
		}
		if uid != nil {
			d.UserID = *uid
		}
		if gid != nil {
			d.GroupID = *gid
		}
		if email != nil {
			d.UserEmail = *email
		}
		if gname != nil {
			d.GroupName = *gname
		}
		out = append(out, d)
	}
	writeJSON(w, 200, map[string]any{"shares": out})
}

// ----- Shared-with-me listing -----------------------------------------------

type sharedFileDTO struct {
	ID         string    `json:"id"`
	Name       string    `json:"name"`
	Mime       string    `json:"mime"`
	Size       int64     `json:"size"`
	Status     string    `json:"status"`
	TemplateID *string   `json:"templateId,omitempty"`
	FolderID   *string   `json:"folderId,omitempty"`
	OwnerEmail string    `json:"ownerEmail,omitempty"`
	Role       string    `json:"role"`          // viewer | editor
	SharedVia  string    `json:"sharedVia"`     // "user" | "group" | "folder"
	CreatedAt  time.Time `json:"createdAt"`
}

// SharedWithMe: GET /v1/shared-with-me — returns every file visible to me
// *that I don't own*. Useful as a distinct sidebar section in Drive.
func (h *Handler) SharedWithMe(w http.ResponseWriter, r *http.Request) {
	c := r.Context().Value(auth.UserCtxKey).(*auth.Claims)
	// We pick the "best" provenance per file in a single query: a direct
	// user share wins over a group share, which wins over a folder share.
	// This is cosmetic — all three result in access, we just label the
	// row for the UI.
	q := `
		WITH my_groups AS (
			SELECT group_id FROM group_members WHERE user_id = $1
		),
		shared_folders AS (
			WITH RECURSIVE t AS (
				SELECT rs.resource_id AS id FROM resource_shares rs
				WHERE rs.resource_type='folder'
				  AND (rs.user_id=$1 OR rs.group_id IN (SELECT group_id FROM my_groups))
				UNION
				SELECT f.id FROM folders f JOIN t ON f.parent_id = t.id
			)
			SELECT id FROM t
		)
		SELECT f.id, f.name, f.mime, f.size, f.status, f.template_id, f.folder_id,
		       u.email, f.created_at,
		       COALESCE(
		         (SELECT role FROM resource_shares WHERE resource_type='file' AND resource_id=f.id AND user_id=$1 LIMIT 1),
		         (SELECT role FROM resource_shares WHERE resource_type='file' AND resource_id=f.id AND group_id IN (SELECT group_id FROM my_groups) LIMIT 1),
		         'viewer'
		       ) AS role,
		       CASE
		         WHEN EXISTS(SELECT 1 FROM resource_shares WHERE resource_type='file' AND resource_id=f.id AND user_id=$1) THEN 'user'
		         WHEN EXISTS(SELECT 1 FROM resource_shares WHERE resource_type='file' AND resource_id=f.id AND group_id IN (SELECT group_id FROM my_groups)) THEN 'group'
		         ELSE 'folder'
		       END AS shared_via
		  FROM files f
		  LEFT JOIN users u ON u.id = f.owner_id
		 WHERE f.org_id=$2 AND f.trashed_at IS NULL AND f.owner_id <> $1
		   AND (
		     f.id IN (
		       SELECT resource_id FROM resource_shares
		        WHERE resource_type='file'
		          AND (user_id=$1 OR group_id IN (SELECT group_id FROM my_groups))
		     )
		     OR f.folder_id IN (SELECT id FROM shared_folders)
		   )
		 ORDER BY f.created_at DESC
		 LIMIT 500`
	rows, err := h.DB.Query(r.Context(), q, c.UserID, c.OrgID)
	if err != nil {
		writeErr(w, 500, "db_error", err.Error())
		return
	}
	defer rows.Close()
	out := []sharedFileDTO{}
	for rows.Next() {
		var d sharedFileDTO
		var email *string
		if err := rows.Scan(&d.ID, &d.Name, &d.Mime, &d.Size, &d.Status,
			&d.TemplateID, &d.FolderID, &email, &d.CreatedAt, &d.Role, &d.SharedVia); err != nil {
			writeErr(w, 500, "db_error", err.Error())
			return
		}
		if email != nil {
			d.OwnerEmail = *email
		}
		out = append(out, d)
	}
	writeJSON(w, 200, map[string]any{"files": out})
}

// ----- helpers --------------------------------------------------------------

// ownsResource returns true when the user owns the given file or folder
// (by id, scoped to their org). Used to gate the grant/revoke endpoints.
func (h *Handler) ownsResource(ctx context.Context, resType, resID, userID, orgID string) (bool, error) {
	var table string
	switch resType {
	case "file":
		table = "files"
	case "folder":
		table = "folders"
	default:
		return false, errors.New("invalid resource type")
	}
	var ok bool
	err := h.DB.QueryRow(ctx,
		"SELECT EXISTS(SELECT 1 FROM "+table+" WHERE id=$1 AND org_id=$2 AND owner_id=$3)",
		resID, orgID, userID).Scan(&ok)
	return ok, err
}
