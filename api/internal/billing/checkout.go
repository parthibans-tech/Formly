package billing

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"strings"

	"github.com/docforge/api/internal/audit"
	"github.com/docforge/api/internal/auth"
	"github.com/jackc/pgx/v5"
)

// Drivers holds the set of live providers wired in main.go. The handler
// dispatches on plan currency (INR → razorpay, else → stripe). Either
// driver may be nil/unconfigured; we surface that as a 501 with a
// clear error code so the frontend can display "configure billing
// provider" rather than a generic crash.
type Drivers struct {
	Razorpay Provider
	Stripe   Provider
}

// AttachDrivers stores the driver registry on the handler so checkout
// / cancel / webhook routes can resolve a provider per request.
func (h *Handler) AttachDrivers(d Drivers) { h.drivers = d }

// -- checkout -----------------------------------------------------------

type checkoutReq struct {
	PlanID     string `json:"planId"`
	SuccessURL string `json:"successUrl,omitempty"`
	CancelURL  string `json:"cancelUrl,omitempty"`
	CouponCode string `json:"couponCode,omitempty"`
}

func (h *Handler) Checkout(w http.ResponseWriter, r *http.Request) {
	c, _ := r.Context().Value(auth.UserCtxKey).(*auth.Claims)
	if c == nil {
		writeErr(w, 401, "unauthorized", "missing claims")
		return
	}
	if c.Role != auth.RoleAdmin {
		writeErr(w, 403, "forbidden", "only org admins can change billing")
		return
	}
	var req checkoutReq
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeErr(w, 400, "invalid_body", err.Error())
		return
	}
	req.PlanID = strings.TrimSpace(req.PlanID)
	if req.PlanID == "" {
		writeErr(w, 400, "missing_plan", "planId is required")
		return
	}

	// Resolve the org name + user email for hosted-checkout pages.
	var (
		orgName, userEmail, userName string
		planCurrency, planTier       string
	)
	if err := h.DB.QueryRow(r.Context(), `
		SELECT o.name,
		       COALESCE(u.email,''),
		       COALESCE(u.name,''),
		       p.currency,
		       p.tier
		  FROM organizations o
		  LEFT JOIN users u ON u.id = $2::uuid
		  LEFT JOIN plans  p ON p.id = $3
		 WHERE o.id = $1::uuid`,
		c.OrgID, c.UserID, req.PlanID,
	).Scan(&orgName, &userEmail, &userName, &planCurrency, &planTier); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			writeErr(w, 404, "plan_not_found", "plan not found")
			return
		}
		writeErr(w, 500, "db_error", err.Error())
		return
	}
	if planTier == "free" {
		writeErr(w, 400, "free_plan",
			"free plans don't go through checkout — contact support to downgrade")
		return
	}
	if planTier == "enterprise" {
		writeErr(w, 400, "enterprise_plan",
			"enterprise plans are sales-led — please contact us instead")
		return
	}

	prov := h.providerForCurrency(planCurrency)
	if prov == nil || !prov.Configured() {
		writeErr(w, 501, "provider_unavailable",
			"billing provider for "+planCurrency+" is not configured")
		return
	}

	// Validate coupon up front so we never start a checkout with a
	// dud code. The remote provider will also re-validate against its
	// own catalog (Stripe coupons / Razorpay offers).
	couponCode := strings.ToUpper(strings.TrimSpace(req.CouponCode))
	if couponCode != "" {
		coupon, cerr := LookupCoupon(r.Context(), h.DB, couponCode)
		if cerr != nil {
			writeErr(w, 404, "coupon_not_found", cerr.Error())
			return
		}
		var planAmount int64
		_ = h.DB.QueryRow(r.Context(),
			`SELECT COALESCE(amount_cents,0) FROM plans WHERE id=$1`, req.PlanID,
		).Scan(&planAmount)
		if err := coupon.Validate(req.PlanID, planCurrency, planAmount); err != nil {
			writeErr(w, 400, "coupon_invalid", err.Error())
			return
		}
	}

	res, err := prov.StartCheckout(r.Context(), CheckoutInput{
		OrgID:      c.OrgID,
		OrgName:    orgName,
		UserEmail:  userEmail,
		UserName:   userName,
		UserID:     c.UserID,
		PlanID:     req.PlanID,
		SuccessURL: req.SuccessURL,
		CancelURL:  req.CancelURL,
		CouponCode: couponCode,
	})
	if err != nil {
		if errors.Is(err, ErrNotConfigured) {
			writeErr(w, 501, "provider_unavailable", err.Error())
			return
		}
		writeErr(w, 502, "checkout_failed", err.Error())
		return
	}

	audit.LogHTTP(r, h.DB, "billing.checkout_started", "subscription",
		res.ProviderSubscriptionID,
		map[string]any{"planId": req.PlanID, "provider": prov.Name()})

	writeJSON(w, 200, map[string]any{
		"url":      res.URL,
		"provider": prov.Name(),
	})
}

