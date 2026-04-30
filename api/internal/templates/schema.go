package templates

// Schema introspection for per-template API-integration docs.
//
// GET /v1/templates/:id/schema returns a JSON-Schema-flavored description
// of the exact `data` payload the caller should POST to
// /v1/templates/:id/generate. It's the single source of truth powering
// the /templates/:id/api page, which renders a copy-paste ready
// integration guide (endpoint + auth + payload shape + cURL/JS/Python
// snippets) for third-party systems wiring up document generation.
//
// Shape per mode:
//   - acroform: fields derived from template_fields, enriched with the
//     mapping's dataKey/default/required/validation/options from
//     config_json.mappings. The dataKey is what the caller sends —
//     not the PDF field name — which is exactly what integrators need.
//   - static: same as acroform but seeded from template_widgets (each
//     widget with a non-empty dataKey contributes one field).
//   - html/markdown/doc: seeded from config_json.placeholders, optionally
//     enriched by a caller-supplied validations map in config_json.
//
// Validation rules attached to fields flow into the JSON Schema so API
// consumers can run client-side schema validation *before* hitting the
// generate endpoint — matching what the server does during rendering,
// so integrators get "same answer, earlier".

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"regexp"
	"sort"
	"strings"

	"github.com/docforge/api/internal/auth"
	"github.com/docforge/api/internal/generate/acroform"
	"github.com/go-chi/chi/v5"
)

// placeholderRegex returns the {{key}} matcher used for the path/name
// placeholder list in the schema response. Wrapped in a function so the
// (small) compiled regex is created once per call without exporting it
// — pathtpl already owns the canonical version, but we keep a private
// copy here to avoid an internal-package import cycle.
func placeholderRegex() *regexp.Regexp {
	return regexp.MustCompile(`\{\{\s*([a-zA-Z_][a-zA-Z0-9_]*)\s*\}\}`)
}

// ctx is a short alias for context.Context — keeps handler helper
// signatures readable without leaking the package name everywhere.
type ctx = context.Context

// schemaField is one row in the caller-facing payload description.
// It's deliberately flat so the frontend can render a single table
// without threading nested structures.
type schemaField struct {
	Key         string                 `json:"key"`                   // top-level JSON key the caller sends
	Label       string                 `json:"label,omitempty"`       // human-readable hint (PDF field name / placeholder)
	Type        string                 `json:"type"`                  // string | number | boolean | date | email | url | choice
	Required    bool                   `json:"required"`
	Default     string                 `json:"default,omitempty"`
	Description string                 `json:"description,omitempty"` // short prose, shown in the integrator table
	Constraints map[string]interface{} `json:"constraints,omitempty"` // minLength / maxLength / pattern / min / max / minDate / maxDate
	Options     []string               `json:"options,omitempty"`     // allowed values for choice-style fields
	Page        int                    `json:"page,omitempty"`        // PDF page number, when applicable
}

// schemaEndpoint summarizes the transport for the doc UI so the
// frontend doesn't have to hardcode the URL pattern.
type schemaEndpoint struct {
	URL         string   `json:"url"`
	Method      string   `json:"method"`
	ContentType string   `json:"contentType"`
	AuthSchemes []string `json:"authSchemes"` // e.g. ["Bearer <api-key>", "Bearer <session-jwt>"]
}

// outputDoc is the integrator-facing description of the template's
// output naming + folder rules. We surface only the templates (with the
// {{key}} placeholders left in) — never the resolved values, since
// resolution depends on the request data the caller is about to send.
type outputDoc struct {
	FolderPath       string `json:"folderPath,omitempty"`
	FilenameTemplate string `json:"filenameTemplate,omitempty"`
	// Placeholders is the set of {{key}}s referenced anywhere in the
	// folderPath or filenameTemplate. Helpful for the API guide UI to
	// flag "you'll need to send `customerName` in `data` for this
	// template's path to resolve".
	Placeholders []string `json:"placeholders,omitempty"`
}

// securityDoc surfaces the *shape* of security policy without leaking
// passwords. Integrators need to know "this template enforces a print-
// only PDF" without the API guide doubling as a credential dump.
type securityDoc struct {
	Enabled        bool `json:"enabled"`
	HasUserPassword  bool `json:"hasUserPassword"`
	HasOwnerPassword bool `json:"hasOwnerPassword"`
	Encryption     string `json:"encryption,omitempty"` // "AES-128" | "AES-256"
	// Permissions: per-action allow flags. Only meaningful when Enabled
	// is true; absent fields default to false (denied).
	Permissions map[string]bool `json:"permissions,omitempty"`
}

