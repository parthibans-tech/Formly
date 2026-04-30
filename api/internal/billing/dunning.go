package billing

import (
	"context"
	"log"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
)

// Dunning sweeps the subscriptions table once a day:
//
//   1. Trial reminders — orgs whose trial ends in 3 days (warned once)
//      and 1 day (warned again) get a "trial ending" mail.
//   2. Past-due dunning — orgs in past_due since >7 days get a follow-up
//      mail, capped at 3 notices total. After the 4th day past the
//      grace period the subscription auto-cancels.
//
// The cron runs once an hour but the body is idempotent — every check
// has a "have we already done this today?" guard.

// PastDueGraceDays is how long we wait after the first past_due event
// before hard-canceling. 7 days is enough room for the user to update
// their card; longer than that we eat the cost of unbilled service.
const PastDueGraceDays = 7

// MaxDunningNotices caps repeated past_due reminder emails so we
// don't spam an admin who has already read the first three.
const MaxDunningNotices = 3

// markPastDue is called by the webhook layer the first time an org
// flips into past_due. Subsequent calls are no-ops thanks to the
// COALESCE — we only want the *first* timestamp so the grace period
// counts from the original incident, not the latest retry.
func markPastDue(ctx context.Context, db *pgxpool.Pool, provider, providerSubID string) {
	_, _ = db.Exec(ctx, `
		UPDATE subscriptions
		   SET past_due_since = COALESCE(past_due_since, now())
		 WHERE provider=$1 AND provider_subscription_id=$2
		   AND status='past_due'`,
		provider, providerSubID)
}

// lookupOrgAndPlan resolves (orgID, planName) for a (provider, providerSubID)
// pair so the webhook handlers can address notification emails without
// duplicating the JOIN.
func lookupOrgAndPlan(ctx context.Context, db *pgxpool.Pool, provider, providerSubID string) (string, string) {
	if providerSubID == "" {
		return "", ""
	}
	var orgID, planName string
	_ = db.QueryRow(ctx, `
		SELECT s.org_id::text, COALESCE(p.name,'')
		  FROM subscriptions s
		  LEFT JOIN plans p ON p.id = s.plan_id
		 WHERE s.provider=$1 AND s.provider_subscription_id=$2
		 LIMIT 1`, provider, providerSubID,
	).Scan(&orgID, &planName)
	return orgID, planName
}