// -- cancel / reactivate ------------------------------------------------

type cancelReq struct {
	AtPeriodEnd bool `json:"atPeriodEnd"`
}

func (h *Handler) CancelSubscription(w http.ResponseWriter, r *http.Request) {
	c, _ := r.Context().Value(auth.UserCtxKey).(*auth.Claims)
	if c == nil {
		writeErr(w, 401, "unauthorized", "missing claims")
		return
	}
	if c.Role != auth.RoleAdmin {
		writeErr(w, 403, "forbidden", "only org admins can change billing")
		return
	}
	var req cancelReq
	_ = json.NewDecoder(r.Body).Decode(&req)

	// Find the active subscription. We need provider + provider_sub_id
	// to make the remote call.
	var (
		subID, provider string
		providerSubID   *string
	)
	err := h.DB.QueryRow(r.Context(), `
		SELECT id::text, provider, provider_subscription_id
		  FROM subscriptions
		 WHERE org_id=$1
		   AND status IN ('trialing','active','past_due','paused')
		 ORDER BY created_at DESC LIMIT 1`, c.OrgID,
	).Scan(&subID, &provider, &providerSubID)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			writeErr(w, 404, "no_subscription", "no active subscription")
			return
		}
		writeErr(w, 500, "db_error", err.Error())
		return
	}

	if provider == ProviderManual {
		// Manual subs have no remote system. Cancel locally.
		_, _ = h.DB.Exec(r.Context(), `
			UPDATE subscriptions SET status='canceled',
			       canceled_at=now(), updated_at=now()
			 WHERE id=$1::uuid`, subID)
		audit.LogHTTP(r, h.DB, "billing.subscription_canceled",
			"subscription", subID, map[string]any{"atPeriodEnd": false})
		writeJSON(w, 200, map[string]any{"ok": true})
		return
	}
	if providerSubID == nil || *providerSubID == "" {
		writeErr(w, 409, "no_provider_link",
			"subscription has no remote id — contact support")
		return
	}
	prov := h.providerByName(provider)
	if prov == nil || !prov.Configured() {
		writeErr(w, 501, "provider_unavailable",
			"billing provider "+provider+" is not configured")
		return
	}
	if err := prov.Cancel(r.Context(), *providerSubID, req.AtPeriodEnd); err != nil {
		writeErr(w, 502, "cancel_failed", err.Error())
		return
	}
	if req.AtPeriodEnd {
		_, _ = h.DB.Exec(r.Context(), `
			UPDATE subscriptions SET cancel_at_period_end=true,
			       updated_at=now()
			 WHERE id=$1::uuid`, subID)
	} else {
		_, _ = h.DB.Exec(r.Context(), `
			UPDATE subscriptions SET status='canceled',
			       canceled_at=now(), updated_at=now()
			 WHERE id=$1::uuid`, subID)
	}
	audit.LogHTTP(r, h.DB, "billing.subscription_canceled",
		"subscription", subID,
		map[string]any{"atPeriodEnd": req.AtPeriodEnd, "provider": provider})
	writeJSON(w, 200, map[string]any{"ok": true})
}

