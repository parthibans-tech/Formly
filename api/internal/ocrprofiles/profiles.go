// Package ocrprofiles is the "document type" layer in front of the
// raw tesseract pipeline. End users pick a profile ("Aadhaar", "PAN",
// "Receipt", or one their org admin authored) in the UI and we
// translate that into:
//
//  1. Tesseract knobs tuned for that document family (PSM, language,
//     preprocess on/off).
//  2. A small set of regex extractors that pull structured fields out
//     of the raw OCR text — IDs, dates, amounts.
//  3. An optional LLM cleanup prompt that re-reads the OCR text with
//     the model and returns a structured JSON payload, fixing common
//     mistranscriptions (O↔0, I↔1, B↔8) that regex alone can't.
//
// # Why two scopes (built-in + org)
//
// Profiles can be platform-shipped (`org_id IS NULL`, is_builtin=true)
// or org-authored (`org_id = <org>`, is_builtin=false). Built-ins are
// editable only by super admins; org admins can CRUD profiles inside
// their own org. The list endpoint UNION-merges the two sets so a
// user always sees built-ins followed by their org's customisations.
//
// # Why per-profile PSM matters
//
// Tesseract's default PSM 3 ("auto, no OSD") hedges across page
// types and consistently misreads ID-card-shaped uniform text — PAN
// and Aadhaar both improve dramatically under PSM 6 ("single uniform
// block"). The profile knob lets us pick the right setting per
// document type without making the operator-level OCR_PSM env
// override do double-duty.
//
// # DB vs hardcoded fallback
//
// The production registry reads from the `ocr_profiles` table.
// Migration 047 seeds the six built-in profiles, so on a freshly-
// migrated database the DB query always returns at least those six.
// As a defensive belt-and-braces, when the DB query yields zero rows
// (migration not yet run, table empty for any reason) the registry
// falls through to a hardcoded static set so the feature never goes
// completely dark.
package ocrprofiles

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"regexp"
	"strings"

	"github.com/docforge/api/internal/ai"
	"github.com/jackc/pgx/v5/pgxpool"
)

// Profile is the runtime shape of a "document type" preset. Public
// fields are JSON-serialisable for the read endpoints; the compiled
// regex map is private (lazy-built from the raw extractor strings on
// first Extract call) so callers can't accidentally clobber it.
type Profile struct {
	// ID is the database row UUID. Empty for static fallback profiles.
	ID string `json:"id,omitempty"`
	// OrgID — empty for built-ins, populated for org-authored ones.
	// We don't ship this in client responses (it's redundant with
	// IsBuiltin) but keep it on the struct for server-side filtering.
	OrgID string `json:"-"`
	// Slug is the URL / cache / localStorage key. Stable across deploys.
	Slug string `json:"slug"`
	// Name is the picker label.
	Name string `json:"name"`
	// Description is a one-line "use this for…" hint shown under the
	// label in the picker.
	Description string `json:"description"`
	// Icon is a lucide icon name. The frontend maps strings like
	// "id-card" → <IdCard /> and falls back to a generic document
	// icon for unknown values.
	Icon string `json:"icon"`
	// Lang is the tesseract -l value to use. Empty → inherit from
	// the operator's OCR_LANG default.
	Lang string `json:"lang,omitempty"`
	// PSM is the tesseract --psm to use. -1 → inherit default.
	PSM int `json:"psm"`
	// Preprocess overrides the imagemagick preprocessing toggle.
	// nil → inherit. Pointer-to-bool (rather than tri-state int) so
	// the JSON shape reads cleanly: omitted = inherit, true/false =
	// explicit override.
	Preprocess *bool `json:"preprocess,omitempty"`
	// Fields is the ordered display list for the result table.
	Fields []string `json:"fields,omitempty"`
	// Builtin marks platform-shipped profiles.
	Builtin bool `json:"builtin"`
	// Extractors maps a field key (matches an entry in Fields) to a
	// regex string. The first capture group is the value. Public on
	// the struct so the admin UI can edit them; runtime callers use
	// Extract() which compiles per-call.
	Extractors map[string]string `json:"extractors,omitempty"`
	// LLMPromptText is the system prompt sent to the chat model when
	// LLM cleanup is enabled. Empty disables cleanup. Public for the
	// admin UI; runtime callers use HasLLMPrompt() / LLMPrompt().
	LLMPromptText string `json:"llmPrompt,omitempty"`
}

