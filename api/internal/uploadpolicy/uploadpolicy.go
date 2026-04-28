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
	"net/url"
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

	// PreviewCSP is the literal Content-Security-Policy header value the
	// API attaches to inline-preview responses (the InlinePreview proxy
	// streams blob bytes with this header set). Defense-in-depth against
	// stored-XSS: even if a forged text/html or weaponised SVG slips past
	// the upload sniffer, this CSP keeps it from doing anything in the
	// designer's iframe context. Default is "no JS, no network, sandbox".
	PreviewCSP string

	// PreviewIframeSandbox is the literal value the frontend should set on
	// the <iframe sandbox="..."> that hosts a preview. "" = maximum
	// isolation (no scripts, no forms, no same-origin). Orgs that need
	// to relax this for trusted content (e.g. their own marketing HTML)
	// can list tokens like "allow-scripts allow-forms allow-same-origin".
	// Surfaced in the preview-URL response shape so the frontend stays
	// in lockstep with the active policy.
	PreviewIframeSandbox string

	// PdfHardenEnabled gates the synchronous PDF structural scan
	// (internal/pdfsec) that runs at upload Complete. When true, every
	// uploaded application/pdf is inspected for active-content features
	// (JavaScript, Launch actions, embedded files, external file refs)
	// and rejected if the resolved PdfBlockedFeatures matches. Runs
	// independently of ScanEnabled — does not require a ClamAV daemon.
	PdfHardenEnabled bool

	// PdfBlockedFeatures is the list of pdfsec.Threat constants the
	// policy refuses on detection. nil/empty = scan-but-don't-block
	// (report-only, useful for audit visibility before turning on
	// enforcement). Default — when PdfHardenEnabled is true and this
	// list is empty — applies pdfsec.DefaultBlockedFeatures.
	PdfBlockedFeatures []string

	// EmbedAllowedOrigins is the per-org allowlist of HTTP origins
	// (scheme + host + optional port; one entry per origin) that may
	// embed this org's public form/share/review pages in an iframe.
	// Merged into the response's Content-Security-Policy
	// `frame-ancestors` directive — and the matching Next.js middleware
	// strips the inherited `X-Frame-Options: SAMEORIGIN` so modern
	// browsers actually honour the wider list.
	//
	// Empty (the safe default) = lock-down, only same-origin embedding
	// permitted (today's behaviour). Populated = those origins, plus
	// 'self', may iframe the embed routes. The product-level default is
	// also empty — we do NOT ship a cross-tenant default origin list
	// because that would silently let one customer iframe another
	// customer's branded form.
	//
	// Validation: each entry must parse as a valid URL with scheme +
	// host, no path. See ValidateEmbedOrigin.
	EmbedAllowedOrigins []string
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
	PreviewCSP              *string
	PreviewIframeSandbox    *string
	PdfHardenEnabled        *bool
	PdfBlockedFeatures      []string // nil = inherit; empty slice = report-only
	EmbedAllowedOrigins     []string // nil = inherit; empty slice = explicit lock-down
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
		   preview_csp=$8,
		   preview_iframe_sandbox=$9,
		   pdf_harden_enabled=$10,
		   pdf_blocked_features=$11,
		   embed_allowed_origins=$12,
		   updated_at=now(),
		   updated_by=$13
		 WHERE id='default'`,
		p.MaxUploadBytes,
		p.AllowedMimeTypes,
		p.BlockedExtensions,
		p.MimeSniffEnabled,
		p.ScanEnabled,
		p.MaxFilenameLen,
		p.ForceAttachmentForRisky,
		p.PreviewCSP,
		p.PreviewIframeSandbox,
		p.PdfHardenEnabled,
		p.PdfBlockedFeatures,
		p.EmbedAllowedOrigins,
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
		    force_attachment_for_risky, preview_csp, preview_iframe_sandbox,
		    pdf_harden_enabled, pdf_blocked_features, embed_allowed_origins,
		    updated_at, updated_by)
		 VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13, now(), $14)
		 ON CONFLICT (org_id) DO UPDATE SET
		   max_upload_bytes=EXCLUDED.max_upload_bytes,
		   allowed_mime_types=EXCLUDED.allowed_mime_types,
		   blocked_extensions=EXCLUDED.blocked_extensions,
		   mime_sniff_enabled=EXCLUDED.mime_sniff_enabled,
		   scan_enabled=EXCLUDED.scan_enabled,
		   max_filename_len=EXCLUDED.max_filename_len,
		   force_attachment_for_risky=EXCLUDED.force_attachment_for_risky,
		   preview_csp=EXCLUDED.preview_csp,
		   preview_iframe_sandbox=EXCLUDED.preview_iframe_sandbox,
		   pdf_harden_enabled=EXCLUDED.pdf_harden_enabled,
		   pdf_blocked_features=EXCLUDED.pdf_blocked_features,
		   embed_allowed_origins=EXCLUDED.embed_allowed_origins,
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
		ov.PreviewCSP,
		ov.PreviewIframeSandbox,
		ov.PdfHardenEnabled,
		ov.PdfBlockedFeatures,
		ov.EmbedAllowedOrigins,
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
	// ZIP-based container formats (docx, xlsx, pptx, odt, ods, odp, epub,
	// jar, apk, …) all legitimately sniff as application/zip because they
	// ARE zip archives. Don't flag the mismatch — the declared MIME wins
	// via CanonicalMime once we get past this gate. Match against the raw
	// declaration (pre-family) so suffixes like +zip / +xml are kept.
	if d1 == "application/zip" && isZipBasedFormat(strings.ToLower(strings.TrimSpace(declared))) {
		return detected, false
	}
	return detected, d1 != d2
}

// isZipBasedFormat reports whether the declared MIME is a known
// container format whose underlying bytes are a ZIP archive. Used by
// SniffMime to suppress false-positive mismatches (DOCX, XLSX, etc.).
func isZipBasedFormat(declared string) bool {
	switch declared {
	case
		"application/vnd.openxmlformats-officedocument.wordprocessingml.document", // .docx
		"application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",       // .xlsx
		"application/vnd.openxmlformats-officedocument.presentationml.presentation", // .pptx
		"application/vnd.oasis.opendocument.text",         // .odt
		"application/vnd.oasis.opendocument.spreadsheet",  // .ods
		"application/vnd.oasis.opendocument.presentation", // .odp
		"application/epub+zip",                            // .epub
		"application/java-archive",                        // .jar
		"application/vnd.android.package-archive":         // .apk
		return true
	}
	return false
}

// CanonicalMime decides which MIME to PERSIST after a successful upload.
// The client's declaration is often more specific than what
// http.DetectContentType can tell us — DOCX detects as application/zip
// because DOCX is a ZIP, but downstream code keys on the precise office
// MIME — so we keep the declaration whenever it's plausibly consistent
// with the detected family. When they conflict at the family level
// (e.g. declared image/png, detected text/plain) we trust the bytes
// over the claim, because the alternative is letting a forged MIME ride
// into files.mime and skew every downstream branch (Detector, download
// disposition, IsRiskyMime).
//
// This runs alongside SniffMime: if the policy toggle is on, mismatched
// uploads are rejected before this is consulted, so the "trust bytes"
// branch only fires when an org admin opted out of strict mode.
func CanonicalMime(declared, detected string) string {
	d := strings.ToLower(strings.TrimSpace(declared))
	// Strip parameters from detected — http.DetectContentType returns
	// values like "text/html; charset=utf-8", and we don't want the
	// charset noise leaking into files.mime where downstream code does
	// exact-string equality.
	x := strings.ToLower(strings.TrimSpace(detected))
	if i := strings.Index(x, ";"); i >= 0 {
		x = strings.TrimSpace(x[:i])
	}

	// Detection is the "I don't know" sentinel — fall back to whatever
	// the client said (or octet-stream if they said nothing either).
	if x == "" || x == "application/octet-stream" {
		if d == "" {
			return "application/octet-stream"
		}
		return d
	}
	// Declaration is empty / generic — bytes win.
	if d == "" || d == "application/octet-stream" {
		return x
	}
	// Same family (modulo +xml suffix and content-type parameters):
	// keep the more specific declaration.
	if family(d) == family(x) {
		return d
	}
	// text/* vs text/* is noisy (text/plain detection often shadows
	// text/html, text/csv, etc.); keep the declaration. SniffMime
	// applies the same exemption.
	if strings.HasPrefix(family(d), "text/") && strings.HasPrefix(family(x), "text/") {
		return d
	}
	// Family mismatch and we got here — declared lied. Trust bytes.
	return x
}

// IsRiskyMime returns true when serving this MIME inline could enable a
// stored-XSS attack (HTML, SVG, XHTML). Used by the download presign to
// force Content-Disposition: attachment per policy.
func IsRiskyMime(mime string) bool {
	// Strip parameters and +xml suffix so "text/html; charset=utf-8"
	// and "application/xhtml+xml" both reduce to their family form.
	// http.DetectContentType emits parameters by default (charset),
	// and storing them shouldn't bypass the XSS check.
	m := family(mime)
	switch {
	case m == "text/html", m == "application/xhtml":
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
// to "untitled"). Caps total length at AbsMaxFilenameLen (255) — that's
// the POSIX/NTFS ceiling and beyond it nothing downstream copes well
// (Content-Disposition headers, presigned-URL paths, FS round-trips).
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
	// Hard ceiling regardless of org policy. The policy's MaxFilenameLen
	// gates the *upload request* with a 4xx; this is the last-line
	// defense for code paths that don't run policy (legacy clients,
	// internal-derived names, mis-wired handlers). We preserve the
	// extension so downstream MIME hints stay intact.
	return capFilenameLen(out, AbsMaxFilenameLen)
}

// AbsMaxFilenameLen is the absolute upper bound on stored filenames,
// independent of org policy. POSIX NAME_MAX is 255 bytes; we keep parity
// so a downloaded file always round-trips through the local filesystem.
const AbsMaxFilenameLen = 255

// capFilenameLen truncates `name` to at most n bytes while preserving
// the extension (so "long-resume.pdf" stays a .pdf). If the extension
// itself is pathological (>16 bytes — almost certainly a fake), we
// fall back to a plain right-trim.
func capFilenameLen(name string, n int) string {
	if n <= 0 || len(name) <= n {
		return name
	}
	ext := filepath.Ext(name)
	if len(ext) == 0 || len(ext) > 16 {
		return name[:n]
	}
	stem := name[:len(name)-len(ext)]
	keep := n - len(ext)
	if keep <= 0 {
		return name[:n]
	}
	return stem[:keep] + ext
}

// SafeStorageSlug returns an opaque, ASCII-only, URL-safe form of `name`
// suitable for embedding in an object-storage key. Use this — never the
// raw user-supplied filename — when constructing keys like
// `orgs/<id>/files/<id>/<slug>`.
//
// Why a separate function (vs. just using SanitizeFilename for both):
//
//   - Object-storage keys end up in presigned URLs that pass through
//     ASCII-aware tooling (CDNs, log scrapers, webhook payloads, replay
//     attackers reusing the path). Keeping keys pure ASCII avoids
//     surprises with mojibake, RTL-override exploits, NULs, quotes,
//     and combining marks.
//   - Storage keys are never shown to the user — files.name is the
//     display field — so we can be aggressive without UX cost.
//   - Caps at SafeStorageSlugMaxLen so a 4 KB filename can't blow past
//     S3's 1024-byte key ceiling once concatenated with org/file UUIDs.
//
// Output charset: [a-z0-9._-]. Runs of disallowed characters collapse
// to a single dash. Always returns a non-empty value (falls back to
// "file" if input sanitises to nothing).
func SafeStorageSlug(name string) string {
	name = filepath.Base(strings.TrimSpace(name))
	if name == "." || name == "/" || name == "\\" || name == "" {
		return "file"
	}
	// Split off the extension so we slug stem + ext separately and
	// don't collapse the dot.
	ext := filepath.Ext(name)
	stem := name[:len(name)-len(ext)]

	stem = slugifyASCII(stem)
	ext = slugifyASCII(ext) // strips weird chars from `.foo bar` etc.

	if stem == "" {
		stem = "file"
	}
	out := stem + ext
	out = capFilenameLen(out, SafeStorageSlugMaxLen)
	// Final paranoia: if cap or slugify left an empty string somehow,
	// don't return "" (would produce keys ending in a slash).
	if out == "" || out == "." || out == "-" {
		return "file"
	}
	return out
}

// SafeStorageSlugMaxLen bounds the slug at 80 bytes — comfortably under
// S3's 1024-byte key max even after concatenation with the
// `orgs/<uuid>/files/<uuid>/` prefix (~85 bytes for two UUIDs +
// boilerplate).
const SafeStorageSlugMaxLen = 80

// slugifyASCII lowercases and reduces input to [a-z0-9._-], collapsing
// runs of disallowed chars into a single '-'. Trims leading/trailing
// dashes so we don't produce keys like `orgs/.../files/.../-thing`.
func slugifyASCII(s string) string {
	s = strings.ToLower(s)
	var b strings.Builder
	b.Grow(len(s))
	prevDash := false
	for _, r := range s {
		switch {
		case r >= 'a' && r <= 'z',
			r >= '0' && r <= '9',
			r == '.' || r == '_' || r == '-':
			b.WriteRune(r)
			prevDash = false
		default:
			if !prevDash {
				b.WriteByte('-')
				prevDash = true
			}
		}
	}
	return strings.Trim(b.String(), "-")
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
		        force_attachment_for_risky, preview_csp,
		        preview_iframe_sandbox, pdf_harden_enabled,
		        pdf_blocked_features, embed_allowed_origins,
		        updated_at, updated_by
		   FROM product_config WHERE id='default'`,
	).Scan(
		&pp.MaxUploadBytes,
		&pp.AllowedMimeTypes,
		&pp.BlockedExtensions,
		&pp.MimeSniffEnabled,
		&pp.ScanEnabled,
		&pp.MaxFilenameLen,
		&pp.ForceAttachmentForRisky,
		&pp.PreviewCSP,
		&pp.PreviewIframeSandbox,
		&pp.PdfHardenEnabled,
		&pp.PdfBlockedFeatures,
		&pp.EmbedAllowedOrigins,
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
		        force_attachment_for_risky, preview_csp, preview_iframe_sandbox,
		        pdf_harden_enabled, pdf_blocked_features, embed_allowed_origins
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
		&ov.PreviewCSP,
		&ov.PreviewIframeSandbox,
		&ov.PdfHardenEnabled,
		&ov.PdfBlockedFeatures,
		&ov.EmbedAllowedOrigins,
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
	if ov.PreviewCSP != nil {
		out.PreviewCSP = *ov.PreviewCSP
	}
	if ov.PreviewIframeSandbox != nil {
		out.PreviewIframeSandbox = *ov.PreviewIframeSandbox
	}
	if ov.PdfHardenEnabled != nil {
		out.PdfHardenEnabled = *ov.PdfHardenEnabled
	}
	if ov.PdfBlockedFeatures != nil {
		// Override semantics: any non-nil slice replaces wholesale,
		// even an explicit empty list (= "report-only" mode). nil
		// means inherit, matching the AllowedMimeTypes convention.
		out.PdfBlockedFeatures = ov.PdfBlockedFeatures
	}
	if ov.EmbedAllowedOrigins != nil {
		// Same tri-state as PdfBlockedFeatures: nil = inherit,
		// []string{} = explicit empty (lock-down — overrides a wider
		// product-level default), populated = replace wholesale. The
		// product default itself is empty, so this knob is almost
		// always set per-org.
		out.EmbedAllowedOrigins = ov.EmbedAllowedOrigins
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
		PreviewCSP:              DefaultPreviewCSP,
		PreviewIframeSandbox:    DefaultPreviewIframeSandbox,
		PdfHardenEnabled:        true,
		PdfBlockedFeatures:      DefaultPdfBlockedFeatures(),
		// EmbedAllowedOrigins intentionally empty by default —
		// shipping any cross-tenant default origin would silently let
		// one customer iframe another customer's branded form. Org
		// admins opt in explicitly per-origin.
		EmbedAllowedOrigins: nil,
	}
}

