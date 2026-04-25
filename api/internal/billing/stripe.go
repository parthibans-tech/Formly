package billing

import (
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
)

// notifierHook lets the package-level dispatcher reach back into the
// Handler's mailer without each driver carrying its own copy. It is
// set in main.go right after AttachMailer.
var notifierHook func(orgID, kind, planName string)

// SetNotifier wires the notification hook used by the drivers from the
// outermost handler. Pass nil to disable.
func SetNotifier(fn func(orgID, kind, planName string)) { notifierHook = fn }

func notify(orgID, kind, planName string) {
	if notifierHook != nil {
		notifierHook(orgID, kind, planName)
	}
}

// StripeDriver is the USD-side counterpart to RazorpayDriver.
//
// Phase 4b ships a thin but real implementation: we create a Checkout
// Session (mode=subscription) and let Stripe host the card collection +
// trial, then reconcile via webhooks. That keeps PCI scope on Stripe's
// side and avoids us building a card form.
//
// Configured() == false when STRIPE_SECRET_KEY is unset; in that case
// the driver returns ErrNotConfigured and the handler responds 501,
// nudging the operator to either supply credentials or pick INR.
type StripeDriver struct {
	DB            *pgxpool.Pool
	SecretKey     string
	WebhookSecret string
	HTTP          *http.Client
}

func NewStripeDriver(db *pgxpool.Pool, secretKey, webhookSecret string) *StripeDriver {
	return &StripeDriver{
		DB: db, SecretKey: secretKey, WebhookSecret: webhookSecret,
		HTTP: &http.Client{Timeout: 20 * time.Second},
	}
}

func (d *StripeDriver) Name() string     { return ProviderStripe }
func (d *StripeDriver) Configured() bool { return d.SecretKey != "" }

const stripeBase = "https://api.stripe.com/v1"

// stripeForm builds a flat form-urlencoded body from a nested map. The
// Stripe API uses bracketed keys (e.g. line_items[0][price]=...).
type stripeForm struct {
	values url.Values
}

func newStripeForm() *stripeForm { return &stripeForm{values: url.Values{}} }
func (f *stripeForm) set(k, v string) {
	if v == "" {
		return
	}
	f.values.Set(k, v)
}

func (d *StripeDriver) call(ctx context.Context, path string, form *stripeForm) ([]byte, int, error) {
	req, err := http.NewRequestWithContext(ctx, "POST",
		stripeBase+path, strings.NewReader(form.values.Encode()))
	if err != nil {
		return nil, 0, err
	}
	req.SetBasicAuth(d.SecretKey, "")
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	resp, err := d.HTTP.Do(req)
	if err != nil {
		return nil, 0, err
	}
	defer resp.Body.Close()
	raw, _ := io.ReadAll(resp.Body)
	return raw, resp.StatusCode, nil
}

func (d *StripeDriver) StartCheckout(ctx context.Context, in CheckoutInput) (CheckoutResult, error) {
	if !d.Configured() {
		return CheckoutResult{}, ErrNotConfigured
	}
	// Resolve plan -> Stripe price id.
	var (
		amount   int64
		stripeID *string
		currency string
	)
	if err := d.DB.QueryRow(ctx,
		`SELECT amount_cents, stripe_price_id, currency
		   FROM plans WHERE id=$1 AND active=true`, in.PlanID,
	).Scan(&amount, &stripeID, &currency); err != nil {
		return CheckoutResult{}, err
	}
	if stripeID == nil || *stripeID == "" {
		// Lazy create not implemented for Stripe; operators should
		// paste the price id from the dashboard into plans.stripe_price_id.
		return CheckoutResult{}, errors.New(
			"stripe_price_id missing for plan " + in.PlanID +
				" — paste the Stripe price id into plans.stripe_price_id")
	}

	form := newStripeForm()
	form.set("mode", "subscription")
	form.set("line_items[0][price]", *stripeID)
	form.set("line_items[0][quantity]", "1")
	form.set("customer_email", in.UserEmail)
	form.set("success_url", coalesce(in.SuccessURL,
		"http://localhost:3000/settings/billing?status=success"))
	form.set("cancel_url", coalesce(in.CancelURL,
		"http://localhost:3000/settings/billing?status=cancel"))
	form.set("subscription_data[metadata][org_id]", in.OrgID)
	form.set("subscription_data[metadata][internal_plan_id]", in.PlanID)
	if in.CouponCode != "" {
		form.set("subscription_data[metadata][coupon_code]", in.CouponCode)
		// Best-effort: pass the same code to Stripe so the user sees the
		// discount on the hosted page. If Stripe doesn't have a matching
		// coupon, the session creation fails — operators must mirror
		// local coupons in the Stripe dashboard for now.
		form.set("discounts[0][coupon]", in.CouponCode)
	}
	form.set("metadata[org_id]", in.OrgID)
	form.set("metadata[internal_plan_id]", in.PlanID)

	raw, status, err := d.call(ctx, "/checkout/sessions", form)
	if err != nil {
		return CheckoutResult{}, err
	}
	if status >= 300 {
		return CheckoutResult{}, fmt.Errorf("stripe create session: %s", string(raw))
	}
	var resp struct {
		ID         string `json:"id"`
		URL        string `json:"url"`
		Customer   string `json:"customer"`
		Subscription string `json:"subscription"`
	}
	if err := json.Unmarshal(raw, &resp); err != nil || resp.URL == "" {
		return CheckoutResult{}, fmt.Errorf("stripe create session: bad response: %s", string(raw))
	}
	// We don't yet have a subscription id (Stripe creates it after the
	// user completes checkout); the webhook reconciles. Pre-record a
	// placeholder using the session id so the user sees the in-flight
	// state — the webhook will update with the real subscription id.
	_ = upsertPendingSubscription(ctx, d.DB, in.OrgID, in.PlanID,
		ProviderStripe, "cs_"+resp.ID, currency, amount)
	if in.CouponCode != "" {
		_, _ = d.DB.Exec(ctx,
			`UPDATE subscriptions SET coupon_code=$1
			   WHERE provider='stripe' AND provider_subscription_id=$2`,
			in.CouponCode, "cs_"+resp.ID)
	}

	return CheckoutResult{
		URL:                resp.URL,
		ProviderCustomerID: resp.Customer,
	}, nil
}

