package billing

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"

	"github.com/docforge/api/internal/audit"
	"github.com/docforge/api/internal/auth"
	"github.com/jackc/pgx/v5"
)

// CustomerPortalSession returns a hosted URL the user can visit to
// update their payment method, download invoices, or change plan.
//
// Stripe ships this as a first-class feature (Billing Portal). Razorpay
// has no equivalent, so for INR subs we surface a 501 with a helpful
// hint pointing the user at the cancel-and-resubscribe flow — admins
// running on Razorpay can still manage cards from inside Razorpay's
// own customer dashboard via the email Razorpay sends after activation.
func (h *Handler) CustomerPortalSession(w http.ResponseWriter, r *http.Request) {
	c, _ := r.Context().Value(auth.UserCtxKey).(*auth.Claims)
	if c == nil {
		writeErr(w, 401, "unauthorized", "missing claims")
		return
	}
	if c.Role != auth.RoleAdmin {
		writeErr(w, 403, "forbidden", "only org admins can manage billing")
		return
	}

	// Pull the active subscription so we know which provider to talk to.
	var (
		provider string
		customer *string
	)
	err := h.DB.QueryRow(r.Context(), `
		SELECT provider, provider_customer_id
		  FROM subscriptions
		 WHERE org_id=$1
		   AND status IN ('trialing','active','past_due','paused')
		 ORDER BY created_at DESC LIMIT 1`,
		c.OrgID,
	).Scan(&provider, &customer)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			writeErr(w, 404, "no_subscription", "no active subscription")
			return
		}
		writeErr(w, 500, "db_error", err.Error())
		return
	}
	if provider != ProviderStripe {
		writeErr(w, 501, "portal_unavailable",
			"customer portal is only available for Stripe-billed plans; cancel and resubscribe to update payment method")
		return
	}
	if h.drivers.Stripe == nil || !h.drivers.Stripe.Configured() {
		writeErr(w, 501, "provider_unavailable", "stripe is not configured")
		return
	}
	if customer == nil || *customer == "" {
		writeErr(w, 409, "no_customer",
			"no Stripe customer is linked yet — wait for the first webhook then retry")
		return
	}
	stripe, ok := h.drivers.Stripe.(*StripeDriver)
	if !ok {
		writeErr(w, 500, "provider_internal", "unexpected stripe driver type")
		return
	}
	returnURL := strings.TrimSpace(r.URL.Query().Get("returnUrl"))
	if returnURL == "" {
		returnURL = "http://localhost:3000/settings/billing"
	}
	portalURL, err := stripe.CreatePortalSession(r.Context(), *customer, returnURL)
	if err != nil {
		writeErr(w, 502, "portal_failed", err.Error())
		return
	}
	audit.LogHTTP(r, h.DB, "billing.portal_opened", "subscription", "",
		map[string]any{"provider": provider})
	writeJSON(w, 200, map[string]any{"url": portalURL})
}

// CreatePortalSession is on StripeDriver — but we keep the wire here
// next to the handler so all the URL plumbing is one read.
func (d *StripeDriver) CreatePortalSession(ctx context.Context, customerID, returnURL string) (string, error) {
	if !d.Configured() {
		return "", ErrNotConfigured
	}
	form := url.Values{}
	form.Set("customer", customerID)
	form.Set("return_url", returnURL)
	req, err := http.NewRequestWithContext(ctx, "POST",
		stripeBase+"/billing_portal/sessions",
		strings.NewReader(form.Encode()))
	if err != nil {
		return "", err
	}
	req.SetBasicAuth(d.SecretKey, "")
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	resp, err := d.HTTP.Do(req)
	if err != nil {
		return "", err
	}
	defer resp.Body.Close()
	raw, _ := io.ReadAll(resp.Body)
	if resp.StatusCode >= 300 {
		return "", fmt.Errorf("stripe portal session: %s", string(raw))
	}
	var out struct {
		URL string `json:"url"`
	}
	if err := json.Unmarshal(raw, &out); err != nil || out.URL == "" {
		return "", fmt.Errorf("stripe portal session: bad response: %s", string(raw))
	}
	return out.URL, nil
}