// DefaultPdfBlockedFeatures returns a fresh slice mirroring
// pdfsec.DefaultBlockedFeatures. Returned by value (not the package
// constant) so a caller mutating the slice can't poison every future
// defaultPolicy() call. Kept here, not in pdfsec, to avoid a hard
// import cycle between uploadpolicy and pdfsec — the policy layer
// shouldn't depend on the scanner implementation.
func DefaultPdfBlockedFeatures() []string {
	return []string{"javascript", "launch", "embedded_file", "external_xobject"}
}

// DefaultPreviewCSP is the maximally restrictive Content-Security-Policy
// the API attaches to inline previews when no org/product override is
// active. It mirrors the SQL default in migrations/042_preview_csp.sql so
// in-process fallbacks (when the migration hasn't seeded yet) match what
// the DB would have served. Knobs:
//
//   - default-src 'none'        — deny everything by default.
//   - img-src 'self' data: blob:— allow images from same-origin and
//                                  inline-encoded only.
//   - style-src 'unsafe-inline' — allow inline CSS so HTML mocks render.
//                                  Inline JS is still blocked (no
//                                  script-src directive).
//   - font-src 'self' data:     — allow web fonts where useful.
//   - sandbox                   — apply the sandbox flag at the response
//                                  level even if the iframe forgets to.
const DefaultPreviewCSP = "default-src 'none'; img-src 'self' data: blob:; style-src 'unsafe-inline'; font-src 'self' data:; sandbox"

