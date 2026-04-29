package storage

import (
	"bytes"
	"context"
	"fmt"
	"io"
	"net/url"
	"os"
	"time"

	"github.com/minio/minio-go/v7"
	"github.com/minio/minio-go/v7/pkg/credentials"
)

func bytesReader(b []byte) io.Reader { return bytes.NewReader(b) }

type Client struct {
	mc         *minio.Client
	publicMC   *minio.Client
	bucket     string
}

func New() (*Client, error) {
	endpoint := getenv("MINIO_ENDPOINT", "localhost:9000")
	publicEndpoint := getenv("MINIO_PUBLIC_ENDPOINT", endpoint)
	access := getenv("MINIO_ACCESS_KEY", "minioadmin")
	secret := getenv("MINIO_SECRET_KEY", "minioadmin")
	bucket := getenv("MINIO_BUCKET", "docforge")
	region := getenv("MINIO_REGION", "us-east-1")
	useSSL := os.Getenv("MINIO_SSL") == "true"
	publicUseSSL := useSSL
	if v := os.Getenv("MINIO_PUBLIC_SSL"); v != "" {
		publicUseSSL = v == "true"
	}

	creds := credentials.NewStaticV4(access, secret, "")

	// Region is set explicitly so PresignedPostPolicy / GetBucketLocation
	// don't probe the network at request time. Without this, the public
	// client tries to HEAD the public endpoint and chokes if anything
	// (nginx redirects, TLS quirks) is in front of MinIO.
	mc, err := minio.New(endpoint, &minio.Options{Creds: creds, Secure: useSSL, Region: region})
	if err != nil {
		return nil, err
	}

	publicMC := mc
	if publicEndpoint != endpoint || publicUseSSL != useSSL {
		publicMC, err = minio.New(publicEndpoint, &minio.Options{Creds: creds, Secure: publicUseSSL, Region: region})
		if err != nil {
			return nil, err
		}
	}

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	exists, err := mc.BucketExists(ctx, bucket)
	if err != nil {
		return nil, err
	}
	if !exists {
		if err := mc.MakeBucket(ctx, bucket, minio.MakeBucketOptions{}); err != nil {
			return nil, err
		}
	}

	return &Client{mc: mc, publicMC: publicMC, bucket: bucket}, nil
}

func (c *Client) Bucket() string { return c.bucket }

func (c *Client) PresignPut(ctx context.Context, key string, ttl time.Duration) (string, error) {
	u, err := c.publicMC.PresignedPutObject(ctx, c.bucket, key, ttl)
	if err != nil {
		return "", err
	}
	return u.String(), nil
}

// PostUpload bundles everything a browser needs to POST a multipart form
// upload to the bucket. The fields map carries the signature, policy
// hash, and other AWS-style form parameters; the URL is the bucket
// endpoint. Clients build a FormData with every field plus a final
// "file" part and POST to the URL.
type PostUpload struct {
	URL    string            `json:"url"`
	Fields map[string]string `json:"fields"`
}

// PresignPost returns a presigned POST policy that lets the browser
// upload directly to the bucket. Unlike PresignedPutObject, this lets us
// bake hard constraints into the policy itself:
//
//   - content-length range — MinIO refuses oversize uploads at the edge,
//     so we don't waste bandwidth/storage on a payload we'd reject anyway.
//   - exact key — clients can't rewrite the object key.
//   - content-type — clients can't lie about the type at the storage
//     layer (they still can to our API, but the stored object's
//     Content-Type matches what was advertised).
//
// `expectedMime` is what the client claimed when calling our presign
// endpoint; we lock the storage object to that value. `maxBytes` comes
// from the resolved upload policy.
func (c *Client) PresignPost(
	ctx context.Context,
	key, expectedMime string,
	maxBytes int64,
	ttl time.Duration,
) (*PostUpload, error) {
	pp := minio.NewPostPolicy()
	if err := pp.SetBucket(c.bucket); err != nil {
		return nil, err
	}
	if err := pp.SetKey(key); err != nil {
		return nil, err
	}
	if err := pp.SetExpires(time.Now().UTC().Add(ttl)); err != nil {
		return nil, err
	}
	if expectedMime == "" {
		expectedMime = "application/octet-stream"
	}
	if err := pp.SetContentType(expectedMime); err != nil {
		return nil, err
	}
	// Min 1 byte (so empty uploads aren't silently accepted), max from
	// policy. SetContentLengthRange is what makes the bucket reject
	// >maxBytes at write time.
	if err := pp.SetContentLengthRange(1, maxBytes); err != nil {
		return nil, err
	}
	u, fields, err := c.publicMC.PresignedPostPolicy(ctx, pp)
	if err != nil {
		return nil, err
	}
	return &PostUpload{URL: u.String(), Fields: fields}, nil
}

