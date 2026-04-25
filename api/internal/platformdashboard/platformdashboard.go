// Package platformdashboard exposes a single super-admin endpoint that
// aggregates the headline numbers for the operator console:
//
//   - Org / user / subscription counts
//   - 30-day revenue and last-7-day timeline
//   - Recent signups, recent paid invoices, recent failed payments
//   - Recent platform audit actions
//
// Keeping this in one round-trip avoids fanning out to a dozen endpoints
// on dashboard load. Auth: route is mounted behind requireSuperAdmin, so
// every query is authoritative across all orgs.
package platformdashboard

import (
	"encoding/json"
	"net/http"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
)

type Handler struct {
	DB *pgxpool.Pool
}

func New(db *pgxpool.Pool) *Handler { return &Handler{DB: db} }

type counts struct {
	Total   int64 `json:"total"`
	Active  int64 `json:"active,omitempty"`
	Frozen  int64 `json:"frozen,omitempty"`
	Deleted int64 `json:"deleted,omitempty"`
	Locked  int64 `json:"locked,omitempty"`
	Last30d int64 `json:"last30d,omitempty"`
}

type subCounts struct {
	Trialing int64 `json:"trialing"`
	Active   int64 `json:"active"`
	PastDue  int64 `json:"pastDue"`
	Canceled int64 `json:"canceled"`
	Paused   int64 `json:"paused"`
}

type revPoint struct {
	Day        string `json:"day"`
	TotalCents int64  `json:"totalCents"`
	Count      int64  `json:"count"`
}

type revenue struct {
	Last30dCents int64                 `json:"last30dCents"`
	Last30dCount int64                 `json:"last30dCount"`
	ByCurrency   map[string]int64      `json:"byCurrency"`
	Daily        []revPoint            `json:"daily"`
	Mrr          map[string]int64      `json:"mrr"`
}

type signupRow struct {
	ID        string    `json:"id"`
	Email     string    `json:"email"`
	Name      string    `json:"name,omitempty"`
	OrgID     string    `json:"orgId"`
	OrgName   string    `json:"orgName"`
	CreatedAt time.Time `json:"createdAt"`
}

type invoiceRow struct {
	ID         string     `json:"id"`
	Number     string     `json:"number"`
	Status     string     `json:"status"`
	Provider   string     `json:"provider"`
	Currency   string     `json:"currency"`
	TotalCents int64      `json:"totalCents"`
	OrgID      string     `json:"orgId"`
	OrgName    string     `json:"orgName"`
	IssuedAt   time.Time  `json:"issuedAt"`
	PaidAt     *time.Time `json:"paidAt,omitempty"`
	HostedURL  *string    `json:"hostedUrl,omitempty"`
}

type auditRow struct {
	ID         string    `json:"id"`
	Action     string    `json:"action"`
	ActorEmail *string   `json:"actorEmail,omitempty"`
	OrgID      *string   `json:"orgId,omitempty"`
	OrgName    *string   `json:"orgName,omitempty"`
	CreatedAt  time.Time `json:"createdAt"`
}

