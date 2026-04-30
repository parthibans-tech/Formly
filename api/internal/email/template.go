package email

// A single, reusable transactional email layout shared across every
// system-generated mail (invites, access requests, billing notices,
// test sends). One template means:
//
//   - one place to fix when a client (Outlook, Gmail dark mode, Apple
//     Mail VoiceOver, …) misrenders us;
//   - consistent branding so recipients learn to recognise "this is
//     Drive360, not phishing", which Gmail's reputation scoring
//     specifically rewards;
//   - matching plain-text and HTML parts so the multipart/alternative
//     wrapper never has a stub plaintext body — bare-HTML mails get
//     scored badly by SpamAssassin's MIME_HTML_ONLY rule.
//
// The HTML side is intentionally table-based and inline-styled. CSS
// classes don't survive Outlook 2019 / 2021 (which still uses Word's
// rendering engine), and inline styles bypass Gmail's <style>-block
// stripping. That look "old school" because it has to.
//
// Anti-spam knobs baked in:
//
//   - the visible footer carries a human "you are receiving this
//     because…" line. Filters look for this; its absence on cold-
//     looking transactional mail is a moderate spam signal;
//   - a physical postal address is stitched into the footer (CAN-SPAM
//     §316.5 requires it; major filters look for it even on
//     transactional mail). Operators set BRAND_POSTAL_ADDRESS;
//   - all links reference the same APP_URL host so we don't trip
//     "url-shortener / mixed-domain" checks;
//   - text/plain fallback mirrors the HTML content one-for-one so
//     anti-spam multi-part comparisons (e.g. SpamAssassin's
//     MPART_ALT_DIFF) don't fire.

import (
	htmlpkg "html"
	"os"
	"strings"
)

// Branded describes one transactional email. All fields except
// Paragraphs and ProductName are optional — the renderer hides empty
// sections rather than leaving holes.
type Branded struct {
	// PreviewText shows in the inbox preview line in Gmail / Apple
	// Mail / Outlook. ~90 chars is the safe limit. Leaving this empty
	// lets the body's first sentence leak in, which usually looks fine
	// but reads weird if the body opens with "Hi Alice,".
	PreviewText string

	// Title shows as the H1 inside the email card.
	Title string

	// Greeting like "Hi Alice," — rendered as its own paragraph above
	// the body text. Leave empty to skip.
	Greeting string

	// Paragraphs are the body. Each entry becomes a <p>. Inline HTML
	// is *not* allowed — Paragraphs are HTML-escaped on the way in.
	// Use Highlights for emphasis blocks.
	Paragraphs []string

	// CTA is the primary call-to-action button. Empty Text or URL
	// hides the button entirely (e.g. notification-only mails).
	CTAText string
	CTAURL  string

	// SecondaryNote appears below the button in muted styling. Good
	// place for "this link expires on …" copy.
	SecondaryNote string

	// Quote is an optional blockquote (e.g. "the requester said:
	// please give me access"). Rendered with a left rule, slightly
	// muted, and HTML-escaped.
	Quote string

	// Reason explains why the recipient is getting this mail. Shows
	// in the footer. Defaults to a generic "you have an account…"
	// when blank — but every caller should set it.
	Reason string

	// ProductName branding line. Defaults to env BRAND_NAME or
	// "Drive360".
	ProductName string

	// SupportEmail surfaces a reply-to / "questions? email us" link
	// in the footer. Defaults to env BRAND_SUPPORT_EMAIL when blank.
	SupportEmail string
}

// Render produces an HTML body and a matching plaintext body. Use the
// HTML for Message.HTMLBody and the text for Message.TextBody so the
// multipart/alternative wrapper has both parts.
func Render(b Branded) (htmlBody, textBody string) {
	if b.ProductName == "" {
		b.ProductName = firstNonEmpty(os.Getenv("BRAND_NAME"), "Drive360")
	}
	if b.SupportEmail == "" {
		b.SupportEmail = strings.TrimSpace(os.Getenv("BRAND_SUPPORT_EMAIL"))
	}
	if b.Reason == "" {
		b.Reason = "You're receiving this because you have a " + b.ProductName + " account."
	}
	postal := strings.TrimSpace(os.Getenv("BRAND_POSTAL_ADDRESS"))
	appURL := strings.TrimSpace(os.Getenv("APP_URL"))
	if appURL == "" {
		appURL = "https://drive360.app"
	}

	return renderHTML(b, postal, appURL), renderText(b, postal, appURL)
}