// Reactivate undoes a pending cancel_at_period_end on the active sub.
// We call the provider so the remote side stops the wind-down too, then
// flip our flag back. Only valid while the sub is still active.
func (h *Handler) Reactivate(w http.ResponseWriter, r *http.Request) {
	c, _ := r.Context().Value(auth.UserCtxKey).(*auth.Claims)
	if c == nil {
		writeErr(w, 401, "unauthorized", "missing claims")
		return
	}
	if c.Role != auth.RoleAdmin {
		writeErr(w, 403, "forbidden", "only org admins can change billing")
		return
	}
	var (
		subID, provider string
		providerSubID   *string
		cancelFlag      bool
	)
	err := h.DB.QueryRow(r.Context(), `
		SELECT id::text, provider, provider_subscription_id, cancel_at_period_end
		  FROM subscriptions
		 WHERE org_id=$1
		   AND status IN ('trialing','active','past_due','paused')
		 ORDER BY created_at DESC LIMIT 1`, c.OrgID,
	).Scan(&subID, &provider, &providerSubID, &cancelFlag)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			writeErr(w, 404, "no_subscription", "no active subscription")
			return
		}
		writeErr(w, 500, "db_error", err.Error())
		return
	}
	if !cancelFlag {
		writeErr(w, 409, "not_cancelling",
			"subscription is not scheduled for cancellation")
		return
	}
	if provider == ProviderManual {
		_, _ = h.DB.Exec(r.Context(),
			`UPDATE subscriptions SET cancel_at_period_end=false,
			   updated_at=now() WHERE id=$1::uuid`, subID)
		audit.LogHTTP(r, h.DB, "billing.subscription_reactivated",
			"subscription", subID, nil)
		writeJSON(w, 200, map[string]any{"ok": true})
		return
	}
	if providerSubID == nil || *providerSubID == "" {
		writeErr(w, 409, "no_provider_link",
			"subscription has no remote id — contact support")
		return
	}
	prov := h.providerByName(provider)
	if prov == nil || !prov.Configured() {
		writeErr(w, 501, "provider_unavailable",
			"billing provider "+provider+" is not configured")
		return
	}
	rt, ok := prov.(Reactivator)
	if !ok {
		writeErr(w, 501, "not_supported",
			provider+" does not support reactivation; cancel & resubscribe instead")
		return
	}
	if err := rt.Reactivate(r.Context(), *providerSubID); err != nil {
		writeErr(w, 502, "reactivate_failed", err.Error())
		return
	}
	_, _ = h.DB.Exec(r.Context(),
		`UPDATE subscriptions SET cancel_at_period_end=false,
		   updated_at=now() WHERE id=$1::uuid`, subID)
	audit.LogHTTP(r, h.DB, "billing.subscription_reactivated",
		"subscription", subID, map[string]any{"provider": provider})
	writeJSON(w, 200, map[string]any{"ok": true})
}

// Reactivator is implemented by drivers that support undoing a pending
// period-end cancel without creating a fresh subscription. Stripe does;
// Razorpay's API doesn't expose an "uncancel" once a request lands, so
// it doesn't implement this.
type Reactivator interface {
	Reactivate(ctx context.Context, providerSubID string) error
}

// ChangePlan switches an active subscription to a new plan. The remote
// switch is provider-specific (Stripe supports proration; Razorpay
// schedules the change at the cycle boundary). We update the local row
// optimistically; the next webhook reconciles canonical state.
type changePlanReq struct {
	PlanID string `json:"planId"`
}

func (h *Handler) ChangePlan(w http.ResponseWriter, r *http.Request) {
	c, _ := r.Context().Value(auth.UserCtxKey).(*auth.Claims)
	if c == nil {
		writeErr(w, 401, "unauthorized", "missing claims")
		return
	}
	if c.Role != auth.RoleAdmin {
		writeErr(w, 403, "forbidden", "only org admins can change billing")
		return
	}
	var req changePlanReq
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeErr(w, 400, "invalid_body", err.Error())
		return
	}
	req.PlanID = strings.TrimSpace(req.PlanID)
	if req.PlanID == "" {
		writeErr(w, 400, "missing_plan", "planId is required")
		return
	}

	var (
		subID, provider, currentPlan string
		providerSubID                *string
	)
	err := h.DB.QueryRow(r.Context(), `
		SELECT id::text, provider, provider_subscription_id, plan_id
		  FROM subscriptions
		 WHERE org_id=$1
		   AND status IN ('trialing','active','past_due','paused')
		 ORDER BY created_at DESC LIMIT 1`, c.OrgID,
	).Scan(&subID, &provider, &providerSubID, &currentPlan)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			writeErr(w, 404, "no_subscription",
				"no active subscription — start a fresh checkout instead")
			return
		}
		writeErr(w, 500, "db_error", err.Error())
		return
	}
	if currentPlan == req.PlanID {
		writeErr(w, 409, "same_plan", "this is already your active plan")
		return
	}
	if provider == ProviderManual {
		// Manual subs can be swapped freely — no remote system to nudge.
		if _, err := h.DB.Exec(r.Context(),
			`UPDATE subscriptions SET plan_id=$2, updated_at=now()
			   WHERE id=$1::uuid`, subID, req.PlanID); err != nil {
			writeErr(w, 500, "db_error", err.Error())
			return
		}
		audit.LogHTTP(r, h.DB, "billing.plan_changed", "subscription", subID,
			map[string]any{"from": currentPlan, "to": req.PlanID})
		writeJSON(w, 200, map[string]any{"ok": true})
		return
	}
	if providerSubID == nil || *providerSubID == "" {
		writeErr(w, 409, "no_provider_link",
			"subscription has no remote id — contact support")
		return
	}
	prov := h.providerByName(provider)
	if prov == nil || !prov.Configured() {
		writeErr(w, 501, "provider_unavailable",
			"billing provider "+provider+" is not configured")
		return
	}
	switcher, ok := prov.(PlanSwitcher)
	if !ok {
		writeErr(w, 501, "not_supported",
			provider+" does not support mid-cycle plan changes; cancel & resubscribe")
		return
	}
	if err := switcher.ChangePlan(r.Context(), *providerSubID, req.PlanID); err != nil {
		writeErr(w, 502, "change_failed", err.Error())
		return
	}
	if _, err := h.DB.Exec(r.Context(),
		`UPDATE subscriptions SET plan_id=$2, updated_at=now()
		   WHERE id=$1::uuid`, subID, req.PlanID); err != nil {
		writeErr(w, 500, "db_error", err.Error())
		return
	}
	audit.LogHTTP(r, h.DB, "billing.plan_changed", "subscription", subID,
		map[string]any{"from": currentPlan, "to": req.PlanID, "provider": provider})
	writeJSON(w, 200, map[string]any{"ok": true})
}