// HasLLMPrompt reports whether the profile has a cleanup prompt
// configured.
func (p Profile) HasLLMPrompt() bool { return p.LLMPromptText != "" }

// LLMPrompt exposes the system prompt for the docchat orchestration
// layer. Method-only to mirror the original immutable API; the
// underlying field is public for serialization.
func (p Profile) LLMPrompt() string { return p.LLMPromptText }

// Extract runs every regex against the raw OCR text and returns a
// map of field→matched value. Fields without a match (or with a
// blank capture) are omitted — the UI renders "—" for missing
// values rather than an empty string, so leaving them out keeps the
// render path simple.
//
// Compilation happens per call. We deliberately don't cache compiled
// regexes on the Profile struct because Profile is copied by value
// across the docchat → ocrprofiles boundary, and a cached map of
// *regexp.Regexp would require reference semantics that ripple
// through the whole package. The cost is microseconds per request
// against a tesseract latency measured in seconds — not worth the
// complexity. A single bad regex stored by an admin is logged and
// the field is skipped, so one corrupt extractor doesn't disable
// the rest.
func (p Profile) Extract(text string) map[string]string {
	if len(p.Extractors) == 0 {
		return nil
	}
	out := make(map[string]string, len(p.Extractors))
	for key, src := range p.Extractors {
		re, err := regexp.Compile(src)
		if err != nil {
			// Skip silently; admin-saved bad regex shouldn't fail
			// the whole /extract-text call. Logging is the caller's
			// responsibility (we have no logger here).
			continue
		}
		m := re.FindStringSubmatch(text)
		if len(m) < 2 {
			continue
		}
		val := strings.TrimSpace(m[1])
		if val == "" {
			continue
		}
		out[key] = val
	}
	return out
}

// Registry is the read-only interface the docchat handler uses to
// look up a profile. Keeping this an interface lets callers stay
// agnostic to whether the profile came from the DB, the static
// fallback, or a test stub.
type Registry interface {
	// Get returns the profile matching the slug, scoped to the
	// caller's org (org-authored profiles are private to that org;
	// built-ins are visible to everyone). Empty/unknown slugs
	// resolve to the "generic" profile so callers can pass through
	// untrusted input without an extra "is this slug valid?" branch.
	Get(ctx context.Context, orgID, slug string) (Profile, bool)
	// List returns built-ins followed by the caller's org-authored
	// profiles, in display order.
	List(ctx context.Context, orgID string) []Profile
}

/* ------------------------- DB-backed registry ------------------------- */

// DBRegistry is the production Registry implementation. Reads from
// the `ocr_profiles` table on every call (no caching) — the table is
// small (low double-digit row count even for the largest org) and
// `/extract-text` is dominated by tesseract latency (seconds), so a
// sub-millisecond DB round-trip per request isn't worth caching.
//
// When the DB query returns zero rows (migration not yet run, table
// truncated, etc.) we fall through to the static registry so the
// feature never goes completely dark on a misconfigured deployment.
type DBRegistry struct {
	DB *pgxpool.Pool
}

// NewDBRegistry constructs the production registry. Pass the same
// pool the rest of main.go uses.
func NewDBRegistry(db *pgxpool.Pool) *DBRegistry { return &DBRegistry{DB: db} }

// Get looks up a profile by slug. Built-ins (`org_id IS NULL`) and
// the caller's org-authored rows are both candidates. We prefer the
// org row over the built-in if both exist with the same slug — that's
// the "an org overrode the built-in for our workflow" case.
func (r *DBRegistry) Get(ctx context.Context, orgID, slug string) (Profile, bool) {
	if r == nil || r.DB == nil {
		return staticRegistry.Get(ctx, orgID, slug)
	}
	slug = strings.ToLower(strings.TrimSpace(slug))
	if slug == "" {
		slug = "generic"
	}
	// Order: prefer org-owned row over the built-in with the same slug.
	// `org_id = $1` rows sort first because of the `ORDER BY ... DESC`
	// trick (NULL sorts last in DESC). Limit 1 because we only need
	// the winner.
	row := r.DB.QueryRow(ctx, `
		SELECT id, COALESCE(org_id::text, ''), slug, name, description, icon,
		       lang, psm, preprocess, fields, extractors, llm_prompt, is_builtin
		  FROM ocr_profiles
		 WHERE slug = $2
		   AND (org_id IS NULL OR org_id = $1::uuid)
		 ORDER BY (org_id IS NULL) ASC
		 LIMIT 1
	`, nullableUUID(orgID), slug)
	p, err := scanProfile(row)
	if err == nil {
		return p, true
	}
	// Fallback: if the row truly doesn't exist (no DB seed, no
	// matching org row), use the static registry.
	return staticRegistry.Get(ctx, orgID, slug)
}

