// Package orgdashboard exposes a single endpoint that aggregates the
// per-org admin landing data — analogous to platformdashboard but
// scoped to the caller's org. Used by /dashboard for org admins so
// they see a one-shot summary instead of fanning out to a dozen
// endpoints.
package orgdashboard

import (
	"encoding/json"
	"net/http"
	"time"

	"github.com/docforge/api/internal/auth"
	"github.com/jackc/pgx/v5/pgxpool"
)

type Handler struct {
	DB *pgxpool.Pool
}

func New(db *pgxpool.Pool) *Handler { return &Handler{DB: db} }

type memberCounts struct {
	Total   int64 `json:"total"`
	Active  int64 `json:"active"`
	Locked  int64 `json:"locked"`
	Pending int64 `json:"pending"`
	Last30d int64 `json:"last30d"`
}

type fileCounts struct {
	Total      int64 `json:"total"`
	Active     int64 `json:"active"`
	Trashed    int64 `json:"trashed"`
	BytesUsed  int64 `json:"bytesUsed"`
	Last30d    int64 `json:"last30d"`
}

type jobCounts struct {
	Completed24h int64 `json:"completed24h"`
	Failed24h    int64 `json:"failed24h"`
	Running      int64 `json:"running"`
	Queued       int64 `json:"queued"`
}

type quotaSummary struct {
	MaxUsers        *int   `json:"maxUsers,omitempty"`
	MaxStorageBytes *int64 `json:"maxStorageBytes,omitempty"`
	UsersUsed       int64  `json:"usersUsed"`
	StorageUsed     int64  `json:"storageUsed"`
}

type subSummary struct {
	PlanName          string  `json:"planName"`
	Tier              string  `json:"tier"`
	Status            string  `json:"status"`
	TrialEndsAt       *string `json:"trialEndsAt,omitempty"`
	CurrentPeriodEnd  *string `json:"currentPeriodEnd,omitempty"`
	CancelAtPeriodEnd bool    `json:"cancelAtPeriodEnd"`
	PastDueSince      *string `json:"pastDueSince,omitempty"`
	Currency          string  `json:"currency"`
	AmountCents       *int64  `json:"amountCents,omitempty"`
	Interval          string  `json:"interval"`
}

type invoiceRow struct {
	ID         string    `json:"id"`
	Number     string    `json:"number"`
	Status     string    `json:"status"`
	Currency   string    `json:"currency"`
	TotalCents int64     `json:"totalCents"`
	IssuedAt   time.Time `json:"issuedAt"`
	HostedURL  *string   `json:"hostedUrl,omitempty"`
}

type memberRow struct {
	ID        string    `json:"id"`
	Email     string    `json:"email"`
	Name      string    `json:"name,omitempty"`
	Role      string    `json:"role"`
	CreatedAt time.Time `json:"createdAt"`
}

type auditRow struct {
	ID         string    `json:"id"`
	Action     string    `json:"action"`
	ActorEmail *string   `json:"actorEmail,omitempty"`
	CreatedAt  time.Time `json:"createdAt"`
}