// SchemaResp is the full payload for /v1/templates/:id/schema.
type SchemaResp struct {
	TemplateID   string                 `json:"templateId"`
	TemplateName string                 `json:"templateName"`
	Mode         string                 `json:"mode"`
	Endpoint     schemaEndpoint         `json:"endpoint"`
	Fields       []schemaField          `json:"fields"`
	JSONSchema   map[string]interface{} `json:"jsonSchema"` // JSON Schema draft-07 for the `data` body
	Example      map[string]interface{} `json:"example"`    // a filled-in example payload
	Output       *outputDoc             `json:"output,omitempty"`
	Security     *securityDoc           `json:"security,omitempty"`
	Notes        []string               `json:"notes,omitempty"`
}

// Schema: GET /v1/templates/:id/schema — introspects a template and
// returns a JSON Schema–flavored description of the generate payload,
// plus rendering hints (endpoint URL, auth schemes, per-field notes).
func (h *Handler) Schema(w http.ResponseWriter, r *http.Request) {
	c := r.Context().Value(auth.UserCtxKey).(*auth.Claims)
	id := chi.URLParam(r, "id")

	var mode, name string
	var cfgRaw []byte
	err := h.DB.QueryRow(r.Context(),
		`SELECT mode, name, config_json FROM templates WHERE id=$1 AND org_id=$2`,
		id, c.OrgID,
	).Scan(&mode, &name, &cfgRaw)
	if err != nil {
		writeErr(w, 404, "not_found", "template not found")
		return
	}

	var cfg struct {
		Mappings     map[string]acroform.Mapping            `json:"mappings"`
		Placeholders []string                               `json:"placeholders"`
		Validations  map[string]*acroform.ValidationRule    `json:"validations"`
		Required     []string                               `json:"required"`
		Output       *struct {
			FolderPath       string `json:"folderPath"`
			FilenameTemplate string `json:"filenameTemplate"`
		} `json:"output"`
		Security *struct {
			OwnerPassword string                 `json:"ownerPassword"`
			UserPassword  string                 `json:"userPassword"`
			Encryption    string                 `json:"encryption"`
			Permissions   map[string]interface{} `json:"permissions"`
		} `json:"security"`
	}
	_ = json.Unmarshal(cfgRaw, &cfg)

	var fields []schemaField
	var notes []string

	switch mode {
	case "acroform":
		fields, notes = schemaForAcroform(r.Context(), h, id, cfg.Mappings)
	case "static":
		fields, notes = schemaForStatic(r.Context(), h, id)
	case "html", "markdown", "doc":
		fields, notes = schemaForPlaceholders(mode, cfg.Placeholders, cfg.Required, cfg.Validations)
	default:
		fields = []schemaField{}
		notes = []string{fmt.Sprintf("unsupported template mode %q", mode)}
	}

	// Build JSON Schema draft-07 + example payload from the field list.
	jsonSchema := buildJSONSchema(fields)
	example := buildExample(fields)

	// Output naming / folder hints — surface only the templates with
	// {{key}} placeholders intact, plus the deduped placeholder list so
	// the API guide can flag "you'll need these keys for the path to
	// resolve cleanly".
	var outDoc *outputDoc
	if cfg.Output != nil && (cfg.Output.FolderPath != "" || cfg.Output.FilenameTemplate != "") {
		outDoc = &outputDoc{
			FolderPath:       cfg.Output.FolderPath,
			FilenameTemplate: cfg.Output.FilenameTemplate,
			Placeholders:     extractPlaceholders(cfg.Output.FolderPath, cfg.Output.FilenameTemplate),
		}
		notes = append(notes, "Output filename/folder support `{{key}}` placeholders resolved against your `data` payload — missing keys collapse to empty strings, so guard against that with sensible templates.")
	}

	// Security policy summary. We never echo passwords; the caller
	// already set them and doesn't need them returned. The UI uses
	// `enabled` and the per-permission flags to render a "this template
	// outputs a password-protected PDF with print enabled" panel.
	var secDoc *securityDoc
	if cfg.Security != nil && (cfg.Security.OwnerPassword != "" || cfg.Security.UserPassword != "") {
		perms := map[string]bool{}
		for _, k := range []string{"print", "copy", "modify", "annotate"} {
			if v, ok := cfg.Security.Permissions[k]; ok {
				if b, ok := v.(bool); ok {
					perms[k] = b
				}
			}
		}
		enc := cfg.Security.Encryption
		if enc == "" {
			enc = "AES-256"
		}
		secDoc = &securityDoc{
			Enabled:          true,
			HasUserPassword:  cfg.Security.UserPassword != "",
			HasOwnerPassword: cfg.Security.OwnerPassword != "",
			Encryption:       enc,
			Permissions:      perms,
		}
		notes = append(notes, "This template outputs an encrypted PDF — recipients will be prompted for a password to open or to bypass the permission restrictions.")
	}

	resp := SchemaResp{
		TemplateID:   id,
		TemplateName: name,
		Mode:         mode,
		Endpoint: schemaEndpoint{
			URL:         fmt.Sprintf("/v1/templates/%s/generate", id),
			Method:      "POST",
			ContentType: "application/json",
			AuthSchemes: []string{
				"Bearer <api-key>  (keys starting with fk_, created in Settings → API keys — recommended for server-to-server)",
				"Bearer <session-jwt>  (from /v1/auth/login, short-lived, useful for logged-in users)",
			},
		},
		Fields:     fields,
		JSONSchema: jsonSchema,
		Example:    example,
		Output:     outDoc,
		Security:   secDoc,
		Notes:      notes,
	}
	writeJSON(w, 200, resp)
}

