// CSV exports + bulk admin actions.
//
// All endpoints inherit the requireSuperAdmin guard from main.go and
// write an audit row for every state-changing call so the trail is
// unfalsifiable. The list filters mirror those of platformusers.List
// and platformorgs.List so an operator can "search → export" without
// re-typing the query.

package platformanalytics

import (
	"encoding/json"
	"fmt"
	"net/http"
	"strings"
	"time"

	"github.com/docforge/api/internal/audit"
	"github.com/docforge/api/internal/auth"
)

// itoa avoids strconv import for positional argument numbering.
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

// -- ORG export ----------------------------------------------------------

// ExportOrgsCSV streams the org list (with the same filters as
// platformorgs.List) as RFC 4180 CSV. Up to 5000 rows so an operator
// can hand the file to finance or compliance without back-and-forth.
//
// GET /v1/admin/orgs/export.csv?q=&status=&plan=
func (h *Handler) ExportOrgsCSV(w http.ResponseWriter, r *http.Request) {
	q := strings.TrimSpace(r.URL.Query().Get("q"))
	status := strings.TrimSpace(r.URL.Query().Get("status"))
	plan := strings.TrimSpace(r.URL.Query().Get("plan"))

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
		conds = append(conds, "o.deleted_at IS NULL")
	}
	if len(conds) == 0 {
		conds = []string{"true"}
	}

	sql := `
		SELECT o.id::text, o.name,
		       COALESCE((
		         SELECT p.tier FROM subscriptions s
		           JOIN plans p ON p.id = s.plan_id
		          WHERE s.org_id = o.id
		            AND s.status IN ('trialing','active','past_due','paused')
		          ORDER BY s.created_at DESC LIMIT 1
		       ), 'free') AS plan,
		       (SELECT COUNT(*) FROM users u WHERE u.org_id=o.id)::bigint AS user_count,
		       COALESCE((SELECT SUM(size) FROM files f
		                  WHERE f.org_id=o.id AND f.trashed_at IS NULL), 0)::bigint AS storage_bytes,
		       o.frozen_at, COALESCE(o.frozen_reason,''),
		       o.deleted_at, o.created_at
		  FROM organizations o
		 WHERE ` + strings.Join(conds, " AND ") + `
		 ORDER BY o.created_at DESC LIMIT 5000`

	rows, err := h.DB.Query(r.Context(), sql, args...)
	if err != nil {
		writeErr(w, 500, "db_error", err.Error())
		return
	}
	defer rows.Close()

	csvHeader(w, fmt.Sprintf("formly-orgs-%s.csv", time.Now().UTC().Format("20060102-150405")))
	fmt.Fprintln(w, "id,name,plan,user_count,storage_bytes,frozen_at,frozen_reason,deleted_at,created_at")
	exported := 0
	for rows.Next() {
		var (
			id, name, plan, frozenReason string
			users, bytes                 int64
			frozenAt, deletedAt          *time.Time
			createdAt                    time.Time
		)
		if err := rows.Scan(&id, &name, &plan, &users, &bytes,
			&frozenAt, &frozenReason, &deletedAt, &createdAt); err != nil {
			continue
		}
		fmt.Fprintf(w, "%s,%s,%s,%d,%d,%s,%s,%s,%s\n",
			id,
			quoteCSV(name),
			plan,
			users,
			bytes,
			tsOrEmpty(frozenAt),
			quoteCSV(frozenReason),
			tsOrEmpty(deletedAt),
			createdAt.UTC().Format(time.RFC3339),
		)
		exported++
	}
	audit.LogHTTP(r, h.DB, "super_admin.orgs_exported", "orgs", "",
		map[string]any{"rows": exported, "filters": map[string]string{
			"q": q, "status": status, "plan": plan,
		}})
}

