// Package billing implements the subscription module — Phase 4a.
//
// This phase ships:
//   - read-only plan catalog (`GET /v1/billing/plans`) with currency
//     auto-detection (Accept-Language → INR/USD; ?currency= override)
//   - read-only subscription state for the caller's org
//     (`GET /v1/billing/subscription`)
//   - read-only invoice list (`GET /v1/billing/invoices`)
//   - super-admin "manual provider" assignment that swaps an org onto
//     a different plan and writes an invoice row
//     (`POST /v1/admin/orgs/{id}/subscription`)
//   - signup hook that auto-provisions a 14-day Pro trial (StartTrial)
//   - LoadOrgLimits — the helper enforcement code calls when it needs
//     to know "how many users / how much storage can this org use?".
//     Per-org overrides on `organizations.{max_users,max_storage_bytes}`
//     win over the plan default; nil = unlimited.
//
// Razorpay / Stripe live providers come in Phase 4b. The interface
// below (`Provider`) is set up so wiring them in won't require touching
// the handlers.
package billing

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"strings"
	"time"

	"github.com/docforge/api/internal/audit"
	"github.com/docforge/api/internal/auth"
	"github.com/go-chi/chi/v5"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"
)

const (
	StatusTrialing = "trialing"
	StatusActive   = "active"
	StatusPastDue  = "past_due"
	StatusCanceled = "canceled"
	StatusPaused   = "paused"

	ProviderManual   = "manual"
	ProviderRazorpay = "razorpay"
	ProviderStripe   = "stripe"

	// Pro trial defaults. Change here if marketing wants a different
	// length — every signup goes through StartTrial.
	TrialPlanID = "pro_inr_monthly"
	TrialDays   = 14
)

type Handler struct {
	DB      *pgxpool.Pool
	drivers Drivers
	Mailer  MailerSender
}

func New(db *pgxpool.Pool) *Handler { return &Handler{DB: db} }

// AttachMailer wires the email sender used for trial-ending,
// payment-failed, and cancellation notifications. Optional — nil
// just disables notification mails.
func (h *Handler) AttachMailer(m MailerSender) { h.Mailer = m }

// -- catalog -------------------------------------------------------------

type planRow struct {
	ID              string         `json:"id"`
	Name            string         `json:"name"`
	Tier            string         `json:"tier"`
	Currency        string         `json:"currency"`
	Interval        string         `json:"interval"`
	AmountCents     *int64         `json:"amountCents,omitempty"`
	MaxUsers        *int           `json:"maxUsers,omitempty"`
	MaxStorageBytes *int64         `json:"maxStorageBytes,omitempty"`
	Features        map[string]any `json:"features"`
	SortOrder       int            `json:"sortOrder"`
}

// ListPlans returns the active plan catalog filtered to the caller's
// preferred currency (the request's resolved currency, or anything
// "neutral" — free / enterprise rows have no currency-specific price).
//
// `?currency=INR|USD` is an explicit override; otherwise we infer from
// Accept-Language (`en-IN` → INR, anything else → USD).
func (h *Handler) ListPlans(w http.ResponseWriter, r *http.Request) {
	cur := DetectCurrency(r)
	rows, err := h.DB.Query(r.Context(), `
		SELECT id, name, tier, currency, interval, amount_cents,
		       max_users, max_storage_bytes, features, sort_order
		  FROM plans
		 WHERE active = true
		 ORDER BY sort_order, id`)
	if err != nil {
		writeErr(w, 500, "db_error", err.Error())
		return
	}
	defer rows.Close()

	out := []planRow{}
	for rows.Next() {
		var (
			p           planRow
			featuresRaw []byte
		)
		if err := rows.Scan(&p.ID, &p.Name, &p.Tier, &p.Currency, &p.Interval,
			&p.AmountCents, &p.MaxUsers, &p.MaxStorageBytes,
			&featuresRaw, &p.SortOrder); err != nil {
			continue
		}
		// Hide the "other currency" Pro rows so the storefront only shows
		// the relevant pair. Free / enterprise rows are currency-neutral
		// (their price is 0 or null) — keep them regardless.
		if p.Tier == "pro" && !strings.EqualFold(p.Currency, cur) {
			continue
		}
		_ = json.Unmarshal(featuresRaw, &p.Features)
		out = append(out, p)
	}
	writeJSON(w, 200, map[string]any{
		"plans":    out,
		"currency": cur,
	})
}

