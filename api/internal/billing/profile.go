package billing

import (
	"encoding/json"
	"errors"
	"net/http"
	"strings"
	"time"

	"github.com/docforge/api/internal/audit"
	"github.com/docforge/api/internal/auth"
	"github.com/jackc/pgx/v5"
)

// profile is the editable billing identity for an org. Stored in
// billing_profiles (one row per org); zero values are returned when no
// row exists yet so the UI can render an empty form on first visit.
type profile struct {
	CompanyName  string     `json:"companyName"`
	BillingEmail string     `json:"billingEmail"`
	BillingPhone string     `json:"billingPhone"`
	TaxID        string     `json:"taxId"`
	TaxIDLabel   string     `json:"taxIdLabel"`
	AddressLine1 string     `json:"addressLine1"`
	AddressLine2 string     `json:"addressLine2"`
	City         string     `json:"city"`
	Region       string     `json:"region"`
	PostalCode   string     `json:"postalCode"`
	Country      string     `json:"country"`
	Notes        string     `json:"notes"`
	UpdatedAt    *time.Time `json:"updatedAt,omitempty"`
	UpdatedBy    *string    `json:"updatedBy,omitempty"`
}

// GetProfile answers GET /v1/billing/profile. Any authed member of the
// org can read it (it's not secret — the data appears on every invoice).
func (h *Handler) GetProfile(w http.ResponseWriter, r *http.Request) {
	c, _ := r.Context().Value(auth.UserCtxKey).(*auth.Claims)
	if c == nil {
		writeErr(w, 401, "unauthorized", "missing claims")
		return
	}
	var p profile
	var updatedAt time.Time
	var updatedBy *string
	err := h.DB.QueryRow(r.Context(), `
		SELECT company_name, billing_email, billing_phone,
		       tax_id, tax_id_label,
		       address_line1, address_line2, city, region, postal_code,
		       country, notes, updated_at, updated_by::text
		  FROM billing_profiles
		 WHERE org_id = $1`, c.OrgID,
	).Scan(
		&p.CompanyName, &p.BillingEmail, &p.BillingPhone,
		&p.TaxID, &p.TaxIDLabel,
		&p.AddressLine1, &p.AddressLine2, &p.City, &p.Region, &p.PostalCode,
		&p.Country, &p.Notes, &updatedAt, &updatedBy,
	)
	if err != nil && !errors.Is(err, pgx.ErrNoRows) {
		writeErr(w, 500, "db_error", err.Error())
		return
	}
	if err == nil {
		p.UpdatedAt = &updatedAt
		p.UpdatedBy = updatedBy
	}
	writeJSON(w, 200, p)
}

// PutProfile answers PUT /v1/billing/profile. Admin-only; upserts the
// row and writes an audit event. All fields are optional individually
// but the body must be valid JSON.
func (h *Handler) PutProfile(w http.ResponseWriter, r *http.Request) {
	c, _ := r.Context().Value(auth.UserCtxKey).(*auth.Claims)
	if c == nil {
		writeErr(w, 401, "unauthorized", "missing claims")
		return
	}
	if !c.IsAdmin() {
		writeErr(w, 403, "forbidden", "admin role required")
		return
	}
	var in profile
	if err := json.NewDecoder(r.Body).Decode(&in); err != nil {
		writeErr(w, 400, "invalid_body", err.Error())
		return
	}
	in.CompanyName = strings.TrimSpace(in.CompanyName)
	in.BillingEmail = strings.TrimSpace(in.BillingEmail)
	in.BillingPhone = strings.TrimSpace(in.BillingPhone)
	in.TaxID = strings.TrimSpace(in.TaxID)
	in.TaxIDLabel = strings.TrimSpace(in.TaxIDLabel)
	in.AddressLine1 = strings.TrimSpace(in.AddressLine1)
	in.AddressLine2 = strings.TrimSpace(in.AddressLine2)
	in.City = strings.TrimSpace(in.City)
	in.Region = strings.TrimSpace(in.Region)
	in.PostalCode = strings.TrimSpace(in.PostalCode)
	in.Country = strings.TrimSpace(in.Country)
	in.Notes = strings.TrimSpace(in.Notes)

	// Light validation — keep these loose so admins outside the
	// validator's tested locales aren't blocked.
	if len(in.CompanyName) > 200 ||
		len(in.BillingEmail) > 200 ||
		len(in.BillingPhone) > 40 ||
		len(in.TaxID) > 60 ||
		len(in.TaxIDLabel) > 40 ||
		len(in.AddressLine1) > 200 ||
		len(in.AddressLine2) > 200 ||
		len(in.City) > 120 ||
		len(in.Region) > 120 ||
		len(in.PostalCode) > 40 ||
		len(in.Country) > 80 ||
		len(in.Notes) > 1000 {
		writeErr(w, 400, "field_too_long", "one or more fields exceed length limits")
		return
	}
	if in.BillingEmail != "" && !strings.Contains(in.BillingEmail, "@") {
		writeErr(w, 400, "invalid_email", "billingEmail must be an email address")
		return
	}

	if _, err := h.DB.Exec(r.Context(), `
		INSERT INTO billing_profiles (
			org_id, company_name, billing_email, billing_phone,
			tax_id, tax_id_label,
			address_line1, address_line2, city, region, postal_code,
			country, notes, updated_at, updated_by
		) VALUES (
			$1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, NOW(), $14
		)
		ON CONFLICT (org_id) DO UPDATE SET
			company_name  = EXCLUDED.company_name,
			billing_email = EXCLUDED.billing_email,
			billing_phone = EXCLUDED.billing_phone,
			tax_id        = EXCLUDED.tax_id,
			tax_id_label  = EXCLUDED.tax_id_label,
			address_line1 = EXCLUDED.address_line1,
			address_line2 = EXCLUDED.address_line2,
			city          = EXCLUDED.city,
			region        = EXCLUDED.region,
			postal_code   = EXCLUDED.postal_code,
			country       = EXCLUDED.country,
			notes         = EXCLUDED.notes,
			updated_at    = NOW(),
			updated_by    = EXCLUDED.updated_by`,
		c.OrgID, in.CompanyName, in.BillingEmail, in.BillingPhone,
		in.TaxID, in.TaxIDLabel,
		in.AddressLine1, in.AddressLine2, in.City, in.Region, in.PostalCode,
		in.Country, in.Notes, c.UserID,
	); err != nil {
		writeErr(w, 500, "db_error", err.Error())
		return
	}

	audit.LogHTTP(r, h.DB, "billing.profile_updated", "org", c.OrgID,
		map[string]any{
			"hasCompanyName": in.CompanyName != "",
			"hasTaxId":       in.TaxID != "",
			"country":        in.Country,
		})

	h.GetProfile(w, r)
}