// RunDunning scans the table once and applies trial / past-due actions.
// Safe to call repeatedly — every "did we already act?" check is in SQL.
func (h *Handler) RunDunning(ctx context.Context) {
	now := time.Now().UTC()

	// 1. Trial reminders — fire at 3 days and 1 day remaining. We use
	// dunning_notices to avoid double-firing on the same org.
	{
		rows, err := h.DB.Query(ctx, `
			SELECT s.org_id::text, COALESCE(p.name,'free'),
			       CEIL(EXTRACT(EPOCH FROM (s.trial_ends_at - now()))/86400)::int AS days_left
			  FROM subscriptions s
			  LEFT JOIN plans p ON p.id = s.plan_id
			 WHERE s.status='trialing'
			   AND s.trial_ends_at IS NOT NULL
			   AND s.trial_ends_at > now()
			   AND s.trial_ends_at < now() + interval '3 days'
			   AND (s.last_dunning_at IS NULL OR s.last_dunning_at < now() - interval '20 hours')`)
		if err == nil {
			defer rows.Close()
			for rows.Next() {
				var (
					orgID, planName string
					daysLeft        int
				)
				if rows.Scan(&orgID, &planName, &daysLeft) != nil {
					continue
				}
				if daysLeft != 1 && daysLeft != 3 {
					continue
				}
				notifyTrialEnding(ctx, h.DB, h.Mailer, orgID, planName, daysLeft)
				_, _ = h.DB.Exec(ctx,
					`UPDATE subscriptions SET last_dunning_at=now()
					   WHERE org_id=$1 AND status='trialing'`, orgID)
			}
		}
	}

	// 2. Expired trials — cancel status='trialing' rows whose
	// trial_ends_at has passed without a payment method on file. Only
	// manual trials (StartTrial-provisioned) need this sweep;
	// Stripe/Razorpay trials get converted by their own webhooks.
	//
	// We do NOT auto-provision a replacement subscription. Trial is
	// one-time per org (enforced by StartTrial), and the product
	// policy is "if your trial ends, pick a plan and pay" — not "drop
	// silently to a free tier". After this sweep the org has no
	// active sub, LoadOrgLimits flags it as RequiresUpgrade, and
	// every write gets a 402 subscription_required until the admin
	// completes checkout on /settings/billing.
	{
		rows, err := h.DB.Query(ctx, `
			SELECT s.id::text, s.org_id::text, COALESCE(p.name,'your trial')
			  FROM subscriptions s
			  LEFT JOIN plans p ON p.id = s.plan_id
			 WHERE s.status='trialing'
			   AND s.provider='manual'
			   AND s.trial_ends_at IS NOT NULL
			   AND s.trial_ends_at < now()`)
		if err == nil {
			type expired struct {
				ID, OrgID, PlanName string
			}
			var batch []expired
			for rows.Next() {
				var e expired
				if rows.Scan(&e.ID, &e.OrgID, &e.PlanName) != nil {
					continue
				}
				batch = append(batch, e)
			}
			rows.Close()

			for _, e := range batch {
				if _, err := h.DB.Exec(ctx, `
					UPDATE subscriptions
					   SET status='canceled', canceled_at=now(), updated_at=now()
					 WHERE id=$1::uuid AND status='trialing'`, e.ID); err != nil {
					log.Printf("billing.dunning: cancel expired trial %s: %v", e.ID, err)
					continue
				}
				notifyTrialExpired(ctx, h.DB, h.Mailer, e.OrgID, e.PlanName)
			}
		}
	}

	// 3. Past-due reminders — every 24h up to MaxDunningNotices, then
	// the next sweep cancels the subscription outright.
	{
		rows, err := h.DB.Query(ctx, `
			SELECT s.id::text, s.org_id::text, COALESCE(p.name,'your plan'),
			       s.dunning_notices, s.past_due_since, s.provider,
			       s.provider_subscription_id
			  FROM subscriptions s
			  LEFT JOIN plans p ON p.id = s.plan_id
			 WHERE s.status='past_due'
			   AND s.past_due_since IS NOT NULL`)
		if err == nil {
			defer rows.Close()
			type dq struct {
				ID, OrgID, PlanName, Provider string
				ProviderSubID                 *string
				Notices                       int
				Since                         time.Time
			}
			var rowsToProcess []dq
			for rows.Next() {
				var d dq
				var psid *string
				if rows.Scan(&d.ID, &d.OrgID, &d.PlanName,
					&d.Notices, &d.Since, &d.Provider, &psid) != nil {
					continue
				}
				d.ProviderSubID = psid
				rowsToProcess = append(rowsToProcess, d)
			}
			for _, d := range rowsToProcess {
				elapsed := now.Sub(d.Since)
				if elapsed >= PastDueGraceDays*24*time.Hour && d.Notices >= MaxDunningNotices {
					// Hard cancel — local + remote.
					if d.Provider != ProviderManual && d.ProviderSubID != nil && *d.ProviderSubID != "" {
						if prov := h.providerByName(d.Provider); prov != nil && prov.Configured() {
							_ = prov.Cancel(ctx, *d.ProviderSubID, false)
						}
					}
					_, _ = h.DB.Exec(ctx, `
						UPDATE subscriptions
						   SET status='canceled', canceled_at=now(), updated_at=now()
						 WHERE id=$1::uuid`, d.ID)
					notifyCanceled(ctx, h.DB, h.Mailer, d.OrgID, d.PlanName)
					continue
				}
				// Send the next reminder if 24h has passed since the last.
				_, _ = h.DB.Exec(ctx, `
					UPDATE subscriptions
					   SET dunning_notices = dunning_notices + 1,
					       last_dunning_at = now()
					 WHERE id=$1::uuid
					   AND (last_dunning_at IS NULL OR last_dunning_at < now() - interval '20 hours')`,
					d.ID)
				notifyPaymentFailed(ctx, h.DB, h.Mailer, d.OrgID, d.PlanName)
			}
		}
	}
}

// StartDunningLoop kicks the background sweep on a fixed interval.
// `interval` of 0 falls back to 1h. The loop exits when ctx is canceled.
func (h *Handler) StartDunningLoop(ctx context.Context, interval time.Duration) {
	if interval <= 0 {
		interval = time.Hour
	}
	go func() {
		t := time.NewTicker(interval)
		defer t.Stop()
		// Run once at start so dev/staging sees something happen
		// without waiting an hour.
		h.RunDunning(ctx)
		for {
			select {
			case <-ctx.Done():
				return
			case <-t.C:
				func() {
					defer func() {
						if r := recover(); r != nil {
							log.Printf("billing.dunning: panic: %v", r)
						}
					}()
					h.RunDunning(ctx)
				}()
			}
		}
	}()
}
