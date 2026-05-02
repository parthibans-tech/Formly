// Package delivery is the post-render fan-out: once a generated PDF is
// uploaded, this package decides who else needs to know about it
// (email recipients, share-link consumers) and assembles the metadata
// that the GenerateCompleted event needs to carry.
//
// Why a separate package
// ----------------------
// The runner has historically owned only "render → upload → publish a
// sparse event". As distribution surfaces grow (auto-email, auto-share,
// signed download URLs in the webhook payload) the runner.go file would
// balloon with cross-package wiring (mail.Mailer, sharing creators,
// storage presigner). Punching this out into delivery/ keeps:
//
//   - runner.go thin — it calls one function (Apply) and gets back a
//     small Result struct it can fold into the event payload.
//
//   - the wiring honest — delivery talks to interfaces, so the import
//     graph stays runner → delivery → (interfaces), and the concrete
//     mail.Mailer / sharing.Handler implementations live in cmd/api
//     where they're already constructed.
//
// Order of operations inside Apply
// --------------------------------
// 1. Generate a long-lived (24h default) presigned download URL — this
//    becomes the canonical link in webhook payloads / emails / share
//    fallbacks. Without this even a no-op delivery enriches the event.
//
// 2. If ShareConfig is enabled, mint a share link first. Email then
//    has the option of including the share URL (more friendly for
//    end-users — they can re-download without poking their inbox for
//    the original attachment).
//
// 3. If EmailConfig is enabled, send. Best-effort: a failed send does
//    not roll back the share link or the upload. The error surfaces
//    through Result.EmailError so the runner can log it without
//    failing the whole render.
//
// All three steps are best-effort — render success is not gated on
// delivery success. The Result struct reports what actually happened
// so the caller can fold the outcomes into the GenerateCompleted
// event payload (and surface in the audit trail).
package delivery

import (
	"context"
	"fmt"
	"strings"
	"time"

	"github.com/docforge/api/internal/email"
)

// Config is the parsed shape of `config_json.delivery`. Both
// sub-blocks are optional; a missing block means "don't fan out to
// that channel". An empty Config{} is a no-op — Apply still produces
// a download URL but doesn't send mail or create a share link.
type Config struct {
	Email *EmailConfig `json:"email,omitempty"`
	Share *ShareConfig `json:"share,omitempty"`
}

// EmailConfig describes the auto-email-on-render flow. Recipients
// support {{key}} placeholders against the request data so a single
// template can route to per-tenant or per-customer addresses
// without the integrator having to call a separate email endpoint.
type EmailConfig struct {
	// Enabled is the master switch. Off by default so existing
	// templates don't suddenly start mailing on every render.
	Enabled bool `json:"enabled"`

	// To / CC / BCC accept either a literal address or a
	// {{key}} placeholder that resolves against the request data.
	// Multiple addresses per slot allowed.
	To  []string `json:"to,omitempty"`
	CC  []string `json:"cc,omitempty"`
	BCC []string `json:"bcc,omitempty"`

	// Subject / Body support {{key}} placeholders. Body is
	// rendered as plain text; HTML support can come later if the
	// integrator demand materialises.
	Subject string `json:"subject,omitempty"`
	Body    string `json:"body,omitempty"`

	// AttachPDF defaults true (the obvious thing to do with a
	// freshly-generated PDF). Set false when the email should
	// instead carry just the share link — e.g. for very large
	// outputs where attachments would bounce.
	AttachPDF *bool `json:"attachPDF,omitempty"`

	// IncludeDownloadLink, when true, appends the long-lived
	// presigned download URL to the email body. Useful even when
	// AttachPDF is true — the recipient can re-download without
	// digging through their inbox.
	IncludeDownloadLink bool `json:"includeDownloadLink,omitempty"`

	// IncludeShareLink, when true AND ShareConfig produced one,
	// appends the public share URL (which honours password /
	// expiry / one-time policies) instead of/alongside the
	// presigned link.
	IncludeShareLink bool `json:"includeShareLink,omitempty"`
}

