package email

// AWS SES provider — uses the SES v2 "outbound-emails" REST endpoint
// with raw RFC822 content so attachments and HTML alternative parts
// keep working through the same buildRFC822 path used by SMTP.
//
// We sign the request with AWS SigV4 in-process rather than pulling in
// aws-sdk-go-v2: the SDK adds ~5MB of indirect deps and we only need
// one operation. The signing code below is the canonical
// "AWS Signature Version 4 for HTTPS" recipe verbatim — see
// https://docs.aws.amazon.com/general/latest/gr/sigv4-signed-request-examples.html
// for the reference implementation we're mirroring.

import (
	"bytes"
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"sort"
	"strings"
	"time"
)

type sesProvider struct {
	accessKey string
	secretKey string
	region    string
	client    *http.Client
}

func newSES(extra map[string]interface{}) (*sesProvider, error) {
	access, _ := extra["accessKey"].(string)
	secret, _ := extra["secretKey"].(string)
	region, _ := extra["region"].(string)
	if access == "" || secret == "" {
		return nil, fmt.Errorf("ses: accessKey and secretKey are required")
	}
	if region == "" {
		// SES is region-scoped; default to us-east-1 to match the AWS console
		// default, but most real installs will set this explicitly.
		region = "us-east-1"
	}
	return &sesProvider{
		accessKey: access,
		secretKey: secret,
		region:    region,
		client:    &http.Client{Timeout: 30 * time.Second},
	}, nil
}

func (p *sesProvider) Name() string { return "ses" }

func (p *sesProvider) Send(ctx context.Context, m Message) (Result, error) {
	// Reuse the existing RFC822 builder so attachments + multipart layout
	// stay consistent with the SMTP provider — SES Raw simply forwards
	// these bytes after dropping in its own message ID header.
	raw, err := buildRFC822(m)
	if err != nil {
		return Result{}, err
	}

	dest := map[string]any{}
	if len(m.To) > 0 {
		dest["ToAddresses"] = m.To
	}
	if len(m.CC) > 0 {
		dest["CcAddresses"] = m.CC
	}
	if len(m.BCC) > 0 {
		dest["BccAddresses"] = m.BCC
	}
	body := map[string]any{
		"FromEmailAddress": fromHeader(m.From, m.FromName),
		"Destination":      dest,
		"Content": map[string]any{
			"Raw": map[string]any{
				"Data": base64.StdEncoding.EncodeToString(raw),
			},
		},
	}
	if m.ReplyTo != "" {
		body["ReplyToAddresses"] = []string{m.ReplyTo}
	}
	payload, _ := json.Marshal(body)

	host := "email." + p.region + ".amazonaws.com"
	endpoint := "https://" + host + "/v2/email/outbound-emails"
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, endpoint, bytes.NewReader(payload))
	if err != nil {
		return Result{}, err
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Host", host)

	if err := p.signV4(req, payload); err != nil {
		return Result{}, err
	}

	resp, err := p.client.Do(req)
	if err != nil {
		return Result{}, err
	}
	defer resp.Body.Close()
	respBody, _ := io.ReadAll(io.LimitReader(resp.Body, 8192))
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return Result{}, fmt.Errorf("ses %d: %s", resp.StatusCode, strings.TrimSpace(string(respBody)))
	}
	var parsed struct {
		MessageID string `json:"MessageId"`
	}
	_ = json.Unmarshal(respBody, &parsed)
	return Result{ProviderID: parsed.MessageID}, nil
}

// signV4 attaches the AWS Signature V4 Authorization header to req. The
// recipe — canonical request → string-to-sign → derive signing key →
// hex-encode HMAC — comes straight from the AWS docs and matches what
// aws-sdk-go's `v4.SignHTTP` produces for a JSON POST.
func (p *sesProvider) signV4(req *http.Request, payload []byte) error {
	const service = "ses"
	now := time.Now().UTC()
	amzDate := now.Format("20060102T150405Z")
	dateStamp := now.Format("20060102")

	bodyHash := sha256Hex(payload)
	req.Header.Set("X-Amz-Date", amzDate)
	req.Header.Set("X-Amz-Content-Sha256", bodyHash)

	// Canonical headers — names lowercased, values trimmed, sorted by name.
	signedHeaderNames := []string{"content-type", "host", "x-amz-content-sha256", "x-amz-date"}
	sort.Strings(signedHeaderNames)
	var canonHeaders strings.Builder
	for _, name := range signedHeaderNames {
		v := req.Header.Get(name)
		if name == "host" {
			v = req.Host
			if v == "" {
				v = req.URL.Host
			}
		}
		canonHeaders.WriteString(name)
		canonHeaders.WriteString(":")
		canonHeaders.WriteString(strings.TrimSpace(v))
		canonHeaders.WriteString("\n")
	}
	signedHeaders := strings.Join(signedHeaderNames, ";")

	canonicalRequest := strings.Join([]string{
		req.Method,
		req.URL.Path, // already absolute
		req.URL.RawQuery,
		canonHeaders.String(),
		signedHeaders,
		bodyHash,
	}, "\n")

	credentialScope := fmt.Sprintf("%s/%s/%s/aws4_request", dateStamp, p.region, service)
	stringToSign := strings.Join([]string{
		"AWS4-HMAC-SHA256",
		amzDate,
		credentialScope,
		sha256Hex([]byte(canonicalRequest)),
	}, "\n")

	kDate := hmacSHA256([]byte("AWS4"+p.secretKey), []byte(dateStamp))
	kRegion := hmacSHA256(kDate, []byte(p.region))
	kService := hmacSHA256(kRegion, []byte(service))
	kSigning := hmacSHA256(kService, []byte("aws4_request"))
	signature := hex.EncodeToString(hmacSHA256(kSigning, []byte(stringToSign)))

	auth := fmt.Sprintf(
		"AWS4-HMAC-SHA256 Credential=%s/%s, SignedHeaders=%s, Signature=%s",
		p.accessKey, credentialScope, signedHeaders, signature,
	)
	req.Header.Set("Authorization", auth)
	return nil
}

func sha256Hex(b []byte) string {
	h := sha256.Sum256(b)
	return hex.EncodeToString(h[:])
}

func hmacSHA256(key, data []byte) []byte {
	h := hmac.New(sha256.New, key)
	h.Write(data)
	return h.Sum(nil)
}
