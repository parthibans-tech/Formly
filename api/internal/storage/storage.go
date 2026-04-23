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

func (c *Client) StatObject(ctx context.Context, key string) (minio.ObjectInfo, error) {
	return c.mc.StatObject(ctx, c.bucket, key, minio.StatObjectOptions{})
}

func (c *Client) Remove(ctx context.Context, key string) error {
	return c.mc.RemoveObject(ctx, c.bucket, key, minio.RemoveObjectOptions{})
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

func getenv(k, def string) string {
	if v := os.Getenv(k); v != "" {
		return v
	}
	return def
}
