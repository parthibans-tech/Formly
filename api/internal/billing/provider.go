// Provider abstraction for live billing integrations (Phase 4b).
//
// We support two live providers:
//
//   - Razorpay  — INR plans. Subscription model is "create plan +
//                 customer + subscription, redirect user to short_url".
//                 Webhooks confirm activation, charges, cancels.
//   - Stripe    — USD (and other multi-currency) plans. Stripe Checkout
//                 hands us a hosted session URL; webhooks reconcile.
//
// The two providers have very different APIs, so we keep the interface
// small and focused on what the handlers need:
//
//   - StartCheckout — initiate a paid subscription, return a redirect URL
//   - CancelSubscription — cancel (immediately or at period end)
//   - VerifyWebhook — parse + signature-check an incoming webhook
//   - HandleEvent  — apply a verified event to our DB
//
// The "manual" provider implemented in billing.go handles super-admin
// assignments; it never appears here because there's no remote system to
// talk to.
package billing

import (
	"context"
	"errors"
	"net/http"
	"strings"
	"time"
)

// Provider is satisfied by both Razorpay and Stripe drivers.
type Provider interface {
	// Name is the provider key stored on subscriptions.provider.
	Name() string

	// Configured reports whether the driver has credentials. Disabled
	// drivers are present in the registry but reject calls with a clear
	// error, so we don't accidentally route a user to an unconfigured
	// payment page.
	Configured() bool

	// StartCheckout creates the remote subscription / checkout session
	// and returns a redirect URL for the user.
	//
	// On success the implementation has *also* recorded a "pending"
	// subscription row (status='trialing' if a trial applies, otherwise
	// 'past_due' until the activation webhook lands) so the org's
	// /settings/billing page reflects the in-flight upgrade.
	StartCheckout(ctx context.Context, in CheckoutInput) (CheckoutResult, error)

	// Cancel ends the remote subscription. atPeriodEnd=true defers the
	// cutoff to the natural cycle boundary; false cancels now.
	Cancel(ctx context.Context, providerSubscriptionID string, atPeriodEnd bool) error

	// VerifyWebhook authenticates an incoming webhook request and
	// returns a normalized event the dispatcher can switch on. The
	// implementation is responsible for reading r.Body — handlers
	// should not touch the body before calling this.
	VerifyWebhook(r *http.Request, rawBody []byte) (WebhookEvent, error)

	// HandleEvent applies a verified event to the DB. The handler is
	// responsible for idempotency — the dispatcher already guarantees
	// each (provider, event_id) tuple is processed at most once via
	// the billing_events table, so HandleEvent only sees fresh events.
	HandleEvent(ctx context.Context, ev WebhookEvent) error
}

type CheckoutInput struct {
	OrgID       string
	OrgName     string
	UserEmail   string
	UserName    string
	UserID      string
	PlanID      string // internal plan id (matches plans.id)
	SuccessURL  string // optional return URL (Stripe only)
	CancelURL   string

	// Coupon code already validated by the handler. Drivers pass this
	// through to the provider (Stripe `discounts[0][coupon]`) and store
	// it on the local subscription row so renewals know whether the
	// discount still applies.
	CouponCode string
}

type CheckoutResult struct {
	URL                    string
	ProviderSubscriptionID string
	ProviderCustomerID     string
}

// WebhookEvent is the normalized shape passed from VerifyWebhook to
// HandleEvent. Type strings stay raw (provider-specific) so each driver
// can switch on whatever it wants; dispatch only uses ID for
// idempotency.
type WebhookEvent struct {
	ID        string
	Type      string
	Raw       []byte
	Received  time.Time
}

// ErrNotConfigured is returned by Configured() == false drivers. The
// HTTP handlers translate this into a 501 with a helpful message.
var ErrNotConfigured = errors.New("billing provider is not configured")

// ChooseProvider picks Razorpay for INR plans and Stripe for everything
// else (typically USD). This keeps a one-to-one mapping between
// currency and provider in Phase 4b — multi-provider per currency lands
// only when there's a business reason.
func ChooseProvider(currency string) string {
	switch strings.ToUpper(currency) {
	case "INR":
		return ProviderRazorpay
	default:
		return ProviderStripe
	}
}
