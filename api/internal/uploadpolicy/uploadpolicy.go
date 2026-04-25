// Package uploadpolicy resolves the layered upload-security configuration
// (product defaults → per-org overrides) and exposes the validators that
// gate every file upload.
//
// The resolver is the single source of truth for "what is this org allowed
// to upload?" Every entry point — presign, complete, download — pulls the
// effective Policy through Service.Effective and runs the matching check.
//
// Design notes:
//
//   - Two-table model (see migrations/040_upload_policy.sql). product_config
//     holds platform-wide defaults edited by super-admins; org_upload_config
//     holds per-org overrides where each NULL column means "inherit".
//
//   - In-process cache with a short TTL (60 s). Upload presigns are hot —
//     hammering the DB on every drag-and-drop is wasteful — and a minute
//     of staleness is fine for a config that admins change rarely. Cache
//     is invalidated on writes by Service.Update*.
//
//   - All validators return a typed error so handlers can surface the
//     correct HTTP status + machine-readable code without re-string-
//     matching on the message.
package uploadpolicy

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

// Policy is the resolved (product → org-overridden) configuration that
// applies to a specific org at request time. Every field is non-NULL —
// the resolver fills NULL overrides from product defaults.
type Policy struct {
	MaxUploadBytes          int64
	AllowedMimeTypes        []string // empty = allow any (subject to extension blocklist)
	BlockedExtensions       []string // always denied (lowercase, dot-prefixed)
	MimeSniffEnabled        bool
	ScanEnabled             bool
	MaxFilenameLen          int
	ForceAttachmentForRisky bool
}

// Overrides is the raw row from org_upload_config — NULLs preserved so
// the org-admin UI can distinguish "I haven't set this, inherit" from
// "I explicitly set it to this value." The super-admin product_config
// uses the same shape but with all fields populated.
type Overrides struct {
	MaxUploadBytes          *int64
	AllowedMimeTypes        []string // nil slice = inherit; empty slice = explicitly "any"
	BlockedExtensions       []string // same convention as above
	MimeSniffEnabled        *bool
	ScanEnabled             *bool
	MaxFilenameLen          *int
	ForceAttachmentForRisky *bool
}

// ProductPolicy is the singleton platform-default record. Same shape as
// Policy plus an updatedAt/updatedBy audit pair.
type ProductPolicy struct {
	Policy
	UpdatedAt time.Time
	UpdatedBy *string
}

// ---------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------

type cacheEntry struct {
	policy Policy
	expiry time.Time
}

type Service struct {
	db    *pgxpool.Pool
	mu    sync.RWMutex
	cache map[string]cacheEntry // key: orgID, "" = product
	ttl   time.Duration
}

func New(db *pgxpool.Pool) *Service {
	return &Service{
		db:    db,
		cache: map[string]cacheEntry{},
		ttl:   60 * time.Second,
	}
}

// Effective returns the merged policy for orgID. Reads product_config and
// org_upload_config (both PK lookups) in a single round trip.
func (s *Service) Effective(ctx context.Context, orgID string) (Policy, error) {
	if cached, ok := s.get(orgID); ok {
		return cached, nil
	}
	prod, err := s.loadProduct(ctx)
	if err != nil {
		return Policy{}, err
	}
	if orgID == "" {
		s.put(orgID, prod.Policy)
		return prod.Policy, nil
	}
	ov, err := s.loadOrgOverrides(ctx, orgID)
	if err != nil {
		return Policy{}, err
	}
	merged := mergeProductOrg(prod.Policy, ov)
	s.put(orgID, merged)
	return merged, nil
}

// Product returns the platform defaults verbatim (for the super-admin UI).
func (s *Service) Product(ctx context.Context) (ProductPolicy, error) {
	return s.loadProduct(ctx)
}

// OrgOverrides returns the raw row (NULLs preserved) for the given org,
// for the org-admin UI. Returns a zero Overrides if the row doesn't
// exist yet (org has never overridden anything).
func (s *Service) OrgOverrides(ctx context.Context, orgID string) (Overrides, error) {
	return s.loadOrgOverrides(ctx, orgID)
}

// UpdateProduct upserts the singleton product_config row.
func (s *Service) UpdateProduct(ctx context.Context, userID string, p Policy) error {
	if err := validateInputs(p); err != nil {
		return err
	}
	_, err := s.db.Exec(ctx,
		`UPDATE product_config SET
		   max_upload_bytes=$1,
		   allowed_mime_types=$2,
		   blocked_extensions=$3,
		   mime_sniff_enabled=$4,
		   scan_enabled=$5,
		   max_filename_len=$6,
		   force_attachment_for_risky=$7,
		   updated_at=now(),
		   updated_by=$8
		 WHERE id='default'`,
		p.MaxUploadBytes,
		p.AllowedMimeTypes,
		p.BlockedExtensions,
		p.MimeSniffEnabled,
		p.ScanEnabled,
		p.MaxFilenameLen,
		p.ForceAttachmentForRisky,
		userID,
	)
	if err != nil {
		return err
	}
	s.invalidate("")
	// Org policies derive from product, so any cached org policy is now
	// stale too. Cheapest correctness move: blow the whole cache.
	s.invalidateAll()
	return nil
}