// -- caller's subscription ----------------------------------------------

type subSummary struct {
	ID                 string  `json:"id"`
	Status             string  `json:"status"`
	Provider           string  `json:"provider"`
	PlanID             string  `json:"planId"`
	PlanName           string  `json:"planName"`
	Tier               string  `json:"tier"`
	Currency           string  `json:"currency"`
	Interval           string  `json:"interval"`
	AmountCents        *int64  `json:"amountCents,omitempty"`
	TrialEndsAt        *string `json:"trialEndsAt,omitempty"`
	CurrentPeriodEnd   *string `json:"currentPeriodEnd,omitempty"`
	CancelAtPeriodEnd  bool    `json:"cancelAtPeriodEnd"`
	CanceledAt         *string `json:"canceledAt,omitempty"`
	PastDueSince       *string `json:"pastDueSince,omitempty"`
	CouponCode         *string `json:"couponCode,omitempty"`
	UpdatedAt          string  `json:"updatedAt"`
}

func (h *Handler) Subscription(w http.ResponseWriter, r *http.Request) {
	c, _ := r.Context().Value(auth.UserCtxKey).(*auth.Claims)
	if c == nil {
		writeErr(w, 401, "unauthorized", "missing claims")
		return
	}
	sub, err := loadActiveSubscription(r.Context(), h.DB, c.OrgID)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			// No active sub. The frontend's billing page uses this to
			// decide whether to show the plan picker / paywall — so we
			// also tell it whether the trial slot is already burnt
			// (one-time rule) or whether StartTrial would still grant
			// one (e.g. an org created out-of-band by an admin).
			trialUsed, _ := orgHasAnySubscription(r.Context(), h.DB, c.OrgID)
			writeJSON(w, 200, map[string]any{
				"status":           "none",
				"requiresUpgrade":  true,
				"trialUsed":        trialUsed,
				"hint":             "Choose a plan on /settings/billing to continue.",
			})
			return
		}
		writeErr(w, 500, "db_error", err.Error())
		return
	}
	writeJSON(w, 200, sub)
}

// orgHasAnySubscription reports whether the org has any subscription
// row at all (active, canceled, anything). Used by the billing UI to
// decide between "Start your 14-day trial" and "Trial used — pick a
// plan", since StartTrial is one-time.
func orgHasAnySubscription(ctx context.Context, db *pgxpool.Pool, orgID string) (bool, error) {
	var n int
	err := db.QueryRow(ctx,
		`SELECT 1 FROM subscriptions WHERE org_id=$1 LIMIT 1`, orgID,
	).Scan(&n)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return false, nil
		}
		return false, err
	}
	return true, nil
}

// -- invoices -----------------------------------------------------------

type invoiceRow struct {
	ID          string  `json:"id"`
	Number      string  `json:"number"`
	Status      string  `json:"status"`
	Provider    string  `json:"provider"`
	Currency    string  `json:"currency"`
	TotalCents  int64   `json:"totalCents"`
	IssuedAt    string  `json:"issuedAt"`
	PaidAt      *string `json:"paidAt,omitempty"`
	HostedURL   *string `json:"hostedUrl,omitempty"`
	PDFURL      *string `json:"pdfUrl,omitempty"`
}

func (h *Handler) ListInvoices(w http.ResponseWriter, r *http.Request) {
	c, _ := r.Context().Value(auth.UserCtxKey).(*auth.Claims)
	if c == nil {
		writeErr(w, 401, "unauthorized", "missing claims")
		return
	}
	rows, err := h.DB.Query(r.Context(), `
		SELECT id, number, status, provider, currency, total_cents,
		       issued_at, paid_at, hosted_url, pdf_url
		  FROM invoices
		 WHERE org_id = $1
		 ORDER BY issued_at DESC
		 LIMIT 100`, c.OrgID)
	if err != nil {
		writeErr(w, 500, "db_error", err.Error())
		return
	}
	defer rows.Close()
	out := []invoiceRow{}
	for rows.Next() {
		var (
			i        invoiceRow
			issuedAt time.Time
			paidAt   *time.Time
		)
		if err := rows.Scan(&i.ID, &i.Number, &i.Status, &i.Provider,
			&i.Currency, &i.TotalCents, &issuedAt, &paidAt,
			&i.HostedURL, &i.PDFURL); err != nil {
			continue
		}
		i.IssuedAt = issuedAt.Format(time.RFC3339)
		if paidAt != nil {
			s := paidAt.Format(time.RFC3339)
			i.PaidAt = &s
		}
		out = append(out, i)
	}
	writeJSON(w, 200, map[string]any{"invoices": out})
}

