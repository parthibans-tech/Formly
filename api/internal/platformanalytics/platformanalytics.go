// Package platformanalytics powers the enterprise super-admin analytics
// console — the Organizations and Users dashboards that go beyond simple
// CRUD into time-series growth, retention, segmentation and engagement.
//
// All endpoints sit behind requireSuperAdmin in cmd/api/main.go and read
// from operational Postgres directly; we deliberately avoid Prometheus
// here because RUM/HTTP metrics already live in promquery, and the
// signals we need (signups by day, MFA adoption, plan churn) are
// authoritative in Postgres.
//
// Window argument
// ---------------
// Most series accept ?window=7d|30d|90d|180d|365d (default 30d). We bucket
// by day for ≤30d and by week beyond that — keeps the JSON payloads
// small enough to ship in one round-trip.
package platformanalytics

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

type Handler struct {
	DB *pgxpool.Pool
}

func New(db *pgxpool.Pool) *Handler { return &Handler{DB: db} }

// -- shared helpers ------------------------------------------------------

// resolveWindow parses ?window=7d|30d|90d and returns (durationDays,
// bucket). Buckets stay 'day' up to 30d so the dashboard time-series
// stays high-resolution; longer ranges fall back to 'week' to keep the
// payload bounded.
func resolveWindow(r *http.Request) (days int, bucket string) {
	switch strings.ToLower(strings.TrimSpace(r.URL.Query().Get("window"))) {
	case "7d":
		return 7, "day"
	case "90d":
		return 90, "week"
	case "180d":
		return 180, "week"
	case "365d":
		return 365, "week"
	}
	return 30, "day"
}

type point struct {
	Bucket string `json:"bucket"`
	Value  int64  `json:"value"`
}

type bucketStr struct {
	Label string `json:"label"`
	Value int64  `json:"value"`
}

// bucketed runs a (timestamp bucket, count|sum) query whose first two
// positional args are $1=days and $2=bucket. Any extras are appended.
func bucketed(ctx context.Context, db *pgxpool.Pool, sql string, days int, bucket string, extras ...any) []point {
	args := append([]any{days, bucket}, extras...)
	rows, err := db.Query(ctx, sql, args...)
	if err != nil {
		return []point{}
	}
	defer rows.Close()
	out := []point{}
	for rows.Next() {
		var t time.Time
		var v int64
		if err := rows.Scan(&t, &v); err == nil {
			out = append(out, point{Bucket: t.UTC().Format(time.RFC3339), Value: v})
		}
	}
	return out
}

// -- ORG analytics -------------------------------------------------------

