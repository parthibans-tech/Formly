-- Phase 4a: subscription + billing.
--
-- Four tables build the subscription module:
--
--   plans              — immutable price catalog. Seeded inline below;
--                        new rows can be added later but rows are never
--                        deleted (subscriptions reference them by id).
--   subscriptions      — one row per org. Holds the currently-active
--                        plan, status, trial deadline, and provider
--                        identifiers when the org has linked
--                        Razorpay / Stripe.
--   invoices           — billing history. Manual provider writes a row
--                        per super-admin assignment so the org sees
--                        something on /settings/billing; Razorpay/Stripe
--                        webhooks will UPSERT real rows in Phase 4b.
--   payment_methods    — saved cards / UPI handles. Phase 4a does not
--                        write to this; the table exists so 4b can
--                        attach without another migration.
--
-- The plan id is a stable string (not a UUID) so SQL backfills and the
-- seed migration stay readable. Each plan binds an interval + currency,
-- which means "Pro USD monthly" and "Pro INR monthly" are separate rows
-- — necessary for clean joins to currency-specific provider price ids.
--
-- organizations.plan (added in 029) is replaced by the subscriptions
-- join. We drop it here so there's only one source of truth for the
-- org's tier; max_users / max_storage_bytes stay as per-org overrides
-- that win against the plan default when set.