// -- super-admin manual assignment --------------------------------------

type assignReq struct {
	PlanID  string `json:"planId"`
	Status  string `json:"status,omitempty"`  // optional override; defaults to "active"
	Note    string `json:"note,omitempty"`    // shown on the generated invoice
	NoCharge bool  `json:"noCharge,omitempty"` // skip writing an invoice row (e.g. comp / move)
}

// AdminAssign swaps the target org onto the requested plan via the
// "manual" provider. Used by support to comp a pro plan, move an org to
// enterprise, or undo a billing-system snafu.
//
// Behaviour:
//   - any existing active subscription is canceled (status='canceled',
//     canceled_at=now()) so the partial-unique index lets the new row in
//   - a new subscription row is inserted with provider='manual'
//   - unless NoCharge is set, a paid invoice is recorded for the audit
//     trail and the org's /settings/billing display
//   - super_admin.subscription_assigned audit row is written
func (h *Handler) AdminAssign(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "id")
	var req assignReq
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeErr(w, 400, "invalid_body", err.Error())
		return
	}
	req.PlanID = strings.TrimSpace(req.PlanID)
	if req.PlanID == "" {
		writeErr(w, 400, "missing_plan", "planId is required")
		return
	}
	status := strings.TrimSpace(req.Status)
	if status == "" {
		status = StatusActive
	}
	if !validAssignStatus(status) {
		writeErr(w, 400, "invalid_status",
			"status must be one of trialing, active, past_due, paused")
		return
	}

	// Resolve plan up front so we can fail fast and capture price for
	// the invoice row.
	var plan struct {
		Name        string
		Tier        string
		Currency    string
		Interval    string
		AmountCents *int64
	}
	err := h.DB.QueryRow(r.Context(),
		`SELECT name, tier, currency, interval, amount_cents
		   FROM plans WHERE id=$1 AND active=true`, req.PlanID,
	).Scan(&plan.Name, &plan.Tier, &plan.Currency, &plan.Interval, &plan.AmountCents)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			writeErr(w, 404, "plan_not_found", "plan not found or inactive")
			return
		}
		writeErr(w, 500, "db_error", err.Error())
		return
	}

	tx, err := h.DB.Begin(r.Context())
	if err != nil {
		writeErr(w, 500, "db_error", err.Error())
		return
	}
	defer tx.Rollback(r.Context())

	// Cancel any in-flight subscription for this org. We touch only the
	// statuses covered by the partial unique index — anything already
	// canceled stays put so historical rows keep their original timing.
	if _, err := tx.Exec(r.Context(), `
		UPDATE subscriptions
		   SET status='canceled', canceled_at=now(), updated_at=now()
		 WHERE org_id=$1
		   AND status IN ('trialing','active','past_due','paused')`, id,
	); err != nil {
		writeErr(w, 500, "db_error", err.Error())
		return
	}

	// Period end heuristic: 30 days for monthly, 365 for yearly, NULL
	// otherwise (free / enterprise are evergreen until manually changed).
	var periodEnd *time.Time
	now := time.Now()
	switch plan.Interval {
	case "month":
		t := now.AddDate(0, 1, 0)
		periodEnd = &t
	case "year":
		t := now.AddDate(1, 0, 0)
		periodEnd = &t
	}

	var trialEndsAt *time.Time
	if status == StatusTrialing {
		t := now.AddDate(0, 0, TrialDays)
		trialEndsAt = &t
	}

	var subID string
	if err := tx.QueryRow(r.Context(), `
		INSERT INTO subscriptions
		  (org_id, plan_id, status, provider, currency,
		   trial_ends_at, current_period_start, current_period_end)
		VALUES ($1, $2, $3, 'manual', $4, $5, $6, $7)
		RETURNING id`,
		id, req.PlanID, status, plan.Currency,
		trialEndsAt, now, periodEnd,
	).Scan(&subID); err != nil {
		writeErr(w, 500, "db_error", err.Error())
		return
	}

	// Optional invoice row for visibility. Skipped when NoCharge or when
	// the plan has no fixed price (free / enterprise).
	if !req.NoCharge && plan.AmountCents != nil && *plan.AmountCents > 0 {
		number := fmt.Sprintf("MAN-%s", now.Format("20060102-150405"))
		note := strings.TrimSpace(req.Note)
		if note == "" {
			note = plan.Name + " — manual assignment"
		}
		if _, err := tx.Exec(r.Context(), `
			INSERT INTO invoices
			  (org_id, subscription_id, provider, number, status, currency,
			   amount_cents, total_cents, period_start, period_end, paid_at)
			VALUES ($1,$2,'manual',$3,'paid',$4,$5,$5,$6,$7,now())`,
			id, subID, number, plan.Currency,
			*plan.AmountCents, now, periodEnd,
		); err != nil {
			writeErr(w, 500, "db_error", err.Error())
			return
		}
	}

	if err := tx.Commit(r.Context()); err != nil {
		writeErr(w, 500, "db_error", err.Error())
		return
	}

	audit.LogHTTP(r, h.DB, "super_admin.subscription_assigned", "org", id,
		map[string]any{
			"planId":   req.PlanID,
			"status":   status,
			"noCharge": req.NoCharge,
		})
	writeJSON(w, 200, map[string]any{"ok": true, "subscriptionId": subID})
}