// OrgAnalytics aggregates the cross-org operator dashboard. Returned in
// a single shot so the page doesn't need a fan-out.
//
// GET /v1/admin/orgs/analytics?window=30d
func (h *Handler) OrgAnalytics(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	days, bucket := resolveWindow(r)
	out := map[string]any{
		"window":    fmt.Sprintf("%dd", days),
		"bucket":    bucket,
		"generated": time.Now().UTC().Format(time.RFC3339),
	}

	// 1) Org signups over time (creation dates of organizations).
	out["signups"] = bucketed(ctx, h.DB, `
		SELECT date_trunc($2, created_at) AS b, COUNT(*)::bigint
		  FROM organizations
		 WHERE created_at > now() - ($1 || ' days')::interval
		 GROUP BY b ORDER BY b ASC`, days, bucket)

	// 2) Plan tier distribution. Orgs without an active subscription
	//    fall back to 'free'.
	planDist := []bucketStr{}
	if rows, err := h.DB.Query(ctx, `
		SELECT COALESCE((
		         SELECT p.tier FROM subscriptions s
		           JOIN plans p ON p.id = s.plan_id
		          WHERE s.org_id = o.id
		            AND s.status IN ('trialing','active','past_due','paused')
		          ORDER BY s.created_at DESC LIMIT 1
		       ), 'free') AS tier,
		       COUNT(*)::bigint
		  FROM organizations o
		 WHERE o.deleted_at IS NULL
		 GROUP BY 1 ORDER BY 2 DESC`); err == nil {
		defer rows.Close()
		for rows.Next() {
			var b bucketStr
			if rows.Scan(&b.Label, &b.Value) == nil {
				planDist = append(planDist, b)
			}
		}
	}
	out["planDistribution"] = planDist

	// 3) Storage distribution: bucket orgs by total file bytes.
	storage := []bucketStr{}
	if rows, err := h.DB.Query(ctx, `
		WITH s AS (
		  SELECT o.id,
		         COALESCE((SELECT SUM(size) FROM files f
		                    WHERE f.org_id=o.id AND f.trashed_at IS NULL), 0) AS bytes
		    FROM organizations o WHERE o.deleted_at IS NULL
		)
		SELECT label, COUNT(*)::bigint FROM (
		  SELECT CASE
		           WHEN bytes <= 100*1024*1024 THEN '0–100 MB'
		           WHEN bytes <= 1024*1024*1024 THEN '100 MB–1 GB'
		           WHEN bytes <= 10::bigint*1024*1024*1024 THEN '1–10 GB'
		           WHEN bytes <= 100::bigint*1024*1024*1024 THEN '10–100 GB'
		           ELSE '>100 GB'
		         END AS label,
		         CASE
		           WHEN bytes <= 100*1024*1024 THEN 1
		           WHEN bytes <= 1024*1024*1024 THEN 2
		           WHEN bytes <= 10::bigint*1024*1024*1024 THEN 3
		           WHEN bytes <= 100::bigint*1024*1024*1024 THEN 4
		           ELSE 5
		         END AS sortkey
		  FROM s
		) t GROUP BY label, sortkey ORDER BY sortkey`); err == nil {
		defer rows.Close()
		for rows.Next() {
			var b bucketStr
			if rows.Scan(&b.Label, &b.Value) == nil {
				storage = append(storage, b)
			}
		}
	}
	out["storageDistribution"] = storage

	// 4) Org-size buckets (members per org).
	sizeDist := []bucketStr{}
	if rows, err := h.DB.Query(ctx, `
		WITH s AS (
		  SELECT o.id,
		         (SELECT COUNT(*) FROM users u WHERE u.org_id=o.id) AS n
		    FROM organizations o WHERE o.deleted_at IS NULL
		)
		SELECT label, COUNT(*)::bigint FROM (
		  SELECT CASE
		           WHEN n <= 1 THEN 'Solo'
		           WHEN n <= 5 THEN '2–5'
		           WHEN n <= 25 THEN '6–25'
		           WHEN n <= 100 THEN '26–100'
		           WHEN n <= 500 THEN '101–500'
		           ELSE '500+'
		         END AS label,
		         CASE
		           WHEN n <= 1 THEN 1
		           WHEN n <= 5 THEN 2
		           WHEN n <= 25 THEN 3
		           WHEN n <= 100 THEN 4
		           WHEN n <= 500 THEN 5
		           ELSE 6
		         END AS sortkey
		    FROM s
		) t GROUP BY label, sortkey ORDER BY sortkey`); err == nil {
		defer rows.Close()
		for rows.Next() {
			var b bucketStr
			if rows.Scan(&b.Label, &b.Value) == nil {
				sizeDist = append(sizeDist, b)
			}
		}
	}
	out["sizeDistribution"] = sizeDist

	// 5) Activity status — orgs are "active" if they have an audit row
	//    in the last 30 days; otherwise "dormant", "frozen" or "deleted".
	type statusRow struct {
		Active  int64 `json:"active"`
		Dormant int64 `json:"dormant"`
		Frozen  int64 `json:"frozen"`
		Deleted int64 `json:"deleted"`
	}
	var st statusRow
	_ = h.DB.QueryRow(ctx, `
		SELECT
		  COUNT(*) FILTER (WHERE deleted_at IS NULL AND frozen_at IS NULL
		                   AND EXISTS (SELECT 1 FROM audit_log a
		                                 WHERE a.org_id=o.id
		                                   AND a.created_at > now() - interval '30 days')),
		  COUNT(*) FILTER (WHERE deleted_at IS NULL AND frozen_at IS NULL
		                   AND NOT EXISTS (SELECT 1 FROM audit_log a
		                                     WHERE a.org_id=o.id
		                                       AND a.created_at > now() - interval '30 days')),
		  COUNT(*) FILTER (WHERE frozen_at IS NOT NULL AND deleted_at IS NULL),
		  COUNT(*) FILTER (WHERE deleted_at IS NOT NULL)
		FROM organizations o`,
	).Scan(&st.Active, &st.Dormant, &st.Frozen, &st.Deleted)
	out["activityStatus"] = st

	// 6) Top orgs by user count.
	topByUsers := []map[string]any{}
	if rows, err := h.DB.Query(ctx, `
		SELECT o.id::text, o.name,
		       (SELECT COUNT(*) FROM users u WHERE u.org_id=o.id)::bigint AS n
		  FROM organizations o WHERE o.deleted_at IS NULL
		 ORDER BY n DESC LIMIT 10`); err == nil {
		defer rows.Close()
		for rows.Next() {
			var id, name string
			var n int64
			if rows.Scan(&id, &name, &n) == nil {
				topByUsers = append(topByUsers, map[string]any{"id": id, "name": name, "value": n})
			}
		}
	}
	out["topByUsers"] = topByUsers

	// 7) Top orgs by storage.
	topByStorage := []map[string]any{}
	if rows, err := h.DB.Query(ctx, `
		SELECT o.id::text, o.name,
		       COALESCE((SELECT SUM(size) FROM files f
		                  WHERE f.org_id=o.id AND f.trashed_at IS NULL), 0)::bigint AS bytes
		  FROM organizations o WHERE o.deleted_at IS NULL
		 ORDER BY bytes DESC LIMIT 10`); err == nil {
		defer rows.Close()
		for rows.Next() {
			var id, name string
			var n int64
			if rows.Scan(&id, &name, &n) == nil {
				topByStorage = append(topByStorage, map[string]any{"id": id, "name": name, "value": n})
			}
		}
	}
	out["topByStorage"] = topByStorage

	// 8) Top orgs by revenue (paid invoices in window).
	topByRevenue := []map[string]any{}
	if rows, err := h.DB.Query(ctx, `
		SELECT o.id::text, o.name, COALESCE(SUM(i.total_cents),0)::bigint AS cents
		  FROM organizations o
		  JOIN invoices i ON i.org_id=o.id
		 WHERE i.status='paid'
		   AND i.issued_at > now() - ($1 || ' days')::interval
		   AND o.deleted_at IS NULL
		 GROUP BY o.id, o.name
		 ORDER BY cents DESC LIMIT 10`, days); err == nil {
		defer rows.Close()
		for rows.Next() {
			var id, name string
			var n int64
			if rows.Scan(&id, &name, &n) == nil {
				topByRevenue = append(topByRevenue, map[string]any{"id": id, "name": name, "value": n})
			}
		}
	}
	out["topByRevenue"] = topByRevenue

	// 9) Churn signal: orgs frozen or soft-deleted bucketed.
	out["churn"] = bucketed(ctx, h.DB, `
		SELECT date_trunc($2, COALESCE(deleted_at, frozen_at)) AS b, COUNT(*)::bigint
		  FROM organizations
		 WHERE (deleted_at IS NOT NULL OR frozen_at IS NOT NULL)
		   AND COALESCE(deleted_at, frozen_at) > now() - ($1 || ' days')::interval
		 GROUP BY b ORDER BY b ASC`, days, bucket)

	// 10) Cohort retention. Group orgs by signup week and report
	//     whether they had any audit activity in the last 30 days.
	cohorts := []map[string]any{}
	if rows, err := h.DB.Query(ctx, `
		WITH c AS (
		  SELECT o.id,
		         to_char(date_trunc('week', o.created_at), 'YYYY-MM-DD') AS cohort,
		         EXISTS (SELECT 1 FROM audit_log a
		                  WHERE a.org_id=o.id
		                    AND a.created_at > now() - interval '30 days') AS retained
		    FROM organizations o
		   WHERE o.created_at > now() - interval '180 days'
		     AND o.deleted_at IS NULL
		)
		SELECT cohort, COUNT(*)::bigint AS total,
		       COUNT(*) FILTER (WHERE retained)::bigint AS active
		  FROM c GROUP BY cohort ORDER BY cohort ASC`); err == nil {
		defer rows.Close()
		for rows.Next() {
			var cohort string
			var total, active int64
			if rows.Scan(&cohort, &total, &active) == nil {
				cohorts = append(cohorts, map[string]any{
					"cohort": cohort, "total": total, "active": active,
				})
			}
		}
	}
	out["cohorts"] = cohorts

	// 11) Dormant orgs (no audit activity in 30 days, not frozen/deleted).
	dormant := []map[string]any{}
	if rows, err := h.DB.Query(ctx, `
		SELECT o.id::text, o.name,
		       (SELECT MAX(created_at) FROM audit_log a WHERE a.org_id=o.id) AS last_seen,
		       o.created_at
		  FROM organizations o
		 WHERE o.deleted_at IS NULL AND o.frozen_at IS NULL
		   AND NOT EXISTS (SELECT 1 FROM audit_log a
		                     WHERE a.org_id=o.id
		                       AND a.created_at > now() - interval '30 days')
		 ORDER BY o.created_at ASC LIMIT 12`); err == nil {
		defer rows.Close()
		for rows.Next() {
			var id, name string
			var lastSeen *time.Time
			var created time.Time
			if rows.Scan(&id, &name, &lastSeen, &created) == nil {
				row := map[string]any{
					"id": id, "name": name, "createdAt": created.Format(time.RFC3339),
				}
				if lastSeen != nil {
					row["lastSeen"] = lastSeen.Format(time.RFC3339)
				}
				dormant = append(dormant, row)
			}
		}
	}
	out["dormant"] = dormant

	writeJSON(w, 200, out)
}