func (d *StripeDriver) Cancel(ctx context.Context, providerSubID string, atPeriodEnd bool) error {
	if !d.Configured() {
		return ErrNotConfigured
	}
	if strings.HasPrefix(providerSubID, "cs_") {
		// Placeholder session id, no real subscription to cancel —
		// just clear our row.
		return cancelSubscriptionByProviderID(ctx, d.DB, ProviderStripe, providerSubID)
	}
	form := newStripeForm()
	if atPeriodEnd {
		form.set("cancel_at_period_end", "true")
		raw, status, err := d.call(ctx, "/subscriptions/"+providerSubID, form)
		if err != nil {
			return err
		}
		if status >= 300 {
			return fmt.Errorf("stripe cancel: %s", string(raw))
		}
		return nil
	}
	// Immediate cancel uses DELETE /subscriptions/{id}.
	req, err := http.NewRequestWithContext(ctx, "DELETE",
		stripeBase+"/subscriptions/"+providerSubID, nil)
	if err != nil {
		return err
	}
	req.SetBasicAuth(d.SecretKey, "")
	resp, err := d.HTTP.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode >= 300 {
		raw, _ := io.ReadAll(resp.Body)
		return fmt.Errorf("stripe cancel: %s", string(raw))
	}
	return nil
}

// Reactivate undoes a pending cancel_at_period_end so the subscription
// keeps renewing. Stripe exposes this directly.
func (d *StripeDriver) Reactivate(ctx context.Context, providerSubID string) error {
	if !d.Configured() {
		return ErrNotConfigured
	}
	if strings.HasPrefix(providerSubID, "cs_") {
		// No real subscription yet — nothing to reactivate.
		return nil
	}
	form := newStripeForm()
	form.set("cancel_at_period_end", "false")
	raw, status, err := d.call(ctx, "/subscriptions/"+providerSubID, form)
	if err != nil {
		return err
	}
	if status >= 300 {
		return fmt.Errorf("stripe reactivate: %s", string(raw))
	}
	return nil
}

// ChangePlan switches the subscription's first item to a new price id.
// `proration_behavior=create_prorations` charges a partial-cycle delta
// at the next invoice — standard SaaS upgrade UX.
func (d *StripeDriver) ChangePlan(ctx context.Context, providerSubID, newPlanID string) error {
	if !d.Configured() {
		return ErrNotConfigured
	}
	if strings.HasPrefix(providerSubID, "cs_") {
		return errors.New("checkout still in progress; wait for activation before changing plan")
	}
	// Look up the new Stripe price id.
	var stripeID *string
	if err := d.DB.QueryRow(ctx,
		`SELECT stripe_price_id FROM plans WHERE id=$1 AND active=true`, newPlanID,
	).Scan(&stripeID); err != nil {
		return err
	}
	if stripeID == nil || *stripeID == "" {
		return errors.New("destination plan has no stripe_price_id")
	}
	// Stripe needs the existing subscription_item id to swap the price.
	raw, status, err := d.call(ctx, "/subscriptions/"+providerSubID, newStripeForm())
	if err != nil {
		return err
	}
	if status >= 300 {
		return fmt.Errorf("stripe fetch sub: %s", string(raw))
	}
	var sub struct {
		Items struct {
			Data []struct {
				ID string `json:"id"`
			} `json:"data"`
		} `json:"items"`
	}
	if err := json.Unmarshal(raw, &sub); err != nil || len(sub.Items.Data) == 0 {
		return fmt.Errorf("stripe sub items missing: %s", string(raw))
	}
	form := newStripeForm()
	form.set("items[0][id]", sub.Items.Data[0].ID)
	form.set("items[0][price]", *stripeID)
	form.set("proration_behavior", "create_prorations")
	raw, status, err = d.call(ctx, "/subscriptions/"+providerSubID, form)
	if err != nil {
		return err
	}
	if status >= 300 {
		return fmt.Errorf("stripe change plan: %s", string(raw))
	}
	return nil
}