CREATE TABLE IF NOT EXISTS plans (
    id                 TEXT PRIMARY KEY,
    name               TEXT NOT NULL,
    tier               TEXT NOT NULL,           -- free | pro | enterprise
    currency           TEXT NOT NULL DEFAULT 'INR',
    interval           TEXT NOT NULL DEFAULT 'month', -- month | year | none
    amount_cents       BIGINT,                  -- NULL = "contact us"
    max_users          INT,                     -- NULL = unlimited
    max_storage_bytes  BIGINT,                  -- NULL = unlimited
    features           JSONB NOT NULL DEFAULT '{}'::jsonb,
    razorpay_plan_id   TEXT,
    stripe_price_id    TEXT,
    active             BOOLEAN NOT NULL DEFAULT true,
    sort_order         INT NOT NULL DEFAULT 100,
    created_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS plans_tier_active_idx
    ON plans(tier, active) WHERE active;

CREATE TABLE IF NOT EXISTS subscriptions (
    id                       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id                   UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    plan_id                  TEXT NOT NULL REFERENCES plans(id),
    status                   TEXT NOT NULL,           -- trialing | active | past_due | canceled | paused
    provider                 TEXT NOT NULL DEFAULT 'manual', -- manual | razorpay | stripe
    provider_subscription_id TEXT,
    provider_customer_id     TEXT,
    currency                 TEXT NOT NULL DEFAULT 'INR',
    trial_ends_at            TIMESTAMPTZ,
    current_period_start     TIMESTAMPTZ,
    current_period_end       TIMESTAMPTZ,
    cancel_at_period_end     BOOLEAN NOT NULL DEFAULT false,
    canceled_at              TIMESTAMPTZ,
    created_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at               TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- One active subscription per org. The partial unique index is what
-- prevents accidental double-billing when the manual handler races a
-- webhook reconciliation.
CREATE UNIQUE INDEX IF NOT EXISTS subscriptions_org_active_idx
    ON subscriptions(org_id)
    WHERE status IN ('trialing','active','past_due','paused');

CREATE INDEX IF NOT EXISTS subscriptions_provider_idx
    ON subscriptions(provider, provider_subscription_id)
    WHERE provider_subscription_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS invoices (
    id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id               UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    subscription_id      UUID REFERENCES subscriptions(id) ON DELETE SET NULL,
    provider             TEXT NOT NULL DEFAULT 'manual',
    provider_invoice_id  TEXT,
    number               TEXT NOT NULL,            -- human-facing label
    status               TEXT NOT NULL DEFAULT 'paid', -- draft|open|paid|void|uncollectible
    currency             TEXT NOT NULL DEFAULT 'INR',
    amount_cents         BIGINT NOT NULL DEFAULT 0,
    tax_cents            BIGINT NOT NULL DEFAULT 0,
    total_cents          BIGINT NOT NULL DEFAULT 0,
    pdf_url              TEXT,
    hosted_url           TEXT,
    period_start         TIMESTAMPTZ,
    period_end           TIMESTAMPTZ,
    issued_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
    paid_at              TIMESTAMPTZ,
    created_at           TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS invoices_org_issued_idx
    ON invoices(org_id, issued_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS invoices_provider_uniq_idx
    ON invoices(provider, provider_invoice_id)
    WHERE provider_invoice_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS payment_methods (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id          UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    provider        TEXT NOT NULL,
    provider_pm_id  TEXT NOT NULL,
    brand           TEXT,
    last4           TEXT,
    exp_month       INT,
    exp_year        INT,
    is_default      BOOLEAN NOT NULL DEFAULT false,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS payment_methods_org_idx ON payment_methods(org_id);
CREATE UNIQUE INDEX IF NOT EXISTS payment_methods_provider_uniq_idx
    ON payment_methods(provider, provider_pm_id);

-- Webhook event log (idempotency). Each provider event is recorded once
-- by id; replays no-op. Phase 4b reads/writes this; we create it now to
-- avoid a follow-up migration.
CREATE TABLE IF NOT EXISTS billing_events (
    id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    provider     TEXT NOT NULL,
    event_id     TEXT NOT NULL,
    event_type   TEXT NOT NULL,
    payload      JSONB NOT NULL,
    received_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (provider, event_id)
);

-- Plan catalog seed. INR amounts are in paise (₹1 = 100). USD amounts
-- are in cents. Annual prices give ~2 months free vs monthly × 12 to
-- reward upfront commitment.
INSERT INTO plans (id, name, tier, currency, interval, amount_cents,
                   max_users, max_storage_bytes, features, sort_order)
VALUES
  ('free',
     'Free', 'free', 'INR', 'none', 0,
     3, 1073741824,  -- 3 users, 1 GB
     '{"templates":10,"share_links":true,"api_keys":false}'::jsonb, 10),

  ('pro_inr_monthly',
     'Pro (INR / monthly)', 'pro', 'INR', 'month', 249900,
     25, 53687091200, -- 25 users, 50 GB
     '{"templates":-1,"share_links":true,"api_keys":true,"webhooks":true}'::jsonb, 20),

  ('pro_inr_yearly',
     'Pro (INR / yearly)', 'pro', 'INR', 'year', 2499000,
     25, 53687091200,
     '{"templates":-1,"share_links":true,"api_keys":true,"webhooks":true}'::jsonb, 21),

  ('pro_usd_monthly',
     'Pro (USD / monthly)', 'pro', 'USD', 'month', 2900,
     25, 53687091200,
     '{"templates":-1,"share_links":true,"api_keys":true,"webhooks":true}'::jsonb, 30),

  ('pro_usd_yearly',
     'Pro (USD / yearly)', 'pro', 'USD', 'year', 29000,
     25, 53687091200,
     '{"templates":-1,"share_links":true,"api_keys":true,"webhooks":true}'::jsonb, 31),

  ('enterprise',
     'Enterprise', 'enterprise', 'INR', 'none', NULL,
     NULL, NULL,
     '{"templates":-1,"share_links":true,"api_keys":true,"webhooks":true,"sso":true,"sla":true}'::jsonb, 90)
ON CONFLICT (id) DO NOTHING;

-- Backfill: every existing org gets a free-tier subscription so the
-- billing UI never has to render an "unknown plan" state.
INSERT INTO subscriptions (org_id, plan_id, status, provider, currency)
SELECT o.id, 'free', 'active', 'manual', 'INR'
  FROM organizations o
 WHERE NOT EXISTS (
       SELECT 1 FROM subscriptions s
        WHERE s.org_id = o.id
          AND s.status IN ('trialing','active','past_due','paused')
 );

-- Drop the redundant plan label column from organizations. Effective
-- tier now comes from subscriptions.plan_id.
ALTER TABLE organizations DROP COLUMN IF EXISTS plan;