// ShareConfig describes the auto-share-link flow. When enabled,
// every successful render mints a public share link with the same
// policy knobs the manual /shares endpoint exposes.
type ShareConfig struct {
	// Enabled is the master switch.
	Enabled bool `json:"enabled"`

	// Role is "viewer" or "downloader". Default "viewer" if blank.
	Role string `json:"role,omitempty"`

	// ExpiresIn is the share lifetime in seconds. 0 = no expiry.
	// Templates that want "self-cleaning" links should set this
	// to 7-30 days; integrators that want permanent archival
	// links can leave it unset.
	ExpiresIn int `json:"expiresIn,omitempty"`

	// Password, when non-empty, requires consumers to enter it
	// before the link resolves. Bcrypt-hashed by the share
	// creator — never stored in plain text.
	Password string `json:"password,omitempty"`

	// OneTime: link self-revokes after the first download.
	OneTime bool `json:"oneTime,omitempty"`

	// DownloadLimit: 0 = unlimited. Counts every "download"
	// action, not "view".
	DownloadLimit int `json:"downloadLimit,omitempty"`
}

// IsEnabled reports whether Apply will do anything beyond producing
// the canonical download URL (which it always does). Cheap pre-check.
func (c Config) IsEnabled() bool {
	if c.Email != nil && c.Email.Enabled {
		return true
	}
	if c.Share != nil && c.Share.Enabled {
		return true
	}
	return false
}

// PresignGetter is the slice of storage.Client we need: produce a
// presigned download URL for a stored object. Forces attachment
// disposition for risky MIME types (so we always get the PDF
// download path, never inline render).
type PresignGetter interface {
	PresignGet(ctx context.Context, key, mime, filename string, ttl time.Duration) (string, error)
}

// ShareCreator mints a share link for a file. Implemented by a
// thin adapter in cmd/api/main.go that wraps sharing.Handler so
// delivery doesn't pull in the sharing package directly.
type ShareCreator interface {
	CreateShareLink(ctx context.Context, opts ShareCreateOptions) (ShareCreateResult, error)
}

// ShareCreateOptions is the small input surface ShareCreator needs.
// Mirrors the fields sharing.createReq exposes today.
type ShareCreateOptions struct {
	OrgID         string
	UserID        string // creator; "" for system-created
	FileID        string
	Role          string // viewer | downloader
	ExpiresIn     int    // seconds; 0 = no expiry
	Password      string
	OneTime       bool
	DownloadLimit int
}

// ShareCreateResult carries back enough to render a public URL and
// stash the IDs in the event payload.
type ShareCreateResult struct {
	ShareID string
	Token   string
	URL     string // public URL (e.g. https://app/share/<token>)
}

// EmailSender is the slice of mail.Mailer delivery uses. Returns
// the email_sends row id so we can stash it in the event payload.
type EmailSender interface {
	Send(ctx context.Context, opts EmailSendOptions) (sendID string, err error)
}

// EmailSendOptions mirrors mail.SendOptions but without dragging in
// the email package's transitive types — keeps the import direction
// delivery → (no mail).
type EmailSendOptions struct {
	OrgID        string
	UserID       string
	TemplateID   string
	OutputFileID string
	Kind         string // we always send "template"; included for adapter flexibility
	Source       string
	To           []string
	CC           []string
	BCC          []string
	Subject      string
	TextBody     string
	HTMLBody     string
	Attachments  []email.Attachment
	Metadata     map[string]any
}

// Deps bundles the interface dependencies into a single struct so
// Apply's signature stays compact even as we add adapters.
type Deps struct {
	Presign PresignGetter
	Share   ShareCreator
	Mail    EmailSender
}

// Args is the per-call inputs Apply needs to know which file is
// being delivered and how to fill placeholders.
type Args struct {
	OrgID        string
	UserID       string
	TemplateID   string
	TemplateName string

	OutputFileID string
	OutputKey    string
	OutputName   string
	OutputBytes  []byte // attached when EmailConfig.AttachPDF is true

	// Data is the request payload — used to resolve {{key}}
	// placeholders in email subject/body/recipients.
	Data map[string]interface{}

	// DownloadTTL controls how long the canonical download URL
	// remains valid. 0 → 24h default. Webhook consumers typically
	// fetch immediately, but humans clicking through email links
	// half a day later still need a working URL, so we err on the
	// long side.
	DownloadTTL time.Duration
}

