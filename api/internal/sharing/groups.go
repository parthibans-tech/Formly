package sharing

// Groups: named collections of users within an org, used as share
// principals in resource_shares. An admin or any org member can create
// groups; members are free-form (no role distinction — "group member"
// is just a bag that buys you access to every resource shared to the
// group).
//
// Endpoints (registered in cmd/api/main.go):
//   GET    /v1/groups                       — list all groups in org
//   POST   /v1/groups                       — create a group
//   GET    /v1/groups/:id                   — get a group + its members
//   PATCH  /v1/groups/:id                   — rename a group
//   DELETE /v1/groups/:id                   — delete a group (cascades to group_members + resource_shares)
//   GET    /v1/groups/:id/members           — list members
//   POST   /v1/groups/:id/members           — add a member (body: { userId })
//   DELETE /v1/groups/:id/members/:userId   — remove a member
//
// Permissions:
//   - Any authenticated org member can list and create groups.
//   - Only the `created_by` user or an admin can rename / delete or
//     add / remove members. That's a deliberately conservative default
//     — teams that want shared ownership of groups can later add a
//     group_owners table; for now the creator is the steward.

import (
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/docforge/api/internal/auth"
	"github.com/go-chi/chi/v5"
	"github.com/jackc/pgx/v5"
)

type groupDTO struct {
	ID          string    `json:"id"`
	Name        string    `json:"name"`
	CreatedBy   string    `json:"createdBy"`
	CreatorName string    `json:"creatorName,omitempty"`
	MemberCount int       `json:"memberCount"`
	CreatedAt   time.Time `json:"createdAt"`
	UpdatedAt   time.Time `json:"updatedAt"`
}

type groupMemberDTO struct {
	UserID    string    `json:"userId"`
	Email     string    `json:"email"`
	Name      string    `json:"name,omitempty"`
	AddedBy   string    `json:"addedBy,omitempty"`
	AddedAt   time.Time `json:"addedAt"`
}

// ----- Groups CRUD ----------------------------------------------------------

// GroupsList: GET /v1/groups. Returns every group in the caller's org
// with a member count so the UI can render them in a picker without a
// second roundtrip.
//
// Optional ?q= filters by group name (case-insensitive substring) and
// optional ?limit= caps the row count. Both default to "no filter" so
// existing callers (settings page, etc.) keep working unchanged. Limit
// is clamped to [1,200]; 0 means "no limit". Used by the share-people
// modal so a workspace with hundreds of groups doesn't dump them all
// into a picker.
func (h *Handler) GroupsList(w http.ResponseWriter, r *http.Request) {
	c := r.Context().Value(auth.UserCtxKey).(*auth.Claims)
	q := strings.TrimSpace(r.URL.Query().Get("q"))
	limit := 0
	if v := strings.TrimSpace(r.URL.Query().Get("limit")); v != "" {
		if n, err := strconv.Atoi(v); err == nil {
			limit = n
		}
	}
	if limit > 200 {
		limit = 200
	}

	args := []any{c.OrgID}
	sql := `
		SELECT g.id, g.name, g.created_by, u.email,
		       (SELECT COUNT(*) FROM group_members gm WHERE gm.group_id = g.id),
		       g.created_at, g.updated_at
		  FROM groups g
		  LEFT JOIN users u ON u.id = g.created_by
		 WHERE g.org_id = $1`
	if q != "" {
		args = append(args, "%"+q+"%")
		sql += fmt.Sprintf(" AND g.name ILIKE $%d", len(args))
	}
	sql += ` ORDER BY lower(g.name) ASC`
	if limit > 0 {
		args = append(args, limit)
		sql += fmt.Sprintf(" LIMIT $%d", len(args))
	}

	rows, err := h.DB.Query(r.Context(), sql, args...)
	if err != nil {
		writeErr(w, 500, "db_error", err.Error())
		return
	}
	defer rows.Close()
	out := []groupDTO{}
	for rows.Next() {
		var d groupDTO
		var creatorEmail *string
		if err := rows.Scan(&d.ID, &d.Name, &d.CreatedBy, &creatorEmail,
			&d.MemberCount, &d.CreatedAt, &d.UpdatedAt); err != nil {
			writeErr(w, 500, "db_error", err.Error())
			return
		}
		if creatorEmail != nil {
			d.CreatorName = *creatorEmail
		}
		out = append(out, d)
	}
	writeJSON(w, 200, map[string]any{"groups": out})
}