// UpdateOrg upserts an org's overrides. Pass &Overrides with explicit nils
// for fields that should inherit from product.
func (s *Service) UpdateOrg(ctx context.Context, userID, orgID string, ov Overrides) error {
	if err := validateOverrides(ov); err != nil {
		return err
	}
	_, err := s.db.Exec(ctx,
		`INSERT INTO org_upload_config
		   (org_id, max_upload_bytes, allowed_mime_types, blocked_extensions,
		    mime_sniff_enabled, scan_enabled, max_filename_len,
		    force_attachment_for_risky, updated_at, updated_by)
		 VALUES ($1,$2,$3,$4,$5,$6,$7,$8, now(), $9)
		 ON CONFLICT (org_id) DO UPDATE SET
		   max_upload_bytes=EXCLUDED.max_upload_bytes,
		   allowed_mime_types=EXCLUDED.allowed_mime_types,
		   blocked_extensions=EXCLUDED.blocked_extensions,
		   mime_sniff_enabled=EXCLUDED.mime_sniff_enabled,
		   scan_enabled=EXCLUDED.scan_enabled,
		   max_filename_len=EXCLUDED.max_filename_len,
		   force_attachment_for_risky=EXCLUDED.force_attachment_for_risky,
		   updated_at=now(),
		   updated_by=EXCLUDED.updated_by`,
		orgID,
		ov.MaxUploadBytes,
		ov.AllowedMimeTypes,
		ov.BlockedExtensions,
		ov.MimeSniffEnabled,
		ov.ScanEnabled,
		ov.MaxFilenameLen,
		ov.ForceAttachmentForRisky,
		userID,
	)
	if err != nil {
		return err
	}
	s.invalidate(orgID)
	return nil
}

// ResetOrg removes an org's overrides — equivalent to deleting the row,
// which makes every field inherit from product_config.
func (s *Service) ResetOrg(ctx context.Context, orgID string) error {
	_, err := s.db.Exec(ctx, `DELETE FROM org_upload_config WHERE org_id=$1`, orgID)
	if err != nil {
		return err
	}
	s.invalidate(orgID)
	return nil
}

// ---------------------------------------------------------------------
// Validators (called by handlers; they translate Policy → user errors).
// ---------------------------------------------------------------------

// Error is the typed result of a policy check. HTTP status + machine
// code so handlers don't string-match.
type Error struct {
	Status  int
	Code    string
	Message string
}

func (e *Error) Error() string { return e.Message }

// IsError extracts a *Error from any error chain.
func IsError(err error) (*Error, bool) {
	var e *Error
	if errors.As(err, &e) {
		return e, true
	}
	return nil, false
}

// CheckPresign validates the user's intent before we hand them a presigned
// URL. Catches:
//
//   - filename too long / empty
//   - extension on the blocklist
//   - claimed MIME outside the allowlist
//   - declaredSize over the cap (prevents wasting a presigned PUT on
//     something we'll reject anyway)
//
// The caller passes the already-sanitised filename; SanitizeFilename runs
// first.
func CheckPresign(p Policy, name, mime string, declaredSize int64) error {
	name = strings.TrimSpace(name)
	if name == "" {
		return &Error{Status: 400, Code: "missing_name", Message: "filename is required"}
	}
	if len(name) > p.MaxFilenameLen {
		return &Error{
			Status:  400,
			Code:    "name_too_long",
			Message: fmt.Sprintf("filename exceeds %d characters", p.MaxFilenameLen),
		}
	}
	ext := strings.ToLower(filepath.Ext(name))
	for _, blocked := range p.BlockedExtensions {
		if strings.EqualFold(ext, blocked) {
			return &Error{
				Status:  415,
				Code:    "extension_blocked",
				Message: "this file extension is not allowed: " + ext,
			}
		}
	}
	if len(p.AllowedMimeTypes) > 0 && !mimeAllowed(mime, p.AllowedMimeTypes) {
		return &Error{
			Status:  415,
			Code:    "mime_not_allowed",
			Message: "this file type is not allowed by your organisation's upload policy",
		}
	}
	if declaredSize > 0 && declaredSize > p.MaxUploadBytes {
		return &Error{
			Status:  413,
			Code:    "file_too_large",
			Message: fmt.Sprintf("file exceeds the %s upload limit", humanBytes(p.MaxUploadBytes)),
		}
	}
	return nil
}

