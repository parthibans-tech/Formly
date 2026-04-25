// Package platformorgs implements super-admin organization management
// (Phase 3): list/search every workspace, view a detail panel, freeze
// or soft-delete misbehaving tenants, and adjust per-org quotas.
//
// Authorization: every route is mounted behind the requireSuperAdmin
// middleware in cmd/api/main.go. Handlers don't re-check; instead each
// state-changing call writes an "super_admin.org_*" audit row so the
// trail is unfalsifiable.
package platformorgs

import (
	"encoding/json"
	"errors"
	"net/http"
	"strings"
	"time"

	"github.com/docforge/api/internal/audit"
	"github.com/docforge/api/internal/auth"
	"github.com/go-chi/chi/v5"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

type Handler struct {
	DB *pgxpool.Pool
}

func New(db *pgxpool.Pool) *Handler { return &Handler{DB: db} }

// -- list / search -------------------------------------------------------

type orgRow struct {
	ID              string  `json:"id"`
	Name            string  `json:"name"`
	Plan            string  `json:"plan"`
	UserCount       int64   `json:"userCount"`
	StorageBytes    int64   `json:"storageBytes"`
	MaxUsers        *int    `json:"maxUsers,omitempty"`
	MaxStorageBytes *int64  `json:"maxStorageBytes,omitempty"`
	FrozenAt        *string `json:"frozenAt,omitempty"`
	FrozenReason    *string `json:"frozenReason,omitempty"`
	DeletedAt       *string `json:"deletedAt,omitempty"`
	CreatedAt       string  `json:"createdAt"`
}

// List returns up to `limit` orgs filtered by:
//
//	q       — case-insensitive substring of name
//	status  — "active" | "frozen" | "deleted"
//	plan    — exact plan label (free / pro / enterprise / ...)
func (h *Handler) List(w http.ResponseWriter, r *http.Request) {
	q := strings.TrimSpace(r.URL.Query().Get("q"))
	status := strings.TrimSpace(r.URL.Query().Get("status"))
	plan := strings.TrimSpace(r.URL.Query().Get("plan"))
	limit := 100
	if v := r.URL.Query().Get("limit"); v != "" {
		var n int
		if _, err := atoi(v, &n); err == nil && n > 0 && n <= 500 {
			limit = n
		}
	}

	var (
		conds []string
		args  []any
	)
	if q != "" {
		args = append(args, "%"+q+"%")
		conds = append(conds, "o.name ILIKE $"+itoa(len(args)))
	}
	if plan != "" {
		args = append(args, plan)
		conds = append(conds, `EXISTS (
			SELECT 1 FROM subscriptions s
			 JOIN plans p ON p.id = s.plan_id
			 WHERE s.org_id = o.id
			   AND s.status IN ('trialing','active','past_due','paused')
			   AND p.tier = $`+itoa(len(args))+`)`)
	}
	switch status {
	case "active":
		conds = append(conds, "o.deleted_at IS NULL AND o.frozen_at IS NULL")
	case "frozen":
		conds = append(conds, "o.frozen_at IS NOT NULL AND o.deleted_at IS NULL")
	case "deleted":
		conds = append(conds, "o.deleted_at IS NOT NULL")
	default:
		// Default view hides deleted orgs — operators have to opt in.
		conds = append(conds, "o.deleted_at IS NULL")
	}
	if len(conds) == 0 {
		conds = []string{"true"}
	}
	args = append(args, limit)
	limitPlaceholder := "$" + itoa(len(args))

	sql := `
		SELECT o.id, o.name,
		       COALESCE((
		         SELECT p.tier FROM subscriptions s
		           JOIN plans p ON p.id = s.plan_id
		          WHERE s.org_id = o.id
		            AND s.status IN ('trialing','active','past_due','paused')
		          ORDER BY s.created_at DESC LIMIT 1
		       ), 'free') AS plan_tier,
		       (SELECT count(*) FROM users u WHERE u.org_id=o.id) AS user_count,
		       COALESCE((SELECT sum(size) FROM files f
		                  WHERE f.org_id=o.id AND f.trashed_at IS NULL), 0) AS storage_bytes,
		       o.max_users, o.max_storage_bytes,
		       o.frozen_at, o.frozen_reason, o.deleted_at,
		       o.created_at
		  FROM organizations o
		 WHERE ` + strings.Join(conds, " AND ") + `
		 ORDER BY o.created_at DESC
		 LIMIT ` + limitPlaceholder

	rows, err := h.DB.Query(r.Context(), sql, args...)
	if err != nil {
		writeErr(w, 500, "db_error", err.Error())
		return
	}
	defer rows.Close()

	out := []orgRow{}
	for rows.Next() {
		var (
			o                              orgRow
			frozenAt, deletedAt            *time.Time
			createdAt                      time.Time
		)
		if err := rows.Scan(&o.ID, &o.Name, &o.Plan,
			&o.UserCount, &o.StorageBytes,
			&o.MaxUsers, &o.MaxStorageBytes,
			&frozenAt, &o.FrozenReason, &deletedAt,
			&createdAt); err != nil {
			continue
		}
		o.CreatedAt = createdAt.Format(time.RFC3339)
		if frozenAt != nil {
			s := frozenAt.Format(time.RFC3339)
			o.FrozenAt = &s
		}
		if deletedAt != nil {
			s := deletedAt.Format(time.RFC3339)
			o.DeletedAt = &s
		}
		out = append(out, o)
	}
	writeJSON(w, 200, map[string]any{"orgs": out})
}

// -- detail --------------------------------------------------------------

type orgDetail struct {
	orgRow
	Members     []memberRow  `json:"members"`
	RecentAudit []auditEntry `json:"recentAudit"`
}

type memberRow struct {
	ID    string `json:"id"`
	Email string `json:"email"`
	Name  string `json:"name"`
	Role  string `json:"role"`
}

type auditEntry struct {
	At     string         `json:"at"`
	Action string         `json:"action"`
	Actor  string         `json:"actor"`
	IP     string         `json:"ip"`
	Meta   map[string]any `json:"meta,omitempty"`
}

func (h *Handler) Detail(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "id")
	var (
		o                   orgRow
		frozenAt, deletedAt *time.Time
		createdAt           time.Time
	)
	err := h.DB.QueryRow(r.Context(), `
		SELECT o.id, o.name,
		       COALESCE((
		         SELECT p.tier FROM subscriptions s
		           JOIN plans p ON p.id = s.plan_id
		          WHERE s.org_id = o.id
		            AND s.status IN ('trialing','active','past_due','paused')
		          ORDER BY s.created_at DESC LIMIT 1
		       ), 'free'),
		       (SELECT count(*) FROM users u WHERE u.org_id=o.id),
		       COALESCE((SELECT sum(size) FROM files f
		                  WHERE f.org_id=o.id AND f.trashed_at IS NULL), 0),
		       o.max_users, o.max_storage_bytes,
		       o.frozen_at, o.frozen_reason, o.deleted_at,
		       o.created_at
		  FROM organizations o
		 WHERE o.id=$1`, id,
	).Scan(&o.ID, &o.Name, &o.Plan,
		&o.UserCount, &o.StorageBytes,
		&o.MaxUsers, &o.MaxStorageBytes,
		&frozenAt, &o.FrozenReason, &deletedAt,
		&createdAt)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			writeErr(w, 404, "not_found", "org not found")
			return
		}
		writeErr(w, 500, "db_error", err.Error())
		return
	}
	o.CreatedAt = createdAt.Format(time.RFC3339)
	if frozenAt != nil {
		s := frozenAt.Format(time.RFC3339)
		o.FrozenAt = &s
	}
	if deletedAt != nil {
		s := deletedAt.Format(time.RFC3339)
		o.DeletedAt = &s
	}

	members := []memberRow{}
	mrows, err := h.DB.Query(r.Context(), `
		SELECT id, email, COALESCE(name,''), COALESCE(role,'editor')
		  FROM users WHERE org_id=$1 ORDER BY created_at DESC LIMIT 100`, id)
	if err == nil {
		defer mrows.Close()
		for mrows.Next() {
			var m memberRow
			if err := mrows.Scan(&m.ID, &m.Email, &m.Name, &m.Role); err == nil {
				members = append(members, m)
			}
		}
	}

	recent := []auditEntry{}
	arows, err := h.DB.Query(r.Context(), `
		SELECT created_at, action, COALESCE(actor_email,''),
		       COALESCE(ip_addr::text,''), meta
		  FROM audit_log
		 WHERE org_id=$1
		 ORDER BY created_at DESC LIMIT 50`, id)
	if err == nil {
		defer arows.Close()
		for arows.Next() {
			var e auditEntry
			var at time.Time
			var metaJSON []byte
			if err := arows.Scan(&at, &e.Action, &e.Actor, &e.IP, &metaJSON); err == nil {
				e.At = at.Format(time.RFC3339)
				if len(metaJSON) > 0 {
					_ = json.Unmarshal(metaJSON, &e.Meta)
				}
				recent = append(recent, e)
			}
		}
	}

	writeJSON(w, 200, orgDetail{orgRow: o, Members: members, RecentAudit: recent})
}