// extractPlaceholders returns the deduped, sorted list of {{key}}
// identifiers referenced anywhere in the supplied templates. Used to
// surface "these data keys drive your output path" in the API guide
// without making the UI re-parse the template strings itself.
func extractPlaceholders(tmpls ...string) []string {
	re := placeholderRegex()
	seen := map[string]bool{}
	for _, t := range tmpls {
		for _, m := range re.FindAllStringSubmatch(t, -1) {
			if len(m) >= 2 {
				seen[m[1]] = true
			}
		}
	}
	out := make([]string, 0, len(seen))
	for k := range seen {
		out = append(out, k)
	}
	sort.Strings(out)
	return out
}

// schemaForAcroform walks template_fields (enriched with config.mappings)
// and returns one schemaField per PDF form field. dataKey beats name
// whenever a mapping sets one, because that's the JSON key the caller
// actually sends — the internal PDF field name only ever matters when
// we fill the PDF on the server side.
func schemaForAcroform(ctx ctx, h *Handler, tplID string, mappings map[string]acroform.Mapping) ([]schemaField, []string) {
	rows, err := h.DB.Query(ctx,
		`SELECT name, type, COALESCE(page,0), COALESCE(options,'[]'::jsonb)
		 FROM template_fields WHERE template_id=$1 ORDER BY page, name`, tplID)
	if err != nil {
		return nil, []string{"failed to load acroform fields: " + err.Error()}
	}
	defer rows.Close()

	seen := map[string]bool{} // dedupe dataKeys (multiple PDF fields may share one)
	out := []schemaField{}
	for rows.Next() {
		var fieldName, fieldType string
		var page int
		var optsRaw []byte
		if err := rows.Scan(&fieldName, &fieldType, &page, &optsRaw); err != nil {
			continue
		}
		m := mappings[fieldName]
		dataKey := fieldName
		if m.DataKey != "" {
			dataKey = m.DataKey
		}
		if seen[dataKey] {
			// A later mapping already covered this key. Don't overwrite —
			// the first pass wins and subsequent duplicates collapse.
			continue
		}
		seen[dataKey] = true

		var options []string
		_ = json.Unmarshal(optsRaw, &options)

		f := schemaField{
			Key:      dataKey,
			Label:    fieldName,
			Type:     inferTypeFromAcroform(fieldType, m.Validation),
			Required: m.Required,
			Default:  m.Default,
			Options:  options,
			Page:     page,
		}
		if fieldType == "checkbox" || fieldType == "radiobutton" {
			f.Type = "boolean"
			if fieldType == "radiobutton" && len(options) > 0 {
				f.Type = "choice"
			}
		}
		if m.Validation != nil {
			f.Constraints = constraintsFromRule(m.Validation)
			if m.Validation.Type != "" {
				f.Type = m.Validation.Type
			}
		}
		f.Description = acroformFieldDescription(fieldName, fieldType, &m)
		out = append(out, f)
	}
	notes := []string{
		"AcroForm templates are validated server-side before rendering — a 422 with per-field messages is returned on any rule violation.",
		"The `key` column is what you send in `data`; the `label` column is the underlying PDF field name (shown for reference).",
	}
	return out, notes
}