// OrgAnalyticsForID is the per-org drill-down: member growth, storage
// growth, audit-activity timeline and top contributors. Used by the
// "Analytics" tab in the org detail drawer.
//
// GET /v1/admin/orgs/{id}/analytics?window=30d
func (h *Handler) OrgAnalyticsForID(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	id := chi.URLParam(r, "id")
	days, bucket := resolveWindow(r)
	out := map[string]any{
		"window": fmt.Sprintf("%dd", days),
		"bucket": bucket,
	}

	out["memberGrowth"] = bucketed(ctx, h.DB, `
		SELECT date_trunc($2, created_at) AS b, COUNT(*)::bigint
		  FROM users WHERE org_id=$3::uuid
		   AND created_at > now() - ($1 || ' days')::interval
		 GROUP BY b ORDER BY b ASC`, days, bucket, id)

	out["storageGrowth"] = bucketed(ctx, h.DB, `
		SELECT date_trunc($2, created_at) AS b, COALESCE(SUM(size),0)::bigint
		  FROM files WHERE org_id=$3::uuid AND trashed_at IS NULL
		   AND created_at > now() - ($1 || ' days')::interval
		 GROUP BY b ORDER BY b ASC`, days, bucket, id)

	out["activity"] = bucketed(ctx, h.DB, `
		SELECT date_trunc($2, created_at) AS b, COUNT(*)::bigint
		  FROM audit_log WHERE org_id=$3::uuid
		   AND created_at > now() - ($1 || ' days')::interval
		 GROUP BY b ORDER BY b ASC`, days, bucket, id)

	roleDist := []bucketStr{}
	if rows, err := h.DB.Query(ctx, `
		SELECT COALESCE(role,'editor'), COUNT(*)::bigint
		  FROM users WHERE org_id=$1::uuid
		 GROUP BY 1 ORDER BY 2 DESC`, id); err == nil {
		defer rows.Close()
		for rows.Next() {
			var b bucketStr
			if rows.Scan(&b.Label, &b.Value) == nil {
				roleDist = append(roleDist, b)
			}
		}
	}
	out["roleDistribution"] = roleDist

	topContributors := []map[string]any{}
	if rows, err := h.DB.Query(ctx, `
		SELECT COALESCE(actor_email,'(system)'),
		       COUNT(*)::bigint
		  FROM audit_log
		 WHERE org_id=$1::uuid
		   AND created_at > now() - interval '30 days'
		 GROUP BY 1 ORDER BY 2 DESC LIMIT 10`, id); err == nil {
		defer rows.Close()
		for rows.Next() {
			var actor string
			var n int64
			if rows.Scan(&actor, &n) == nil {
				topContributors = append(topContributors, map[string]any{"actor": actor, "value": n})
			}
		}
	}
	out["topContributors"] = topContributors

	topFiles := []map[string]any{}
	if rows, err := h.DB.Query(ctx, `
		SELECT id::text, COALESCE(name,''), COALESCE(size,0)::bigint
		  FROM files WHERE org_id=$1::uuid AND trashed_at IS NULL
		 ORDER BY size DESC LIMIT 10`, id); err == nil {
		defer rows.Close()
		for rows.Next() {
			var fid, name string
			var size int64
			if rows.Scan(&fid, &name, &size) == nil {
				topFiles = append(topFiles, map[string]any{"id": fid, "name": name, "size": size})
			}
		}
	}
	out["topFiles"] = topFiles

	var failedLogins int64
	_ = h.DB.QueryRow(ctx, `
		SELECT COUNT(*) FROM audit_log
		 WHERE org_id=$1::uuid
		   AND action LIKE 'auth.%failed%'
		   AND created_at > now() - interval '30 days'`, id).Scan(&failedLogins)
	out["failedLogins30d"] = failedLogins

	// DAU within the org — distinct actor_ids per bucket, last `days`.
	// Useful for the per-org dashboard: "is this workspace becoming more
	// engaged or coasting?"
	out["dauSeries"] = bucketed(ctx, h.DB, `
		SELECT date_trunc($2, created_at) AS b,
		       COUNT(DISTINCT actor_id)::bigint
		  FROM audit_log
		 WHERE org_id=$3::uuid
		   AND actor_id IS NOT NULL
		   AND created_at > now() - ($1 || ' days')::interval
		 GROUP BY b ORDER BY b ASC`, days, bucket, id)

	// Hour-of-day pattern: when does this org's team work? A nightshift
	// spike from a 9–5 org is a takeover signal.
	hourly := make([]int64, 24)
	if rows, err := h.DB.Query(ctx, `
		SELECT EXTRACT(HOUR FROM created_at)::int AS h, COUNT(*)::bigint
		  FROM audit_log
		 WHERE org_id=$1::uuid
		   AND created_at > now() - interval '30 days'
		 GROUP BY h ORDER BY h`, id); err == nil {
		defer rows.Close()
		for rows.Next() {
			var hr int
			var n int64
			if rows.Scan(&hr, &n) == nil && hr >= 0 && hr < 24 {
				hourly[hr] = n
			}
		}
	}
	out["hourlyPattern"] = hourly

	// Action breakdown — top 12 audit actions for this org, last 30d.
	// Surfaces "what does this org actually do?"
	actionBreakdown := []bucketStr{}
	if rows, err := h.DB.Query(ctx, `
		SELECT action, COUNT(*)::bigint
		  FROM audit_log
		 WHERE org_id=$1::uuid
		   AND created_at > now() - interval '30 days'
		 GROUP BY action ORDER BY 2 DESC LIMIT 12`, id); err == nil {
		defer rows.Close()
		for rows.Next() {
			var b bucketStr
			if rows.Scan(&b.Label, &b.Value) == nil {
				actionBreakdown = append(actionBreakdown, b)
			}
		}
	}
	out["actionBreakdown"] = actionBreakdown

	// Quota utilization snapshot — % of users / storage used. Renders as
	// two ring gauges on the dashboard so an operator can spot orgs near
	// their plan ceiling at a glance.
	type quotaSnap struct {
		UserCount         int64  `json:"userCount"`
		MaxUsers          *int64 `json:"maxUsers"`
		StorageBytes      int64  `json:"storageBytes"`
		MaxStorageBytes   *int64 `json:"maxStorageBytes"`
		UsersPercent      *int64 `json:"usersPercent"`
		StoragePercent    *int64 `json:"storagePercent"`
	}
	q := quotaSnap{}
	_ = h.DB.QueryRow(ctx, `
		SELECT
		  (SELECT COUNT(*) FROM users WHERE org_id=$1::uuid)::bigint,
		  (SELECT max_users FROM organizations WHERE id=$1::uuid),
		  (SELECT COALESCE(SUM(size),0) FROM files
		    WHERE org_id=$1::uuid AND trashed_at IS NULL)::bigint,
		  (SELECT max_storage_bytes FROM organizations WHERE id=$1::uuid)`,
		id).Scan(&q.UserCount, &q.MaxUsers, &q.StorageBytes, &q.MaxStorageBytes)
	if q.MaxUsers != nil && *q.MaxUsers > 0 {
		p := int64((float64(q.UserCount) / float64(*q.MaxUsers)) * 100)
		q.UsersPercent = &p
	}
	if q.MaxStorageBytes != nil && *q.MaxStorageBytes > 0 {
		p := int64((float64(q.StorageBytes) / float64(*q.MaxStorageBytes)) * 100)
		q.StoragePercent = &p
	}
	out["quota"] = q

	writeJSON(w, 200, out)
}