// -- freeze / unfreeze ---------------------------------------------------

type freezeReq struct {
	Reason string `json:"reason"`
}

func (h *Handler) Freeze(w http.ResponseWriter, r *http.Request) {
	c, _ := r.Context().Value(auth.UserCtxKey).(*auth.Claims)
	id := chi.URLParam(r, "id")
	if c != nil && c.OrgID == id {
		writeErr(w, 400, "cannot_freeze_self_org",
			"you can't freeze the org you're signed into — switch first")
		return
	}
	var req freezeReq
	_ = json.NewDecoder(r.Body).Decode(&req)
	reason := strings.TrimSpace(req.Reason)
	if reason == "" {
		writeErr(w, 400, "missing_reason",
			"a reason is required for the audit trail")
		return
	}
	tag, err := h.DB.Exec(r.Context(), `
		UPDATE organizations
		   SET frozen_at=now(), frozen_by=$2::uuid, frozen_reason=$3
		 WHERE id=$1 AND frozen_at IS NULL AND deleted_at IS NULL`,
		id, c.UserID, reason)
	if err != nil {
		writeErr(w, 500, "db_error", err.Error())
		return
	}
	if tag.RowsAffected() == 0 {
		writeErr(w, 409, "already_frozen_or_deleted",
			"org is already frozen or has been deleted")
		return
	}
	audit.LogHTTP(r, h.DB, "super_admin.org_frozen", "org", id,
		map[string]any{"reason": reason})
	writeJSON(w, 200, map[string]any{"ok": true})
}