// CheckCompletedSize is the post-upload guard. The presigned POST already
// caps via content-length-range, but we re-check here as defence-in-
// depth — and to enforce the cap on legacy PUT presigns that pre-date
// this policy.
func CheckCompletedSize(p Policy, actualBytes int64) error {
	if actualBytes > p.MaxUploadBytes {
		return &Error{
			Status:  413,
			Code:    "file_too_large",
			Message: fmt.Sprintf("file exceeds the %s upload limit", humanBytes(p.MaxUploadBytes)),
		}
	}
	return nil
}

// SniffMime runs http.DetectContentType against the head bytes and reports
// whether the detected type is consistent with the declared mime. Strict
// equality isn't required: text/plain detection is too coarse, octet-stream
// is the "I don't know" sentinel. We return the detected type so callers
// can store the corrected mime if they want to trust the sniff over the
// client claim.
func SniffMime(headBytes []byte, declared string) (detected string, mismatch bool) {
	detected = http.DetectContentType(headBytes)
	if declared == "" || declared == "application/octet-stream" {
		return detected, false
	}
	// Consider only the family (left of the +). image/svg+xml and
	// image/svg should both be treated as svg.
	d1 := family(detected)
	d2 := family(declared)
	if d1 == "application/octet-stream" || d2 == "application/octet-stream" {
		return detected, false
	}
	if strings.HasPrefix(d1, "text/") && strings.HasPrefix(d2, "text/") {
		// text/plain vs text/html etc. — too noisy to flag.
		return detected, false
	}
	return detected, d1 != d2
}

// IsRiskyMime returns true when serving this MIME inline could enable a
// stored-XSS attack (HTML, SVG, XHTML). Used by the download presign to
// force Content-Disposition: attachment per policy.
func IsRiskyMime(mime string) bool {
	m := strings.ToLower(strings.TrimSpace(mime))
	switch {
	case m == "text/html", m == "application/xhtml+xml":
		return true
	case strings.HasPrefix(m, "image/svg"):
		return true
	case strings.Contains(m, "javascript"), strings.Contains(m, "ecmascript"):
		return true
	}
	return false
}

// SanitizeFilename strips path separators and control characters. Returns
// the cleaned name; never empty if input wasn't all-whitespace (falls back
// to "untitled").
func SanitizeFilename(name string) string {
	name = strings.TrimSpace(name)
	// Strip path components: only the basename ever ends up in the object
	// key. Defends against `../` injection even though S3 doesn't traverse.
	name = filepath.Base(name)
	if name == "." || name == "/" || name == "\\" {
		name = ""
	}
	// Replace control chars + path separators with underscore.
	var b strings.Builder
	for _, r := range name {
		if r < 0x20 || r == 0x7f || r == '/' || r == '\\' {
			b.WriteRune('_')
			continue
		}
		b.WriteRune(r)
	}
	out := strings.TrimSpace(b.String())
	if out == "" {
		out = "untitled"
	}
	return out
}

// ---------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------

func (s *Service) get(orgID string) (Policy, bool) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	e, ok := s.cache[orgID]
	if !ok || time.Now().After(e.expiry) {
		return Policy{}, false
	}
	return e.policy, true
}

func (s *Service) put(orgID string, p Policy) {
	s.mu.Lock()
	s.cache[orgID] = cacheEntry{policy: p, expiry: time.Now().Add(s.ttl)}
	s.mu.Unlock()
}

func (s *Service) invalidate(orgID string) {
	s.mu.Lock()
	delete(s.cache, orgID)
	s.mu.Unlock()
}

func (s *Service) invalidateAll() {
	s.mu.Lock()
	s.cache = map[string]cacheEntry{}
	s.mu.Unlock()
}

func (s *Service) loadProduct(ctx context.Context) (ProductPolicy, error) {
	var (
		pp        ProductPolicy
		updatedBy *string
	)
	err := s.db.QueryRow(ctx,
		`SELECT max_upload_bytes, allowed_mime_types, blocked_extensions,
		        mime_sniff_enabled, scan_enabled, max_filename_len,
		        force_attachment_for_risky, updated_at, updated_by
		   FROM product_config WHERE id='default'`,
	).Scan(
		&pp.MaxUploadBytes,
		&pp.AllowedMimeTypes,
		&pp.BlockedExtensions,
		&pp.MimeSniffEnabled,
		&pp.ScanEnabled,
		&pp.MaxFilenameLen,
		&pp.ForceAttachmentForRisky,
		&pp.UpdatedAt,
		&updatedBy,
	)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			// Migration didn't seed yet — fall back to safe defaults so
			// the API doesn't 500 on every upload during deploy.
			return ProductPolicy{Policy: defaultPolicy()}, nil
		}
		return ProductPolicy{}, err
	}
	pp.UpdatedBy = updatedBy
	return pp, nil
}

