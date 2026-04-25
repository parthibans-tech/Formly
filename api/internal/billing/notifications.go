package billing

import (
	"context"
	"fmt"
	"strings"

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
// through. It looks up admins, layers the org-scoped mailer config,
// and writes one audit row per recipient.
func SendBillingNotice(
	ctx context.Context,
	db *pgxpool.Pool,
	mailer MailerSender,
	orgID, kind, subject, htmlBody, textBody string,
	meta map[string]any,
) {
	if mailer == nil || orgID == "" {
		return
	}
	admins, err := orgAdmins(ctx, db, orgID)
	if err != nil || len(admins) == 0 {
		return
	}
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
	body := fmt.Sprintf(
		"We couldn't charge your card for %s. Visit /settings/billing to update your payment method before your subscription is paused.",
		planName,
	)
	SendBillingNotice(ctx, db, mailer, orgID, "billing_payment_failed",
		subject, htmlWrap(subject, body), body,
		map[string]any{"planName": planName})
}

// notifyCanceled is the "your subscription ended" mail. Triggers on
// subscription.cancelled / customer.subscription.deleted webhooks.
func notifyCanceled(ctx context.Context, db *pgxpool.Pool, mailer MailerSender, orgID, planName string) {
	subject := "Your subscription has been canceled"
	body := fmt.Sprintf(
		"Your %s subscription has been canceled. Workspace data is retained — you can resubscribe at any time from /settings/billing.",
		planName,
	)
	SendBillingNotice(ctx, db, mailer, orgID, "billing_canceled",
		subject, htmlWrap(subject, body), body, nil)
}

// notifyTrialEnding fires from the daily cron when a trial has 3 (or 1)
// days left. Frequency cap is enforced by the cron, not here.
func notifyTrialEnding(ctx context.Context, db *pgxpool.Pool, mailer MailerSender, orgID, planName string, daysLeft int) {
	subject := fmt.Sprintf("Trial ends in %d day%s",
		daysLeft, plural(daysLeft))
	body := fmt.Sprintf(
		"Your trial of %s ends in %d day%s. Add a payment method on /settings/billing to keep going without interruption.",
		planName, daysLeft, plural(daysLeft),
	)
	SendBillingNotice(ctx, db, mailer, orgID, "billing_trial_ending",
		subject, htmlWrap(subject, body), body,
		map[string]any{"daysLeft": daysLeft})
}

func plural(n int) string {
	if n == 1 {
		return ""
	}
	return "s"
}

func htmlWrap(title, body string) string {
	return strings.Join([]string{
		`<!DOCTYPE html><html><body style="font-family:system-ui,sans-serif;max-width:560px;margin:32px auto;color:#0f172a">`,
		`<h2 style="font-size:18px;margin-bottom:12px">` + title + `</h2>`,
		`<p style="font-size:14px;line-height:1.5">` + body + `</p>`,
		`<p style="font-size:12px;color:#64748b;margin-top:32px">— Formly Billing</p>`,
		`</body></html>`,
	}, "")
}