// -- USER analytics ------------------------------------------------------

// UserAnalytics is the cross-org user dashboard.
//
// GET /v1/admin/users/analytics?window=30d
func (h *Handler) UserAnalytics(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	days, bucket := resolveWindow(r)
	out := map[string]any{
		"window": fmt.Sprintf("%dd", days),
		"bucket": bucket,
	}

	out["signups"] = bucketed(ctx, h.DB, `
		SELECT date_trunc($2, created_at) AS b, COUNT(*)::bigint
		  FROM users
		 WHERE created_at > now() - ($1 || ' days')::interval
		 GROUP BY b ORDER BY b ASC`, days, bucket)

	roleDist := []bucketStr{}
	if rows, err := h.DB.Query(ctx, `
		SELECT COALESCE(role,'editor'), COUNT(*)::bigint
		  FROM users GROUP BY 1 ORDER BY 2 DESC`); err == nil {
		defer rows.Close()
		for rows.Next() {
			var b bucketStr
			if rows.Scan(&b.Label, &b.Value) == nil {
				roleDist = append(roleDist, b)
			}
		}
	}
	out["roleDistribution"] = roleDist

	type mfaRow struct {
		WithMFA    int64   `json:"withMfa"`
		WithoutMFA int64   `json:"withoutMfa"`
		AdoptionPC float64 `json:"adoptionPercent"`
	}
	var mr mfaRow
	_ = h.DB.QueryRow(ctx, `
		SELECT
		  (SELECT COUNT(*) FROM two_factor_secrets t
		     WHERE t.verified_at IS NOT NULL),
		  (SELECT COUNT(*) FROM users u
		     WHERE NOT EXISTS (SELECT 1 FROM two_factor_secrets t
		                         WHERE t.user_id=u.id AND t.verified_at IS NOT NULL))
	`).Scan(&mr.WithMFA, &mr.WithoutMFA)
	if total := mr.WithMFA + mr.WithoutMFA; total > 0 {
		mr.AdoptionPC = float64(mr.WithMFA) * 100.0 / float64(total)
	}
	out["mfaAdoption"] = mr

	lockedByReason := []bucketStr{}
	if rows, err := h.DB.Query(ctx, `
		SELECT COALESCE(LEFT(locked_reason,60),'(no reason)'),
		       COUNT(*)::bigint
		  FROM users WHERE locked_at IS NOT NULL
		 GROUP BY 1 ORDER BY 2 DESC LIMIT 10`); err == nil {
		defer rows.Close()
		for rows.Next() {
			var b bucketStr
			if rows.Scan(&b.Label, &b.Value) == nil {
				lockedByReason = append(lockedByReason, b)
			}
		}
	}
	out["lockedByReason"] = lockedByReason

	type activityRow struct {
		Active5m  int64 `json:"active5m"`
		Active1h  int64 `json:"active1h"`
		Active24h int64 `json:"active24h"`
		Dau       int64 `json:"dau"`
		Wau       int64 `json:"wau"`
		Mau       int64 `json:"mau"`
	}
	var ar activityRow
	_ = h.DB.QueryRow(ctx, `
		SELECT
		  COUNT(DISTINCT user_id) FILTER (WHERE last_active_at > now() - interval '5 minutes'),
		  COUNT(DISTINCT user_id) FILTER (WHERE last_active_at > now() - interval '1 hour'),
		  COUNT(DISTINCT user_id) FILTER (WHERE last_active_at > now() - interval '24 hours'),
		  COUNT(DISTINCT user_id) FILTER (WHERE last_active_at > now() - interval '1 day'),
		  COUNT(DISTINCT user_id) FILTER (WHERE last_active_at > now() - interval '7 days'),
		  COUNT(DISTINCT user_id) FILTER (WHERE last_active_at > now() - interval '30 days')
		FROM user_sessions WHERE revoked_at IS NULL
	`).Scan(&ar.Active5m, &ar.Active1h, &ar.Active24h, &ar.Dau, &ar.Wau, &ar.Mau)
	out["engagement"] = ar

	out["dauSeries"] = bucketed(ctx, h.DB, `
		SELECT date_trunc($2, last_active_at) AS b,
		       COUNT(DISTINCT user_id)::bigint
		  FROM user_sessions
		 WHERE last_active_at > now() - ($1 || ' days')::interval
		 GROUP BY b ORDER BY b ASC`, days, bucket)

	out["loginFailures"] = bucketed(ctx, h.DB, `
		SELECT date_trunc($2, created_at) AS b, COUNT(*)::bigint
		  FROM audit_log
		 WHERE action LIKE 'auth.%failed%'
		   AND created_at > now() - ($1 || ' days')::interval
		 GROUP BY b ORDER BY b ASC`, days, bucket)

	topEngaged := []map[string]any{}
	if rows, err := h.DB.Query(ctx, `
		SELECT u.id::text, u.email,
		       COUNT(DISTINCT date_trunc('day', s.last_active_at))::bigint AS days
		  FROM users u
		  JOIN user_sessions s ON s.user_id=u.id
		 WHERE s.last_active_at > now() - interval '30 days'
		 GROUP BY u.id, u.email
		 ORDER BY days DESC LIMIT 10`); err == nil {
		defer rows.Close()
		for rows.Next() {
			var id, email string
			var n int64
			if rows.Scan(&id, &email, &n) == nil {
				topEngaged = append(topEngaged, map[string]any{
					"id": id, "email": email, "value": n,
				})
			}
		}
	}
	out["topEngaged"] = topEngaged

	sessDist := []bucketStr{}
	if rows, err := h.DB.Query(ctx, `
		WITH s AS (
		  SELECT user_id, COUNT(*) AS n
		    FROM user_sessions WHERE revoked_at IS NULL
		   GROUP BY user_id
		)
		SELECT label, COUNT(*)::bigint FROM (
		  SELECT CASE
		           WHEN n=1 THEN '1'
		           WHEN n<=3 THEN '2–3'
		           WHEN n<=10 THEN '4–10'
		           ELSE '11+'
		         END AS label,
		         CASE WHEN n=1 THEN 1 WHEN n<=3 THEN 2 WHEN n<=10 THEN 3 ELSE 4 END AS sortkey
		    FROM s
		) t GROUP BY label, sortkey ORDER BY sortkey`); err == nil {
		defer rows.Close()
		for rows.Next() {
			var b bucketStr
			if rows.Scan(&b.Label, &b.Value) == nil {
				sessDist = append(sessDist, b)
			}
		}
	}
	out["sessionDistribution"] = sessDist

	recentLocks := []map[string]any{}
	if rows, err := h.DB.Query(ctx, `
		SELECT u.id::text, u.email, COALESCE(u.locked_reason,''), u.locked_at,
		       COALESCE(o.name,''), u.org_id::text
		  FROM users u LEFT JOIN organizations o ON o.id=u.org_id
		 WHERE u.locked_at IS NOT NULL
		 ORDER BY u.locked_at DESC LIMIT 12`); err == nil {
		defer rows.Close()
		for rows.Next() {
			var id, email, reason, orgName, orgID string
			var lockedAt time.Time
			if rows.Scan(&id, &email, &reason, &lockedAt, &orgName, &orgID) == nil {
				recentLocks = append(recentLocks, map[string]any{
					"id": id, "email": email, "reason": reason,
					"lockedAt": lockedAt.Format(time.RFC3339),
					"orgName":  orgName, "orgId": orgID,
				})
			}
		}
	}
	out["recentLocks"] = recentLocks

	writeJSON(w, 200, out)
}