// List returns every visible profile (built-ins + this org's). The
// frontend sorts these into picker order (built-ins first, then org
// profiles by name); we send them in a stable order from SQL so the
// list endpoint's response is deterministic.
func (r *DBRegistry) List(ctx context.Context, orgID string) []Profile {
	if r == nil || r.DB == nil {
		return staticRegistry.List(ctx, orgID)
	}
	rows, err := r.DB.Query(ctx, `
		SELECT id, COALESCE(org_id::text, ''), slug, name, description, icon,
		       lang, psm, preprocess, fields, extractors, llm_prompt, is_builtin
		  FROM ocr_profiles
		 WHERE org_id IS NULL OR org_id = $1::uuid
		 ORDER BY is_builtin DESC, name ASC
	`, nullableUUID(orgID))
	if err != nil {
		return staticRegistry.List(ctx, orgID)
	}
	defer rows.Close()
	var out []Profile
	for rows.Next() {
		p, err := scanProfile(rows)
		if err != nil {
			continue
		}
		out = append(out, p)
	}
	if len(out) == 0 {
		return staticRegistry.List(ctx, orgID)
	}
	return out
}

// row covers both *pgx.Row and *pgx.Rows for the shared scanner.
type rowScanner interface {
	Scan(dest ...any) error
}

// scanProfile reads one row of the standard SELECT projection into a
// Profile. Centralised so the column order matches everywhere.
func scanProfile(r rowScanner) (Profile, error) {
	var (
		p              Profile
		preprocess     *bool
		fieldsJSON     []byte
		extractorsJSON []byte
	)
	if err := r.Scan(
		&p.ID, &p.OrgID, &p.Slug, &p.Name, &p.Description, &p.Icon,
		&p.Lang, &p.PSM, &preprocess, &fieldsJSON, &extractorsJSON,
		&p.LLMPromptText, &p.Builtin,
	); err != nil {
		return Profile{}, err
	}
	p.Preprocess = preprocess
	if len(fieldsJSON) > 0 {
		_ = json.Unmarshal(fieldsJSON, &p.Fields)
	}
	if len(extractorsJSON) > 0 {
		_ = json.Unmarshal(extractorsJSON, &p.Extractors)
	}
	return p, nil
}

// nullableUUID converts an empty-string org id into a SQL NULL so the
// query's `org_id = $1::uuid` predicate doesn't blow up on a public
// caller. Postgres + pgx need an explicit `nil` for that.
func nullableUUID(id string) any {
	if strings.TrimSpace(id) == "" {
		return nil
	}
	return id
}

/* ------------------------- Static fallback --------------------------- */

// staticRegistry is the hardcoded fallback used when the DB returns
// nothing. Mirrors the migration's seed list 1:1 — keeping the two in
// sync is the price of having a fallback at all. The mismatch surface
// is small (six profiles, edited maybe once a quarter) and the
// migration is the source of truth in production; this exists only so
// a developer running the API against a fresh schema before
// migrations run sees the picker work.
var staticRegistry = newStaticRegistry()

// StaticDefault returns the in-memory built-in registry. Useful for
// tests and for the "DB unreachable" path.
func StaticDefault() Registry { return staticRegistry }

type staticReg struct {
	bySlug  map[string]Profile
	ordered []Profile
}

func (r *staticReg) Get(_ context.Context, _, slug string) (Profile, bool) {
	if p, ok := r.bySlug[strings.ToLower(strings.TrimSpace(slug))]; ok {
		return p, true
	}
	if p, ok := r.bySlug["generic"]; ok {
		return p, false
	}
	return Profile{}, false
}

func (r *staticReg) List(_ context.Context, _ string) []Profile {
	out := make([]Profile, len(r.ordered))
	copy(out, r.ordered)
	return out
}

func newStaticRegistry() *staticReg {
	r := &staticReg{bySlug: map[string]Profile{}}
	for _, raw := range builtinSpecs() {
		p := Profile{
			Slug:          raw.Slug,
			Name:          raw.Name,
			Description:   raw.Description,
			Icon:          raw.Icon,
			Lang:          raw.Lang,
			PSM:           raw.PSM,
			Preprocess:    raw.Preprocess,
			Fields:        raw.Fields,
			Builtin:       true,
			Extractors:    raw.Extractors,
			LLMPromptText: raw.LLMPrompt,
		}
		r.bySlug[p.Slug] = p
		r.ordered = append(r.ordered, p)
	}
	return r
}