// Result is what Apply reports back. Every field is best-effort —
// Empty strings and nil errors mean "didn't try" rather than
// "tried and silently succeeded with no output".
type Result struct {
	// DownloadURL is the presigned long-lived URL for the output
	// file. Always populated unless presign itself failed.
	DownloadURL string

	// ShareID / ShareURL are populated only when ShareConfig was
	// enabled AND share creation succeeded. ShareError carries any
	// failure so the caller can log without failing the render.
	ShareID    string
	ShareURL   string
	ShareError error

	// EmailSendID is populated when EmailConfig was enabled and
	// the send was attempted (whether or not delivery succeeded —
	// the audit row exists either way). EmailError carries the
	// provider error if delivery failed.
	EmailSendID string
	EmailError  error
}

// Apply performs the post-upload fan-out described in the package
// doc. Returns a Result describing what happened. Errors at the
// individual step level are stuffed into Result; the function only
// returns a top-level error when the inputs are unusable (e.g.
// no Args.OutputFileID), so the caller can fold the metadata into
// the event payload regardless of partial failures.
func Apply(ctx context.Context, cfg Config, deps Deps, args Args) (Result, error) {
	if args.OutputFileID == "" || args.OutputKey == "" {
		return Result{}, fmt.Errorf("delivery: missing output file id/key")
	}
	if args.DownloadTTL == 0 {
		args.DownloadTTL = 24 * time.Hour
	}

	var res Result

	// 1. Canonical download URL — always produced when a presigner is
	//    wired, even if no email/share is configured. Webhook payloads
	//    rely on this so an integrator can act on the event without a
	//    second round-trip to /files/<id>/download.
	if deps.Presign != nil {
		url, err := deps.Presign.PresignGet(ctx, args.OutputKey, "application/pdf", args.OutputName, args.DownloadTTL)
		if err == nil {
			res.DownloadURL = url
		}
		// We deliberately swallow the presign error rather than
		// failing the render: an unsigned event payload is still
		// useful (consumers can fall back to /files/<id>). Logging
		// happens in the runner.
	}

	// 2. Share link — done before email so the email body can
	//    embed the share URL when IncludeShareLink is set.
	if cfg.Share != nil && cfg.Share.Enabled && deps.Share != nil {
		role := cfg.Share.Role
		if role == "" {
			role = "viewer"
		}
		sr, err := deps.Share.CreateShareLink(ctx, ShareCreateOptions{
			OrgID:         args.OrgID,
			UserID:        args.UserID,
			FileID:        args.OutputFileID,
			Role:          role,
			ExpiresIn:     cfg.Share.ExpiresIn,
			Password:      cfg.Share.Password,
			OneTime:       cfg.Share.OneTime,
			DownloadLimit: cfg.Share.DownloadLimit,
		})
		if err != nil {
			res.ShareError = err
		} else {
			res.ShareID = sr.ShareID
			res.ShareURL = sr.URL
		}
	}

	// 3. Email — best-effort, last step. We expand placeholders in
	//    every field and decide attachment vs. link inclusion based
	//    on the EmailConfig knobs.
	if cfg.Email != nil && cfg.Email.Enabled && deps.Mail != nil {
		send := buildEmailOptions(cfg.Email, args, res)
		if len(send.To) > 0 {
			id, err := deps.Mail.Send(ctx, send)
			res.EmailSendID = id
			res.EmailError = err
		} else {
			// No resolved recipients — record this as an error so
			// the integrator notices their {{customerEmail}}
			// placeholder didn't resolve, rather than silently
			// dropping the send.
			res.EmailError = fmt.Errorf("delivery: email enabled but recipient list resolved to empty")
		}
	}

	return res, nil
}

