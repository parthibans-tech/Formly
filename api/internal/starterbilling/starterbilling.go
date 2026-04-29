// Package starterbilling owns the category-level endpoints for the
// Billing starter family (invoice, receipt, statement, GST invoice,
// thermal/e/mobile/manual/POS/cloud/subscription bills). It also
// services the Finance category (quote, purchase-order) because the
// arithmetic surface is identical.
//
// Endpoints:
//
//	POST /v1/starters/billing/recalc                — pure arithmetic, no AI
//	POST /v1/starters/billing/ai/line-items         — text → structured items
//	POST /v1/starters/billing/ai/payment-reminder   — drafts an overdue email
//
// /recalc has no AI dependency — it's the canonical place to do
// currency-aware totals so the live preview never disagrees with the
// rendered PDF. The two AI endpoints follow the established
// aitools.RunStructured pattern.
//
// Naming: we couldn't reuse `internal/billing/` (it's the Stripe /
// Razorpay subscription billing for the SaaS itself). `starterbilling`
// is unambiguous and grep-friendly.
package starterbilling

import (
	"context"
	"fmt"
	"log/slog"
	"math"
	"net/http"
	"strings"
	"time"

	"github.com/docforge/api/internal/ai"
	"github.com/docforge/api/internal/aitools"
	"github.com/docforge/api/internal/auth"
	"github.com/go-chi/chi/v5"
	"github.com/go-chi/chi/v5/middleware"
)

// Tunables — same shape as starterai's so operators don't have to
// learn a new mental model.
const (
	DefaultPromptTimeout = 180 * time.Second
	maxLineItemsTokens   = 700
	maxReminderTokens    = 600
)

// Handler holds the dependencies for every route in this package.
type Handler struct {
	AI            ai.Client
	Log           *slog.Logger
	PromptTimeout time.Duration
}

// New builds a Handler with sane defaults.
func New(c ai.Client, log *slog.Logger) *Handler {
	if c == nil {
		c = ai.Disabled{}
	}
	return &Handler{AI: c, Log: log, PromptTimeout: DefaultPromptTimeout}
}

// Mount wires the routes under the parent (already-authenticated) router.
func (h *Handler) Mount(r chi.Router) {
	budget := h.PromptTimeout + 15*time.Second
	if budget < 30*time.Second {
		budget = 30 * time.Second
	}
	timeout := middleware.Timeout(budget)

	// /recalc is pure CPU; doesn't need the AI budget but uses the same
	// timeout middleware for consistency. Returns in microseconds in
	// practice.
	r.Post("/v1/starters/billing/recalc", h.RecalcHTTP)

	r.With(timeout).Post("/v1/starters/billing/ai/line-items", h.LineItemsHTTP)
	r.With(timeout).Post("/v1/starters/billing/ai/payment-reminder", h.PaymentReminderHTTP)
}

/* ------------------------------ Recalc ------------------------------ */

// RecalcRequest computes invoice / quote / PO totals from the user's
// raw line items + tax/discount knobs. Currency is informational; the
// arithmetic is currency-agnostic.
type RecalcRequest struct {
	StarterID string         `json:"starterId,omitempty"`
	Items     []RecalcItem   `json:"items"`
	Tax       *RecalcTax     `json:"tax,omitempty"`
	Discount  *RecalcDiscount `json:"discount,omitempty"`
	Currency  string         `json:"currency,omitempty"`
	// Precision: number of fraction digits to round to. Defaults to 2.
	// Some currencies (JPY, KRW) want 0; metals/crypto want 4–8.
	Precision *int `json:"precision,omitempty"`
}

type RecalcItem struct {
	Description string  `json:"description,omitempty"`
	Qty         float64 `json:"qty"`
	UnitPrice   float64 `json:"unitPrice"`
}

type RecalcTax struct {
	Rate  float64 `json:"rate"`            // 0..1, e.g. 0.0825
	Label string  `json:"label,omitempty"` // informational, echoed back
}

type RecalcDiscount struct {
	Rate float64 `json:"rate,omitempty"` // 0..1
	Flat float64 `json:"flat,omitempty"` // currency units
}

type RecalcResponse struct {
	Subtotal       float64 `json:"subtotal"`
	DiscountAmount float64 `json:"discountAmount"`
	TaxAmount      float64 `json:"taxAmount"`
	Total          float64 `json:"total"`
	Currency       string  `json:"currency,omitempty"`
	TaxLabel       string  `json:"taxLabel,omitempty"`
}

// RecalcHTTP serves POST /v1/starters/billing/recalc. Pure function —
// no DB, no AI, no auth-tenant scoping (it's just arithmetic). Still
// requires auth because it's mounted under the authenticated router.
func (h *Handler) RecalcHTTP(w http.ResponseWriter, r *http.Request) {
	var req RecalcRequest
	if err := aitools.DecodeJSON(w, r, &req, aitools.SmallReqCap); err != nil {
		aitools.WriteErr(w, r, http.StatusBadRequest, "invalid_payload", err.Error())
		return
	}
	out := Recalc(req)
	aitools.WriteJSON(w, http.StatusOK, out)
}