// boolPtr is a small helper for the spec table — a literal `true` is
// not addressable so we'd need a temp var on every line otherwise.
func boolPtr(v bool) *bool { return &v }

// rawSpec mirrors a Profile but stays in source code form (raw regex
// strings, no ID/OrgID). The migration's seed inserts use the same
// values; keeping the two in sync is a documented obligation.
type rawSpec struct {
	Slug        string
	Name        string
	Description string
	Icon        string
	Lang        string
	PSM         int
	Preprocess  *bool
	Fields      []string
	Extractors  map[string]string
	LLMPrompt   string
}

// builtinSpecs is the canonical fallback list. **MUST stay in sync
// with migration 047_ocr_profiles.sql** — a developer updating one
// without the other gets two answers depending on whether the DB
// query happened to return rows.
//
// Edits in production should go through the admin UI (which writes to
// the DB), not this slice. Code edits here are only for reseeding the
// fallback after migration 047 ships.
func builtinSpecs() []rawSpec {
	return []rawSpec{
		{
			Slug:        "generic",
			Name:        "Generic Document",
			Description: "Default OCR. Use for arbitrary scans, screenshots, and any document type not listed below.",
			Icon:        "file-text",
			PSM:         -1,
		},
		{
			Slug:        "aadhaar",
			Name:        "Aadhaar Card",
			Description: "Indian Aadhaar — front or back. Tuned for the 12-digit number, name, DOB, gender.",
			Icon:        "id-card",
			PSM:         6,
			Preprocess:  boolPtr(true),
			Fields:      []string{"aadhaar_number", "name", "dob", "gender"},
			Extractors: map[string]string{
				"aadhaar_number": `(?i)(\d{4}\s*\d{4}\s*\d{4})`,
				"dob":            `(?i)(?:DOB|D\.?O\.?B\.?|Date of Birth|Year of Birth)\s*[:\-]?\s*([\d/\-\.]{4,10})`,
				"gender":         `(?i)\b(MALE|FEMALE|TRANSGENDER)\b`,
				"name":           `(?m)^([A-Z][A-Za-z]+(?:\s+[A-Z][A-Za-z]+){1,3})\s*$`,
			},
			LLMPrompt: `You are extracting fields from raw OCR text of an Indian Aadhaar card.
Return ONLY a JSON object (no prose, no code fences) with these keys:
  aadhaar_number  — 12-digit number, formatted as "XXXX XXXX XXXX"
  name            — full name as printed
  dob             — date of birth in DD/MM/YYYY format
  gender          — "Male", "Female", or "Transgender"
If a field is missing or unreadable, set its value to null.
Common OCR mistakes to fix: O↔0, I↔1, B↔8, S↔5 inside digit fields. Names should keep their original capitalisation.`,
		},
		{
			Slug:        "pan",
			Name:        "PAN Card",
			Description: "Indian PAN card. Tuned for the 10-character PAN, name, father's name, DOB.",
			Icon:        "credit-card",
			PSM:         6,
			Preprocess:  boolPtr(true),
			Fields:      []string{"pan", "name", "father_name", "dob"},
			Extractors: map[string]string{
				"pan":         `(?i)\b([A-Z]{5}\s*[0-9]{4}\s*[A-Z])\b`,
				"dob":         `(?i)(?:DOB|D\.?O\.?B\.?|Date of Birth)\s*[:\-]?\s*([\d/\-\.]{4,10})`,
				"father_name": `(?im)Father['']?s?\s*Name\s*[:\-]?\s*([A-Z][A-Za-z\s]+)`,
				"name":        `(?im)^Name\s*[:\-]?\s*([A-Z][A-Za-z\s]+)`,
			},
			LLMPrompt: `You are extracting fields from raw OCR text of an Indian PAN card.
Return ONLY a JSON object (no prose, no code fences) with these keys:
  pan         — 10-character PAN, all uppercase, no spaces (e.g. "ABCDE1234F")
  name        — cardholder's full name as printed
  father_name — father's name as printed
  dob         — date of birth in DD/MM/YYYY format
If a field is missing or unreadable, set its value to null.
The PAN format is exactly 5 letters + 4 digits + 1 letter — fix obvious OCR mistakes (O↔0, I↔1, B↔8) inside the PAN to make it match this pattern.`,
		},
		{
			Slug:        "dl",
			Name:        "Driving License",
			Description: "Indian driving license. Tuned for DL number, name, DOB, validity.",
			Icon:        "car",
			PSM:         6,
			Preprocess:  boolPtr(true),
			Fields:      []string{"dl_number", "name", "dob", "valid_till"},
			Extractors: map[string]string{
				"dl_number":  `(?i)\b([A-Z]{2}[\s\-]?\d{2}[\s\-]?\d{4}[\s\-]?\d{6,7})\b`,
				"dob":        `(?i)(?:DOB|D\.?O\.?B\.?|Date of Birth)\s*[:\-]?\s*([\d/\-\.]{4,10})`,
				"valid_till": `(?i)(?:Valid\s*(?:Till|Upto|Until)|Expir[ye]\s*Date)\s*[:\-]?\s*([\d/\-\.]{4,10})`,
				"name":       `(?im)^Name\s*[:\-]?\s*([A-Z][A-Za-z\s]+)`,
			},
			LLMPrompt: `You are extracting fields from raw OCR text of an Indian driving license.
Return ONLY a JSON object (no prose, no code fences) with these keys:
  dl_number   — driving license number
  name        — full name as printed
  dob         — date of birth in DD/MM/YYYY format
  valid_till  — expiry date in DD/MM/YYYY format
If a field is missing or unreadable, set its value to null.
Fix obvious OCR mistakes (O↔0, I↔1, B↔8) inside the DL number.`,
		},
		{
			Slug:        "passport",
			Name:        "Passport",
			Description: "Passport bio page. Tuned for passport number, name, nationality, DOB, expiry.",
			Icon:        "book-marked",
			PSM:         6,
			Preprocess:  boolPtr(true),
			Fields:      []string{"passport_number", "surname", "given_names", "nationality", "dob", "expiry"},
			Extractors: map[string]string{
				"passport_number": `(?i)\b([A-Z][0-9]{7,8})\b`,
				"dob":             `(?i)(?:DOB|Date of Birth)\s*[:\-]?\s*([\d/\-\.]{4,10})`,
				"expiry":          `(?i)(?:Date of Expir[ye]|Valid\s*Until)\s*[:\-]?\s*([\d/\-\.]{4,10})`,
				"surname":         `(?im)^Surname\s*[:\-]?\s*([A-Z][A-Za-z\s]+)`,
				"given_names":     `(?im)Given\s*Names?\s*[:\-]?\s*([A-Z][A-Za-z\s]+)`,
				"nationality":     `(?im)Nationality\s*[:\-]?\s*([A-Z][A-Za-z\s]+)`,
			},
			LLMPrompt: `You are extracting fields from raw OCR text of a passport bio page.
Return ONLY a JSON object (no prose, no code fences) with these keys:
  passport_number — passport number, all uppercase, no spaces
  surname         — surname as printed
  given_names     — given names as printed
  nationality     — nationality as printed
  dob             — date of birth in DD/MM/YYYY format
  expiry          — date of expiry in DD/MM/YYYY format
If a field is missing or unreadable, set its value to null.
Fix obvious OCR mistakes (O↔0, I↔1, B↔8, Z↔2) inside the passport number.`,
		},
		{
			Slug:        "receipt",
			Name:        "Receipt / Invoice",
			Description: "Printed receipts and invoices. Tuned for vendor, total, date, GST/tax amounts.",
			Icon:        "receipt",
			PSM:         6,
			Preprocess:  boolPtr(true),
			Fields:      []string{"vendor", "date", "total", "tax", "invoice_number"},
			Extractors: map[string]string{
				"total":          `(?i)(?:Grand\s*Total|TOTAL|Amount\s*Due|Net\s*Payable)\s*[:\-]?\s*[₹$€£]?\s*([\d,]+\.?\d*)`,
				"tax":            `(?i)(?:GST|Tax|VAT|CGST|SGST|IGST)\s*[:\-]?\s*[₹$€£]?\s*([\d,]+\.?\d*)`,
				"date":           `(?i)(?:Date|Invoice\s*Date|Bill\s*Date)\s*[:\-]?\s*([\d/\-\.]{4,10})`,
				"invoice_number": `(?i)(?:Invoice\s*(?:No|Number|#)|Bill\s*No)\s*[:\-]?\s*([A-Z0-9\-/]+)`,
				"vendor":         `(?m)^([A-Z][A-Za-z0-9&'.\s]{3,})$`,
			},
			LLMPrompt: `You are extracting fields from raw OCR text of a printed receipt or invoice.
Return ONLY a JSON object (no prose, no code fences) with these keys:
  vendor         — merchant or vendor name
  date           — invoice or bill date in DD/MM/YYYY format
  total          — total / grand total / amount due as a numeric string with two decimals (no currency symbol)
  tax            — total tax amount (GST/VAT/sales tax) as a numeric string with two decimals
  invoice_number — invoice or bill number as printed
If a field is missing or unreadable, set its value to null.
Numbers must use a period for decimals and no thousands separators.`,
		},
	}
}