// UserAnalyticsForID is the per-user drill-down.
//
// GET /v1/admin/users/{id}/analytics?window=30d
func (h *Handler) UserAnalyticsForID(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	id := chi.URLParam(r, "id")
	days, bucket := resolveWindow(r)
	out := map[string]any{
		"window": fmt.Sprintf("%dd", days),
		"bucket": bucket,
	}

	out["activity"] = bucketed(ctx, h.DB, `
		SELECT date_trunc($2, created_at) AS b, COUNT(*)::bigint
		  FROM audit_log
		 WHERE actor_id=$3::uuid
		   AND created_at > now() - ($1 || ' days')::interval
		 GROUP BY b ORDER BY b ASC`, days, bucket, id)

	hourly := make([]int64, 24)
	if rows, err := h.DB.Query(ctx, `
		SELECT EXTRACT(HOUR FROM created_at)::int AS h, COUNT(*)::bigint
		  FROM audit_log
		 WHERE actor_id=$1::uuid
		   AND action LIKE 'auth.%'
		   AND created_at > now() - interval '60 days'
		 GROUP BY h ORDER BY h`, id); err == nil {
		defer rows.Close()
		for rows.Next() {
			var hr int
			var n int64
			if rows.Scan(&hr, &n) == nil && hr >= 0 && hr < 24 {
				hourly[hr] = n
			}
		}
	}
	out["hourlyPattern"] = hourly

	out["sessionStarts"] = bucketed(ctx, h.DB, `
		SELECT date_trunc($2, created_at) AS b, COUNT(*)::bigint
		  FROM user_sessions
		 WHERE user_id=$3::uuid
		   AND created_at > now() - ($1 || ' days')::interval
		 GROUP BY b ORDER BY b ASC`, days, bucket, id)

	var failures int64
	_ = h.DB.QueryRow(ctx, `
		SELECT COUNT(*) FROM audit_log
		 WHERE (actor_id=$1::uuid OR (meta->>'targetUserId')=$1::text)
		   AND action LIKE 'auth.%failed%'
		   AND created_at > now() - interval '30 days'`, id).Scan(&failures)
	out["failedLogins30d"] = failures

	var totalActions, distinctActions int64
	_ = h.DB.QueryRow(ctx, `
		SELECT COUNT(*), COUNT(DISTINCT action)
		  FROM audit_log
		 WHERE actor_id=$1::uuid
		   AND created_at > now() - interval '30 days'`, id).Scan(&totalActions, &distinctActions)
	out["actions30d"] = map[string]int64{
		"total":    totalActions,
		"distinct": distinctActions,
	}

	// Action breakdown — top 12 audit actions this user performed in 30d.
	// Helps answer "what kind of work does this account do?" — useful when
	// triaging "is this person a viewer who suddenly looks like an admin?"
	actionBreakdown := []bucketStr{}
	if rows, err := h.DB.Query(ctx, `
		SELECT action, COUNT(*)::bigint
		  FROM audit_log
		 WHERE actor_id=$1::uuid
		   AND created_at > now() - interval '30 days'
		 GROUP BY action ORDER BY 2 DESC LIMIT 12`, id); err == nil {
		defer rows.Close()
		for rows.Next() {
			var b bucketStr
			if rows.Scan(&b.Label, &b.Value) == nil {
				actionBreakdown = append(actionBreakdown, b)
			}
		}
	}
	out["actionBreakdown"] = actionBreakdown

	// Distinct IPs the user signed in from in the last 60d. A sudden
	// jump in IP diversity is a strong takeover signal.
	ipBreakdown := []bucketStr{}
	if rows, err := h.DB.Query(ctx, `
		SELECT COALESCE(NULLIF(ip,''),'unknown'), COUNT(*)::bigint
		  FROM audit_log
		 WHERE actor_id=$1::uuid
		   AND action LIKE 'auth.%'
		   AND created_at > now() - interval '60 days'
		 GROUP BY 1 ORDER BY 2 DESC LIMIT 10`, id); err == nil {
		defer rows.Close()
		for rows.Next() {
			var b bucketStr
			if rows.Scan(&b.Label, &b.Value) == nil {
				ipBreakdown = append(ipBreakdown, b)
			}
		}
	}
	out["ipBreakdown"] = ipBreakdown

	// Top user-agent fingerprints — short string only (browser-family-ish).
	// Built off audit_log.user_agent to keep the query trivial.
	uaBreakdown := []bucketStr{}
	if rows, err := h.DB.Query(ctx, `
		SELECT COALESCE(
		         NULLIF(SUBSTRING(user_agent FROM '^[^ /]+'), ''),
		         '(unknown)'),
		       COUNT(*)::bigint
		  FROM audit_log
		 WHERE actor_id=$1::uuid
		   AND created_at > now() - interval '60 days'
		 GROUP BY 1 ORDER BY 2 DESC LIMIT 10`, id); err == nil {
		defer rows.Close()
		for rows.Next() {
			var b bucketStr
			if rows.Scan(&b.Label, &b.Value) == nil {
				uaBreakdown = append(uaBreakdown, b)
			}
		}
	}
	out["uaBreakdown"] = uaBreakdown

	// Active sessions snapshot — count + most-recent activity.
	var activeSessions int64
	var lastActiveAt *time.Time
	_ = h.DB.QueryRow(ctx, `
		SELECT COUNT(*)::bigint, MAX(last_active_at)
		  FROM user_sessions
		 WHERE user_id=$1::uuid AND revoked_at IS NULL`,
		id).Scan(&activeSessions, &lastActiveAt)
	snap := map[string]any{"activeSessions": activeSessions}
	if lastActiveAt != nil {
		snap["lastActiveAt"] = lastActiveAt.UTC().Format(time.RFC3339)
	}
	out["sessionSnapshot"] = snap

	writeJSON(w, 200, out)
}

