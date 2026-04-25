-- Adds an optional marketing description on plans for the super-admin
-- catalog editor. The storefront still works without it (COALESCE on
-- read), so this is additive — no app code change required to deploy.

ALTER TABLE plans
    ADD COLUMN IF NOT EXISTS description TEXT NOT NULL DEFAULT '';
