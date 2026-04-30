// Package email implements pluggable transactional email delivery with a
// small provider interface. Four providers ship today:
//
//   - console : logs the send to stdout, always succeeds. Perfect for dev.
//   - smtp    : net/smtp — covers most self-hosted deployments.
//   - resend  : Resend.com HTTP API, JSON body with base64 attachment.
//   - ses     : AWS SES v2 raw outbound endpoint, SigV4-signed, no SDK.
//
// Additional providers (Postmark, Sendgrid, …) slot in by implementing
// Provider and registering in `Build()`.
package email

import (
	"bytes"
	"context"
	"crypto/rand"
	"crypto/tls"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"mime"
	"net/http"
	"net/smtp"
	"os"
	"strings"
	"time"
)

type Attachment struct {
	Filename    string
	ContentType string
	Data        []byte
}

type Message struct {
	From        string
	FromName    string
	ReplyTo     string
	To          []string
	CC          []string
	BCC         []string
	Subject     string
	TextBody    string
	HTMLBody    string
	Attachments []Attachment
}

// Result is the provider-agnostic outcome of Send(). ProviderID is the message
// ID the upstream service assigned (if any) — useful for audit correlation.
type Result struct {
	ProviderID string
}

type Provider interface {
	Send(ctx context.Context, m Message) (Result, error)
	Name() string
}

// Config is the stored per-org configuration (provider + opaque JSON). We
// parse `config` at send time into the provider-specific struct.
type Config struct {
	Provider  string                 `json:"provider"`
	FromName  string                 `json:"fromName"`
	FromEmail string                 `json:"fromEmail"`
	ReplyTo   string                 `json:"replyTo"`
	Extra     map[string]interface{} `json:"config"`
}

// Build returns a ready-to-use Provider for the configured provider name.
// Returns an error for misconfigured providers.
func Build(cfg Config) (Provider, error) {
	switch strings.ToLower(cfg.Provider) {
	case "", "console":
		return &consoleProvider{}, nil
	case "smtp":
		return newSMTP(cfg.Extra)
	case "resend":
		return newResend(cfg.Extra)
	case "ses":
		return newSES(cfg.Extra)
	default:
		return nil, fmt.Errorf("unknown email provider %q", cfg.Provider)
	}
}

// -- Console (dev) --------------------------------------------------------

type consoleProvider struct{}

func (c *consoleProvider) Name() string { return "console" }

func (c *consoleProvider) Send(_ context.Context, m Message) (Result, error) {
	fmt.Printf("[console email] %s -> %v  subject=%q  attachments=%d\n",
		fromHeader(m.From, m.FromName), m.To, m.Subject, len(m.Attachments))
	return Result{ProviderID: fmt.Sprintf("console-%d", time.Now().UnixNano())}, nil
}

// -- SMTP -----------------------------------------------------------------

type smtpProvider struct {
	host     string
	port     int
	username string
	password string
	startTLS bool
}

func newSMTP(extra map[string]interface{}) (*smtpProvider, error) {
	host, _ := extra["host"].(string)
	if host == "" {
		return nil, fmt.Errorf("smtp: host is required")
	}
	port := 587
	if v, ok := extra["port"].(float64); ok {
		port = int(v)
	} else if v, ok := extra["port"].(int); ok {
		port = v
	}
	username, _ := extra["username"].(string)
	password, _ := extra["password"].(string)
	startTLS := true
	if v, ok := extra["startTLS"].(bool); ok {
		startTLS = v
	}
	return &smtpProvider{host: host, port: port, username: username, password: password, startTLS: startTLS}, nil
}

func (s *smtpProvider) Name() string { return "smtp" }

func (s *smtpProvider) Send(ctx context.Context, m Message) (Result, error) {
	var auth smtp.Auth
	if s.username != "" {
		auth = smtp.PlainAuth("", s.username, s.password, s.host)
	}
	raw, err := buildRFC822(m)
	if err != nil {
		return Result{}, err
	}
	addr := fmt.Sprintf("%s:%d", s.host, s.port)
	recipients := append(append(append([]string{}, m.To...), m.CC...), m.BCC...)

	var serverErr error
	done := make(chan struct{})
	go func() {
		defer close(done)
		if s.startTLS {
			serverErr = sendMailStartTLS(addr, s.host, auth, m.From, recipients, raw)
			return
		}
		serverErr = smtp.SendMail(addr, auth, m.From, recipients, raw)
	}()
	select {
	case <-ctx.Done():
		return Result{}, ctx.Err()
	case <-done:
		if serverErr != nil {
			return Result{}, serverErr
		}
	}
	return Result{ProviderID: fmt.Sprintf("smtp-%d", time.Now().UnixNano())}, nil
}