/* ----------------------------- LLM cleanup -------------------------- */

// CleanupResult is what RunCleanup returns. Fields holds the parsed
// JSON object the model produced; CleanedText is a human-readable
// rendering ("Aadhaar Number: XXXX …\nName: …") suitable for showing
// in the result drawer above the raw OCR. Both can be empty when the
// model is unavailable or returns garbage — the caller falls back to
// raw OCR + regex extractors only.
type CleanupResult struct {
	Fields      map[string]any `json:"fields"`
	CleanedText string         `json:"cleanedText"`
	Provider    string         `json:"provider"`
	Model       string         `json:"model,omitempty"`
}

// ErrCleanupUnavailable is returned by RunCleanup when AI is disabled
// or chat capability is missing. The docchat handler treats this as
// "ship the raw + regex result without cleanup" rather than failing
// the whole request.
var ErrCleanupUnavailable = errors.New("ocrprofiles: LLM cleanup unavailable")

// RunCleanup sends the raw OCR text through the chat model with the
// profile's system prompt and parses the returned JSON.
func RunCleanup(ctx context.Context, c ai.Client, p Profile, rawText string) (CleanupResult, error) {
	if c == nil || !c.Enabled() || !c.Capabilities().Chat {
		return CleanupResult{}, ErrCleanupUnavailable
	}
	if !p.HasLLMPrompt() {
		return CleanupResult{}, nil
	}
	resp, err := c.Chat(ctx, ai.ChatRequest{
		Messages: []ai.ChatMessage{
			{Role: "system", Content: p.LLMPromptText},
			{Role: "user", Content: "Raw OCR text:\n\n" + rawText},
		},
		Temperature: 0,
		MaxTokens:   600,
	})
	if err != nil {
		return CleanupResult{}, err
	}
	body := stripJSONFences(resp.Content)
	var fields map[string]any
	if err := json.Unmarshal([]byte(body), &fields); err != nil {
		// Don't fail the request — degrade to "raw + regex only".
		return CleanupResult{Provider: c.Provider(), Model: resp.Model}, nil
	}
	return CleanupResult{
		Fields:      fields,
		CleanedText: renderCleanText(p, fields),
		Provider:    c.Provider(),
		Model:       resp.Model,
	}, nil
}

