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
	"crypto/tls"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"mime/multipart"
	"net/http"
	"net/smtp"
	"net/textproto"
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

// buildRFC822 writes a multipart/mixed message with headers, optional text
// and HTML bodies as multipart/alternative, plus any attachments.
func buildRFC822(m Message) ([]byte, error) {
	var buf bytes.Buffer
	mixed := multipart.NewWriter(&buf)

	// Top-level headers.
	fmt.Fprintf(&buf, "From: %s\r\n", fromHeader(m.From, m.FromName))
	fmt.Fprintf(&buf, "To: %s\r\n", strings.Join(m.To, ", "))
	if len(m.CC) > 0 {
		fmt.Fprintf(&buf, "Cc: %s\r\n", strings.Join(m.CC, ", "))
	}
	if m.ReplyTo != "" {
		fmt.Fprintf(&buf, "Reply-To: %s\r\n", m.ReplyTo)
	}
	fmt.Fprintf(&buf, "Subject: %s\r\n", m.Subject)
	fmt.Fprintf(&buf, "MIME-Version: 1.0\r\n")
	fmt.Fprintf(&buf, "Content-Type: multipart/mixed; boundary=%q\r\n\r\n", mixed.Boundary())

	// Alternative part (text + html). Email clients render whichever they can.
	altHeader := textproto.MIMEHeader{}
	alt := multipart.NewWriter(&buf)
	altHeader.Set("Content-Type", fmt.Sprintf("multipart/alternative; boundary=%q", alt.Boundary()))

	altBoundary := mixed.Boundary()
	_ = altBoundary // silence linter — boundaries are written below

	// Start the first mixed part: multipart/alternative.
	if _, err := fmt.Fprintf(&buf, "--%s\r\n", mixed.Boundary()); err != nil {
		return nil, err
	}
	if _, err := fmt.Fprintf(&buf, "Content-Type: multipart/alternative; boundary=%q\r\n\r\n", alt.Boundary()); err != nil {
		return nil, err
	}
	if m.TextBody != "" {
		fmt.Fprintf(&buf, "--%s\r\n", alt.Boundary())
		fmt.Fprintf(&buf, "Content-Type: text/plain; charset=utf-8\r\n\r\n%s\r\n", m.TextBody)
	}
	if m.HTMLBody != "" {
		fmt.Fprintf(&buf, "--%s\r\n", alt.Boundary())
		fmt.Fprintf(&buf, "Content-Type: text/html; charset=utf-8\r\n\r\n%s\r\n", m.HTMLBody)
	}
	fmt.Fprintf(&buf, "--%s--\r\n", alt.Boundary())

	// Attachments.
	for _, a := range m.Attachments {
		fmt.Fprintf(&buf, "--%s\r\n", mixed.Boundary())
		ct := a.ContentType
		if ct == "" {
			ct = "application/octet-stream"
		}
		fmt.Fprintf(&buf, "Content-Type: %s\r\n", ct)
		fmt.Fprintf(&buf, "Content-Disposition: attachment; filename=%q\r\n", a.Filename)
		fmt.Fprintf(&buf, "Content-Transfer-Encoding: base64\r\n\r\n")
		enc := base64.StdEncoding.EncodeToString(a.Data)
		// Wrap base64 at 76 cols for sanity.
		for i := 0; i < len(enc); i += 76 {
			end := i + 76
			if end > len(enc) {
				end = len(enc)
			}
			buf.WriteString(enc[i:end])
			buf.WriteString("\r\n")
		}
	}
	fmt.Fprintf(&buf, "--%s--\r\n", mixed.Boundary())
	return buf.Bytes(), nil
}

func fromHeader(email, name string) string {
	if name == "" {
		return email
	}
	return fmt.Sprintf("%q <%s>", name, email)
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