type groupCreateReq struct {
	Name string `json:"name"`
}

// GroupsCreate: POST /v1/groups. `name` is trimmed; empty names rejected.
// Collisions with an existing case-insensitive name surface as a 409.
func (h *Handler) GroupsCreate(w http.ResponseWriter, r *http.Request) {
	c := r.Context().Value(auth.UserCtxKey).(*auth.Claims)
	var req groupCreateReq
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeErr(w, 400, "invalid_body", err.Error())
		return
	}
	name := strings.TrimSpace(req.Name)
	if name == "" {
		writeErr(w, 400, "invalid_name", "name is required")
		return
	}
	if len(name) > 120 {
		writeErr(w, 400, "invalid_name", "name too long")
		return
	}
	var id string
	err := h.DB.QueryRow(r.Context(),
		`INSERT INTO groups (org_id, name, created_by)
		 VALUES ($1, $2, $3)
		 RETURNING id`,
		c.OrgID, name, c.UserID,
	).Scan(&id)
	if err != nil {
		// Uniqueness violation → 409 (uq_groups_org_name).
		if strings.Contains(err.Error(), "uq_groups_org_name") {
			writeErr(w, 409, "name_conflict", "a group with that name already exists")
			return
		}
		writeErr(w, 500, "db_error", err.Error())
		return
	}
	writeJSON(w, 200, map[string]any{"id": id, "name": name})
}

// GroupsGet: GET /v1/groups/:id. Returns the group with its members
// inlined — saves the UI a roundtrip when opening a group detail view.
func (h *Handler) GroupsGet(w http.ResponseWriter, r *http.Request) {
	c := r.Context().Value(auth.UserCtxKey).(*auth.Claims)
	id := chi.URLParam(r, "id")
	var d groupDTO
	var creatorEmail *string
	err := h.DB.QueryRow(r.Context(), `
		SELECT g.id, g.name, g.created_by, u.email,
		       (SELECT COUNT(*) FROM group_members gm WHERE gm.group_id = g.id),
		       g.created_at, g.updated_at
		  FROM groups g
		  LEFT JOIN users u ON u.id = g.created_by
		 WHERE g.id = $1 AND g.org_id = $2`,
		id, c.OrgID,
	).Scan(&d.ID, &d.Name, &d.CreatedBy, &creatorEmail, &d.MemberCount, &d.CreatedAt, &d.UpdatedAt)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			writeErr(w, 404, "not_found", "group not found")
			return
		}
		writeErr(w, 500, "db_error", err.Error())
		return
	}
	if creatorEmail != nil {
		d.CreatorName = *creatorEmail
	}
	members, err := h.fetchMembers(r, id)
	if err != nil {
		writeErr(w, 500, "db_error", err.Error())
		return
	}
	writeJSON(w, 200, map[string]any{"group": d, "members": members})
}

type groupUpdateReq struct {
	Name string `json:"name"`
}