// AdminGet returns the org's current subscription + invoice history,
// for the super-admin org-detail "Billing" tab.
func (h *Handler) AdminGet(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "id")
	sub, err := loadActiveSubscription(r.Context(), h.DB, id)
	if err != nil && !errors.Is(err, pgx.ErrNoRows) {
		writeErr(w, 500, "db_error", err.Error())
		return
	}
	rows, err := h.DB.Query(r.Context(), `
		SELECT id, number, status, provider, currency, total_cents,
		       issued_at, paid_at, hosted_url, pdf_url
		  FROM invoices
		 WHERE org_id = $1
		 ORDER BY issued_at DESC
		 LIMIT 50`, id)
	if err != nil {
		writeErr(w, 500, "db_error", err.Error())
		return
	}
	defer rows.Close()
	invoices := []invoiceRow{}
	for rows.Next() {
		var (
			i        invoiceRow
			issuedAt time.Time
			paidAt   *time.Time
		)
		if err := rows.Scan(&i.ID, &i.Number, &i.Status, &i.Provider,
			&i.Currency, &i.TotalCents, &issuedAt, &paidAt,
			&i.HostedURL, &i.PDFURL); err != nil {
			continue
		}
		i.IssuedAt = issuedAt.Format(time.RFC3339)
		if paidAt != nil {
			s := paidAt.Format(time.RFC3339)
			i.PaidAt = &s
		}
		invoices = append(invoices, i)
	}
	writeJSON(w, 200, map[string]any{
		"subscription": sub,
		"invoices":     invoices,
	})
}

func validAssignStatus(s string) bool {
	switch s {
	case StatusTrialing, StatusActive, StatusPastDue, StatusPaused:
		return true
	}
	return false
}

// -- helpers (used by other packages) -----------------------------------

// StartTrial provisions a 14-day Pro trial subscription for a fresh org.
// Called from the registration handler in package auth — that flow runs
// inside its own DB transaction, so we accept a queryer interface that
// either *pgxpool.Pool or pgx.Tx satisfies.
//
// One-time only. The trial is granted exactly once per org — if the
// org has ANY prior subscription row (active, canceled, expired,
// anything) we skip the insert. This keeps the rule honest:
//
//   - signup retries / double-fires are still safe (no duplicate row)
//   - users can't game the trial by canceling and re-signing up the
//     same org
//   - super-admin can still grant a comp plan via /admin/orgs/{id}/subscription
//     because that path uses AdminAssign, not StartTrial
//
// After the trial ends without a payment, RunDunning cancels the row
// and does NOT auto-provision a replacement. The org becomes
// "trial expired, no active subscription" — LoadOrgLimits flags it as
// RequiresUpgrade and the enforcement helpers return
// subscription_required (402). The admin must pick a paid plan from
// /settings/billing to unblock writes.
func StartTrial(ctx context.Context, q DBQueryer, orgID string) error {
	if orgID == "" {
		return nil
	}
	var existing string
	err := q.QueryRow(ctx,
		`SELECT id FROM subscriptions WHERE org_id=$1 LIMIT 1`, orgID,
	).Scan(&existing)
	if err == nil {
		return nil // org has been billed before — no fresh trial
	}
	if !errors.Is(err, pgx.ErrNoRows) {
		return err
	}
	now := time.Now()
	trialEnd := now.AddDate(0, 0, TrialDays)
	periodEnd := now.AddDate(0, 1, 0)
	_, err = q.Exec(ctx, `
		INSERT INTO subscriptions
		  (org_id, plan_id, status, provider, currency,
		   trial_ends_at, current_period_start, current_period_end)
		VALUES ($1, $2, 'trialing', 'manual', 'INR', $3, $4, $5)`,
		orgID, TrialPlanID, trialEnd, now, periodEnd,
	)
	return err
}