// VerifyWebhook implements the Stripe-Signature verification scheme
// (timestamp + v1=signature pairs). When WebhookSecret is empty we fall
// through unverified — same dev policy as Razorpay.
func (d *StripeDriver) VerifyWebhook(r *http.Request, raw []byte) (WebhookEvent, error) {
	if d.WebhookSecret != "" {
		if err := verifyStripeSignature(d.WebhookSecret,
			r.Header.Get("Stripe-Signature"), raw); err != nil {
			return WebhookEvent{}, err
		}
	}
	var env struct {
		ID   string `json:"id"`
		Type string `json:"type"`
	}
	if err := json.Unmarshal(raw, &env); err != nil {
		return WebhookEvent{}, fmt.Errorf("bad webhook body: %w", err)
	}
	if env.ID == "" {
		return WebhookEvent{}, errors.New("missing event id")
	}
	return WebhookEvent{
		ID:       env.ID,
		Type:     env.Type,
		Raw:      raw,
		Received: time.Now(),
	}, nil
}

// HandleEvent dispatches Stripe webhook events.
//
// Events we handle:
//   checkout.session.completed       — promote placeholder to real sub id
//   customer.subscription.updated    — status / period sync
//   customer.subscription.deleted    — cancel
//   invoice.paid                     — record invoice
//   invoice.payment_failed           — past_due
func (d *StripeDriver) HandleEvent(ctx context.Context, ev WebhookEvent) error {
	var env struct {
		Type string `json:"type"`
		Data struct {
			Object map[string]any `json:"object"`
		} `json:"data"`
	}
	if err := json.Unmarshal(ev.Raw, &env); err != nil {
		return err
	}
	obj := env.Data.Object
	switch ev.Type {
	case "checkout.session.completed":
		sessID, _ := obj["id"].(string)
		subID, _ := obj["subscription"].(string)
		if sessID == "" || subID == "" {
			return nil
		}
		customerID, _ := obj["customer"].(string)
		// Replace the cs_ placeholder with the real subscription id.
		_, err := d.DB.Exec(ctx, `
			UPDATE subscriptions
			   SET provider_subscription_id = $2,
			       provider_customer_id = COALESCE(NULLIF($3,''), provider_customer_id),
			       status = 'active',
			       updated_at = now()
			 WHERE provider = 'stripe' AND provider_subscription_id = $1`,
			"cs_"+sessID, subID, customerID)
		// First completed checkout = redeem the coupon (if any).
		var coupon *string
		_ = d.DB.QueryRow(ctx,
			`SELECT coupon_code FROM subscriptions
			  WHERE provider='stripe' AND provider_subscription_id=$1`, subID,
		).Scan(&coupon)
		if coupon != nil && *coupon != "" {
			_ = RecordRedemption(ctx, d.DB, *coupon)
		}
		return err
	case "customer.subscription.updated", "customer.subscription.created":
		subID, _ := obj["id"].(string)
		status := stripeStatusToInternal(stringFrom(obj, "status"))
		var periodEnd *time.Time
		if v, ok := obj["current_period_end"].(float64); ok && v > 0 {
			t := time.Unix(int64(v), 0).UTC()
			periodEnd = &t
		}
		var periodStart *time.Time
		if v, ok := obj["current_period_start"].(float64); ok && v > 0 {
			t := time.Unix(int64(v), 0).UTC()
			periodStart = &t
		}
		return updateSubscriptionStatus(ctx, d.DB, ProviderStripe, subID,
			status, periodStart, periodEnd)
	case "customer.subscription.deleted":
		subID, _ := obj["id"].(string)
		orgID, planName := lookupOrgAndPlan(ctx, d.DB, ProviderStripe, subID)
		if err := cancelSubscriptionByProviderID(ctx, d.DB, ProviderStripe, subID); err != nil {
			return err
		}
		notify(orgID, "canceled", planName)
		return nil
	case "invoice.paid":
		subID := stringFrom(obj, "subscription")
		ev := invoiceInsert{
			OrgID:             stripeOrgIDFromInvoice(obj),
			ProviderSubID:     subID,
			ProviderInvoiceID: stringFrom(obj, "id"),
			Number: coalesce(stringFrom(obj, "number"),
				"STR-"+stringFrom(obj, "id")),
			Currency:   strings.ToUpper(stringFrom(obj, "currency")),
			TotalCents: int64(numberFrom(obj, "amount_paid")),
			TaxCents:   int64(numberFrom(obj, "tax")),
			IssuedAt:   time.Unix(int64(numberFrom(obj, "created")), 0).UTC(),
			Status:     "paid",
			HostedURL:  stringFrom(obj, "hosted_invoice_url"),
			PDFURL:     stringFrom(obj, "invoice_pdf"),
		}
		if err := recordInvoice(ctx, d.DB, ProviderStripe, ev); err != nil {
			return err
		}
		// Coupons configured for `duration='once'` auto-expire after
		// the first invoice — that's already the Stripe default — but
		// 'forever' / 'repeating' codes redeem on every successful
		// invoice so the local counter tracks reality.
		var coupon *string
		_ = d.DB.QueryRow(ctx, `
			SELECT s.coupon_code FROM subscriptions s
			 WHERE s.provider='stripe' AND s.provider_subscription_id=$1`, subID,
		).Scan(&coupon)
		if coupon != nil && *coupon != "" {
			_ = RecordRedemption(ctx, d.DB, *coupon)
		}
		return nil
	case "invoice.payment_failed":
		subID := stringFrom(obj, "subscription")
		if err := updateSubscriptionStatus(ctx, d.DB, ProviderStripe, subID,
			StatusPastDue, nil, nil); err != nil {
			return err
		}
		markPastDue(ctx, d.DB, ProviderStripe, subID)
		orgID, planName := lookupOrgAndPlan(ctx, d.DB, ProviderStripe, subID)
		notify(orgID, "payment_failed", planName)
		return nil
	}
	return nil
}