func (h *Handler) Unfreeze(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "id")
	tag, err := h.DB.Exec(r.Context(), `
		UPDATE organizations
		   SET frozen_at=NULL, frozen_by=NULL, frozen_reason=NULL
		 WHERE id=$1 AND frozen_at IS NOT NULL`, id)
	if err != nil {
		writeErr(w, 500, "db_error", err.Error())
		return
	}
	if tag.RowsAffected() == 0 {
		writeErr(w, 404, "not_frozen", "org is not currently frozen")
		return
	}
	audit.LogHTTP(r, h.DB, "super_admin.org_unfrozen", "org", id, nil)
	writeJSON(w, 200, map[string]any{"ok": true})
}

// -- soft delete / restore ----------------------------------------------

func (h *Handler) SoftDelete(w http.ResponseWriter, r *http.Request) {
	c, _ := r.Context().Value(auth.UserCtxKey).(*auth.Claims)
	id := chi.URLParam(r, "id")
	if c != nil && c.OrgID == id {
		writeErr(w, 400, "cannot_delete_self_org",
			"you can't delete the org you're signed into")
		return
	}
	tag, err := h.DB.Exec(r.Context(),
		`UPDATE organizations SET deleted_at=now()
		  WHERE id=$1 AND deleted_at IS NULL`, id)
	if err != nil {
		writeErr(w, 500, "db_error", err.Error())
		return
	}
	if tag.RowsAffected() == 0 {
		writeErr(w, 409, "already_deleted", "org is already deleted")
		return
	}
	// Kill every active session for users in this org so they're booted
	// to the login screen on next request — where the deleted-org check
	// in /v1/auth/login will refuse to issue a fresh JWT.
	_, _ = h.DB.Exec(r.Context(), `
		UPDATE user_sessions SET revoked_at=now()
		 WHERE user_id IN (SELECT id FROM users WHERE org_id=$1)
		   AND revoked_at IS NULL`, id)

	audit.LogHTTP(r, h.DB, "super_admin.org_deleted", "org", id, nil)
	writeJSON(w, 200, map[string]any{"ok": true})
}

