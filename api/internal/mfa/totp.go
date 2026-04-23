// Package mfa implements TOTP (RFC 6238) for second-factor auth.
//
// The package is self-contained (HMAC-SHA1 + RFC 4648 base32) with no extra
// dependencies — TOTP is small enough that pulling in a library isn't worth
// the surface area.
package mfa

import (
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha1"
	"encoding/base32"
	"encoding/binary"
	"fmt"
	"net/url"
	"strings"
	"time"
)

// SecretBytes is the RFC-recommended 20-byte secret length for TOTP/SHA1.
const SecretBytes = 20

// Period is the default TOTP step size in seconds.
const Period = 30

// Digits is the standard 6-digit code length.
const Digits = 6

// NewSecret generates a fresh base32-encoded secret.
func NewSecret() (string, error) {
	b := make([]byte, SecretBytes)
	if _, err := rand.Read(b); err != nil {
		return "", err
	}
	return strings.TrimRight(base32.StdEncoding.EncodeToString(b), "="), nil
}

// OtpauthURL builds the standard `otpauth://totp/...` provisioning URI that
// the authenticator app scans.
func OtpauthURL(issuer, accountName, secret string) string {
	q := url.Values{}
	q.Set("secret", secret)
	q.Set("issuer", issuer)
	q.Set("algorithm", "SHA1")
	q.Set("digits", fmt.Sprintf("%d", Digits))
	q.Set("period", fmt.Sprintf("%d", Period))
	label := url.PathEscape(issuer + ":" + accountName)
	return "otpauth://totp/" + label + "?" + q.Encode()
}

// Verify checks whether `code` is valid for `secret` at the current time,
// allowing a ±1-step window for clock drift.
func Verify(secret, code string) bool {
	code = strings.TrimSpace(code)
	if len(code) != Digits {
		return false
	}
	now := time.Now().Unix() / Period
	for _, step := range []int64{now - 1, now, now + 1} {
		if c := compute(secret, step); c == code {
			return true
		}
	}
	return false
}

// compute runs the HOTP algorithm at a given step. Returns the formatted code,
// or empty string on decode errors.
func compute(secret string, step int64) string {
	// base32 decode — accept both padded and unpadded forms.
	s := strings.ToUpper(strings.TrimSpace(secret))
	if pad := len(s) % 8; pad != 0 {
		s += strings.Repeat("=", 8-pad)
	}
	key, err := base32.StdEncoding.DecodeString(s)
	if err != nil {
		return ""
	}
	var buf [8]byte
	binary.BigEndian.PutUint64(buf[:], uint64(step))
	mac := hmac.New(sha1.New, key)
	mac.Write(buf[:])
	h := mac.Sum(nil)
	offset := h[len(h)-1] & 0x0f
	bin := binary.BigEndian.Uint32(h[offset:offset+4]) & 0x7fffffff
	mod := uint32(1)
	for i := 0; i < Digits; i++ {
		mod *= 10
	}
	return fmt.Sprintf("%0*d", Digits, bin%mod)
}