// sendMailStartTLS negotiates STARTTLS before auth. `smtp.SendMail` only does
// implicit TLS (port 465); most providers want STARTTLS on 587.
func sendMailStartTLS(addr, host string, auth smtp.Auth, from string, to []string, body []byte) error {
	c, err := smtp.Dial(addr)
	if err != nil {
		return err
	}
	defer c.Close()
	if err := c.Hello("drive360"); err != nil {
		return err
	}
	if ok, _ := c.Extension("STARTTLS"); ok {
		if err := c.StartTLS(&tls.Config{ServerName: host}); err != nil {
			return err
		}
	}
	if auth != nil {
		if ok, _ := c.Extension("AUTH"); ok {
			if err := c.Auth(auth); err != nil {
				return err
			}
		}
	}
	if err := c.Mail(from); err != nil {
		return err
	}
	for _, addr := range to {
		if err := c.Rcpt(addr); err != nil {
			return err
		}
	}
	wc, err := c.Data()
	if err != nil {
		return err
	}
	if _, err := wc.Write(body); err != nil {
		return err
	}
	if err := wc.Close(); err != nil {
		return err
	}
	return c.Quit()
}

// buildRFC822 writes a multipart/mixed RFC 5322 message with the headers
// modern spam filters look for. The structure is:
//
//   headers
//   └─ multipart/mixed
//      ├─ multipart/alternative
//      │  ├─ text/plain        (quoted-printable)
//      │  └─ text/html         (quoted-printable)
//      └─ application/<type>   (base64) — one per attachment
//
// Spam-filter critical headers we set:
//
//   - Date              : RFC 5322 §3.6.1 — missing or stale Date is the
//                         single most common reason transactional mail
//                         lands in spam.
//   - Message-ID        : RFC 5322 §3.6.4 — random local-part + sender's
//                         domain. Filters trace conversation threads on
//                         this; a missing one is treated as bot output.
//   - MIME-Version: 1.0 : without this, content-type extensions are
//                         technically undefined and some MTAs flag it.
//   - Auto-Submitted    : RFC 3834 — declares this is a system-generated
//                         transactional message, not a reply / bulk blast.
//                         Stops auto-responders (vacation replies) from
//                         bouncing back and signals "legitimate robot."
//   - Precedence: bulk  : legacy but still respected by Yahoo/AOL.
//   - X-Auto-Response-Suppress : Outlook-specific, suppresses OOO replies.
//   - Content-Transfer-Encoding on every part — quoted-printable for
//     text (handles smart quotes / em-dashes safely) and base64 for
//     attachments. Bare 8-bit body parts are a moderate spam signal.
//
// We also RFC-2047-encode the Subject and the From display name when they
// contain non-ASCII so a literal "—" in the subject doesn't get the mail
// flagged on older relays.
func buildRFC822(m Message) ([]byte, error) {
	var buf bytes.Buffer
	mixedBoundary := newBoundary()
	altBoundary := newBoundary()

	// -- Top-level headers ---------------------------------------------
	writeHeader(&buf, "Date", time.Now().UTC().Format(time.RFC1123Z))
	writeHeader(&buf, "From", fromHeader(m.From, m.FromName))
	writeHeader(&buf, "To", strings.Join(m.To, ", "))
	if len(m.CC) > 0 {
		writeHeader(&buf, "Cc", strings.Join(m.CC, ", "))
	}
	if m.ReplyTo != "" {
		writeHeader(&buf, "Reply-To", m.ReplyTo)
	}
	writeHeader(&buf, "Subject", encodeHeaderWord(m.Subject))
	writeHeader(&buf, "Message-ID", newMessageID(m.From))
	writeHeader(&buf, "MIME-Version", "1.0")
	// Mark this as a system-generated transactional mail. Two upsides:
	// (1) auto-responders won't bounce back at us; (2) filters score
	// "auto-generated" lower than uncategorised cold mail.
	writeHeader(&buf, "Auto-Submitted", "auto-generated")
	writeHeader(&buf, "X-Auto-Response-Suppress", "All")
	writeHeader(&buf, "Precedence", "bulk")
	writeHeader(&buf, "X-Mailer", "Drive360 Mailer")
	writeHeader(&buf, "Content-Type",
		fmt.Sprintf(`multipart/mixed; boundary="%s"`, mixedBoundary))
	buf.WriteString("\r\n")

	// -- multipart/alternative (text + html) ---------------------------
	fmt.Fprintf(&buf, "--%s\r\n", mixedBoundary)
	fmt.Fprintf(&buf, "Content-Type: multipart/alternative; boundary=\"%s\"\r\n\r\n", altBoundary)

	// We always emit at least one of the two parts; if a caller forgot
	// the text/plain alternative we generate a one-line stub from the
	// subject so clients that prefer plaintext (and filters that
	// punish "html-only" mails) still see something.
	textBody := m.TextBody
	if textBody == "" {
		textBody = m.Subject
	}
	if textBody != "" {
		fmt.Fprintf(&buf, "--%s\r\n", altBoundary)
		buf.WriteString("Content-Type: text/plain; charset=utf-8\r\n")
		buf.WriteString("Content-Transfer-Encoding: quoted-printable\r\n\r\n")
		buf.WriteString(quotedPrintable(textBody))
		buf.WriteString("\r\n")
	}
	if m.HTMLBody != "" {
		fmt.Fprintf(&buf, "--%s\r\n", altBoundary)
		buf.WriteString("Content-Type: text/html; charset=utf-8\r\n")
		buf.WriteString("Content-Transfer-Encoding: quoted-printable\r\n\r\n")
		buf.WriteString(quotedPrintable(m.HTMLBody))
		buf.WriteString("\r\n")
	}
	fmt.Fprintf(&buf, "--%s--\r\n", altBoundary)

	// -- Attachments ---------------------------------------------------
	for _, a := range m.Attachments {
		fmt.Fprintf(&buf, "--%s\r\n", mixedBoundary)
		ct := a.ContentType
		if ct == "" {
			ct = "application/octet-stream"
		}
		// Encode filename per RFC 2231 so non-ASCII names survive.
		filenameParam := mime.BEncoding.Encode("utf-8", a.Filename)
		fmt.Fprintf(&buf, "Content-Type: %s; name=\"%s\"\r\n", ct, filenameParam)
		fmt.Fprintf(&buf, "Content-Disposition: attachment; filename=\"%s\"\r\n", filenameParam)
		buf.WriteString("Content-Transfer-Encoding: base64\r\n\r\n")
		enc := base64.StdEncoding.EncodeToString(a.Data)
		// Wrap base64 at 76 cols (RFC 2045).
		for i := 0; i < len(enc); i += 76 {
			end := i + 76
			if end > len(enc) {
				end = len(enc)
			}
			buf.WriteString(enc[i:end])
			buf.WriteString("\r\n")
		}
	}
	fmt.Fprintf(&buf, "--%s--\r\n", mixedBoundary)
	return buf.Bytes(), nil
}