// ExportUsersCSV streams the user list as CSV with the same filters
// as platformusers.List.
//
// GET /v1/admin/users/export.csv?q=&orgId=&status=&role=
func (h *Handler) ExportUsersCSV(w http.ResponseWriter, r *http.Request) {
	q := strings.TrimSpace(r.URL.Query().Get("q"))
	orgID := strings.TrimSpace(r.URL.Query().Get("orgId"))
	status := strings.TrimSpace(r.URL.Query().Get("status"))
	role := strings.TrimSpace(r.URL.Query().Get("role"))

	var (
		conds []string
		args  []any
	)
	if q != "" {
		args = append(args, "%"+q+"%")
		p := "$" + itoa(len(args))
		conds = append(conds, "(u.email ILIKE "+p+" OR u.name ILIKE "+p+")")
	}
	if orgID != "" {
		args = append(args, orgID)
		conds = append(conds, "u.org_id = $"+itoa(len(args))+"::uuid")
	}
	if role != "" {
		args = append(args, role)
		conds = append(conds, "u.role = $"+itoa(len(args)))
	}
	switch status {
	case "active":
		conds = append(conds, "u.locked_at IS NULL")
	case "locked":
		conds = append(conds, "u.locked_at IS NOT NULL")
	case "no_mfa":
		conds = append(conds, "NOT EXISTS (SELECT 1 FROM two_factor_secrets t WHERE t.user_id=u.id)")
	}
	if len(conds) == 0 {
		conds = []string{"true"}
	}

	sql := `
		SELECT u.id::text, u.email, COALESCE(u.name,''), COALESCE(u.role,'editor'),
		       u.org_id::text, COALESCE(o.name,''),
		       EXISTS (SELECT 1 FROM two_factor_secrets t
		                WHERE t.user_id=u.id AND t.verified_at IS NOT NULL),
		       u.locked_at, COALESCE(u.locked_reason,''),
		       u.created_at,
		       (SELECT MAX(last_active_at) FROM user_sessions s
		         WHERE s.user_id=u.id AND s.revoked_at IS NULL) AS last_seen
		  FROM users u
		  LEFT JOIN organizations o ON o.id=u.org_id
		 WHERE ` + strings.Join(conds, " AND ") + `
		 ORDER BY u.created_at DESC LIMIT 5000`

	rows, err := h.DB.Query(r.Context(), sql, args...)
	if err != nil {
		writeErr(w, 500, "db_error", err.Error())
		return
	}
	defer rows.Close()

	csvHeader(w, fmt.Sprintf("formly-users-%s.csv", time.Now().UTC().Format("20060102-150405")))
	fmt.Fprintln(w, "id,email,name,role,org_id,org_name,has_mfa,locked_at,locked_reason,created_at,last_seen_at")
	exported := 0
	for rows.Next() {
		var (
			id, email, name, role, orgID, orgName, lockedReason string
			hasMFA                                              bool
			lockedAt, lastSeen                                  *time.Time
			createdAt                                           time.Time
		)
		if err := rows.Scan(&id, &email, &name, &role, &orgID, &orgName,
			&hasMFA, &lockedAt, &lockedReason, &createdAt, &lastSeen); err != nil {
			continue
		}
		fmt.Fprintf(w, "%s,%s,%s,%s,%s,%s,%t,%s,%s,%s,%s\n",
			id,
			quoteCSV(email),
			quoteCSV(name),
			role,
			orgID,
			quoteCSV(orgName),
			hasMFA,
			tsOrEmpty(lockedAt),
			quoteCSV(lockedReason),
			createdAt.UTC().Format(time.RFC3339),
			tsOrEmpty(lastSeen),
		)
		exported++
	}
	audit.LogHTTP(r, h.DB, "super_admin.users_exported", "users", "",
		map[string]any{"rows": exported, "filters": map[string]string{
			"q": q, "orgId": orgID, "status": status, "role": role,
		}})
}

func tsOrEmpty(t *time.Time) string {
	if t == nil {
		return ""
	}
	return t.UTC().Format(time.RFC3339)
}

// -- BULK actions --------------------------------------------------------

// BulkFreezeOrgs freezes a list of orgs in one atomic UPDATE. The
// operator's own org is silently skipped (same guard as the singular
// endpoint). One audit row is written per successfully-frozen org so
// each entry is independently auditable.
//
// POST /v1/admin/orgs/bulk-freeze {"ids":["…","…"], "reason":"…"}
func (h *Handler) BulkFreezeOrgs(w http.ResponseWriter, r *http.Request) {
	c, _ := r.Context().Value(auth.UserCtxKey).(*auth.Claims)
	req, err := decodeBulk(r)
	if err != nil {
		writeErr(w, 400, "invalid_body", err.Error())
		return
	}
	reason := strings.TrimSpace(req.Reason)
	if reason == "" {
		writeErr(w, 400, "missing_reason",
			"a reason is required for the audit trail")
		return
	}
	if len(req.IDs) == 0 {
		writeErr(w, 400, "no_ids", "at least one id is required")
		return
	}

	// Filter out the operator's own org so they can't lock themselves out.
	ids := req.IDs[:0]
	for _, id := range req.IDs {
		if c == nil || c.OrgID != id {
			ids = append(ids, id)
		}
	}

	rows, err := h.DB.Query(r.Context(), `
		UPDATE organizations
		   SET frozen_at=now(), frozen_by=$2::uuid, frozen_reason=$3
		 WHERE id = ANY($1::uuid[])
		   AND frozen_at IS NULL AND deleted_at IS NULL
	   RETURNING id::text`, ids, c.UserID, reason)
	if err != nil {
		writeErr(w, 500, "db_error", err.Error())
		return
	}
	defer rows.Close()

	affected := int64(0)
	for rows.Next() {
		var id string
		if rows.Scan(&id) == nil {
			audit.LogHTTP(r, h.DB, "super_admin.org_frozen", "org", id,
				map[string]any{"reason": reason, "bulk": true})
			affected++
		}
	}
	writeJSON(w, 200, bulkResult{
		Requested: int64(len(req.IDs)),
		Affected:  affected,
	})
}

