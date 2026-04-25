-- Phase 4c+: editable billing profile per org.
--
-- Plans / subscriptions / invoices already exist; what was missing is the
-- "who is this org legally, and where do invoices get sent?" record.
-- Admins set this once and it gets stamped onto invoice PDFs and provider
-- customer objects (Stripe Customer.address, Razorpay invoice.billing_to).
--
-- One row per org. Created lazily on first PUT — until then the page
-- shows an empty form.

CREATE TABLE IF NOT EXISTS billing_profiles (
    org_id          UUID PRIMARY KEY REFERENCES organizations(id) ON DELETE CASCADE,
    company_name    TEXT NOT NULL DEFAULT '',
    billing_email   TEXT NOT NULL DEFAULT '',
    billing_phone   TEXT NOT NULL DEFAULT '',
    -- tax_id_label is the regional name for whatever tax_id holds:
    -- GSTIN (IN), VAT (EU/UK), ABN (AU), EIN (US), etc. Free text so we
    -- don't have to ship a migration every time a new region appears.
    tax_id          TEXT NOT NULL DEFAULT '',
    tax_id_label    TEXT NOT NULL DEFAULT '',
    address_line1   TEXT NOT NULL DEFAULT '',
    address_line2   TEXT NOT NULL DEFAULT '',
    city            TEXT NOT NULL DEFAULT '',
    region          TEXT NOT NULL DEFAULT '',
    postal_code     TEXT NOT NULL DEFAULT '',
    country         TEXT NOT NULL DEFAULT '',
    notes           TEXT NOT NULL DEFAULT '',
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_by      UUID REFERENCES users(id) ON DELETE SET NULL
);