// buildEmailOptions resolves placeholders, decides attachment
// inclusion, and assembles the EmailSendOptions handed to the
// EmailSender adapter. Pulled out of Apply so the placeholder
// rules are easy to unit-test.
func buildEmailOptions(cfg *EmailConfig, args Args, res Result) EmailSendOptions {
	subject := resolvePlaceholders(cfg.Subject, args.Data)
	body := resolvePlaceholders(cfg.Body, args.Data)

	// Append download / share links to the body when requested.
	// Each link goes on its own line below the rendered body so
	// the integrator's prose stays readable.
	var extras []string
	if cfg.IncludeShareLink && res.ShareURL != "" {
		extras = append(extras, "Share link: "+res.ShareURL)
	}
	if cfg.IncludeDownloadLink && res.DownloadURL != "" {
		extras = append(extras, "Download link: "+res.DownloadURL)
	}
	if len(extras) > 0 {
		if body != "" {
			body += "\n\n"
		}
		body += strings.Join(extras, "\n")
	}

	to := resolveRecipients(cfg.To, args.Data)
	cc := resolveRecipients(cfg.CC, args.Data)
	bcc := resolveRecipients(cfg.BCC, args.Data)

	// Attachment: default true when the knob is unset. Intentional
	// default: most users of "auto-email on render" want the PDF
	// in-band so the recipient doesn't have to chase a URL.
	attach := true
	if cfg.AttachPDF != nil {
		attach = *cfg.AttachPDF
	}
	var attachments []email.Attachment
	if attach && len(args.OutputBytes) > 0 {
		attachments = append(attachments, email.Attachment{
			Filename:    args.OutputName,
			ContentType: "application/pdf",
			Data:        args.OutputBytes,
		})
	}

	return EmailSendOptions{
		OrgID:        args.OrgID,
		UserID:       args.UserID,
		TemplateID:   args.TemplateID,
		OutputFileID: args.OutputFileID,
		Kind:         "template",
		Source:       "generate.delivery.auto_email",
		To:           to,
		CC:           cc,
		BCC:          bcc,
		Subject:      subject,
		TextBody:     body,
		Attachments:  attachments,
		Metadata: map[string]any{
			"templateId":   args.TemplateID,
			"templateName": args.TemplateName,
			"outputFileId": args.OutputFileID,
			"shareId":      res.ShareID,
		},
	}
}

// resolveRecipients expands each entry against the data payload.
// A literal "alice@example.com" passes through; a "{{customerEmail}}"
// resolves; an unresolved placeholder is dropped (rather than
// shipping the literal "{{...}}" string to a mail provider, which
// would either bounce loudly or silently send nothing useful).
//
// Comma-separated values are split so config like
// `to: ["{{managerEmail}},{{ccEmail}}"]` works the way authors
// likely intend.
func resolveRecipients(in []string, data map[string]interface{}) []string {
	var out []string
	seen := map[string]bool{}
	for _, raw := range in {
		expanded := resolvePlaceholders(raw, data)
		for _, part := range strings.Split(expanded, ",") {
			addr := strings.TrimSpace(part)
			if addr == "" {
				continue
			}
			// A residual "{{...}}" means the placeholder didn't
			// resolve — drop it rather than mail the literal
			// braces to a provider.
			if strings.Contains(addr, "{{") {
				continue
			}
			if seen[addr] {
				continue
			}
			seen[addr] = true
			out = append(out, addr)
		}
	}
	return out
}

// resolvePlaceholders does {{key}} substitution against the data
// map. Missing keys collapse to "" so the rest of the string isn't
// poisoned by the brace literals.
//
// Kept tiny and deliberate — pdfdecor has its own richer version
// (with built-ins like {{page}}); duplicating a small helper here
// keeps delivery free of an import cycle into the rendering subtree.
func resolvePlaceholders(in string, data map[string]interface{}) string {
	if !strings.Contains(in, "{{") {
		return in
	}
	out := in
	for {
		start := strings.Index(out, "{{")
		if start < 0 {
			break
		}
		end := strings.Index(out[start:], "}}")
		if end < 0 {
			break
		}
		end += start
		key := strings.TrimSpace(out[start+2 : end])
		val := ""
		if v, ok := data[key]; ok && v != nil {
			val = fmt.Sprintf("%v", v)
		}
		out = out[:start] + val + out[end+2:]
	}
	return out
}
