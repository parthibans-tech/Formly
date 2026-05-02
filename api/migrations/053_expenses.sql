-- 053_expenses.sql
--
-- Operator-tracked operating expenses, paired with the existing
-- `invoices` table to give super-admins a real "P&L" view of the
-- product (revenue from invoices, expense from this table, net = the
-- difference).
--
-- Why a new table instead of repurposing `invoices`:
--
--   1. `invoices` is the customer-facing billing artefact — it has a
--      hard FK to `organizations`, status semantics tied to the
--      payment-provider state machine, and a number generated for the
--      end customer. Stuffing internal cost rows in there would
--      pollute every `WHERE status='paid'` query that drives the
--      revenue dashboard.
--
--   2. Expenses have a different lifecycle: they're recorded after the
--      fact by an operator (no provider, no webhook), often recurring
--      (a monthly AWS bill is one row that conceptually re-occurs),
--      and need a category for breakdown rendering.
--
-- The `recurrence` column lets a single row represent a recurring
-- charge without spawning N rows per period — the dashboard normalises
-- it into a "monthly run rate" the same way subscriptions normalise to
-- MRR. This keeps data entry cheap (one row per recurring vendor)
-- while still producing a clean monthly cost figure.
--
-- Soft-delete via `deleted_at` because expense entries are part of the
-- audit trail; an operator who fat-fingers a $50,000 row should be
-- able to recover it without a DBA.

CREATE TABLE IF NOT EXISTS expenses (
    id              UUID         PRIMARY KEY DEFAULT gen_random_uuid(),

    -- Categorisation. Free-text rather than an enum because operators
    -- need to add new buckets without a migration; the dashboard
    -- aggregates by whatever lands here. The standard set the UI
    -- suggests: infrastructure, payroll, software, marketing, legal,
    -- payment_fees, taxes, office, other.
    category        TEXT         NOT NULL,

    -- Free-text vendor / payee. "AWS", "Razorpay", "John Doe (contractor)".
    vendor          TEXT         NOT NULL DEFAULT '',

    -- Money: cents in the row's currency. Same convention as invoices
    -- so the dashboard can SUM them with the same units.
    amount_cents    BIGINT       NOT NULL,
    currency        TEXT         NOT NULL DEFAULT 'INR',

    -- The day the cost actually occurred. For recurring rows, this is
    -- the most recent occurrence; the dashboard computes the projected
    -- monthly run rate from `recurrence` regardless of date.
    occurred_on     DATE         NOT NULL DEFAULT CURRENT_DATE,

    -- one_time | monthly | quarterly | yearly
    --
    -- Anything other than one_time contributes to the monthly run-rate
    -- calc (yearly / 12, quarterly / 3, monthly /1). one_time only
    -- counts toward the in-window total.
    recurrence      TEXT         NOT NULL DEFAULT 'one_time',

    notes           TEXT         NOT NULL DEFAULT '',

    -- Audit ownership: who entered this row, and when. Soft-delete
    -- support so a fat-finger is recoverable.
    created_by      UUID                  REFERENCES users(id) ON DELETE SET NULL,
    created_at      TIMESTAMPTZ  NOT NULL DEFAULT now(),
    updated_at      TIMESTAMPTZ  NOT NULL DEFAULT now(),
    deleted_at      TIMESTAMPTZ,

    CONSTRAINT expenses_recurrence_chk
        CHECK (recurrence IN ('one_time','monthly','quarterly','yearly')),
    CONSTRAINT expenses_amount_chk
        CHECK (amount_cents >= 0)
);

-- Hot indices: dashboard always filters by (deleted_at IS NULL) and
-- often by date window or category.
CREATE INDEX IF NOT EXISTS expenses_occurred_on_idx
    ON expenses (occurred_on DESC)
    WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS expenses_category_idx
    ON expenses (category)
    WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS expenses_recurring_idx
    ON expenses (recurrence)
    WHERE deleted_at IS NULL AND recurrence <> 'one_time';