// Get answers GET /v1/admin/dashboard. The middleware already verified
// super-admin role, so every query runs unscoped.
func (h *Handler) Get(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()

	out := map[string]any{}

	// Orgs counts: total / active / frozen / soft-deleted / created in
	// the last 30 days. Derived in a single COUNT FILTER pass.
	var orgs counts
	_ = h.DB.QueryRow(ctx, `
		SELECT
			COUNT(*) FILTER (WHERE deleted_at IS NULL),
			COUNT(*) FILTER (WHERE deleted_at IS NULL AND frozen_at IS NULL),
			COUNT(*) FILTER (WHERE frozen_at IS NOT NULL AND deleted_at IS NULL),
			COUNT(*) FILTER (WHERE deleted_at IS NOT NULL),
			COUNT(*) FILTER (WHERE created_at > now() - interval '30 days' AND deleted_at IS NULL)
		FROM organizations
	`).Scan(&orgs.Total, &orgs.Active, &orgs.Frozen, &orgs.Deleted, &orgs.Last30d)
	out["orgs"] = orgs

	// User counts: total / locked / created in the last 30 days.
	var users counts
	_ = h.DB.QueryRow(ctx, `
		SELECT
			COUNT(*),
			COUNT(*) FILTER (WHERE locked_at IS NOT NULL),
			COUNT(*) FILTER (WHERE created_at > now() - interval '30 days')
		FROM users
	`).Scan(&users.Total, &users.Locked, &users.Last30d)
	users.Active = users.Total - users.Locked
	out["users"] = users

	// Subscription state breakdown — only meaningful while subscriptions
	// table is non-empty, but the COUNT(...) FILTER calls handle that
	// cleanly with zeros.
	var subs subCounts
	_ = h.DB.QueryRow(ctx, `
		SELECT
			COUNT(*) FILTER (WHERE status='trialing'),
			COUNT(*) FILTER (WHERE status='active'),
			COUNT(*) FILTER (WHERE status='past_due'),
			COUNT(*) FILTER (WHERE status='canceled'),
			COUNT(*) FILTER (WHERE status='paused')
		FROM subscriptions
	`).Scan(&subs.Trialing, &subs.Active, &subs.PastDue, &subs.Canceled, &subs.Paused)
	out["subscriptions"] = subs

	// Revenue last 30 days: total + per-currency totals. Only "paid"
	// invoices are counted; status='void' / 'open' are ignored.
	rev := revenue{
		ByCurrency: map[string]int64{},
		Mrr:        map[string]int64{},
		Daily:      []revPoint{},
	}
	_ = h.DB.QueryRow(ctx, `
		SELECT COALESCE(SUM(total_cents),0), COUNT(*)
		  FROM invoices
		 WHERE status='paid'
		   AND issued_at > now() - interval '30 days'
	`).Scan(&rev.Last30dCents, &rev.Last30dCount)
	if rows, err := h.DB.Query(ctx, `
		SELECT currency, SUM(total_cents)
		  FROM invoices
		 WHERE status='paid'
		   AND issued_at > now() - interval '30 days'
		 GROUP BY currency`); err == nil {
		defer rows.Close()
		for rows.Next() {
			var c string
			var n int64
			if rows.Scan(&c, &n) == nil {
				rev.ByCurrency[c] = n
			}
		}
	}
	// Daily revenue, last 7 days. Used for the inline sparkline.
	if rows, err := h.DB.Query(ctx, `
		SELECT to_char(date_trunc('day', issued_at), 'YYYY-MM-DD') AS day,
		       COALESCE(SUM(total_cents),0),
		       COUNT(*)
		  FROM invoices
		 WHERE status='paid'
		   AND issued_at > now() - interval '7 days'
		 GROUP BY day
		 ORDER BY day ASC`); err == nil {
		defer rows.Close()
		for rows.Next() {
			var p revPoint
			if rows.Scan(&p.Day, &p.TotalCents, &p.Count) == nil {
				rev.Daily = append(rev.Daily, p)
			}
		}
	}
	// MRR proxy: sum of plan amount for currently-active monthly subs.
	// Yearly subs would inflate it 12x if we summed naively, so we
	// rebase yearly to monthly by dividing by 12. Currency-bucketed.
	if rows, err := h.DB.Query(ctx, `
		SELECT s.currency,
		       SUM(CASE WHEN p.interval='year'
		                THEN p.amount_cents / 12
		                ELSE p.amount_cents END)
		  FROM subscriptions s
		  JOIN plans p ON p.id = s.plan_id
		 WHERE s.status IN ('active','trialing','past_due')
		   AND p.amount_cents IS NOT NULL
		 GROUP BY s.currency`); err == nil {
		defer rows.Close()
		for rows.Next() {
			var c string
			var n int64
			if rows.Scan(&c, &n) == nil {
				rev.Mrr[c] = n
			}
		}
	}
	out["revenue"] = rev

	// Recent signups — last 5 users.
	signups := []signupRow{}
	if rows, err := h.DB.Query(ctx, `
		SELECT u.id::text, u.email, COALESCE(u.name,''),
		       u.org_id::text, COALESCE(o.name,''), u.created_at
		  FROM users u
		  LEFT JOIN organizations o ON o.id = u.org_id
		 ORDER BY u.created_at DESC
		 LIMIT 8`); err == nil {
		defer rows.Close()
		for rows.Next() {
			var s signupRow
			if rows.Scan(&s.ID, &s.Email, &s.Name, &s.OrgID, &s.OrgName, &s.CreatedAt) == nil {
				signups = append(signups, s)
			}
		}
	}
	out["recentSignups"] = signups

	// Recent paid invoices.
	paid := []invoiceRow{}
	if rows, err := h.DB.Query(ctx, `
		SELECT i.id::text, i.number, i.status, i.provider, i.currency,
		       i.total_cents, i.org_id::text, COALESCE(o.name,''),
		       i.issued_at, i.paid_at, i.hosted_url
		  FROM invoices i
		  LEFT JOIN organizations o ON o.id = i.org_id
		 WHERE i.status='paid'
		 ORDER BY i.issued_at DESC
		 LIMIT 8`); err == nil {
		defer rows.Close()
		for rows.Next() {
			var iv invoiceRow
			if rows.Scan(&iv.ID, &iv.Number, &iv.Status, &iv.Provider,
				&iv.Currency, &iv.TotalCents, &iv.OrgID, &iv.OrgName,
				&iv.IssuedAt, &iv.PaidAt, &iv.HostedURL) == nil {
				paid = append(paid, iv)
			}
		}
	}
	out["recentInvoices"] = paid

	// Failed / open invoices that need operator attention.
	failed := []invoiceRow{}
	if rows, err := h.DB.Query(ctx, `
		SELECT i.id::text, i.number, i.status, i.provider, i.currency,
		       i.total_cents, i.org_id::text, COALESCE(o.name,''),
		       i.issued_at, i.paid_at, i.hosted_url
		  FROM invoices i
		  LEFT JOIN organizations o ON o.id = i.org_id
		 WHERE i.status IN ('open','uncollectible')
		 ORDER BY i.issued_at DESC
		 LIMIT 8`); err == nil {
		defer rows.Close()
		for rows.Next() {
			var iv invoiceRow
			if rows.Scan(&iv.ID, &iv.Number, &iv.Status, &iv.Provider,
				&iv.Currency, &iv.TotalCents, &iv.OrgID, &iv.OrgName,
				&iv.IssuedAt, &iv.PaidAt, &iv.HostedURL) == nil {
				failed = append(failed, iv)
			}
		}
	}
	out["failedInvoices"] = failed

	// Recent audit events (cross-org).
	auditRows := []auditRow{}
	if rows, err := h.DB.Query(ctx, `
		SELECT a.id::text, a.action,
		       NULLIF(a.actor_email,''), a.org_id::text, o.name,
		       a.created_at
		  FROM audit_log a
		  LEFT JOIN organizations o ON o.id = a.org_id
		 ORDER BY a.created_at DESC
		 LIMIT 10`); err == nil {
		defer rows.Close()
		for rows.Next() {
			var ar auditRow
			if rows.Scan(&ar.ID, &ar.Action, &ar.ActorEmail,
				&ar.OrgID, &ar.OrgName, &ar.CreatedAt) == nil {
				auditRows = append(auditRows, ar)
			}
		}
	}
	out["recentAudit"] = auditRows

	writeJSON(w, 200, out)
}

func writeJSON(w http.ResponseWriter, code int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(code)
	_ = json.NewEncoder(w).Encode(v)
}