// stripJSONFences pulls a JSON object out of a response that might
// be wrapped in ```json fences or prefixed with prose.
func stripJSONFences(s string) string {
	s = strings.TrimSpace(s)
	if i := strings.Index(s, "{"); i >= 0 {
		if j := strings.LastIndex(s, "}"); j > i {
			return s[i : j+1]
		}
	}
	return s
}

// renderCleanText turns the parsed JSON into a "Field: value" block
// in the profile's display order.
func renderCleanText(p Profile, fields map[string]any) string {
	if len(fields) == 0 {
		return ""
	}
	keys := p.Fields
	if len(keys) == 0 {
		for k := range fields {
			keys = append(keys, k)
		}
	}
	var b strings.Builder
	for _, k := range keys {
		v, ok := fields[k]
		if !ok || v == nil {
			continue
		}
		s := fmt.Sprintf("%v", v)
		if strings.TrimSpace(s) == "" {
			continue
		}
		b.WriteString(humanLabel(k))
		b.WriteString(": ")
		b.WriteString(s)
		b.WriteString("\n")
	}
	return strings.TrimRight(b.String(), "\n")
}

// humanLabel turns "aadhaar_number" → "Aadhaar Number" without
// hardcoding a label table.
func humanLabel(key string) string {
	parts := strings.Split(key, "_")
	for i, w := range parts {
		if w == "" {
			continue
		}
		switch strings.ToLower(w) {
		case "dob", "pan", "dl", "gst", "vat":
			parts[i] = strings.ToUpper(w)
		default:
			parts[i] = strings.ToUpper(w[:1]) + w[1:]
		}
	}
	return strings.Join(parts, " ")
}