// DefaultPreviewIframeSandbox is the literal `<iframe sandbox="...">`
// value the frontend should apply when no override is active. Empty
// string = the most restrictive sandbox (no scripts, no forms, no
// same-origin, no top-level navigation). Orgs that need to relax this
// for trusted internal content list tokens explicitly.
const DefaultPreviewIframeSandbox = ""

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
	for _, o := range p.EmbedAllowedOrigins {
		if err := ValidateEmbedOrigin(o); err != nil {
			return err
		}
	}
	return nil
}

func validateOverrides(ov Overrides) error {
	if ov.MaxUploadBytes != nil && *ov.MaxUploadBytes <= 0 {
		return &Error{Status: 400, Code: "invalid_max_bytes", Message: "max_upload_bytes must be positive"}
	}
	for _, o := range ov.EmbedAllowedOrigins {
		if err := ValidateEmbedOrigin(o); err != nil {
			return err
		}
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

// ---------------------------------------------------------------------
// Embed-origin allowlist helpers
// ---------------------------------------------------------------------

// ValidateEmbedOrigin enforces that a stored entry of EmbedAllowedOrigins
// is a literal HTTP origin: scheme + host (+ optional port), no path,
// no query, no fragment, no userinfo. The frame-ancestors CSP directive
// is parsed strictly by browsers — a bogus entry like "customer.com"
// (no scheme) or "https://customer.com/embed" (path) silently invalidates
// the WHOLE directive in some engines, dropping back to default-src and
// blocking the legitimate origins we did get right. The validator runs
// at write time so a typo is rejected by the admin API rather than
// landing in production and degrading every embed.
//
// Wildcards are NOT permitted: "*" or "https://*.customer.com" would let
// any subdomain phish the customer's brand by registering a sibling.
// Customers wanting subdomain coverage must list each subdomain
// explicitly.
func ValidateEmbedOrigin(raw string) error {
	o := strings.TrimSpace(raw)
	if o == "" {
		return &Error{
			Status: 400, Code: "invalid_embed_origin",
			Message: "embed origin must not be empty",
		}
	}
	u, err := url.Parse(o)
	if err != nil {
		return &Error{
			Status: 400, Code: "invalid_embed_origin",
			Message: fmt.Sprintf("embed origin %q is not a valid URL: %v", raw, err),
		}
	}
	if u.Scheme != "http" && u.Scheme != "https" {
		return &Error{
			Status: 400, Code: "invalid_embed_origin",
			Message: fmt.Sprintf("embed origin %q must use http:// or https://", raw),
		}
	}
	if u.Host == "" {
		return &Error{
			Status: 400, Code: "invalid_embed_origin",
			Message: fmt.Sprintf("embed origin %q is missing a host", raw),
		}
	}
	if u.Path != "" && u.Path != "/" {
		return &Error{
			Status: 400, Code: "invalid_embed_origin",
			Message: fmt.Sprintf("embed origin %q must not include a path", raw),
		}
	}
	if u.RawQuery != "" || u.Fragment != "" || u.User != nil {
		return &Error{
			Status: 400, Code: "invalid_embed_origin",
			Message: fmt.Sprintf("embed origin %q must not include query, fragment, or userinfo", raw),
		}
	}
	if strings.Contains(u.Host, "*") {
		return &Error{
			Status: 400, Code: "invalid_embed_origin",
			Message: fmt.Sprintf("embed origin %q must not contain wildcards; list each subdomain explicitly", raw),
		}
	}
	return nil
}

// NormalizeEmbedOrigin returns the canonical "scheme://host[:port]" form
// of a previously-validated origin, lower-cased so duplicate entries
// (Https://Customer.com vs https://customer.com) collapse on save.
func NormalizeEmbedOrigin(raw string) string {
	u, err := url.Parse(strings.TrimSpace(raw))
	if err != nil || u.Host == "" {
		return strings.TrimSpace(raw)
	}
	return strings.ToLower(u.Scheme) + "://" + strings.ToLower(u.Host)
}

// BuildFrameAncestors returns the literal value for the CSP
// `frame-ancestors` directive given an org's allowed-origins list. The
// returned string includes the directive name so callers can splice it
// into a wider CSP without re-implementing the formatting:
//
//	"frame-ancestors 'self'"                            // empty list
//	"frame-ancestors 'self' https://customer.example"   // one entry
//
// 'self' is always included so the SPA's own pages can still iframe
// each other (the designer previewing a form, etc.). Empty / nil list
// produces "frame-ancestors 'self'", matching the pre-feature
// `X-Frame-Options: SAMEORIGIN` posture.
func BuildFrameAncestors(origins []string) string {
	parts := []string{"'self'"}
	seen := map[string]bool{"'self'": true}
	for _, o := range origins {
		n := NormalizeEmbedOrigin(o)
		if n == "" || seen[n] {
			continue
		}
		seen[n] = true
		parts = append(parts, n)
	}
	return "frame-ancestors " + strings.Join(parts, " ")
}
