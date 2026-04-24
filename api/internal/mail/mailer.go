package mail

// Mailer is the reusable, in-process email service every other package
// should use when it needs to send mail. The HTTP layer (mail.go) is
// just a thin shell over this — see SendTemplate / TestSend.
//
// Why this exists
// ---------------
// Before the Mailer, anything that wanted to send email had to:
//   1. Look up email_settings for the org (4-line SQL block).
//   2. JSON-decode the provider config.
//   3. Call email.Build() and remember to handle the error.
//   4. Call provider.Send and write the audit row by hand.
//   5. Publish the events.* topic with the right shape.
//
// The team-invite, access-request, MFA, and notification flows all
// need the same five steps, so we collapse them into one entry point:
//
//     mailer.Send(ctx, mail.SendOptions{
//         OrgID: c.OrgID, UserID: c.UserID,
//         Kind: "access_request", Source: "sharing.access_request_filed",
//         Message: email.Message{To: ..., Subject: ..., HTMLBody: ...},
//         Metadata: map[string]any{"requestId": id},
//     })
//
// Env-fallback config
// -------------------
// If an org has no email_settings row, we fall back to a *system*
// config built from environment variables at boot:
//
//     SES_ACCESS_KEY / SES_SECRET_KEY / SES_REGION  -> ses
//     RESEND_API_KEY                                -> resend
//     EMAIL_FROM                                    -> envelope (required)
//
// SES wins if both are set — most production installs prefer it. The
// fallback exists so brand-new orgs can still receive transactional
// mail (welcome, password resets) before an admin has touched the
// email settings page.
//
// Auditing
// --------
// Every Send writes one row to email_sends with:
//   - kind       : business event ("template", "test", "invitation",
//                  "access_request_filed", "access_request_approved",
//                  "notification", …)
//   - source     : caller-supplied module path for super-admin filtering
//   - metadata   : opaque JSONB the caller stuffs request IDs / tokens
//                  into so the audit row is self-describing
//   - from_email/from_name: the actual envelope used (org config or env)
//
// This row is always written, even when the provider call fails — the
// row's status flips to 'failed' and the error string is captured. The
// super-admin viewer relies on this to surface delivery problems.

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"strings"
	"sync"

	"github.com/docforge/api/internal/email"
	"github.com/docforge/api/internal/events"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

// Mailer is the package-level service. Construct one in cmd/api/main.go
// and inject into every other handler that needs to send mail.
type Mailer struct {
	DB *pgxpool.Pool

	// envCfg is computed once at construction from os.Getenv. We cache
	// it so every Send doesn't re-walk the env (cheap, but pointless).
	envCfg     email.Config
	envHasFrom bool
	once       sync.Once
}

// NewMailer wires up the Mailer and snapshots the env-derived defaults.
func NewMailer(db *pgxpool.Pool) *Mailer {
	m := &Mailer{DB: db}
	m.loadEnvDefaults()
	return m
}

// SendOptions describes one outbound message. OrgID is required for
// per-tenant routing and audit; everything else is optional.
type SendOptions struct {
	OrgID string // org whose config + audit bucket to use
	// UserID is the actor that triggered this send. Optional — system
	// notifications (e.g. nightly summary) leave this empty.
	UserID string

	// Kind identifies the business event. Conventional values:
	//   "template"                 — rendered PDF + sent
	//   "test"                     — settings-page test button
	//   "invitation"               — team invite
	//   "access_request_filed"     — viewer asked owner for access
	//   "access_request_approved"  — owner approved a request
	//   "access_request_denied"    — owner denied a request
	//   "notification"             — generic system notification
	Kind string

	// Source is a free-form module path used for super-admin filtering,
	// e.g. "sharing.access_request_approved" or "team.invite".
	Source string

	Message email.Message

	// TemplateID / OutputFileID populate the matching audit columns
	// when a send is associated with a generated PDF. Optional.
	TemplateID   string
	OutputFileID string

	// Metadata is freeform JSONB stashed in email_sends.metadata for
	// the audit viewer. Common keys: requestId, inviteId, scheduleId.
	Metadata map[string]any
}

// Send delivers the message and writes an audit row. The returned
// sendID is the email_sends.id (always populated, even on failure).
// `err` is the provider error, surfaced so callers can branch on
// "did the actual delivery succeed?" — the audit row exists either way.
func (m *Mailer) Send(ctx context.Context, opts SendOptions) (string, error) {
	cfg, cfgErr := m.resolveConfig(ctx, opts.OrgID)
	if cfgErr != nil {
		// Unknown org / no config and no env defaults — record a failed
		// row anyway so super-admins can see the attempt.
		return m.recordFailure(ctx, opts, "unconfigured", "", cfgErr)
	}

	// Layer the org/env defaults onto whatever the caller specified.
	// Callers usually leave From/FromName/ReplyTo blank because they
	// don't know which provider is active — the Mailer fills them in.
	if opts.Message.From == "" {
		opts.Message.From = cfg.FromEmail
	}
	if opts.Message.FromName == "" {
		opts.Message.FromName = cfg.FromName
	}
	if opts.Message.ReplyTo == "" {
		opts.Message.ReplyTo = cfg.ReplyTo
	}

	prov, err := email.Build(cfg)
	if err != nil {
		return m.recordFailure(ctx, opts, cfg.Provider, "", err)
	}

	res, sendErr := prov.Send(ctx, opts.Message)

	status := "sent"
	var errStr *string
	if sendErr != nil {
		status = "failed"
		s := sendErr.Error()
		errStr = &s
	}

	sendID := m.writeAuditRow(ctx, opts, cfg, status, res.ProviderID, errStr)

	// Events are best-effort — failure to publish should never mask the
	// real send result.
	topic := "email.sent"
	if sendErr != nil {
		topic = "email.failed"
	}
	events.Publish(ctx, topic, opts.OrgID, map[string]any{
		"emailId":    sendID,
		"kind":       opts.Kind,
		"source":     opts.Source,
		"recipients": opts.Message.To,
		"provider":   cfg.Provider,
		"providerId": res.ProviderID,
		"templateId": nilIfEmpty(opts.TemplateID),
		"error":      errStr,
	})

	return sendID, sendErr
}