// schemaForStatic derives fields from template_widgets. Any widget with
// a non-empty data_key contributes one entry; widgets without a data_key
// are purely decorative (text boxes, static images) and don't need to
// appear in the integrator-facing schema.
func schemaForStatic(ctx ctx, h *Handler, tplID string) ([]schemaField, []string) {
	rows, err := h.DB.Query(ctx,
		`SELECT type, page, data_key FROM template_widgets
		 WHERE template_id=$1 AND COALESCE(data_key,'') <> '' ORDER BY page, data_key`, tplID)
	if err != nil {
		return nil, []string{"failed to load widgets: " + err.Error()}
	}
	defer rows.Close()
	seen := map[string]bool{}
	out := []schemaField{}
	for rows.Next() {
		var wtype, dataKey string
		var page int
		if err := rows.Scan(&wtype, &page, &dataKey); err != nil {
			continue
		}
		if seen[dataKey] {
			continue
		}
		seen[dataKey] = true
		out = append(out, schemaField{
			Key:         dataKey,
			Type:        typeForWidget(wtype),
			Page:        page,
			Description: fmt.Sprintf("drives a %s widget on page %d", wtype, page),
		})
	}
	notes := []string{
		"Static templates have no schema validation today — unknown keys are ignored, missing keys render empty.",
	}
	return out, notes
}

// schemaForPlaceholders handles the three source-based modes (html,
// markdown, doc). Their placeholder list is just strings, so we assume
// string type for every key unless the caller adds an explicit
// validations map to config_json.
func schemaForPlaceholders(mode string, placeholders, required []string, validations map[string]*acroform.ValidationRule) ([]schemaField, []string) {
	requiredSet := map[string]bool{}
	for _, k := range required {
		requiredSet[k] = true
	}
	seen := map[string]bool{}
	out := []schemaField{}
	// Start from placeholders to preserve original order…
	for _, p := range placeholders {
		if seen[p] {
			continue
		}
		seen[p] = true
		f := schemaField{
			Key:      p,
			Type:     "string",
			Required: requiredSet[p],
		}
		if rule, ok := validations[p]; ok && rule != nil {
			f.Constraints = constraintsFromRule(rule)
			if rule.Type != "" {
				f.Type = rule.Type
			}
		}
		out = append(out, f)
	}
	// …then pick up any validation-only keys that aren't in placeholders
	// (user added a rule for a key they expect to inject dynamically).
	var extras []string
	for k := range validations {
		if !seen[k] {
			extras = append(extras, k)
		}
	}
	sort.Strings(extras)
	for _, k := range extras {
		rule := validations[k]
		f := schemaField{Key: k, Type: "string", Required: requiredSet[k]}
		if rule != nil {
			f.Constraints = constraintsFromRule(rule)
			if rule.Type != "" {
				f.Type = rule.Type
			}
		}
		out = append(out, f)
	}

	var modeWord string
	switch mode {
	case "html":
		modeWord = "HTML"
	case "markdown":
		modeWord = "Markdown"
	case "doc":
		modeWord = "Doc"
	default:
		modeWord = mode
	}
	notes := []string{
		fmt.Sprintf("%s templates render every {{placeholder}} with the matching key in `data`; missing keys render as empty strings.", modeWord),
		"To enforce validation, add a `validations` map to the template config (same shape as AcroForm ValidationRule). Keys missing from `validations` are treated as optional strings.",
	}
	return out, notes
}

// buildJSONSchema produces a JSON Schema draft-07 object describing the
// `data` field only. We wrap it at the call site with the envelope
// ({ data, flatten?, async?, preview? }) when rendering docs, but the
// raw schema is more useful for machine consumption (e.g. ajv on the
// caller's side).
func buildJSONSchema(fields []schemaField) map[string]interface{} {
	props := map[string]interface{}{}
	var required []string
	for _, f := range fields {
		prop := map[string]interface{}{}
		switch f.Type {
		case "number":
			prop["type"] = "number"
		case "boolean":
			prop["type"] = "boolean"
		case "date":
			prop["type"] = "string"
			prop["format"] = "date"
		case "email":
			prop["type"] = "string"
			prop["format"] = "email"
		case "url":
			prop["type"] = "string"
			prop["format"] = "uri"
		case "choice":
			prop["type"] = "string"
			if len(f.Options) > 0 {
				prop["enum"] = f.Options
			}
		default:
			prop["type"] = "string"
		}
		for k, v := range f.Constraints {
			// JSON Schema keyword names line up with our constraint keys
			// (minLength/maxLength/pattern/min/max) except for min/max on
			// numbers, which JSON Schema calls minimum/maximum.
			switch k {
			case "min":
				prop["minimum"] = v
			case "max":
				prop["maximum"] = v
			default:
				prop[k] = v
			}
		}
		if f.Default != "" {
			prop["default"] = f.Default
		}
		if f.Description != "" {
			prop["description"] = f.Description
		}
		props[f.Key] = prop
		if f.Required {
			required = append(required, f.Key)
		}
	}
	out := map[string]interface{}{
		"$schema":              "http://json-schema.org/draft-07/schema#",
		"type":                 "object",
		"properties":           props,
		"additionalProperties": true,
	}
	if len(required) > 0 {
		out["required"] = required
	}
	return out
}

