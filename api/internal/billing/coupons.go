package billing

import (
	"context"
	"errors"
	"net/http"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

// Coupon mirrors the row in `coupons`. Only the fields the frontend
// or checkout calc cares about are exported; the row itself stays a
// flat record, no derived "currentlyValid" boolean — callers run
// Validate() at the moment of redemption instead.
type Coupon struct {
	Code            string     `json:"code"`
	Description     *string    `json:"description,omitempty"`
	PercentOff      *int       `json:"percentOff,omitempty"`
	AmountOffCents  *int64     `json:"amountOffCents,omitempty"`
	Currency        *string    `json:"currency,omitempty"`
	Duration        string     `json:"duration"`
	DurationMonths  *int       `json:"durationMonths,omitempty"`
	MaxRedemptions  *int       `json:"maxRedemptions,omitempty"`
	Redemptions     int        `json:"redemptions"`
	RedeemBy        *time.Time `json:"redeemBy,omitempty"`
	AppliesToPlans  []string   `json:"appliesToPlans"`
	Active          bool       `json:"active"`
}

// LookupCoupon resolves a code (case-insensitive, trimmed) to its row.
func LookupCoupon(ctx context.Context, db *pgxpool.Pool, code string) (*Coupon, error) {
	code = strings.TrimSpace(strings.ToUpper(code))
	if code == "" {
		return nil, errors.New("coupon code is empty")
	}
	var c Coupon
	err := db.QueryRow(ctx, `
		SELECT code, description, percent_off, amount_off_cents, currency,
		       duration, duration_months, max_redemptions, redemptions,
		       redeem_by, applies_to_plans, active
		  FROM coupons WHERE code = $1`, code,
	).Scan(&c.Code, &c.Description, &c.PercentOff, &c.AmountOffCents,
		&c.Currency, &c.Duration, &c.DurationMonths, &c.MaxRedemptions,
		&c.Redemptions, &c.RedeemBy, &c.AppliesToPlans, &c.Active)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return nil, errors.New("coupon not found")
		}
		return nil, err
	}
	return &c, nil
}

// Validate is called from checkout to confirm the coupon is still
// usable for the given plan + currency. Returns a user-facing message
// on failure.
func (c *Coupon) Validate(planID, currency string, amountCents int64) error {
	if !c.Active {
		return errors.New("coupon is no longer active")
	}
	if c.RedeemBy != nil && time.Now().After(*c.RedeemBy) {
		return errors.New("coupon has expired")
	}
	if c.MaxRedemptions != nil && c.Redemptions >= *c.MaxRedemptions {
		return errors.New("coupon has reached its redemption limit")
	}
	if c.Currency != nil && !strings.EqualFold(*c.Currency, currency) {
		return errors.New("coupon is not valid for this currency")
	}
	if len(c.AppliesToPlans) > 0 {
		ok := false
		for _, p := range c.AppliesToPlans {
			if p == planID {
				ok = true
				break
			}
		}
		if !ok {
			return errors.New("coupon does not apply to this plan")
		}
	}
	if c.PercentOff == nil && c.AmountOffCents == nil {
		return errors.New("coupon has no discount configured")
	}
	if c.AmountOffCents != nil && *c.AmountOffCents > amountCents {
		return errors.New("coupon discount exceeds plan price")
	}
	return nil
}

// Apply returns the discounted total in the same minor unit as the
// input. Discount is rounded down to whole cents.
func (c *Coupon) Apply(amountCents int64) int64 {
	if c.PercentOff != nil && *c.PercentOff > 0 {
		return amountCents - (amountCents * int64(*c.PercentOff) / 100)
	}
	if c.AmountOffCents != nil {
		out := amountCents - *c.AmountOffCents
		if out < 0 {
			return 0
		}
		return out
	}
	return amountCents
}

// RecordRedemption bumps the redemption counter. Called from the
// activation webhook (Razorpay subscription.activated, Stripe
// invoice.paid) so we don't increment on abandoned checkouts.
func RecordRedemption(ctx context.Context, db *pgxpool.Pool, code string) error {
	if code == "" {
		return nil
	}
	_, err := db.Exec(ctx,
		`UPDATE coupons SET redemptions = redemptions + 1
		   WHERE code = $1`, code)
	return err
}

// -- HTTP handlers -------------------------------------------------------

// PreviewCoupon implements POST /v1/billing/coupons/preview. The frontend
// hits this from the upgrade dialog so the user sees the discounted
// price before redirecting to the provider.
func (h *Handler) PreviewCoupon(w http.ResponseWriter, r *http.Request) {
	q := r.URL.Query()
	code := strings.TrimSpace(q.Get("code"))
	planID := strings.TrimSpace(q.Get("planId"))
	if code == "" || planID == "" {
		writeErr(w, 400, "missing_params", "code and planId are required")
		return
	}
	coupon, err := LookupCoupon(r.Context(), h.DB, code)
	if err != nil {
		writeErr(w, 404, "coupon_not_found", err.Error())
		return
	}
	var (
		amount   int64
		currency string
	)
	if err := h.DB.QueryRow(r.Context(),
		`SELECT amount_cents, currency FROM plans WHERE id=$1 AND active=true`,
		planID,
	).Scan(&amount, &currency); err != nil {
		writeErr(w, 404, "plan_not_found", "plan not found")
		return
	}
	if err := coupon.Validate(planID, currency, amount); err != nil {
		writeErr(w, 400, "coupon_invalid", err.Error())
		return
	}
	writeJSON(w, 200, map[string]any{
		"coupon":         coupon,
		"originalCents":  amount,
		"discountedCents": coupon.Apply(amount),
		"currency":       currency,
	})
}