// PresignGet returns a download URL with `Content-Disposition: attachment`
// ALWAYS forced via the response-content-disposition presign param. This
// is the secure-by-default download primitive: every byte stream that
// flows through this URL hits the browser as a save dialog, never an
// in-page render. Stored XSS via a forged text/html upload — even one
// that slipped past CanonicalMime sniffing — can't fire when the
// browser refuses to render the response inline.
//
// Why force unconditionally, not just for risky MIMEs:
//
//   - Defense in depth. The MIME stored on the object is user-influenced
//     (the upload sniffer is best-effort, the bucket itself just stores
//     whatever was POSTed). Trusting that mime to gate disposition gives
//     the attacker one bit of control over how the browser interprets
//     the response.
//   - The "let the browser decide for safe MIMEs" branch was never
//     load-bearing — every caller of PresignGet either passes a real
//     filename (download intent explicit) or wants a save dialog anyway.
//     The two genuine "render this in an iframe" callers use
//     PresignGetInline.
//
// `filename` is reflected verbatim into the disposition value when set,
// or "download" when blank. The mime arg is retained because we still
// want it to influence sanitisation (and could re-purpose it for an
// RFC 5987 filename* fallback later) — it just no longer flips the
// disposition branch.
func (c *Client) PresignGet(ctx context.Context, key, mime, filename string, ttl time.Duration) (string, error) {
	_ = mime // currently advisory; see comment.
	params := url.Values{}
	params.Set("response-content-disposition", attachmentDisposition(filename))
	u, err := c.publicMC.PresignedGetObject(ctx, c.bucket, key, ttl, params)
	if err != nil {
		return "", err
	}
	return u.String(), nil
}

// PresignGetInline returns a presigned GET URL with an explicit
// `Content-Disposition: inline` response override, so browsers render
// the payload in-place (e.g. an iframe'd PDF) instead of offering a
// download.
//
// SECURITY: when `mime` is a risky renderable type (HTML, SVG, XHTML,
// JS-bearing) we refuse the caller's `inline` intent and force
// attachment. Inline-rendering attacker-supplied HTML/SVG is the classic
// stored-XSS path; even if the caller asked for inline, it's never the
// right answer for those MIMEs. Pass `mime=""` only when the content is
// server-generated and known safe (e.g. our own PDF output).
func (c *Client) PresignGetInline(ctx context.Context, key, mime string, ttl time.Duration) (string, error) {
	params := url.Values{}
	if isRiskyMime(mime) {
		// Override caller's intent — risky MIMEs MUST download.
		params.Set("response-content-disposition", `attachment; filename="download"`)
	} else {
		params.Set("response-content-disposition", "inline")
	}
	u, err := c.publicMC.PresignedGetObject(ctx, c.bucket, key, ttl, params)
	if err != nil {
		return "", err
	}
	return u.String(), nil
}

// attachmentDisposition builds the always-attachment Content-Disposition
// value used by PresignGet. Empty filename → "download" so we never
// emit a disposition without a filename (some browsers ignore it
// otherwise, and a generic name keeps log spam consistent).
func attachmentDisposition(filename string) string {
	fn := filename
	if fn == "" {
		fn = "download"
	}
	return fmt.Sprintf(`attachment; filename="%s"`, sanitizeDispFilename(fn))
}

// isRiskyMime is the storage-layer mirror of uploadpolicy.IsRiskyMime —
// duplicated here so the storage package stays free of policy imports.
// Keep these two in sync.
func isRiskyMime(mime string) bool {
	m := lowerTrim(mime)
	if m == "" {
		return false
	}
	if i := indexByte(m, ';'); i >= 0 {
		m = lowerTrim(m[:i])
	}
	switch {
	case m == "text/html", m == "application/xhtml+xml":
		return true
	case len(m) >= 9 && m[:9] == "image/svg":
		return true
	case containsAll(m, "javascript"), containsAll(m, "ecmascript"):
		return true
	}
	return false
}

// sanitizeDispFilename strips quote and CRLF characters from a filename
// before it goes into a Content-Disposition value. Header injection is
// the concern: a filename with a literal `"` or newline could end the
// header early and inject another response header. We don't try to
// support RFC 5987 percent-encoding here — that's a presign URL param,
// the storage proxy reflects it verbatim into the response header.
func sanitizeDispFilename(s string) string {
	out := make([]byte, 0, len(s))
	for i := 0; i < len(s); i++ {
		c := s[i]
		if c == '"' || c == '\\' || c == '\r' || c == '\n' {
			out = append(out, '_')
			continue
		}
		out = append(out, c)
	}
	return string(out)
}