func (h *Handler) Restore(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "id")
	tag, err := h.DB.Exec(r.Context(),
		`UPDATE organizations SET deleted_at=NULL
		  WHERE id=$1 AND deleted_at IS NOT NULL`, id)
	if err != nil {
		writeErr(w, 500, "db_error", err.Error())
		return
	}
	if tag.RowsAffected() == 0 {
		writeErr(w, 404, "not_deleted", "org is not currently deleted")
		return
	}
	audit.LogHTTP(r, h.DB, "super_admin.org_restored", "org", id, nil)
	writeJSON(w, 200, map[string]any{"ok": true})
}

// -- quotas / plan -------------------------------------------------------

type quotasReq struct {
	MaxUsers        *int   `json:"maxUsers,omitempty"`
	MaxStorageBytes *int64 `json:"maxStorageBytes,omitempty"`
}

// SetQuotas updates per-org quota overrides. The active plan still
// supplies a default ceiling; values written here win against it (set
// to 0 to mean "unlimited" by passing null — the caller pattern is
// "omit the field" to leave it unchanged).
//
// Plan changes go through the subscription endpoints, not this one.
func (h *Handler) SetQuotas(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "id")
	var req quotasReq
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeErr(w, 400, "invalid_body", err.Error())
		return
	}
	sets := []string{}
	args := []any{}
	if req.MaxUsers != nil {
		args = append(args, *req.MaxUsers)
		sets = append(sets, "max_users=$"+itoa(len(args)))
	}
	if req.MaxStorageBytes != nil {
		args = append(args, *req.MaxStorageBytes)
		sets = append(sets, "max_storage_bytes=$"+itoa(len(args)))
	}
	if len(sets) == 0 {
		writeErr(w, 400, "no_changes", "supply at least one of maxUsers, maxStorageBytes")
		return
	}
	args = append(args, id)
	sql := "UPDATE organizations SET " + strings.Join(sets, ", ") +
		" WHERE id=$" + itoa(len(args))
	tag, err := h.DB.Exec(r.Context(), sql, args...)
	if err != nil {
		writeErr(w, 500, "db_error", err.Error())
		return
	}
	if tag.RowsAffected() == 0 {
		writeErr(w, 404, "not_found", "org not found")
		return
	}
	audit.LogHTTP(r, h.DB, "super_admin.org_quotas_changed", "org", id,
		map[string]any{
			"maxUsers":        req.MaxUsers,
			"maxStorageBytes": req.MaxStorageBytes,
		})
	writeJSON(w, 200, map[string]any{"ok": true})
}

// -- helpers -------------------------------------------------------------

func writeJSON(w http.ResponseWriter, code int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(code)
	_ = json.NewEncoder(w).Encode(v)
}

func writeErr(w http.ResponseWriter, code int, slug, msg string) {
	writeJSON(w, code, map[string]any{
		"error": map[string]string{"code": slug, "message": msg},
	})
}

func itoa(n int) string {
	if n == 0 {
		return "0"
	}
	var b [20]byte
	i := len(b)
	for n > 0 {
		i--
		b[i] = byte('0' + n%10)
		n /= 10
	}
	return string(b[i:])
}

func atoi(s string, out *int) (int, error) {
	n := 0
	for _, c := range s {
		if c < '0' || c > '9' {
			return 0, errors.New("not a number")
		}
		n = n*10 + int(c-'0')
	}
	*out = n
	return n, nil
}