func (s *Service) loadOrgOverrides(ctx context.Context, orgID string) (Overrides, error) {
	var ov Overrides
	err := s.db.QueryRow(ctx,
		`SELECT max_upload_bytes, allowed_mime_types, blocked_extensions,
		        mime_sniff_enabled, scan_enabled, max_filename_len,
		        force_attachment_for_risky
		   FROM org_upload_config WHERE org_id=$1`,
		orgID,
	).Scan(
		&ov.MaxUploadBytes,
		&ov.AllowedMimeTypes,
		&ov.BlockedExtensions,
		&ov.MimeSniffEnabled,
		&ov.ScanEnabled,
		&ov.MaxFilenameLen,
		&ov.ForceAttachmentForRisky,
	)
	if err != nil && !errors.Is(err, pgx.ErrNoRows) {
		return Overrides{}, err
	}
	return ov, nil
}

func mergeProductOrg(prod Policy, ov Overrides) Policy {
	out := prod
	if ov.MaxUploadBytes != nil {
		out.MaxUploadBytes = *ov.MaxUploadBytes
	}
	if ov.AllowedMimeTypes != nil {
		out.AllowedMimeTypes = ov.AllowedMimeTypes
	}
	if ov.BlockedExtensions != nil {
		out.BlockedExtensions = ov.BlockedExtensions
	}
	if ov.MimeSniffEnabled != nil {
		out.MimeSniffEnabled = *ov.MimeSniffEnabled
	}
	if ov.ScanEnabled != nil {
		out.ScanEnabled = *ov.ScanEnabled
	}
	if ov.MaxFilenameLen != nil {
		out.MaxFilenameLen = *ov.MaxFilenameLen
	}
	if ov.ForceAttachmentForRisky != nil {
		out.ForceAttachmentForRisky = *ov.ForceAttachmentForRisky
	}
	return out
}

func defaultPolicy() Policy {
	return Policy{
		MaxUploadBytes: 100 * 1024 * 1024,
		BlockedExtensions: []string{
			".exe", ".bat", ".cmd", ".com", ".scr", ".vbs", ".ps1",
			".js", ".jse", ".jar", ".msi", ".dll", ".sh", ".app", ".dmg",
		},
		MimeSniffEnabled:        true,
		ScanEnabled:             false,
		MaxFilenameLen:          255,
		ForceAttachmentForRisky: true,
	}
}

func mimeAllowed(mime string, allowed []string) bool {
	m := strings.ToLower(strings.TrimSpace(mime))
	for _, rule := range allowed {
		r := strings.ToLower(strings.TrimSpace(rule))
		if r == "" {
			continue
		}
		if r == m {
			return true
		}
		// Wildcards: "image/*"
		if strings.HasSuffix(r, "/*") {
			prefix := strings.TrimSuffix(r, "/*") + "/"
			if strings.HasPrefix(m, prefix) {
				return true
			}
		}
	}
	return false
}

func family(mime string) string {
	mime = strings.ToLower(strings.TrimSpace(mime))
	if i := strings.Index(mime, ";"); i >= 0 {
		mime = strings.TrimSpace(mime[:i])
	}
	if i := strings.Index(mime, "+"); i >= 0 {
		// image/svg+xml → image/svg
		return mime[:i]
	}
	return mime
}

func validateInputs(p Policy) error {
	if p.MaxUploadBytes <= 0 {
		return &Error{Status: 400, Code: "invalid_max_bytes", Message: "max_upload_bytes must be positive"}
	}
	if p.MaxFilenameLen <= 0 || p.MaxFilenameLen > 4096 {
		return &Error{Status: 400, Code: "invalid_filename_len", Message: "max_filename_len must be between 1 and 4096"}
	}
	return nil
}

func validateOverrides(ov Overrides) error {
	if ov.MaxUploadBytes != nil && *ov.MaxUploadBytes <= 0 {
		return &Error{Status: 400, Code: "invalid_max_bytes", Message: "max_upload_bytes must be positive"}
	}
	if ov.MaxFilenameLen != nil && (*ov.MaxFilenameLen <= 0 || *ov.MaxFilenameLen > 4096) {
		return &Error{Status: 400, Code: "invalid_filename_len", Message: "max_filename_len must be between 1 and 4096"}
	}
	return nil
}

func humanBytes(b int64) string {
	const unit = 1024
	if b < unit {
		return fmt.Sprintf("%d B", b)
	}
	div, exp := int64(unit), 0
	for n := b / unit; n >= unit; n /= unit {
		div *= unit
		exp++
	}
	return fmt.Sprintf("%.1f %sB", float64(b)/float64(div), "KMGTPE"[exp:exp+1])
}