// writeHeader writes one header, folding long lines so any single
// header doesn't exceed RFC 5322's 998-char limit. Most headers are
// short; the folding only kicks in for the From / Subject when names
// or sender lists are large.
func writeHeader(buf *bytes.Buffer, name, value string) {
	value = strings.ReplaceAll(value, "\r", "")
	value = strings.ReplaceAll(value, "\n", " ")
	line := name + ": " + value
	const max = 990
	for len(line) > max {
		// Fold at the last whitespace before the limit.
		cut := strings.LastIndexAny(line[:max], " \t")
		if cut <= len(name)+2 {
			cut = max
		}
		buf.WriteString(line[:cut])
		buf.WriteString("\r\n ")
		line = strings.TrimLeft(line[cut:], " \t")
	}
	buf.WriteString(line)
	buf.WriteString("\r\n")
}

// fromHeader produces a properly RFC-5322-quoted From / Sender value.
// Names containing "specials" (commas, parentheses, quotes, etc.) need
// to live inside a quoted-string; bare names with spaces don't strictly
// require quoting but every major MTA prefers them quoted, so we always
// emit `"Name" <addr@host>` when a name is present. Non-ASCII display
// names are encoded with RFC 2047 B-encoding so filters that reject
// raw 8-bit headers still accept us.
func fromHeader(addr, name string) string {
	if name == "" {
		return addr
	}
	encoded := encodeHeaderWord(name)
	if encoded == name {
		// Pure ASCII — plain quoted-string, escaping inner quotes.
		safe := strings.ReplaceAll(name, `\`, `\\`)
		safe = strings.ReplaceAll(safe, `"`, `\"`)
		return fmt.Sprintf(`"%s" <%s>`, safe, addr)
	}
	return fmt.Sprintf("%s <%s>", encoded, addr)
}

// encodeHeaderWord wraps the value in RFC 2047 B-encoding when it
// contains any non-ASCII byte. Pure-ASCII values pass through as-is so
// the common case stays human-readable in the wire format.
func encodeHeaderWord(s string) string {
	for _, r := range s {
		if r > 0x7f {
			return mime.BEncoding.Encode("utf-8", s)
		}
	}
	return s
}

// quotedPrintable encodes a body part per RFC 2045 §6.7. Modern smart
// quotes / em-dashes / non-breaking spaces (which our marketing copy
// uses liberally) are 8-bit and would otherwise need a `8bit` CTE which
// not every relay supports.
func quotedPrintable(s string) string {
	var out bytes.Buffer
	col := 0
	flush := func(n int) {
		if col+n > 75 {
			out.WriteString("=\r\n")
			col = 0
		}
	}
	for i := 0; i < len(s); i++ {
		c := s[i]
		switch {
		case c == '\n':
			out.WriteString("\r\n")
			col = 0
		case c == '\r':
			// drop bare CR — \r\n handled via \n above
		case c == '=' || c < 32 || c > 126:
			if c == '\t' {
				flush(1)
				out.WriteByte('\t')
				col++
				continue
			}
			flush(3)
			fmt.Fprintf(&out, "=%02X", c)
			col += 3
		default:
			flush(1)
			out.WriteByte(c)
			col++
		}
	}
	return out.String()
}

// newBoundary returns a 24-hex-char boundary unlikely to collide with
// anything in the body. Multipart boundaries that look "structured"
// (e.g. always start with `boundary_`) are sometimes pattern-matched by
// naive filters, so we use plain hex.
func newBoundary() string {
	var b [16]byte
	if _, err := rand.Read(b[:]); err != nil {
		return fmt.Sprintf("b%d", time.Now().UnixNano())
	}
	return hex.EncodeToString(b[:])
}

// newMessageID synthesises an RFC 5322 Message-ID. The local part is
// random; the domain mirrors the sender so SPF/DKIM-aligned filters
// won't downgrade us for an off-domain Message-ID. Falls back to the
// process hostname when the From address is malformed.
func newMessageID(from string) string {
	domain := "drive360.local"
	if at := strings.LastIndex(from, "@"); at >= 0 && at+1 < len(from) {
		domain = strings.TrimSpace(from[at+1:])
		// Strip any "<addr>" wrapping that sneaks in via fromHeader.
		domain = strings.TrimRight(domain, ">")
	}
	if domain == "" {
		if h, err := os.Hostname(); err == nil && h != "" {
			domain = h
		} else {
			domain = "drive360.local"
		}
	}
	var b [12]byte
	_, _ = rand.Read(b[:])
	return fmt.Sprintf("<%s.%d@%s>", hex.EncodeToString(b[:]), time.Now().UnixNano(), domain)
}

// -- Resend ---------------------------------------------------------------

type resendProvider struct {
	apiKey string
	client *http.Client
}

func newResend(extra map[string]interface{}) (*resendProvider, error) {
	key, _ := extra["apiKey"].(string)
	if key == "" {
		return nil, fmt.Errorf("resend: apiKey is required")
	}
	return &resendProvider{apiKey: key, client: &http.Client{Timeout: 20 * time.Second}}, nil
}

func (p *resendProvider) Name() string { return "resend" }

func (p *resendProvider) Send(ctx context.Context, m Message) (Result, error) {
	type rAtt struct {
		Filename string `json:"filename"`
		Content  string `json:"content"` // base64
	}
	body := map[string]interface{}{
		"from":    fromHeader(m.From, m.FromName),
		"to":      m.To,
		"subject": m.Subject,
	}
	if len(m.CC) > 0 {
		body["cc"] = m.CC
	}
	if len(m.BCC) > 0 {
		body["bcc"] = m.BCC
	}
	if m.ReplyTo != "" {
		body["reply_to"] = m.ReplyTo
	}
	if m.HTMLBody != "" {
		body["html"] = m.HTMLBody
	}
	if m.TextBody != "" {
		body["text"] = m.TextBody
	}
	if len(m.Attachments) > 0 {
		atts := make([]rAtt, 0, len(m.Attachments))
		for _, a := range m.Attachments {
			atts = append(atts, rAtt{
				Filename: a.Filename,
				Content:  base64.StdEncoding.EncodeToString(a.Data),
			})
		}
		body["attachments"] = atts
	}
	raw, _ := json.Marshal(body)
	req, _ := http.NewRequestWithContext(ctx, http.MethodPost, "https://api.resend.com/emails", bytes.NewReader(raw))
	req.Header.Set("Authorization", "Bearer "+p.apiKey)
	req.Header.Set("Content-Type", "application/json")
	resp, err := p.client.Do(req)
	if err != nil {
		return Result{}, err
	}
	defer resp.Body.Close()
	respBody, _ := io.ReadAll(io.LimitReader(resp.Body, 4096))
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return Result{}, fmt.Errorf("resend %d: %s", resp.StatusCode, strings.TrimSpace(string(respBody)))
	}
	var parsed struct {
		ID string `json:"id"`
	}
	_ = json.Unmarshal(respBody, &parsed)
	return Result{ProviderID: parsed.ID}, nil
}
