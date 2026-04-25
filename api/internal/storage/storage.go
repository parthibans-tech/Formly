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
	useSSL := os.Getenv("MINIO_SSL") == "true"

	creds := credentials.NewStaticV4(access, secret, "")

	mc, err := minio.New(endpoint, &minio.Options{Creds: creds, Secure: useSSL})
	if err != nil {
		return nil, err
	}

	publicMC := mc
	if publicEndpoint != endpoint {
		publicMC, err = minio.New(publicEndpoint, &minio.Options{Creds: creds, Secure: useSSL})
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

func (c *Client) PresignGet(ctx context.Context, key, filename string, ttl time.Duration) (string, error) {
	params := url.Values{}
	if filename != "" {
		params.Set("response-content-disposition", fmt.Sprintf(`attachment; filename="%s"`, filename))
	}
	u, err := c.publicMC.PresignedGetObject(ctx, c.bucket, key, ttl, params)
	if err != nil {
		return "", err
	}
	return u.String(), nil
}

// PresignGetInline returns a presigned GET URL with an explicit
// `Content-Disposition: inline` response override, so browsers render
// the payload in-place (e.g. an iframe'd PDF) instead of offering a
// download. Used by the preview/playground paths — the regular
// PresignGet falls back to whatever the stored object declares, which
// Safari in particular interprets as "attachment" for PDFs and triggers
// a save prompt even when the caller intended an inline render.
func (c *Client) PresignGetInline(ctx context.Context, key string, ttl time.Duration) (string, error) {
	params := url.Values{}
	params.Set("response-content-disposition", "inline")
	u, err := c.publicMC.PresignedGetObject(ctx, c.bucket, key, ttl, params)
	if err != nil {
		return "", err
	}
	return u.String(), nil
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
