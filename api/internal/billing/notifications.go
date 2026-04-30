package billing

import (
	"context"
	"fmt"
	"os"

	"github.com/docforge/api/internal/email"
	"github.com/docforge/api/internal/mail"
	"github.com/jackc/pgx/v5/pgxpool"
)

// MailerSender is the slim interface notifications need from the mail
// package. Mirrors *mail.Mailer.Send so tests can stub it.
type MailerSender interface {
	Send(ctx context.Context, opts mail.SendOptions) (string, error)
}

// WireNotifier connects the package-level driver-side notifier hook to
// the Handler's mailer. Called once from main.go after AttachMailer.
// Storing ctx in a hook is unusual, but the hook is only invoked from
// HTTP-handler-driven webhooks where the request context is short-lived
// — using the long-lived process context guarantees the email send
// completes even if the webhook ack races ahead.
func (h *Handler) WireNotifier(ctx context.Context) {
	db := h.DB
	mailer := h.Mailer
	SetNotifier(func(orgID, kind, planName string) {
		switch kind {
		case "payment_failed":
			notifyPaymentFailed(ctx, db, mailer, orgID, planName)
		case "canceled":
			notifyCanceled(ctx, db, mailer, orgID, planName)
		}
	})
}

// orgAdmins resolves the email + name of every admin in an org. We
// notify all admins (not just one owner) so a vacationing owner doesn't
// silently miss a payment-failed alert.
func orgAdmins(ctx context.Context, db *pgxpool.Pool, orgID string) ([]struct {
	Email, Name string
}, error) {
	rows, err := db.Query(ctx,
		`SELECT email, COALESCE(name,'')
		   FROM users
		  WHERE org_id=$1 AND role IN ('owner','admin')`, orgID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []struct{ Email, Name string }
	for rows.Next() {
		var e, n string
		if err := rows.Scan(&e, &n); err != nil {
			continue
		}
		if e == "" {
			continue
		}
		out = append(out, struct{ Email, Name string }{e, n})
	}
	return out, nil
}

// SendBillingNotice is the single helper every billing email goes
// through. Callers hand in a Branded struct so the layout, footer, and
// plain-text fallback come from one place — keeping every billing
// mail visually consistent and on the same anti-spam profile.
func SendBillingNotice(
	ctx context.Context,
	db *pgxpool.Pool,
	mailer MailerSender,
	orgID, kind, subject string,
	body email.Branded,
	meta map[string]any,
) {
	if mailer == nil || orgID == "" {
		return
	}
	admins, err := orgAdmins(ctx, db, orgID)
	if err != nil || len(admins) == 0 {
		return
	}
	htmlBody, textBody := email.Render(body)
	for _, a := range admins {
		_, _ = mailer.Send(ctx, mail.SendOptions{
			OrgID:  orgID,
			Kind:   kind,
			Source: "billing." + kind,
			Message: email.Message{
				To:       []string{a.Email},
				Subject:  subject,
				HTMLBody: htmlBody,
				TextBody: textBody,
			},
			Metadata: meta,
		})
	}
}

// notifyPaymentFailed lands when a webhook flips an org to past_due.
// Body is intentionally short — the admin has to log in and take
// action; the mail just nudges them to the right page.
func notifyPaymentFailed(ctx context.Context, db *pgxpool.Pool, mailer MailerSender, orgID, planName string) {
	subject := "Payment failed — please update your card"
	SendBillingNotice(ctx, db, mailer, orgID, "billing_payment_failed", subject, email.Branded{
		PreviewText: "Update your card on file to keep " + planName + " active.",
		Title:       "Payment failed",
		Paragraphs: []string{
			fmt.Sprintf("We couldn't charge your card for %s.", planName),
			"Update your payment method to avoid an interruption — your subscription pauses automatically if the next retry fails.",
		},
		CTAText:       "Update payment method",
		CTAURL:        appURL("/settings/billing"),
		SecondaryNote: "Already updated your card? You can ignore this email — the next retry will pick up the new payment method.",
		Reason:        "You're receiving this because you're an admin on a workspace with a billing issue.",
	}, map[string]any{"planName": planName})
}

// notifyCanceled is the "your subscription ended" mail. Triggers on
// subscription.cancelled / customer.subscription.deleted webhooks.
func notifyCanceled(ctx context.Context, db *pgxpool.Pool, mailer MailerSender, orgID, planName string) {
	subject := "Your subscription has been canceled"
	SendBillingNotice(ctx, db, mailer, orgID, "billing_canceled", subject, email.Branded{
		PreviewText: "Your " + planName + " subscription has ended.",
		Title:       "Subscription canceled",
		Paragraphs: []string{
			fmt.Sprintf("Your %s subscription has been canceled.", planName),
			"Your workspace and data are retained — you can resubscribe any time and pick up exactly where you left off.",
		},
		CTAText: "Resubscribe",
		CTAURL:  appURL("/settings/billing"),
		Reason:  "You're receiving this because you're an admin on the canceled workspace.",
	}, nil)
}

// notifyTrialEnding fires from the daily cron when a trial has 3 (or 1)
// days left. Frequency cap is enforced by the cron, not here.
func notifyTrialEnding(ctx context.Context, db *pgxpool.Pool, mailer MailerSender, orgID, planName string, daysLeft int) {
	subject := fmt.Sprintf("Trial ends in %d day%s", daysLeft, plural(daysLeft))
	SendBillingNotice(ctx, db, mailer, orgID, "billing_trial_ending", subject, email.Branded{
		PreviewText: fmt.Sprintf("Your %s trial ends in %d day%s.", planName, daysLeft, plural(daysLeft)),
		Title:       subject,
		Paragraphs: []string{
			fmt.Sprintf("Your trial of %s ends in %d day%s.", planName, daysLeft, plural(daysLeft)),
			"Add a payment method now to keep things running without interruption — your data and settings stay exactly as they are.",
		},
		CTAText:       "Add payment method",
		CTAURL:        appURL("/settings/billing"),
		SecondaryNote: "Don't need it? You can ignore this email — your workspace will switch to read-only when the trial ends.",
		Reason:        "You're receiving this because you're an admin on a workspace with an active trial.",
	}, map[string]any{"daysLeft": daysLeft})
}

// notifyTrialExpired fires from the dunning sweep that catches trials
// whose `trial_ends_at` passed without a payment method on file. After
// this mail goes out, the org's writes are gated until the admin picks
// a plan on /settings/billing. The trial is one-time per org and won't
// be re-granted, so the only way forward is checkout.
func notifyTrialExpired(ctx context.Context, db *pgxpool.Pool, mailer MailerSender, orgID, planName string) {
	subject := "Your trial has ended — choose a plan to continue"
	SendBillingNotice(ctx, db, mailer, orgID, "billing_trial_expired", subject, email.Branded{
		PreviewText: "Pick a plan to keep your workspace active.",
		Title:       "Your trial has ended",
		Paragraphs: []string{
			fmt.Sprintf("Your %s trial has ended.", planName),
			"Workspace data is preserved, but new uploads, invites, and integrations are paused until you pick a plan. Checkout takes a minute.",
		},
		CTAText: "Choose a plan",
		CTAURL:  appURL("/settings/billing"),
		Reason:  "You're receiving this because you're an admin on a workspace whose trial just expired.",
	}, map[string]any{"planName": planName})
}

func plural(n int) string {
	if n == 1 {
		return ""
	}
	return "s"
}

// appURL is a small wrapper over the APP_URL env so the billing emails
// link back to the same host the recipient signs in on. We keep this
// local rather than importing one from team / sharing because billing
// already imports neither and we want to avoid a cycle.
func appURL(path string) string {
	base := os.Getenv("APP_URL")
	if base == "" {
		base = "https://drive360.app"
	}
	return base + path
}