// Recalc is the pure arithmetic core, exported so other packages can
// reuse it (e.g. a future quote-to-invoice conversion that needs to
// echo the original totals).
func Recalc(req RecalcRequest) RecalcResponse {
	prec := 2
	if req.Precision != nil {
		if p := *req.Precision; p >= 0 && p <= 8 {
			prec = p
		}
	}
	round := makeRounder(prec)

	subtotal := 0.0
	for _, it := range req.Items {
		// Multiply with the unrounded values; round only the line total.
		// Line-level rounding then summing is what most accounting
		// software does (avoids the "off by 1¢" from rounding before sum).
		subtotal += round(it.Qty * it.UnitPrice)
	}

	discount := 0.0
	if req.Discount != nil {
		if req.Discount.Rate > 0 {
			discount += round(subtotal * clamp(req.Discount.Rate, 0, 1))
		}
		if req.Discount.Flat > 0 {
			discount += round(req.Discount.Flat)
		}
	}
	if discount > subtotal {
		// Cap at subtotal — preventing a negative taxable base. Real
		// promotions occasionally exceed subtotal; that's a "zero out"
		// case, not a credit.
		discount = subtotal
	}

	taxable := subtotal - discount
	tax := 0.0
	taxLabel := ""
	if req.Tax != nil {
		tax = round(taxable * clamp(req.Tax.Rate, 0, 1))
		taxLabel = req.Tax.Label
	}
	total := round(taxable + tax)

	return RecalcResponse{
		Subtotal:       round(subtotal),
		DiscountAmount: round(discount),
		TaxAmount:      tax,
		Total:          total,
		Currency:       strings.ToUpper(strings.TrimSpace(req.Currency)),
		TaxLabel:       taxLabel,
	}
}

func clamp(v, lo, hi float64) float64 {
	if v < lo {
		return lo
	}
	if v > hi {
		return hi
	}
	return v
}

func makeRounder(prec int) func(float64) float64 {
	scale := math.Pow10(prec)
	return func(v float64) float64 {
		// Round half-away-from-zero — what most invoicing systems use.
		// Banker's rounding would skew totals on a series of .005 lines.
		if v < 0 {
			return -math.Floor(-v*scale+0.5) / scale
		}
		return math.Floor(v*scale+0.5) / scale
	}
}

/* ----------------------------- LineItems ----------------------------- */

// LineItemsRequest takes a free-text description and returns a list of
// structured line items. Used by the "describe what you're billing for"
// shortcut on the invoice form.
type LineItemsRequest struct {
	StarterID   string `json:"starterId,omitempty"`
	Description string `json:"description"`
	Currency    string `json:"currency,omitempty"`
}

type LineItemsResponse struct {
	Items    []RecalcItem `json:"items"`
	Provider string       `json:"provider"`
	Model    string       `json:"model,omitempty"`
}

const lineItemsSystemPrompt = `You are an invoicing assistant. Given a free-text description of work performed or goods sold, output a JSON object listing the structured line items.

Schema:
{
  "items": [
    { "description": "<short phrase>", "qty": <number>, "unitPrice": <number> }
  ]
}

Rules:
- Output only the JSON object — no commentary, no fences.
- Quantities and unit prices are numbers (not strings).
- If the input is ambiguous, make a reasonable assumption rather than refusing.
- If a single price is mentioned without a quantity, infer qty=1.
- Keep descriptions concise (under 80 chars each).`

// LineItemsHTTP serves POST /v1/starters/billing/ai/line-items.
func (h *Handler) LineItemsHTTP(w http.ResponseWriter, r *http.Request) {
	c, _ := r.Context().Value(auth.UserCtxKey).(*auth.Claims)

	var req LineItemsRequest
	if err := aitools.DecodeJSON(w, r, &req, aitools.SmallReqCap); err != nil {
		aitools.WriteErr(w, r, http.StatusBadRequest, "invalid_payload", err.Error())
		return
	}
	if strings.TrimSpace(req.Description) == "" {
		aitools.WriteErr(w, r, http.StatusBadRequest, "invalid_payload",
			"`description` must be non-empty")
		return
	}

	ctx, cancel := context.WithTimeout(r.Context(), h.PromptTimeout)
	defer cancel()

	user := fmt.Sprintf("Currency: %s\n\nDescription:\n%s",
		aitools.Coalesce(req.Currency, "USD"),
		aitools.Truncate(req.Description, 4000))

	var parsed struct {
		Items []RecalcItem `json:"items"`
	}
	res, err := aitools.RunStructured(ctx, h.AI, aitools.StructuredOpts{
		System:      lineItemsSystemPrompt,
		User:        user,
		Temperature: 0.2,
		MaxTokens:   maxLineItemsTokens,
		Out:         &parsed,
	})
	if err != nil {
		aitools.WriteAIErr(w, r, err)
		return
	}
	if !res.ParsedOK {
		// Degrade: empty items rather than 500 — UI can show "couldn't parse,
		// please type them manually".
		parsed.Items = []RecalcItem{}
	}

	if h.Log != nil && c != nil {
		h.Log.Info("starterbilling.line_items",
			"org_id", c.OrgID, "user_id", c.UserID,
			"items", len(parsed.Items),
			"provider", res.Provider, "model", res.Model)
	}

	aitools.WriteJSON(w, http.StatusOK, LineItemsResponse{
		Items:    parsed.Items,
		Provider: res.Provider,
		Model:    res.Model,
	})
}