// -- bulk actions --------------------------------------------------------

type bulkIDsReq struct {
	IDs    []string `json:"ids"`
	Reason string   `json:"reason,omitempty"`
}

type bulkResult struct {
	Requested int64 `json:"requested"`
	Affected  int64 `json:"affected"`
}

func decodeBulk(r *http.Request) (bulkIDsReq, error) {
	var req bulkIDsReq
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		return req, err
	}
	clean := req.IDs[:0]
	for _, id := range req.IDs {
		id = strings.TrimSpace(id)
		if id != "" {
			clean = append(clean, id)
		}
	}
	req.IDs = clean
	return req, nil
}

// -- CSV export ----------------------------------------------------------

// quoteCSV escapes a single CSV cell per RFC 4180. We deliberately
// avoid encoding/csv here because the handler is small and we already
// stream row-by-row to the response.
func quoteCSV(s string) string {
	if !strings.ContainsAny(s, ",\"\n\r") {
		return s
	}
	return `"` + strings.ReplaceAll(s, `"`, `""`) + `"`
}

func csvHeader(w http.ResponseWriter, filename string) {
	w.Header().Set("Content-Type", "text/csv; charset=utf-8")
	w.Header().Set("Content-Disposition",
		fmt.Sprintf(`attachment; filename="%s"`, filename))
	w.WriteHeader(200)
}

// writeJSON / writeErr -------------------------------------------------

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