// GroupsUpdate: PATCH /v1/groups/:id. Only the creator / admin can rename.
func (h *Handler) GroupsUpdate(w http.ResponseWriter, r *http.Request) {
	c := r.Context().Value(auth.UserCtxKey).(*auth.Claims)
	id := chi.URLParam(r, "id")
	if ok, err := h.canManageGroup(r, id); err != nil {
		writeErr(w, 500, "db_error", err.Error())
		return
	} else if !ok {
		writeErr(w, 403, "forbidden", "only the creator can rename this group")
		return
	}
	var req groupUpdateReq
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeErr(w, 400, "invalid_body", err.Error())
		return
	}
	name := strings.TrimSpace(req.Name)
	if name == "" {
		writeErr(w, 400, "invalid_name", "name is required")
		return
	}
	tag, err := h.DB.Exec(r.Context(),
		`UPDATE groups SET name=$1, updated_at=now() WHERE id=$2 AND org_id=$3`,
		name, id, c.OrgID)
	if err != nil {
		if strings.Contains(err.Error(), "uq_groups_org_name") {
			writeErr(w, 409, "name_conflict", "a group with that name already exists")
			return
		}
		writeErr(w, 500, "db_error", err.Error())
		return
	}
	if tag.RowsAffected() == 0 {
		writeErr(w, 404, "not_found", "group not found")
		return
	}
	writeJSON(w, 200, map[string]any{"ok": true, "name": name})
}

// GroupsDelete: DELETE /v1/groups/:id. Cascades to group_members and
// to any resource_shares rows that referenced this group (via ON
// DELETE CASCADE in migration 022). That means access is revoked
// globally — warn users in the UI before calling this.
func (h *Handler) GroupsDelete(w http.ResponseWriter, r *http.Request) {
	c := r.Context().Value(auth.UserCtxKey).(*auth.Claims)
	id := chi.URLParam(r, "id")
	if ok, err := h.canManageGroup(r, id); err != nil {
		writeErr(w, 500, "db_error", err.Error())
		return
	} else if !ok {
		writeErr(w, 403, "forbidden", "only the creator can delete this group")
		return
	}
	tag, err := h.DB.Exec(r.Context(),
		`DELETE FROM groups WHERE id=$1 AND org_id=$2`, id, c.OrgID)
	if err != nil {
		writeErr(w, 500, "db_error", err.Error())
		return
	}
	if tag.RowsAffected() == 0 {
		writeErr(w, 404, "not_found", "group not found")
		return
	}
	writeJSON(w, 200, map[string]any{"ok": true})
}

// ----- Group members --------------------------------------------------------

// GroupMembersList: GET /v1/groups/:id/members.
func (h *Handler) GroupMembersList(w http.ResponseWriter, r *http.Request) {
	c := r.Context().Value(auth.UserCtxKey).(*auth.Claims)
	id := chi.URLParam(r, "id")
	// Scope check: group must belong to caller's org.
	var ok bool
	if err := h.DB.QueryRow(r.Context(),
		`SELECT EXISTS(SELECT 1 FROM groups WHERE id=$1 AND org_id=$2)`,
		id, c.OrgID).Scan(&ok); err != nil {
		writeErr(w, 500, "db_error", err.Error())
		return
	}
	if !ok {
		writeErr(w, 404, "not_found", "group not found")
		return
	}
	members, err := h.fetchMembers(r, id)
	if err != nil {
		writeErr(w, 500, "db_error", err.Error())
		return
	}
	writeJSON(w, 200, map[string]any{"members": members})
}

type addMemberReq struct {
	UserID string `json:"userId"`
}

// GroupMembersAdd: POST /v1/groups/:id/members.
// Body: {"userId":"…"}. Idempotent — adding an existing member is a no-op.
func (h *Handler) GroupMembersAdd(w http.ResponseWriter, r *http.Request) {
	c := r.Context().Value(auth.UserCtxKey).(*auth.Claims)
	id := chi.URLParam(r, "id")
	if ok, err := h.canManageGroup(r, id); err != nil {
		writeErr(w, 500, "db_error", err.Error())
		return
	} else if !ok {
		writeErr(w, 403, "forbidden", "only the creator can add members")
		return
	}
	var req addMemberReq
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeErr(w, 400, "invalid_body", err.Error())
		return
	}
	if strings.TrimSpace(req.UserID) == "" {
		writeErr(w, 400, "invalid_user", "userId is required")
		return
	}
	// User must be in the same org.
	var exists bool
	if err := h.DB.QueryRow(r.Context(),
		`SELECT EXISTS(SELECT 1 FROM users WHERE id=$1 AND org_id=$2)`,
		req.UserID, c.OrgID).Scan(&exists); err != nil {
		writeErr(w, 500, "db_error", err.Error())
		return
	}
	if !exists {
		writeErr(w, 404, "user_not_found", "user not in this org")
		return
	}
	if _, err := h.DB.Exec(r.Context(),
		`INSERT INTO group_members (group_id, user_id, added_by)
		 VALUES ($1, $2, $3)
		 ON CONFLICT (group_id, user_id) DO NOTHING`,
		id, req.UserID, c.UserID); err != nil {
		writeErr(w, 500, "db_error", err.Error())
		return
	}
	writeJSON(w, 200, map[string]any{"ok": true})
}

