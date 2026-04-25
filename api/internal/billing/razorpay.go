package billing

import (
	"bytes"
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

// RazorpayDriver speaks to https://api.razorpay.com/v1.
//
// It uses HTTP Basic auth with key id + secret. We deliberately don't
// pull in the Razorpay Go SDK — the surface we need (plans, customers,
// subscriptions, signature verification) is small and the SDK adds a
// large dependency tree.
//
// Plan handling: each row in our `plans` table can be linked to a
// remote Razorpay plan via `razorpay_plan_id`. If the link is missing
// when StartCheckout runs, we lazily create the matching plan on
// Razorpay's side and write the id back. That keeps local seeding
// independent of dashboard-side configuration.
type RazorpayDriver struct {
	DB            *pgxpool.Pool
	KeyID         string
	KeySecret     string
	WebhookSecret string
	HTTP          *http.Client
}

func NewRazorpayDriver(db *pgxpool.Pool, keyID, keySecret, webhookSecret string) *RazorpayDriver {
	return &RazorpayDriver{
		DB: db, KeyID: keyID, KeySecret: keySecret, WebhookSecret: webhookSecret,
		HTTP: &http.Client{Timeout: 20 * time.Second},
	}
}

func (d *RazorpayDriver) Name() string       { return ProviderRazorpay }
func (d *RazorpayDriver) Configured() bool   { return d.KeyID != "" && d.KeySecret != "" }

const razorpayBase = "https://api.razorpay.com/v1"

func (d *RazorpayDriver) call(ctx context.Context, method, path string, body any) ([]byte, int, error) {
	var rdr io.Reader
	if body != nil {
		b, err := json.Marshal(body)
		if err != nil {
			return nil, 0, err
		}
		rdr = bytes.NewReader(b)
	}
	req, err := http.NewRequestWithContext(ctx, method, razorpayBase+path, rdr)
	if err != nil {
		return nil, 0, err
	}
	req.SetBasicAuth(d.KeyID, d.KeySecret)
	req.Header.Set("Content-Type", "application/json")
	resp, err := d.HTTP.Do(req)
	if err != nil {
		return nil, 0, err
	}
	defer resp.Body.Close()
	raw, _ := io.ReadAll(resp.Body)
	return raw, resp.StatusCode, nil
}

// ensurePlanID resolves (or lazily creates) the Razorpay plan id for
// our internal plan row. Returns the remote id on success.
func (d *RazorpayDriver) ensurePlanID(ctx context.Context, planID string) (string, string, int64, error) {
	var (
		name, currency, interval string
		amount                   int64
		razorpayID               *string
	)
	err := d.DB.QueryRow(ctx,
		`SELECT name, currency, interval, amount_cents, razorpay_plan_id
		   FROM plans WHERE id=$1 AND active=true`, planID,
	).Scan(&name, &currency, &interval, &amount, &razorpayID)
	if err != nil {
		return "", "", 0, err
	}
	if !strings.EqualFold(currency, "INR") {
		return "", "", 0, fmt.Errorf("razorpay only supports INR plans (got %s)", currency)
	}
	if razorpayID != nil && *razorpayID != "" {
		return *razorpayID, interval, amount, nil
	}

	// Razorpay calls our "month" -> "monthly", "year" -> "yearly".
	period := "monthly"
	if interval == "year" {
		period = "yearly"
	}
	body := map[string]any{
		"period":   period,
		"interval": 1,
		"item": map[string]any{
			"name":     name,
			"amount":   amount,
			"currency": "INR",
		},
		"notes": map[string]string{"internal_plan_id": planID},
	}
	raw, status, err := d.call(ctx, "POST", "/plans", body)
	if err != nil {
		return "", "", 0, err
	}
	if status >= 300 {
		return "", "", 0, fmt.Errorf("razorpay create plan: %s", string(raw))
	}
	var resp struct {
		ID string `json:"id"`
	}
	if err := json.Unmarshal(raw, &resp); err != nil || resp.ID == "" {
		return "", "", 0, fmt.Errorf("razorpay create plan: bad response: %s", string(raw))
	}
	if _, err := d.DB.Exec(ctx,
		`UPDATE plans SET razorpay_plan_id=$1 WHERE id=$2`, resp.ID, planID); err != nil {
		// Non-fatal: we got a plan id; we just won't cache it.
	}
	return resp.ID, interval, amount, nil
}

func (d *RazorpayDriver) StartCheckout(ctx context.Context, in CheckoutInput) (CheckoutResult, error) {
	if !d.Configured() {
		return CheckoutResult{}, ErrNotConfigured
	}
	rzpPlanID, interval, amount, err := d.ensurePlanID(ctx, in.PlanID)
	if err != nil {
		return CheckoutResult{}, err
	}

	// total_count is the number of billing cycles before the
	// subscription auto-completes. 12 months is a year of monthly
	// payments; for a yearly plan we use 5 (5-year horizon — Razorpay
	// requires a finite count, and we'd rather renew via webhook than
	// orphan an active subscription on the boundary).
	totalCount := 12
	if interval == "year" {
		totalCount = 5
	}

	subBody := map[string]any{
		"plan_id":         rzpPlanID,
		"total_count":     totalCount,
		"customer_notify": 1,
		"notes": map[string]string{
			"org_id":           in.OrgID,
			"internal_plan_id": in.PlanID,
			"user_email":       in.UserEmail,
		},
	}
	raw, status, err := d.call(ctx, "POST", "/subscriptions", subBody)
	if err != nil {
		return CheckoutResult{}, err
	}
	if status >= 300 {
		return CheckoutResult{}, fmt.Errorf("razorpay create subscription: %s", string(raw))
	}
	var resp struct {
		ID       string `json:"id"`
		ShortURL string `json:"short_url"`
		Status   string `json:"status"`
	}
	if err := json.Unmarshal(raw, &resp); err != nil || resp.ID == "" {
		return CheckoutResult{}, fmt.Errorf("razorpay create subscription: bad response: %s", string(raw))
	}

	// Pre-record a placeholder subscription row so the user sees their
	// pending upgrade on /settings/billing immediately. Status is
	// 'past_due' until subscription.activated lands — we deliberately
	// avoid 'active' because no money has moved yet, and the webhook
	// will flip it to active or canceled depending on the user's flow.
	if err := upsertPendingSubscription(ctx, d.DB, in.OrgID, in.PlanID,
		ProviderRazorpay, resp.ID, "INR", amount); err != nil {
		// Non-fatal — the subscription still exists on Razorpay and
		// the activation webhook will reconcile.
	}
	if in.CouponCode != "" {
		_, _ = d.DB.Exec(ctx,
			`UPDATE subscriptions SET coupon_code=$1
			   WHERE provider='razorpay' AND provider_subscription_id=$2`,
			in.CouponCode, resp.ID)
	}

	return CheckoutResult{
		URL:                    resp.ShortURL,
		ProviderSubscriptionID: resp.ID,
	}, nil
}

func (d *RazorpayDriver) Cancel(ctx context.Context, providerSubID string, atPeriodEnd bool) error {
	if !d.Configured() {
		return ErrNotConfigured
	}
	body := map[string]any{}
	if atPeriodEnd {
		body["cancel_at_cycle_end"] = 1
	} else {
		body["cancel_at_cycle_end"] = 0
	}
	raw, status, err := d.call(ctx, "POST",
		"/subscriptions/"+providerSubID+"/cancel", body)
	if err != nil {
		return err
	}
	if status >= 300 {
		return fmt.Errorf("razorpay cancel: %s", string(raw))
	}
	return nil
}

// VerifyWebhook validates the X-Razorpay-Signature header against the
// raw body using the configured webhook secret. If the secret is empty
// (typical in dev) we accept the event unverified — the .env note
// documents this trade-off.
func (d *RazorpayDriver) VerifyWebhook(r *http.Request, raw []byte) (WebhookEvent, error) {
	sig := r.Header.Get("X-Razorpay-Signature")
	if d.WebhookSecret != "" {
		mac := hmac.New(sha256.New, []byte(d.WebhookSecret))
		mac.Write(raw)
		expected := hex.EncodeToString(mac.Sum(nil))
		if !hmac.Equal([]byte(sig), []byte(expected)) {
			return WebhookEvent{}, errors.New("invalid signature")
		}
	}
	var env struct {
		Event   string         `json:"event"`
		Payload map[string]any `json:"payload"`
	}
	if err := json.Unmarshal(raw, &env); err != nil {
		return WebhookEvent{}, fmt.Errorf("bad webhook body: %w", err)
	}
	// Razorpay doesn't publish a top-level event id, so we derive a
	// stable one from the raw body — same payload twice = same id =
	// idempotent.
	sum := sha256.Sum256(raw)
	return WebhookEvent{
		ID:       hex.EncodeToString(sum[:]),
		Type:     env.Event,
		Raw:      raw,
		Received: time.Now(),
	}, nil
}

// HandleEvent applies a verified Razorpay webhook event.
//
// Events we handle:
//   subscription.activated   — first successful charge; flip status='active'
//   subscription.charged     — recurring renewal; insert invoice row
//   subscription.completed   — total_count exhausted; status='canceled'
//   subscription.cancelled   — user canceled; status='canceled'
//   subscription.paused      — Razorpay paused (mandate revoked etc.)
//   subscription.halted      — repeated failure; status='past_due'
//   subscription.pending     — payment pending; status='past_due'
//   payment.failed           — single failure under a subscription; log
func (d *RazorpayDriver) HandleEvent(ctx context.Context, ev WebhookEvent) error {
	var env struct {
		Event   string `json:"event"`
		Payload struct {
			Subscription struct {
				Entity struct {
					ID                  string         `json:"id"`
					Status              string         `json:"status"`
					CurrentStart        int64          `json:"current_start"`
					CurrentEnd          int64          `json:"current_end"`
					EndedAt             *int64         `json:"ended_at"`
					Notes               map[string]any `json:"notes"`
				} `json:"entity"`
			} `json:"subscription"`
			Payment struct {
				Entity struct {
					ID             string `json:"id"`
					Amount         int64  `json:"amount"`
					Currency       string `json:"currency"`
					Status         string `json:"status"`
					InvoiceID      string `json:"invoice_id"`
					SubscriptionID string `json:"subscription_id"`
					CreatedAt      int64  `json:"created_at"`
				} `json:"entity"`
			} `json:"payment"`
		} `json:"payload"`
	}
	if err := json.Unmarshal(ev.Raw, &env); err != nil {
		return err
	}
	subEnt := env.Payload.Subscription.Entity

	switch ev.Type {
	case "subscription.activated", "subscription.resumed":
		return updateSubscriptionStatus(ctx, d.DB, ProviderRazorpay, subEnt.ID,
			StatusActive, fromUnix(subEnt.CurrentStart), fromUnix(subEnt.CurrentEnd))
	case "subscription.completed", "subscription.cancelled":
		orgID, planName := lookupOrgAndPlan(ctx, d.DB, ProviderRazorpay, subEnt.ID)
		if err := cancelSubscriptionByProviderID(ctx, d.DB, ProviderRazorpay, subEnt.ID); err != nil {
			return err
		}
		notify(orgID, "canceled", planName)
		return nil
	case "subscription.paused":
		return updateSubscriptionStatus(ctx, d.DB, ProviderRazorpay, subEnt.ID,
			StatusPaused, nil, nil)
	case "subscription.halted", "subscription.pending":
		if err := updateSubscriptionStatus(ctx, d.DB, ProviderRazorpay, subEnt.ID,
			StatusPastDue, nil, nil); err != nil {
			return err
		}
		markPastDue(ctx, d.DB, ProviderRazorpay, subEnt.ID)
		orgID, planName := lookupOrgAndPlan(ctx, d.DB, ProviderRazorpay, subEnt.ID)
		notify(orgID, "payment_failed", planName)
		return nil
	case "subscription.charged":
		// Two effects: roll the period window forward AND record an
		// invoice from the payment entity.
		if err := updateSubscriptionStatus(ctx, d.DB, ProviderRazorpay, subEnt.ID,
			StatusActive, fromUnix(subEnt.CurrentStart), fromUnix(subEnt.CurrentEnd)); err != nil {
			return err
		}
		pay := env.Payload.Payment.Entity
		if pay.ID == "" {
			return nil
		}
		// Best-effort: pull the matching Razorpay invoice (if one exists)
		// so we can record its short_url. Razorpay raises an "invoice"
		// per cycle for subscriptions; that's where the user-facing PDF
		// lives.
		hostedURL := ""
		if pay.InvoiceID != "" {
			if raw, status, err := d.call(ctx, "GET", "/invoices/"+pay.InvoiceID, nil); err == nil && status < 300 {
				var inv struct {
					ShortURL string `json:"short_url"`
				}
				if json.Unmarshal(raw, &inv) == nil {
					hostedURL = inv.ShortURL
				}
			}
		}
		taxCents, taxPct, taxRegion := ComputeTax(pay.Amount, pay.Currency)
		if err := recordInvoice(ctx, d.DB, ProviderRazorpay,
			invoiceInsert{
				OrgID:             orgIDFromNotes(subEnt.Notes),
				ProviderSubID:     subEnt.ID,
				ProviderInvoiceID: pay.ID,
				Number:            "RZP-" + pay.ID,
				Currency:          pay.Currency,
				TotalCents:        pay.Amount,
				TaxCents:          taxCents,
				TaxRegion:         taxRegion,
				TaxPct:            taxPct,
				HostedURL:         hostedURL,
				IssuedAt:          fromUnixOrNow(pay.CreatedAt),
				Status:            "paid",
			}); err != nil {
			return err
		}
		// Bump the local coupon redemption counter on each renewal
		// charge — mirrors the Stripe path so reports match.
		var coupon *string
		_ = d.DB.QueryRow(ctx, `
			SELECT coupon_code FROM subscriptions
			 WHERE provider='razorpay' AND provider_subscription_id=$1`, subEnt.ID,
		).Scan(&coupon)
		if coupon != nil && *coupon != "" {
			_ = RecordRedemption(ctx, d.DB, *coupon)
		}
		return nil
	case "payment.failed":
		// Just bump status to past_due — no invoice row, since no money
		// moved. The next subscription event will correct it.
		return updateSubscriptionStatus(ctx, d.DB, ProviderRazorpay,
			env.Payload.Payment.Entity.SubscriptionID, StatusPastDue, nil, nil)
	}
	// Unknown / non-subscription event — record it but take no action.
	return nil
}

func orgIDFromNotes(n map[string]any) string {
	if v, ok := n["org_id"].(string); ok {
		return v
	}
	return ""
}

func fromUnix(s int64) *time.Time {
	if s <= 0 {
		return nil
	}
	t := time.Unix(s, 0).UTC()
	return &t
}
func fromUnixOrNow(s int64) time.Time {
	if s <= 0 {
		return time.Now().UTC()
	}
	return time.Unix(s, 0).UTC()
}

// upsertPendingSubscription is shared between drivers — when a checkout
// session is created, we want a placeholder row in our DB so the org's
// /settings/billing page reflects the in-flight upgrade. The webhook
// later flips status='active' (or cancels it).
func upsertPendingSubscription(ctx context.Context, db *pgxpool.Pool,
	orgID, planID, provider, providerSubID, currency string, amountCents int64) error {

	// Cancel any current active sub for the org so the partial-unique
	// index lets the new placeholder in.
	if _, err := db.Exec(ctx, `
		UPDATE subscriptions
		   SET status='canceled', canceled_at=now(), updated_at=now()
		 WHERE org_id=$1
		   AND status IN ('trialing','active','past_due','paused')
		   AND provider_subscription_id IS DISTINCT FROM $2`,
		orgID, providerSubID,
	); err != nil {
		return err
	}
	_, err := db.Exec(ctx, `
		INSERT INTO subscriptions
		  (org_id, plan_id, status, provider, provider_subscription_id,
		   currency, current_period_start)
		VALUES ($1,$2,'past_due',$3,$4,$5,now())
		ON CONFLICT DO NOTHING`,
		orgID, planID, provider, providerSubID, currency,
	)
	_ = amountCents
	return err
}

func updateSubscriptionStatus(ctx context.Context, db *pgxpool.Pool,
	provider, providerSubID, status string,
	periodStart, periodEnd *time.Time) error {

	_, err := db.Exec(ctx, `
		UPDATE subscriptions
		   SET status = $3,
		       current_period_start = COALESCE($4, current_period_start),
		       current_period_end   = COALESCE($5, current_period_end),
		       updated_at = now()
		 WHERE provider = $1 AND provider_subscription_id = $2`,
		provider, providerSubID, status, periodStart, periodEnd)
	return err
}

func cancelSubscriptionByProviderID(ctx context.Context, db *pgxpool.Pool,
	provider, providerSubID string) error {
	_, err := db.Exec(ctx, `
		UPDATE subscriptions
		   SET status='canceled', canceled_at=now(), updated_at=now()
		 WHERE provider = $1 AND provider_subscription_id = $2
		   AND status <> 'canceled'`,
		provider, providerSubID)
	return err
}

type invoiceInsert struct {
	OrgID             string
	ProviderSubID     string
	ProviderInvoiceID string
	Number            string
	Currency          string
	TotalCents        int64
	TaxCents          int64
	IssuedAt          time.Time
	Status            string
	HostedURL         string
	PDFURL            string
	TaxRegion         string
	TaxPct            float64
}

// recordInvoice writes a paid invoice row, joining back to the local
// subscription via provider_subscription_id. If the corresponding
// subscription row hasn't been seen yet (rare race) we still record the
// invoice — the foreign key is nullable.
func recordInvoice(ctx context.Context, db *pgxpool.Pool, provider string, in invoiceInsert) error {
	var subID *string
	if in.ProviderSubID != "" {
		_ = db.QueryRow(ctx, `
			SELECT id::text FROM subscriptions
			 WHERE provider=$1 AND provider_subscription_id=$2
			 LIMIT 1`, provider, in.ProviderSubID).Scan(&subID)
	}
	orgID := in.OrgID
	if orgID == "" && subID != nil {
		_ = db.QueryRow(ctx,
			`SELECT org_id::text FROM subscriptions WHERE id=$1::uuid`, *subID,
		).Scan(&orgID)
	}
	if orgID == "" {
		// Without an org id we can't record the invoice — surface the
		// gap so the operator can investigate.
		return errors.New("invoice event has no resolvable org_id")
	}
	_, err := db.Exec(ctx, `
		INSERT INTO invoices
		  (org_id, subscription_id, provider, provider_invoice_id, number,
		   status, currency, amount_cents, tax_cents, total_cents,
		   hosted_url, pdf_url, tax_region, tax_pct,
		   issued_at, paid_at)
		VALUES ($1, NULLIF($2,'')::uuid, $3, $4, $5, $6, $7,
		        $8 - $9, $9, $8,
		        NULLIF($10,''), NULLIF($11,''),
		        NULLIF($12,''), NULLIF($13,0)::numeric,
		        $14, CASE WHEN $6 = 'paid' THEN $14 ELSE NULL END)
		ON CONFLICT (provider, provider_invoice_id) WHERE provider_invoice_id IS NOT NULL
		  DO NOTHING`,
		orgID, derefStr(subID), provider, in.ProviderInvoiceID, in.Number,
		in.Status, in.Currency, in.TotalCents, in.TaxCents,
		in.HostedURL, in.PDFURL, in.TaxRegion, in.TaxPct,
		in.IssuedAt,
	)
	return err
}

func derefStr(p *string) string {
	if p == nil {
		return ""
	}
	return *p
}

// markEventProcessed is called by the dispatcher to record a processed
// (provider, event_id) tuple. Returns (alreadyProcessed=true) when the
// row already exists — the caller short-circuits to a 200 in that case.
func markEventProcessed(ctx context.Context, db *pgxpool.Pool, provider, eventID, eventType string, payload []byte) (bool, error) {
	tag, err := db.Exec(ctx, `
		INSERT INTO billing_events (provider, event_id, event_type, payload)
		VALUES ($1,$2,$3,$4::jsonb)
		ON CONFLICT (provider, event_id) DO NOTHING`,
		provider, eventID, eventType, string(payload))
	if err != nil {
		return false, err
	}
	return tag.RowsAffected() == 0, nil
}

// silence unused import warnings in case we drop pgx symbol later
var _ = pgx.ErrNoRows