// stripeStatusToInternal maps Stripe lifecycle strings to our enum.
func stripeStatusToInternal(s string) string {
	switch s {
	case "trialing":
		return StatusTrialing
	case "active":
		return StatusActive
	case "past_due", "unpaid", "incomplete":
		return StatusPastDue
	case "paused":
		return StatusPaused
	case "canceled", "incomplete_expired":
		return StatusCanceled
	}
	return StatusActive
}

func stripeOrgIDFromInvoice(obj map[string]any) string {
	// metadata is on the Subscription, not the Invoice; we joined back
	// via the local subscriptions row in recordInvoice. As a best-effort
	// fallback, check the invoice's own metadata.
	if md, ok := obj["metadata"].(map[string]any); ok {
		if v, ok := md["org_id"].(string); ok {
			return v
		}
	}
	return ""
}

func stringFrom(m map[string]any, key string) string {
	if v, ok := m[key].(string); ok {
		return v
	}
	return ""
}
func numberFrom(m map[string]any, key string) float64 {
	if v, ok := m[key].(float64); ok {
		return v
	}
	return 0
}
func coalesce(a, b string) string {
	if a != "" {
		return a
	}
	return b
}

// verifyStripeSignature implements Stripe's "v1" signature scheme:
//
//	header = "t=<timestamp>,v1=<sig1>,v1=<sig2>,..."
//	payload = "<timestamp>.<rawBody>"
//	expected = HMAC-SHA256(secret, payload)
//
// We accept any v1 sig that matches.
func verifyStripeSignature(secret, header string, body []byte) error {
	if header == "" {
		return errors.New("missing Stripe-Signature")
	}
	var ts string
	var sigs []string
	for _, part := range strings.Split(header, ",") {
		kv := strings.SplitN(strings.TrimSpace(part), "=", 2)
		if len(kv) != 2 {
			continue
		}
		switch kv[0] {
		case "t":
			ts = kv[1]
		case "v1":
			sigs = append(sigs, kv[1])
		}
	}
	if ts == "" || len(sigs) == 0 {
		return errors.New("malformed Stripe-Signature")
	}
	mac := hmac.New(sha256.New, []byte(secret))
	mac.Write([]byte(ts + "."))
	mac.Write(body)
	expected := hex.EncodeToString(mac.Sum(nil))
	for _, s := range sigs {
		if hmac.Equal([]byte(s), []byte(expected)) {
			// Reject events older than 5 minutes to limit replay window.
			if t, err := strconv.ParseInt(ts, 10, 64); err == nil {
				if time.Since(time.Unix(t, 0)) > 5*time.Minute {
					return errors.New("stripe webhook timestamp too old")
				}
			}
			return nil
		}
	}
	return errors.New("invalid stripe signature")
}

// keep pgxpool reference so unused-import lint never trips when we
// trim a method.
var _ = (*pgxpool.Pool)(nil)
