-- Phase 4c: enforcement scaffolding, coupons, and tax columns.
--
-- Coupons are tracked locally — even when the live provider also stores
-- the same code (Stripe coupons / Razorpay offers) the local row is the
-- source of truth for validation, redemption counting, and applies_to
-- restrictions. Webhooks just add provider-side discounts; the local
-- redemption row is what stops a code being used twice.

CREATE TABLE IF NOT EXISTS coupons (
    code               TEXT PRIMARY KEY,
    description        TEXT,
    percent_off        INT,                       -- 1..100, or NULL when amount-based
    amount_off_cents   BIGINT,                    -- absolute discount in plan currency
    currency           TEXT,                      -- restricts to a single currency when set
    duration           TEXT NOT NULL DEFAULT 'once', -- once | forever | repeating(N months)
    duration_months    INT,
    max_redemptions    INT,                       -- NULL = unlimited
    redemptions        INT NOT NULL DEFAULT 0,
    redeem_by          TIMESTAMPTZ,
    applies_to_plans   TEXT[] NOT NULL DEFAULT '{}', -- empty = all plans
    active             BOOLEAN NOT NULL DEFAULT true,
    created_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Track which coupon a subscription was started with so renewals know
-- whether the discount still applies (duration='repeating' / 'forever').
ALTER TABLE subscriptions
    ADD COLUMN IF NOT EXISTS coupon_code TEXT REFERENCES coupons(code);

-- Tax columns on invoices were already in 031, but we add region tracking
-- so reports can split by jurisdiction.
ALTER TABLE invoices
    ADD COLUMN IF NOT EXISTS tax_region TEXT,
    ADD COLUMN IF NOT EXISTS tax_pct    NUMERIC(6,3);

-- Track per-org dunning state so the cron knows when we last warned the
-- admin and how many notices have been sent before we hard-cancel.
ALTER TABLE subscriptions
    ADD COLUMN IF NOT EXISTS past_due_since TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS dunning_notices INT NOT NULL DEFAULT 0,
    ADD COLUMN IF NOT EXISTS last_dunning_at TIMESTAMPTZ;

-- Seed a couple of demo coupons so /settings/billing has something to
-- redeem against in dev. These are idempotent — feel free to drop in
-- production seeds if/when ops need real codes.
INSERT INTO coupons (code, description, percent_off, duration, max_redemptions, applies_to_plans)
VALUES
  ('LAUNCH20', 'Launch promo — 20% off forever',          20, 'forever',   NULL, '{}'),
  ('TRIAL50',  'Welcome — 50% off first month',           50, 'once',      NULL, ARRAY['pro_inr_monthly','pro_usd_monthly']),
  ('YEAR15',   'Annual savings — 15% off the first year', 15, 'once',      NULL, ARRAY['pro_inr_yearly','pro_usd_yearly'])
ON CONFLICT (code) DO NOTHING;