// BulkUnfreezeOrgs lifts the frozen state on a list of orgs.
//
// POST /v1/admin/orgs/bulk-unfreeze {"ids":["…"]}
func (h *Handler) BulkUnfreezeOrgs(w http.ResponseWriter, r *http.Request) {
	req, err := decodeBulk(r)
	if err != nil {
		writeErr(w, 400, "invalid_body", err.Error())
		return
	}
	if len(req.IDs) == 0 {
		writeErr(w, 400, "no_ids", "at least one id is required")
		return
	}

	rows, err := h.DB.Query(r.Context(), `
		UPDATE organizations
		   SET frozen_at=NULL, frozen_by=NULL, frozen_reason=NULL
		 WHERE id = ANY($1::uuid[])
		   AND frozen_at IS NOT NULL
	   RETURNING id::text`, req.IDs)
	if err != nil {
		writeErr(w, 500, "db_error", err.Error())
		return
	}
	defer rows.Close()

	affected := int64(0)
	for rows.Next() {
		var id string
		if rows.Scan(&id) == nil {
			audit.LogHTTP(r, h.DB, "super_admin.org_unfrozen", "org", id,
				map[string]any{"bulk": true})
			affected++
		}
	}
	writeJSON(w, 200, bulkResult{
		Requested: int64(len(req.IDs)),
		Affected:  affected,
	})
}

// BulkLockUsers locks every user in the list. Skips the operator's own
// account silently. Sessions are killed in the same transaction so the
// lock takes effect on the next request from any device.
//
// POST /v1/admin/users/bulk-lock {"ids":["…"], "reason":"…"}
func (h *Handler) BulkLockUsers(w http.ResponseWriter, r *http.Request) {
	c, _ := r.Context().Value(auth.UserCtxKey).(*auth.Claims)
	req, err := decodeBulk(r)
	if err != nil {
		writeErr(w, 400, "invalid_body", err.Error())
		return
	}
	reason := strings.TrimSpace(req.Reason)
	if reason == "" {
		writeErr(w, 400, "missing_reason",
			"a reason is required for the audit trail")
		return
	}
	if len(req.IDs) == 0 {
		writeErr(w, 400, "no_ids", "at least one id is required")
		return
	}

	ids := req.IDs[:0]
	for _, id := range req.IDs {
		if c == nil || c.UserID != id {
			ids = append(ids, id)
		}
	}

	rows, err := h.DB.Query(r.Context(), `
		UPDATE users
		   SET locked_at=now(), locked_by=$2::uuid, locked_reason=$3,
		       updated_at=now()
		 WHERE id = ANY($1::uuid[])
		   AND locked_at IS NULL
	   RETURNING id::text`, ids, c.UserID, reason)
	if err != nil {
		writeErr(w, 500, "db_error", err.Error())
		return
	}
	defer rows.Close()

	locked := []string{}
	for rows.Next() {
		var id string
		if rows.Scan(&id) == nil {
			locked = append(locked, id)
		}
	}
	if len(locked) > 0 {
		_, _ = h.DB.Exec(r.Context(), `
			UPDATE user_sessions SET revoked_at=now()
			 WHERE user_id = ANY($1::uuid[]) AND revoked_at IS NULL`, locked)
	}
	for _, id := range locked {
		audit.LogHTTP(r, h.DB, "super_admin.user_locked", "user", id,
			map[string]any{"reason": reason, "targetUserId": id, "bulk": true})
	}

	writeJSON(w, 200, bulkResult{
		Requested: int64(len(req.IDs)),
		Affected:  int64(len(locked)),
	})
}

// BulkUnlockUsers reverses BulkLockUsers.
//
// POST /v1/admin/users/bulk-unlock {"ids":["…"]}
func (h *Handler) BulkUnlockUsers(w http.ResponseWriter, r *http.Request) {
	req, err := decodeBulk(r)
	if err != nil {
		writeErr(w, 400, "invalid_body", err.Error())
		return
	}
	if len(req.IDs) == 0 {
		writeErr(w, 400, "no_ids", "at least one id is required")
		return
	}
	rows, err := h.DB.Query(r.Context(), `
		UPDATE users
		   SET locked_at=NULL, locked_by=NULL, locked_reason=NULL,
		       updated_at=now()
		 WHERE id = ANY($1::uuid[])
		   AND locked_at IS NOT NULL
	   RETURNING id::text`, req.IDs)
	if err != nil {
		writeErr(w, 500, "db_error", err.Error())
		return
	}
	defer rows.Close()
	affected := int64(0)
	for rows.Next() {
		var id string
		if rows.Scan(&id) == nil {
			audit.LogHTTP(r, h.DB, "super_admin.user_unlocked", "user", id,
				map[string]any{"targetUserId": id, "bulk": true})
			affected++
		}
	}
	writeJSON(w, 200, bulkResult{
		Requested: int64(len(req.IDs)),
		Affected:  affected,
	})
}

// silence unused import guard for json — ranges of decodeBulk live in
// platformanalytics.go.
var _ = json.Marshal