func lowerTrim(s string) string {
	// Trim ASCII whitespace + lowercase ASCII. Avoiding strings.ToLower
	// + strings.TrimSpace to keep this file's import surface small;
	// the storage package shouldn't pull in heavy text deps.
	start := 0
	end := len(s)
	for start < end && (s[start] == ' ' || s[start] == '\t') {
		start++
	}
	for end > start && (s[end-1] == ' ' || s[end-1] == '\t') {
		end--
	}
	out := make([]byte, end-start)
	for i := start; i < end; i++ {
		c := s[i]
		if c >= 'A' && c <= 'Z' {
			c += 32
		}
		out[i-start] = c
	}
	return string(out)
}

func indexByte(s string, b byte) int {
	for i := 0; i < len(s); i++ {
		if s[i] == b {
			return i
		}
	}
	return -1
}

func containsAll(s, sub string) bool {
	if len(sub) == 0 {
		return true
	}
	for i := 0; i+len(sub) <= len(s); i++ {
		if s[i:i+len(sub)] == sub {
			return true
		}
	}
	return false
}

func (c *Client) StatObject(ctx context.Context, key string) (minio.ObjectInfo, error) {
	return c.mc.StatObject(ctx, c.bucket, key, minio.StatObjectOptions{})
}

func (c *Client) Remove(ctx context.Context, key string) error {
	return c.mc.RemoveObject(ctx, c.bucket, key, minio.RemoveObjectOptions{})
}

// Ping issues a cheap round-trip to verify the storage backend is reachable.
// Used by the observability health checker.
func (c *Client) Ping(ctx context.Context) error {
	_, err := c.mc.BucketExists(ctx, c.bucket)
	return err
}

// PutBytes writes the given bytes to the bucket at key with the supplied MIME type.
func (c *Client) PutBytes(ctx context.Context, key, mime string, data []byte) error {
	_, err := c.mc.PutObject(ctx, c.bucket, key, bytesReader(data), int64(len(data)), minio.PutObjectOptions{ContentType: mime})
	return err
}

// GetBytes fetches the full object into memory. Use for small files only (templates, PDFs < 50MB).
func (c *Client) GetBytes(ctx context.Context, key string) ([]byte, error) {
	obj, err := c.mc.GetObject(ctx, c.bucket, key, minio.GetObjectOptions{})
	if err != nil {
		return nil, err
	}
	defer obj.Close()
	return io.ReadAll(obj)
}

// GetReader streams the object as an io.ReadCloser plus its declared
// size. The scanner uses this to feed clamd via INSTREAM without
// materializing the whole blob in memory — important once we get into
// the tens-of-megabytes range. Caller MUST Close().
func (c *Client) GetReader(ctx context.Context, key string) (io.ReadCloser, int64, error) {
	obj, err := c.mc.GetObject(ctx, c.bucket, key, minio.GetObjectOptions{})
	if err != nil {
		return nil, 0, err
	}
	// Stat() drives the size hint we forward to the scanner so it can
	// short-circuit on MaxStreamSize before we burn bandwidth. If Stat
	// fails we still hand back the reader with size=-1 (unknown) — the
	// scanner treats <=0 as "no client-side limit".
	st, err := obj.Stat()
	if err != nil {
		return obj, -1, nil
	}
	return obj, st.Size, nil
}

// HeadBytes reads the first `n` bytes of the object via a Range request,
// without pulling down the full payload. Used by the upload-policy MIME
// sniffer (n=512 is enough for http.DetectContentType to do its job).
func (c *Client) HeadBytes(ctx context.Context, key string, n int) ([]byte, error) {
	if n <= 0 {
		return nil, nil
	}
	opts := minio.GetObjectOptions{}
	if err := opts.SetRange(0, int64(n-1)); err != nil {
		return nil, err
	}
	obj, err := c.mc.GetObject(ctx, c.bucket, key, opts)
	if err != nil {
		return nil, err
	}
	defer obj.Close()
	buf := make([]byte, n)
	read, err := io.ReadFull(obj, buf)
	if err != nil && err != io.EOF && err != io.ErrUnexpectedEOF {
		return nil, err
	}
	return buf[:read], nil
}

func getenv(k, def string) string {
	if v := os.Getenv(k); v != "" {
		return v
	}
	return def
}