// DBQueryer is the slim pgx interface StartTrial needs — pool or tx
// both satisfy it.
type DBQueryer interface {
	Exec(ctx context.Context, sql string, args ...any) (pgconn.CommandTag, error)
	QueryRow(ctx context.Context, sql string, args ...any) pgx.Row
}

// Limits is the resolved enforcement ceiling for a given org.
//
// RequiresUpgrade is the gate signal for the trial-expired-no-payment
// state: the org used its one-time trial, the trial ended, and no paid
// subscription took its place. Enforcement helpers translate this flag
// into a 402 `subscription_required` LimitError on every write path
// (uploads, invites, feature gates) — reads stay open so the admin can
// still see existing data and reach /settings/billing.
type Limits struct {
	Tier            string
	PlanID          string
	Status          string
	MaxUsers        *int   // nil = unlimited
	MaxStorageBytes *int64 // nil = unlimited
	Features        map[string]any
	RequiresUpgrade bool   // true when trial used + no active sub
}

// LoadOrgLimits returns the effective ceilings for an org by combining
// its active subscription with its per-org override columns. Per-org
// values win — set on `organizations` by super-admin via SetQuotas.
//
// State machine the helper resolves:
//
//   - Active subscription (trialing/active/past_due/paused, and a
//     trial row whose `trial_ends_at` is still in the future) →
//     plan-level limits and features. RequiresUpgrade=false.
//
//   - Trial expired (status='trialing' but trial_ends_at has passed)
//     OR no active row but the org has prior history → RequiresUpgrade
//     is set, all writes get gated behind subscription_required. The
//     dunning sweep cancels the trial row separately; this branch is
//     the safety net for the up-to-1-hour gap before the cron runs.
//
//   - Org row missing (deep data-integrity bug) → bubbles the error;
//     callers fall back to the conservative seed (free tier, no
//     unlimited surprises).
//
// All scan targets are nullable so a canceled-only org doesn't fail
// the row scan and silently fall through to the legacy "everything
// nil = unlimited" bug.
func LoadOrgLimits(ctx context.Context, q DBQueryer, orgID string) (Limits, error) {
	out := Limits{Tier: "free", PlanID: "free", Status: StatusActive,
		Features: map[string]any{}}
	var (
		planID, status, tier *string
		planMaxUsers         *int
		planMaxStorage       *int64
		featuresRaw          []byte
		orgMaxUsers          *int
		orgMaxStorage        *int64
		trialEndsAt          *time.Time
	)
	err := q.QueryRow(ctx, `
		SELECT s.plan_id, s.status, p.tier, p.max_users, p.max_storage_bytes,
		       p.features, o.max_users, o.max_storage_bytes, s.trial_ends_at
		  FROM organizations o
		  LEFT JOIN subscriptions s ON s.org_id = o.id
		       AND s.status IN ('trialing','active','past_due','paused')
		  LEFT JOIN plans p ON p.id = s.plan_id
		 WHERE o.id = $1
		 ORDER BY s.created_at DESC
		 LIMIT 1`, orgID,
	).Scan(&planID, &status, &tier, &planMaxUsers, &planMaxStorage,
		&featuresRaw, &orgMaxUsers, &orgMaxStorage, &trialEndsAt)
	if err != nil {
		return out, err
	}

	expiredTrial := status != nil && *status == StatusTrialing &&
		trialEndsAt != nil && trialEndsAt.Before(time.Now())
	haveActiveSub := planID != nil && !expiredTrial

	if haveActiveSub {
		out.PlanID = *planID
		if status != nil {
			out.Status = *status
		}
		if tier != nil {
			out.Tier = *tier
		}
		if len(featuresRaw) > 0 {
			_ = json.Unmarshal(featuresRaw, &out.Features)
		}
		out.MaxUsers = planMaxUsers
		out.MaxStorageBytes = planMaxStorage
	} else {
		// Trial used up or otherwise no active sub. Mark for upgrade —
		// the enforcement helpers turn this into a 402 with hint
		// pointing the admin at /settings/billing.
		out.RequiresUpgrade = true
		out.Status = "trial_expired"
		// Set zeroed ceilings as a defense-in-depth: even if an
		// enforcement helper forgets to check RequiresUpgrade, the
		// quota check still bites.
		zeroUsers := 0
		zeroStorage := int64(0)
		out.MaxUsers = &zeroUsers
		out.MaxStorageBytes = &zeroStorage
	}

	// Per-org overrides win when present, regardless of plan source.
	// Super-admin can use these to comp a specific org out of the
	// upgrade gate without touching the subscriptions table — set
	// max_users / max_storage_bytes generously and clear any sub. But
	// note: overrides only relax quota numbers, they don't clear the
	// RequiresUpgrade flag. To re-enable an expired-trial org cleanly
	// the right path is AdminAssign (a real comp subscription row).
	if orgMaxUsers != nil {
		out.MaxUsers = orgMaxUsers
	}
	if orgMaxStorage != nil {
		out.MaxStorageBytes = orgMaxStorage
	}
	return out, nil
}