func renderHTML(b Branded, postal, appURL string) string {
	var s strings.Builder

	// -- shell --------------------------------------------------------
	s.WriteString(`<!DOCTYPE html>
<html lang="en" xmlns="http://www.w3.org/1999/xhtml" xmlns:v="urn:schemas-microsoft-com:vml" xmlns:o="urn:schemas-microsoft-com:office:office">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="X-UA-Compatible" content="IE=edge">
<meta name="color-scheme" content="light dark">
<meta name="supported-color-schemes" content="light dark">
<title>`)
	s.WriteString(htmlpkg.EscapeString(b.Title))
	s.WriteString(`</title>
<!--[if mso]>
<style type="text/css">
table, td, div, h1, p { font-family: Arial, sans-serif !important; }
</style>
<![endif]-->
<style>
@media (prefers-color-scheme: dark) {
  body, .bg-page { background:#0b1220 !important; color:#e2e8f0 !important; }
  .card { background:#111827 !important; border-color:#1f2937 !important; }
  .muted { color:#94a3b8 !important; }
  .divider { border-color:#1f2937 !important; }
}
@media only screen and (max-width: 620px) {
  .card { width:100% !important; border-radius:0 !important; }
  .pad-x { padding-left:20px !important; padding-right:20px !important; }
}
</style>
</head>
<body class="bg-page" style="margin:0;padding:0;background:#f1f5f9;color:#0f172a;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">
`)

	// Hidden preheader. The non-breaking-space spam — those `&zwnj;` /
	// `&nbsp;` runs — pad the preview text out so Gmail doesn't pull
	// the next visible line into the inbox preview behind it.
	if b.PreviewText != "" {
		s.WriteString(`<div style="display:none;font-size:1px;color:#f1f5f9;line-height:1px;max-height:0;max-width:0;opacity:0;overflow:hidden;mso-hide:all;">`)
		s.WriteString(htmlpkg.EscapeString(b.PreviewText))
		s.WriteString(strings.Repeat("&zwnj;&nbsp;", 60))
		s.WriteString(`</div>`)
	}

	// Outer 100% wrapper for client backdrops.
	s.WriteString(`<table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="background:#f1f5f9;">
<tr><td align="center" style="padding:32px 12px;">
<table role="presentation" class="card" width="600" cellspacing="0" cellpadding="0" border="0" style="width:600px;max-width:600px;background:#ffffff;border:1px solid #e2e8f0;border-radius:12px;overflow:hidden;">
`)

	// -- header bar ---------------------------------------------------
	s.WriteString(`<tr><td class="pad-x" style="padding:24px 32px 0 32px;">
<table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0">
<tr>
<td align="left" style="font-size:14px;font-weight:600;letter-spacing:0.04em;text-transform:uppercase;color:#0f172a;">`)
	s.WriteString(htmlpkg.EscapeString(b.ProductName))
	s.WriteString(`</td>
</tr>
</table>
</td></tr>
`)

	// -- title --------------------------------------------------------
	s.WriteString(`<tr><td class="pad-x" style="padding:20px 32px 4px 32px;">
<h1 style="margin:0;font-size:22px;line-height:1.3;font-weight:600;color:#0f172a;">`)
	s.WriteString(htmlpkg.EscapeString(b.Title))
	s.WriteString(`</h1>
</td></tr>
`)

	// -- body ---------------------------------------------------------
	s.WriteString(`<tr><td class="pad-x" style="padding:12px 32px 0 32px;font-size:15px;line-height:1.6;color:#334155;">
`)
	if b.Greeting != "" {
		s.WriteString(`<p style="margin:0 0 12px 0;">`)
		s.WriteString(htmlpkg.EscapeString(b.Greeting))
		s.WriteString(`</p>
`)
	}
	for _, p := range b.Paragraphs {
		s.WriteString(`<p style="margin:0 0 12px 0;">`)
		s.WriteString(htmlpkg.EscapeString(p))
		s.WriteString(`</p>
`)
	}
	if b.Quote != "" {
		s.WriteString(`<table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="margin:8px 0 16px 0;">
<tr><td style="padding:10px 14px;background:#f8fafc;border-left:3px solid #cbd5e1;color:#475569;font-size:14px;line-height:1.6;">`)
		s.WriteString(htmlpkg.EscapeString(b.Quote))
		s.WriteString(`</td></tr></table>
`)
	}
	s.WriteString(`</td></tr>
`)

	// -- CTA (bullet-proof button) ------------------------------------
	if b.CTAText != "" && b.CTAURL != "" {
		s.WriteString(`<tr><td class="pad-x" align="left" style="padding:12px 32px 0 32px;">
<!--[if mso]>
<v:roundrect xmlns:v="urn:schemas-microsoft-com:vml" xmlns:w="urn:schemas-microsoft-com:office:word" href="`)
		s.WriteString(b.CTAURL)
		s.WriteString(`" style="height:44px;v-text-anchor:middle;width:220px;" arcsize="14%" stroke="f" fillcolor="#0f172a">
<w:anchorlock/>
<center style="color:#ffffff;font-family:Arial,sans-serif;font-size:15px;font-weight:600;">`)
		s.WriteString(htmlpkg.EscapeString(b.CTAText))
		s.WriteString(`</center>
</v:roundrect>
<![endif]-->
<!--[if !mso]><!-- -->
<a href="`)
		s.WriteString(b.CTAURL)
		s.WriteString(`" style="display:inline-block;background:#0f172a;color:#ffffff;text-decoration:none;font-weight:600;font-size:15px;line-height:44px;padding:0 22px;border-radius:8px;">`)
		s.WriteString(htmlpkg.EscapeString(b.CTAText))
		s.WriteString(`</a>
<!--<![endif]-->
</td></tr>
`)

		// "If the button doesn't work, paste this URL" — both helps
		// users on text-only clients and is a known anti-phishing
		// pattern filters score positively on.
		s.WriteString(`<tr><td class="pad-x muted" style="padding:10px 32px 0 32px;font-size:12px;color:#64748b;line-height:1.5;">
If the button doesn't work, copy this URL into your browser:<br>
<span style="word-break:break-all;color:#475569;">`)
		s.WriteString(htmlpkg.EscapeString(b.CTAURL))
		s.WriteString(`</span>
</td></tr>
`)
	}

	// -- secondary note ----------------------------------------------
	if b.SecondaryNote != "" {
		s.WriteString(`<tr><td class="pad-x muted" style="padding:14px 32px 0 32px;font-size:13px;color:#64748b;line-height:1.6;">`)
		s.WriteString(htmlpkg.EscapeString(b.SecondaryNote))
		s.WriteString(`</td></tr>
`)
	}

	// -- divider + footer ---------------------------------------------
	s.WriteString(`<tr><td class="pad-x" style="padding:24px 32px 0 32px;">
<hr class="divider" style="border:none;border-top:1px solid #e2e8f0;margin:0;">
</td></tr>
<tr><td class="pad-x muted" style="padding:14px 32px 24px 32px;font-size:12px;color:#94a3b8;line-height:1.6;">
`)
	s.WriteString(htmlpkg.EscapeString(b.Reason))
	if b.SupportEmail != "" {
		s.WriteString(`<br>Questions? Reply to this email or contact <a href="mailto:`)
		s.WriteString(htmlpkg.EscapeString(b.SupportEmail))
		s.WriteString(`" style="color:#475569;">`)
		s.WriteString(htmlpkg.EscapeString(b.SupportEmail))
		s.WriteString(`</a>.`)
	}
	s.WriteString(`<br>`)
	s.WriteString(htmlpkg.EscapeString(b.ProductName))
	if postal != "" {
		s.WriteString(` &middot; `)
		s.WriteString(htmlpkg.EscapeString(postal))
	}
	s.WriteString(`
</td></tr>
</table>
</td></tr>
</table>
</body>
</html>`)

	return s.String()
}

