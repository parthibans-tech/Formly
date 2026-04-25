package billing

import (
	"os"
	"strconv"
	"strings"
)

// Tax computation is intentionally simple: a single configurable rate
// per currency, read from env at process start. Plenty of B2B SaaS
// shops in this stage of life run tax this way; "real" jurisdictional
// tax (state-by-state US, GSTIN-aware India) is a much bigger lift and
// usually outsourced to a service like Stripe Tax once volume warrants.
//
// Env keys (defaults are 0):
//   TAX_INR_PCT   — e.g. "18" for 18% GST on Indian invoices
//   TAX_USD_PCT   — e.g. "8.875" for NY-style sales tax on USD invoices
//   TAX_REGION_INR — label written to invoices.tax_region (default "GST")
//   TAX_REGION_USD — label written to invoices.tax_region (default "Sales Tax")

type taxRule struct {
	Pct    float64
	Region string
}

func loadTaxRule(currency string) taxRule {
	switch strings.ToUpper(currency) {
	case "INR":
		return taxRule{
			Pct:    parseFloatEnv("TAX_INR_PCT"),
			Region: envOr("TAX_REGION_INR", "GST"),
		}
	case "USD":
		return taxRule{
			Pct:    parseFloatEnv("TAX_USD_PCT"),
			Region: envOr("TAX_REGION_USD", "Sales Tax"),
		}
	}
	return taxRule{}
}

// ComputeTax returns the tax amount in the same minor unit as the
// subtotal, rounded down to whole cents. Zero when the configured rate
// is zero, when the currency isn't recognised, or when the subtotal
// is non-positive.
func ComputeTax(subtotalCents int64, currency string) (int64, float64, string) {
	rule := loadTaxRule(currency)
	if rule.Pct <= 0 || subtotalCents <= 0 {
		return 0, 0, ""
	}
	tax := int64(float64(subtotalCents) * rule.Pct / 100)
	return tax, rule.Pct, rule.Region
}

func parseFloatEnv(k string) float64 {
	v := strings.TrimSpace(os.Getenv(k))
	if v == "" {
		return 0
	}
	f, err := strconv.ParseFloat(v, 64)
	if err != nil {
		return 0
	}
	return f
}

func envOr(k, fallback string) string {
	if v := strings.TrimSpace(os.Getenv(k)); v != "" {
		return v
	}
	return fallback
}