/* --------------------------- PaymentReminder --------------------------- */

// PaymentReminderRequest drafts a follow-up email for an overdue invoice.
type PaymentReminderRequest struct {
	StarterID   string         `json:"starterId,omitempty"`
	Data        map[string]any `json:"data"`        // invoice data tree
	DaysPastDue int            `json:"daysPastDue"` // ≥ 0
	Tone        string         `json:"tone,omitempty"` // polite | firm | final
}

type PaymentReminderResponse struct {
	Subject  string `json:"subject"`
	Body     string `json:"body"`
	Provider string `json:"provider"`
	Model    string `json:"model,omitempty"`
}

const paymentReminderSystemPrompt = `You draft payment reminder emails for overdue invoices. Output strict JSON:

{ "subject": "<email subject>", "body": "<plain-text email body, with line breaks as \\n\\n between paragraphs>" }

Rules:
- Output only the JSON object — no commentary, no fences.
- Adapt formality to the requested tone:
    * polite (default): warm, assumes the invoice slipped through the cracks
    * firm: direct, references contractual due date
    * final: explicitly mentions consequences (collections, late fees) without threatening
- Length: 3-5 short paragraphs.
- Do NOT invent payment links or bank details — refer the recipient back to the original invoice.`

// PaymentReminderHTTP serves POST /v1/starters/billing/ai/payment-reminder.
func (h *Handler) PaymentReminderHTTP(w http.ResponseWriter, r *http.Request) {
	c, _ := r.Context().Value(auth.UserCtxKey).(*auth.Claims)

	var req PaymentReminderRequest
	if err := aitools.DecodeJSON(w, r, &req, aitools.MediumReqCap); err != nil {
		aitools.WriteErr(w, r, http.StatusBadRequest, "invalid_payload", err.Error())
		return
	}
	if len(req.Data) == 0 {
		aitools.WriteErr(w, r, http.StatusBadRequest, "invalid_payload",
			"`data` must be a non-empty object")
		return
	}
	if req.DaysPastDue < 0 {
		aitools.WriteErr(w, r, http.StatusBadRequest, "invalid_payload",
			"`daysPastDue` must be non-negative")
		return
	}
	tone := strings.ToLower(strings.TrimSpace(req.Tone))
	switch tone {
	case "", "polite":
		tone = "polite"
	case "firm", "final":
	default:
		aitools.WriteErr(w, r, http.StatusBadRequest, "invalid_payload",
			"`tone` must be polite, firm, or final")
		return
	}

	ctx, cancel := context.WithTimeout(r.Context(), h.PromptTimeout)
	defer cancel()

	user := fmt.Sprintf("Tone: %s\nDays past due: %d\n\nInvoice (JSON):\n%s",
		tone, req.DaysPastDue, aitools.CompactJSON(req.Data))

	var parsed struct {
		Subject string `json:"subject"`
		Body    string `json:"body"`
	}
	res, err := aitools.RunStructured(ctx, h.AI, aitools.StructuredOpts{
		System:      paymentReminderSystemPrompt,
		User:        user,
		Temperature: 0.5,
		MaxTokens:   maxReminderTokens,
		Out:         &parsed,
	})
	if err != nil {
		aitools.WriteAIErr(w, r, err)
		return
	}
	if !res.ParsedOK {
		// Degrade to raw output as the body — at least the user gets text
		// they can edit, instead of an empty modal.
		parsed.Subject = "Payment reminder"
		parsed.Body = strings.TrimSpace(res.Raw)
	}

	if h.Log != nil && c != nil {
		h.Log.Info("starterbilling.payment_reminder",
			"org_id", c.OrgID, "user_id", c.UserID,
			"tone", tone, "days_past_due", req.DaysPastDue,
			"provider", res.Provider, "model", res.Model)
	}

	aitools.WriteJSON(w, http.StatusOK, PaymentReminderResponse{
		Subject:  strings.TrimSpace(parsed.Subject),
		Body:     strings.TrimSpace(parsed.Body),
		Provider: res.Provider,
		Model:    res.Model,
	})
}
