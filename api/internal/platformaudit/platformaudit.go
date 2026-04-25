// Package platformaudit serves the cross-org audit log viewer.
//
// The single GET endpoint accepts a handful of filters (orgId, actor,
// action prefix, date range) and returns the latest 200 matching rows
// from audit_log. The page is read-only — every recordable action is
// already audited at its origin.
package platformaudit

import (
	"encoding/json"
	"errors"
	"net/http"
	"strings"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
)

type Handler struct {
	DB *pgxpool.Pool
}

func New(db *pgxpool.Pool) *Handler { return &Handler{DB: db} }

type entry struct {
	At      string         `json:"at"`
	OrgID   string         `json:"orgId"`
	OrgName string         `json:"orgName"`
	ActorID string         `json:"actorId"`
	Actor   string         `json:"actor"`
	Action  string         `json:"action"`
	IP      string         `json:"ip"`
	Meta    map[string]any `json:"meta,omitempty"`
}

// List GET /v1/admin/audit
//
// Query params (all optional, AND-combined):
//
//	orgId   — UUID
//	actor   — substring of email
//	action  — prefix match (e.g. "auth." or "super_admin.")
//	from    — RFC3339 timestamp
//	to      — RFC3339 timestamp
//	limit   — 1..500 (default 200)
func (h *Handler) List(w http.ResponseWriter, r *http.Request) {
	orgID := strings.TrimSpace(r.URL.Query().Get("orgId"))
	actor := strings.TrimSpace(r.URL.Query().Get("actor"))
	action := strings.TrimSpace(r.URL.Query().Get("action"))
	from := strings.TrimSpace(r.URL.Query().Get("from"))
	to := strings.TrimSpace(r.URL.Query().Get("to"))
	limit := 200
	if v := r.URL.Query().Get("limit"); v != "" {
		var n int
		if _, err := atoi(v, &n); err == nil && n > 0 && n <= 500 {
			limit = n
		}
	}

	var (
		conds = []string{"true"}
		args  []any
	)
	if orgID != "" {
		args = append(args, orgID)
		conds = append(conds, "a.org_id = $"+itoa(len(args))+"::uuid")
	}
	if actor != "" {
		args = append(args, "%"+actor+"%")
		conds = append(conds, "a.actor_email ILIKE $"+itoa(len(args)))
	}
	if action != "" {
		args = append(args, action+"%")
		conds = append(conds, "a.action ILIKE $"+itoa(len(args)))
	}
	if from != "" {
		if t, err := time.Parse(time.RFC3339, from); err == nil {
			args = append(args, t)
			conds = append(conds, "a.created_at >= $"+itoa(len(args)))
		}
	}
	if to != "" {
		if t, err := time.Parse(time.RFC3339, to); err == nil {
			args = append(args, t)
			conds = append(conds, "a.created_at <= $"+itoa(len(args)))
		}
	}
	args = append(args, limit)
	limitPlaceholder := "$" + itoa(len(args))

	sql := `
		SELECT a.created_at, COALESCE(a.org_id::text,''),
		       COALESCE(o.name,''),
		       COALESCE(a.actor_id::text,''), COALESCE(a.actor_email,''),
		       a.action, COALESCE(a.ip_addr::text,''), a.meta
		  FROM audit_log a
		  LEFT JOIN organizations o ON o.id = a.org_id
		 WHERE ` + strings.Join(conds, " AND ") + `
		 ORDER BY a.created_at DESC
		 LIMIT ` + limitPlaceholder

	rows, err := h.DB.Query(r.Context(), sql, args...)
	if err != nil {
		writeErr(w, 500, "db_error", err.Error())
		return
	}
	defer rows.Close()

	out := []entry{}
	for rows.Next() {
		var e entry
		var at time.Time
		var metaJSON []byte
		if err := rows.Scan(&at, &e.OrgID, &e.OrgName,
			&e.ActorID, &e.Actor, &e.Action, &e.IP, &metaJSON); err != nil {
			continue
		}
		e.At = at.Format(time.RFC3339)
		if len(metaJSON) > 0 {
			_ = json.Unmarshal(metaJSON, &e.Meta)
		}
		out = append(out, e)
	}
	writeJSON(w, 200, map[string]any{"entries": out})
}

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