func renderText(b Branded, postal, appURL string) string {
	var s strings.Builder
	s.WriteString(b.Title)
	s.WriteString("\n")
	s.WriteString(strings.Repeat("=", len(b.Title)))
	s.WriteString("\n\n")

	if b.Greeting != "" {
		s.WriteString(b.Greeting)
		s.WriteString("\n\n")
	}
	for _, p := range b.Paragraphs {
		s.WriteString(p)
		s.WriteString("\n\n")
	}
	if b.Quote != "" {
		// Indented quote so plain-text readers can tell it's pulled-in
		// content rather than authored prose.
		for _, line := range strings.Split(b.Quote, "\n") {
			s.WriteString("    ")
			s.WriteString(line)
			s.WriteString("\n")
		}
		s.WriteString("\n")
	}
	if b.CTAText != "" && b.CTAURL != "" {
		s.WriteString(b.CTAText)
		s.WriteString(":\n")
		s.WriteString(b.CTAURL)
		s.WriteString("\n\n")
	}
	if b.SecondaryNote != "" {
		s.WriteString(b.SecondaryNote)
		s.WriteString("\n\n")
	}

	// Footer matches the HTML version one-to-one so anti-spam
	// "alternative parts diverge" rules don't fire.
	s.WriteString("--\n")
	s.WriteString(b.Reason)
	s.WriteString("\n")
	if b.SupportEmail != "" {
		s.WriteString("Questions? Reply to this email or contact ")
		s.WriteString(b.SupportEmail)
		s.WriteString(".\n")
	}
	s.WriteString(b.ProductName)
	if postal != "" {
		s.WriteString(" · ")
		s.WriteString(postal)
	}
	s.WriteString("\n")
	return s.String()
}

func firstNonEmpty(vals ...string) string {
	for _, v := range vals {
		if strings.TrimSpace(v) != "" {
			return v
		}
	}
	return ""
}

// --- small helper exported for the few places that only need the
// raw HTML wrapper without composing a full Branded payload --------

// QuickHTML is a convenience wrapper for one-off transactional sends
// (the test button in mail settings, ad-hoc admin notices). Given a
// title and a plain English body, returns the same shell as Render
// but without a CTA. Use Render for anything user-facing.
func QuickHTML(title, body string) (htmlBody, textBody string) {
	return Render(Branded{
		PreviewText: body,
		Title:       title,
		Paragraphs:  []string{body},
		Reason:      "You're receiving this because someone with admin access on your workspace triggered a test send.",
	})
}