// -- internal -----------------------------------------------------------

func loadActiveSubscription(ctx context.Context, db *pgxpool.Pool, orgID string) (*subSummary, error) {
	var (
		s                                            subSummary
		amount                                       *int64
		trialEnd, periodEnd, canceled, pastDueSince  *time.Time
		updatedAt                                    time.Time
		couponCode                                   *string
	)
	err := db.QueryRow(ctx, `
		SELECT s.id, s.status, s.provider, s.plan_id,
		       p.name, p.tier, s.currency, p.interval, p.amount_cents,
		       s.trial_ends_at, s.current_period_end, s.cancel_at_period_end,
		       s.canceled_at, s.past_due_since, s.coupon_code, s.updated_at
		  FROM subscriptions s
		  JOIN plans p ON p.id = s.plan_id
		 WHERE s.org_id=$1
		   AND s.status IN ('trialing','active','past_due','paused')
		 ORDER BY s.created_at DESC
		 LIMIT 1`, orgID,
	).Scan(&s.ID, &s.Status, &s.Provider, &s.PlanID,
		&s.PlanName, &s.Tier, &s.Currency, &s.Interval, &amount,
		&trialEnd, &periodEnd, &s.CancelAtPeriodEnd, &canceled,
		&pastDueSince, &couponCode, &updatedAt)
	if err != nil {
		return nil, err
	}
	s.AmountCents = amount
	s.UpdatedAt = updatedAt.Format(time.RFC3339)
	if trialEnd != nil {
		t := trialEnd.Format(time.RFC3339)
		s.TrialEndsAt = &t
	}
	if periodEnd != nil {
		t := periodEnd.Format(time.RFC3339)
		s.CurrentPeriodEnd = &t
	}
	if canceled != nil {
		t := canceled.Format(time.RFC3339)
		s.CanceledAt = &t
	}
	if pastDueSince != nil {
		t := pastDueSince.Format(time.RFC3339)
		s.PastDueSince = &t
	}
	s.CouponCode = couponCode
	return &s, nil
}

// DetectCurrency picks INR vs USD for the request:
//
//  1. `?currency=INR|USD` query param wins (lets a user manually toggle)
//  2. `Accept-Language` containing `-IN` → INR
//  3. otherwise USD
//
// We deliberately keep this simple — no MaxMind / GeoIP dependency in
// Phase 4a. Phase 4b will plug a real lookup behind the same function.
func DetectCurrency(r *http.Request) string {
	if v := strings.ToUpper(strings.TrimSpace(r.URL.Query().Get("currency"))); v != "" {
		if v == "INR" || v == "USD" {
			return v
		}
	}
	al := strings.ToLower(r.Header.Get("Accept-Language"))
	if strings.Contains(al, "-in") || strings.HasPrefix(al, "hi") ||
		strings.Contains(al, "ta-") || strings.Contains(al, "te-") ||
		strings.Contains(al, "kn-") || strings.Contains(al, "ml-") {
		return "INR"
	}
	return "USD"
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