// PlanSwitcher is implemented by drivers that can swap to a new price
// id on an existing subscription without going through checkout again.
type PlanSwitcher interface {
	ChangePlan(ctx context.Context, providerSubID, newPlanID string) error
}

// -- webhooks ------------------------------------------------------------

func (h *Handler) RazorpayWebhook(w http.ResponseWriter, r *http.Request) {
	if h.drivers.Razorpay == nil {
		writeErr(w, 501, "provider_unavailable", "razorpay not configured")
		return
	}
	h.handleWebhook(w, r, h.drivers.Razorpay)
}

func (h *Handler) StripeWebhook(w http.ResponseWriter, r *http.Request) {
	if h.drivers.Stripe == nil {
		writeErr(w, 501, "provider_unavailable", "stripe not configured")
		return
	}
	h.handleWebhook(w, r, h.drivers.Stripe)
}

func (h *Handler) handleWebhook(w http.ResponseWriter, r *http.Request, prov Provider) {
	raw, err := io.ReadAll(http.MaxBytesReader(w, r.Body, 1<<20)) // 1MB
	if err != nil {
		writeErr(w, 400, "read_failed", err.Error())
		return
	}
	ev, err := prov.VerifyWebhook(r, raw)
	if err != nil {
		// Verification failures get 400, not 401 — providers tend to
		// retry on 4xx but not 5xx, and we want a fast bail on signature
		// mismatch so a misconfigured secret is loud in their dashboard.
		writeErr(w, 400, "invalid_webhook", err.Error())
		return
	}
	already, err := markEventProcessed(r.Context(), h.DB,
		prov.Name(), ev.ID, ev.Type, ev.Raw)
	if err != nil {
		writeErr(w, 500, "db_error", err.Error())
		return
	}
	if already {
		// Idempotent replay — acknowledge so the provider stops
		// retrying.
		writeJSON(w, 200, map[string]any{"ok": true, "duplicate": true})
		return
	}
	if err := prov.HandleEvent(r.Context(), ev); err != nil {
		// Surface the error so the provider retries — but log it on our
		// side via the audit table.
		audit.Log(r.Context(), h.DB, audit.Event{
			Action: "billing.webhook_error",
			Meta: map[string]any{
				"provider":  prov.Name(),
				"eventType": ev.Type,
				"err":       err.Error(),
			},
		})
		writeErr(w, 500, "handle_failed", err.Error())
		return
	}
	writeJSON(w, 200, map[string]any{"ok": true})
}

// -- driver lookup helpers ----------------------------------------------

func (h *Handler) providerForCurrency(currency string) Provider {
	switch ChooseProvider(currency) {
	case ProviderRazorpay:
		return h.drivers.Razorpay
	case ProviderStripe:
		return h.drivers.Stripe
	}
	return nil
}
func (h *Handler) providerByName(name string) Provider {
	switch name {
	case ProviderRazorpay:
		return h.drivers.Razorpay
	case ProviderStripe:
		return h.drivers.Stripe
	}
	return nil
}