// GroupMembersRemove: DELETE /v1/groups/:id/members/:userId.
// Allowed by the creator, or by the user removing themselves (self-leave).
func (h *Handler) GroupMembersRemove(w http.ResponseWriter, r *http.Request) {
	c := r.Context().Value(auth.UserCtxKey).(*auth.Claims)
	id := chi.URLParam(r, "id")
	userID := chi.URLParam(r, "userId")

	selfLeave := userID == c.UserID
	if !selfLeave {
		if ok, err := h.canManageGroup(r, id); err != nil {
			writeErr(w, 500, "db_error", err.Error())
			return
		} else if !ok {
			writeErr(w, 403, "forbidden", "only the creator can remove other members")
			return
		}
	}
	// Scope group to org.
	var ok bool
	if err := h.DB.QueryRow(r.Context(),
		`SELECT EXISTS(SELECT 1 FROM groups WHERE id=$1 AND org_id=$2)`,
		id, c.OrgID).Scan(&ok); err != nil {
		writeErr(w, 500, "db_error", err.Error())
		return
	}
	if !ok {
		writeErr(w, 404, "not_found", "group not found")
		return
	}
	if _, err := h.DB.Exec(r.Context(),
		`DELETE FROM group_members WHERE group_id=$1 AND user_id=$2`,
		id, userID); err != nil {
		writeErr(w, 500, "db_error", err.Error())
		return
	}
	writeJSON(w, 200, map[string]any{"ok": true})
}

// ----- helpers --------------------------------------------------------------

// canManageGroup returns true when the caller is the group's creator
// or an admin. Used to gate write endpoints.
func (h *Handler) canManageGroup(r *http.Request, groupID string) (bool, error) {
	c := r.Context().Value(auth.UserCtxKey).(*auth.Claims)
	if c.IsAdmin() {
		// Still scope to org.
		var exists bool
		err := h.DB.QueryRow(r.Context(),
			`SELECT EXISTS(SELECT 1 FROM groups WHERE id=$1 AND org_id=$2)`,
			groupID, c.OrgID).Scan(&exists)
		return exists, err
	}
	var creator string
	err := h.DB.QueryRow(r.Context(),
		`SELECT created_by FROM groups WHERE id=$1 AND org_id=$2`,
		groupID, c.OrgID).Scan(&creator)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return false, nil
		}
		return false, err
	}
	return creator == c.UserID, nil
}

func (h *Handler) fetchMembers(r *http.Request, groupID string) ([]groupMemberDTO, error) {
	rows, err := h.DB.Query(r.Context(), `
		SELECT gm.user_id, u.email, u.name, gm.added_by, gm.added_at
		  FROM group_members gm
		  JOIN users u ON u.id = gm.user_id
		 WHERE gm.group_id = $1
		 ORDER BY u.email ASC`, groupID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []groupMemberDTO{}
	for rows.Next() {
		var d groupMemberDTO
		var name *string
		var addedBy *string
		if err := rows.Scan(&d.UserID, &d.Email, &name, &addedBy, &d.AddedAt); err != nil {
			return nil, err
		}
		if name != nil {
			d.Name = *name
		}
		if addedBy != nil {
			d.AddedBy = *addedBy
		}
		out = append(out, d)
	}
	return out, nil
}