// resolveConfig prefers the org-specific row in email_settings. If
// none exists, the env-default config is returned (provided EMAIL_FROM
// is set — otherwise the caller can't pretend to send).
func (m *Mailer) resolveConfig(ctx context.Context, orgID string) (email.Config, error) {
	if orgID != "" {
		var (
			provider, fromName, fromEmail, replyTo string
			extra                                  []byte
		)
		err := m.DB.QueryRow(ctx, `
			SELECT provider, COALESCE(from_name,''), from_email, COALESCE(reply_to,''), config
			  FROM email_settings WHERE org_id=$1`, orgID,
		).Scan(&provider, &fromName, &fromEmail, &replyTo, &extra)
		if err == nil {
			cfg := email.Config{
				Provider: provider, FromName: fromName, FromEmail: fromEmail,
				ReplyTo: replyTo,
			}
			_ = json.Unmarshal(extra, &cfg.Extra)
			return cfg, nil
		}
		if err != pgx.ErrNoRows {
			return email.Config{}, err
		}
	}
	// Fall back to env defaults. Without EMAIL_FROM there's no
	// envelope address — bail rather than silently sending from "".
	if !m.envHasFrom {
		return email.Config{}, fmt.Errorf("no email settings for org and no EMAIL_FROM env default")
	}
	return m.envCfg, nil
}

// loadEnvDefaults fills envCfg from process env. SES wins over Resend
// when both are set because SES is the production-y choice; Resend is
// a dev-friendly stand-in. Console mode kicks in if no provider keys
// are set (still useful — every send becomes a stdout log line so the
// flow never silently drops).
func (m *Mailer) loadEnvDefaults() {
	from := strings.TrimSpace(os.Getenv("EMAIL_FROM"))
	fromName := strings.TrimSpace(os.Getenv("EMAIL_FROM_NAME"))
	replyTo := strings.TrimSpace(os.Getenv("EMAIL_REPLY_TO"))
	m.envHasFrom = from != ""
	m.envCfg = email.Config{
		FromEmail: from,
		FromName:  fromName,
		ReplyTo:   replyTo,
		Extra:     map[string]any{},
	}
	switch {
	case os.Getenv("SES_ACCESS_KEY") != "" && os.Getenv("SES_SECRET_KEY") != "":
		m.envCfg.Provider = "ses"
		m.envCfg.Extra = map[string]any{
			"accessKey": os.Getenv("SES_ACCESS_KEY"),
			"secretKey": os.Getenv("SES_SECRET_KEY"),
			"region":    firstNonEmpty(os.Getenv("SES_REGION"), "us-east-1"),
		}
	case os.Getenv("RESEND_API_KEY") != "":
		m.envCfg.Provider = "resend"
		m.envCfg.Extra = map[string]any{"apiKey": os.Getenv("RESEND_API_KEY")}
	default:
		m.envCfg.Provider = "console"
	}
}

// writeAuditRow inserts the post-send row into email_sends. We don't
// surface insert errors to the caller — auditing is best-effort and
// the actual send result is what callers care about. We do log the
// row id back so the events payload can correlate.
func (m *Mailer) writeAuditRow(
	ctx context.Context,
	opts SendOptions,
	cfg email.Config,
	status, providerID string,
	errStr *string,
) string {
	meta := opts.Metadata
	if meta == nil {
		meta = map[string]any{}
	}
	metaJSON, _ := json.Marshal(meta)

	var sendID string
	_ = m.DB.QueryRow(ctx, `
		INSERT INTO email_sends
			(org_id, user_id, template_id, output_file_id,
			 recipients, cc, bcc, subject,
			 provider, status, provider_id, error,
			 kind, source, metadata, from_email, from_name)
		VALUES
			($1, NULLIF($2,'')::uuid,
			 NULLIF($3,'')::uuid, NULLIF($4,'')::uuid,
			 $5, $6, $7, $8,
			 $9, $10, NULLIF($11,''), $12,
			 $13, $14, $15, $16, $17)
		RETURNING id`,
		opts.OrgID, opts.UserID,
		opts.TemplateID, opts.OutputFileID,
		opts.Message.To, opts.Message.CC, opts.Message.BCC, opts.Message.Subject,
		cfg.Provider, status, providerID, errStr,
		opts.Kind, opts.Source, metaJSON,
		nilIfEmpty(cfg.FromEmail), nilIfEmpty(cfg.FromName),
	).Scan(&sendID)
	return sendID
}

// recordFailure is the path for "couldn't even build a provider" — we
// still write an audit row so the failure shows up in the inbox. The
// status is 'failed'; the kind / source / metadata come from the
// caller as usual.
func (m *Mailer) recordFailure(
	ctx context.Context,
	opts SendOptions,
	provider, providerID string,
	cause error,
) (string, error) {
	if opts.OrgID == "" {
		// Without an org we can't write to email_sends at all — surface
		// the original error and let the caller log it.
		return "", cause
	}
	es := cause.Error()
	cfg := email.Config{Provider: provider}
	id := m.writeAuditRow(ctx, opts, cfg, "failed", providerID, &es)
	return id, cause
}

func firstNonEmpty(vals ...string) string {
	for _, v := range vals {
		if v != "" {
			return v
		}
	}
	return ""
}

func nilIfEmpty(s string) any {
	if s == "" {
		return nil
	}
	return s
}