// buildExample fills a payload with plausible sample values so integrators
// can paste-and-run a request without inventing data.
func buildExample(fields []schemaField) map[string]interface{} {
	out := map[string]interface{}{}
	for _, f := range fields {
		if f.Default != "" {
			out[f.Key] = f.Default
			continue
		}
		out[f.Key] = exampleValue(f)
	}
	return out
}

func exampleValue(f schemaField) interface{} {
	if len(f.Options) > 0 {
		return f.Options[0]
	}
	switch f.Type {
	case "number":
		return 42
	case "boolean":
		return true
	case "date":
		return "2025-01-15"
	case "email":
		return "alice@example.com"
	case "url":
		return "https://example.com"
	case "choice":
		return ""
	}
	// Best-effort keyword-based guess — matches the frontend playground's
	// fakeValue logic so previews stay consistent.
	k := strings.ToLower(f.Key)
	switch {
	case strings.Contains(k, "email"):
		return "alice@example.com"
	case strings.Contains(k, "phone"):
		return "+1 (555) 123-4567"
	case strings.Contains(k, "name"):
		return "Alice Johnson"
	case strings.Contains(k, "date"):
		return "2025-01-15"
	case strings.Contains(k, "amount"), strings.Contains(k, "total"), strings.Contains(k, "price"):
		return "1,250.00"
	case strings.Contains(k, "addr"), strings.Contains(k, "street"):
		return "123 Main Street"
	case strings.Contains(k, "city"):
		return "Portland"
	case strings.Contains(k, "zip"), strings.Contains(k, "postal"):
		return "97201"
	}
	return "sample value"
}

// constraintsFromRule flattens a ValidationRule into a serializable map
// that mirrors JSON Schema keyword names where practical (minLength,
// maxLength, pattern) and keeps the generic min/max shape that our own
// UI uses.
func constraintsFromRule(r *acroform.ValidationRule) map[string]interface{} {
	if r == nil {
		return nil
	}
	out := map[string]interface{}{}
	if r.MinLength != nil {
		out["minLength"] = *r.MinLength
	}
	if r.MaxLength != nil {
		out["maxLength"] = *r.MaxLength
	}
	if r.Pattern != "" {
		out["pattern"] = r.Pattern
	}
	if r.Min != nil {
		out["min"] = *r.Min
	}
	if r.Max != nil {
		out["max"] = *r.Max
	}
	if r.MinDate != "" {
		out["minDate"] = r.MinDate
	}
	if r.MaxDate != "" {
		out["maxDate"] = r.MaxDate
	}
	if r.Expression != "" {
		out["expression"] = r.Expression
	}
	if len(out) == 0 {
		return nil
	}
	return out
}

// inferTypeFromAcroform picks the most informative type label for a PDF
// form field. An explicit validation type always wins; otherwise we fall
// back to a coarse mapping from pdfcpu field types.
func inferTypeFromAcroform(fieldType string, rule *acroform.ValidationRule) string {
	if rule != nil && rule.Type != "" {
		return rule.Type
	}
	switch strings.ToLower(fieldType) {
	case "checkbox":
		return "boolean"
	case "combobox", "dropdown", "listbox", "radiobutton":
		return "choice"
	case "date":
		return "date"
	}
	return "string"
}

func acroformFieldDescription(pdfFieldName, pdfFieldType string, m *acroform.Mapping) string {
	parts := []string{fmt.Sprintf("maps to PDF field %q (%s)", pdfFieldName, pdfFieldType)}
	if m != nil {
		if m.Default != "" {
			parts = append(parts, fmt.Sprintf("default %q", m.Default))
		}
		if m.FillWhen != "" {
			parts = append(parts, fmt.Sprintf("only filled when %s", m.FillWhen))
		}
	}
	return strings.Join(parts, "; ")
}

func typeForWidget(widget string) string {
	switch strings.ToLower(widget) {
	case "text", "paragraph", "label":
		return "string"
	case "date", "datetime":
		return "date"
	case "checkbox", "boolean":
		return "boolean"
	case "image", "qrcode", "barcode":
		return "string" // caller passes a URL or data: URI
	case "number", "currency":
		return "number"
	}
	return "string"
}