// Get answers GET /v1/dashboard/admin. Auth middleware has already
// verified a session; the handler enforces role=admin and scopes every
// query to the caller's org.
func (h *Handler) Get(w http.ResponseWriter, r *http.Request) {
	c, _ := r.Context().Value(auth.UserCtxKey).(*auth.Claims)
	if c == nil {
		writeErr(w, 401, "unauthorized", "missing claims")
		return
	}
	if !c.IsAdmin() {
		writeErr(w, 403, "forbidden", "admin role required")
		return
	}

	ctx := r.Context()
	out := map[string]any{}

	// Members: total / active / locked / pending invites / new in 30d.
	// Phase 4: source of truth is org_memberships, joined to users for
	// the lock state. The Last30d filter uses the membership's
	// created_at — i.e. "joined this org in the last 30 days" — which
	// is the right semantic now that a user can be in multiple orgs
	// (otherwise a long-tenured platform user joining a new org would
	// fail the freshness check at their new home).
	var members memberCounts
	_ = h.DB.QueryRow(ctx, `
		SELECT
			COUNT(*),
			COUNT(*) FILTER (WHERE u.locked_at IS NULL),
			COUNT(*) FILTER (WHERE u.locked_at IS NOT NULL),
			COUNT(*) FILTER (WHERE m.created_at > now() - interval '30 days')
		FROM org_memberships m
		JOIN users u ON u.id = m.user_id
		WHERE m.org_id = $1
	`, c.OrgID).Scan(&members.Total, &members.Active, &members.Locked, &members.Last30d)
	_ = h.DB.QueryRow(ctx, `
		SELECT COUNT(*) FROM invitations
		 WHERE org_id=$1 AND accepted_at IS NULL AND revoked_at IS NULL
	`, c.OrgID).Scan(&members.Pending)
	out["members"] = members

	// Files: counts + bytes used + new in 30d.
	var files fileCounts
	_ = h.DB.QueryRow(ctx, `
		SELECT
			COUNT(*),
			COUNT(*) FILTER (WHERE trashed_at IS NULL),
			COUNT(*) FILTER (WHERE trashed_at IS NOT NULL),
			COALESCE(SUM(size) FILTER (WHERE trashed_at IS NULL), 0),
			COUNT(*) FILTER (WHERE created_at > now() - interval '30 days' AND trashed_at IS NULL)
		FROM files WHERE org_id=$1
	`, c.OrgID).Scan(&files.Total, &files.Active, &files.Trashed,
		&files.BytesUsed, &files.Last30d)
	out["files"] = files

	// Templates count (informational chip).
	var templatesTotal int64
	_ = h.DB.QueryRow(ctx,
		`SELECT COUNT(*) FROM templates WHERE org_id=$1`, c.OrgID,
	).Scan(&templatesTotal)
	out["templatesTotal"] = templatesTotal

	// Generation jobs: 24h success/failure + currently in flight.
	var jobs jobCounts
	_ = h.DB.QueryRow(ctx, `SELECT
		SUM(CASE WHEN status='completed' AND finished_at > now() - interval '24 hours' THEN 1 ELSE 0 END),
		SUM(CASE WHEN status='failed'    AND finished_at > now() - interval '24 hours' THEN 1 ELSE 0 END),
		SUM(CASE WHEN status='running'   THEN 1 ELSE 0 END),
		SUM(CASE WHEN status='queued'    THEN 1 ELSE 0 END)
		FROM generation_jobs WHERE org_id=$1`,
		c.OrgID,
	).Scan(&jobs.Completed24h, &jobs.Failed24h, &jobs.Running, &jobs.Queued)
	out["jobs"] = jobs

	// Quotas: per-org override wins over plan default.
	var quota quotaSummary
	_ = h.DB.QueryRow(ctx, `
		SELECT COALESCE(o.max_users, p.max_users),
		       COALESCE(o.max_storage_bytes, p.max_storage_bytes)
		  FROM organizations o
		  LEFT JOIN subscriptions s ON s.org_id = o.id
		    AND s.status IN ('trialing','active','past_due','paused')
		  LEFT JOIN plans p ON p.id = s.plan_id
		 WHERE o.id=$1
		 ORDER BY s.created_at DESC NULLS LAST
		 LIMIT 1`, c.OrgID,
	).Scan(&quota.MaxUsers, &quota.MaxStorageBytes)
	quota.UsersUsed = members.Total
	quota.StorageUsed = files.BytesUsed
	out["quota"] = quota

	// Active subscription summary (nil-safe; first-run orgs may have none).
	var sub subSummary
	var trialEnd, periodEnd, pastDue *time.Time
	err := h.DB.QueryRow(ctx, `
		SELECT p.name, p.tier, s.status, s.trial_ends_at,
		       s.current_period_end, s.cancel_at_period_end,
		       s.past_due_since, s.currency, p.amount_cents, p.interval
		  FROM subscriptions s
		  JOIN plans p ON p.id = s.plan_id
		 WHERE s.org_id=$1
		   AND s.status IN ('trialing','active','past_due','paused')
		 ORDER BY s.created_at DESC LIMIT 1`, c.OrgID,
	).Scan(&sub.PlanName, &sub.Tier, &sub.Status, &trialEnd,
		&periodEnd, &sub.CancelAtPeriodEnd, &pastDue,
		&sub.Currency, &sub.AmountCents, &sub.Interval)
	if err == nil {
		if trialEnd != nil {
			s := trialEnd.Format(time.RFC3339)
			sub.TrialEndsAt = &s
		}
		if periodEnd != nil {
			s := periodEnd.Format(time.RFC3339)
			sub.CurrentPeriodEnd = &s
		}
		if pastDue != nil {
			s := pastDue.Format(time.RFC3339)
			sub.PastDueSince = &s
		}
		out["subscription"] = sub
	} else {
		out["subscription"] = nil
	}

	// Recent invoices (5).
	invoices := []invoiceRow{}
	if rows, err := h.DB.Query(ctx, `
		SELECT id::text, number, status, currency, total_cents,
		       issued_at, hosted_url
		  FROM invoices
		 WHERE org_id=$1
		 ORDER BY issued_at DESC LIMIT 5`, c.OrgID); err == nil {
		defer rows.Close()
		for rows.Next() {
			var iv invoiceRow
			if rows.Scan(&iv.ID, &iv.Number, &iv.Status, &iv.Currency,
				&iv.TotalCents, &iv.IssuedAt, &iv.HostedURL) == nil {
				invoices = append(invoices, iv)
			}
		}
	}
	out["recentInvoices"] = invoices

	// Recent members (8 most recent — useful right after onboarding).
	// Phase 4: ordered by membership creation, not user creation, so
	// admins see "who joined this org most recently" rather than
	// "who signed up to the platform most recently".
	recentMembers := []memberRow{}
	if rows, err := h.DB.Query(ctx, `
		SELECT u.id::text, u.email, COALESCE(u.name,''),
		       COALESCE(m.role,'editor'), m.created_at
		  FROM org_memberships m
		  JOIN users u ON u.id = m.user_id
		 WHERE m.org_id = $1
		 ORDER BY m.created_at DESC LIMIT 8`, c.OrgID); err == nil {
		defer rows.Close()
		for rows.Next() {
			var m memberRow
			if rows.Scan(&m.ID, &m.Email, &m.Name, &m.Role, &m.CreatedAt) == nil {
				recentMembers = append(recentMembers, m)
			}
		}
	}
	out["recentMembers"] = recentMembers

	// Recent audit events for the org (10).
	auditRows := []auditRow{}
	if rows, err := h.DB.Query(ctx, `
		SELECT id::text, action, NULLIF(actor_email,''), created_at
		  FROM audit_log
		 WHERE org_id=$1
		 ORDER BY created_at DESC LIMIT 10`, c.OrgID); err == nil {
		defer rows.Close()
		for rows.Next() {
			var a auditRow
			if rows.Scan(&a.ID, &a.Action, &a.ActorEmail, &a.CreatedAt) == nil {
				auditRows = append(auditRows, a)
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

func writeErr(w http.ResponseWriter, code int, slug, msg string) {
	writeJSON(w, code, map[string]any{
		"error": map[string]any{"code": slug, "message": msg},
	})
}
