package mergerecipes

// Recipe schema introspection.
//
// GET /v1/merge-recipes/{id}/schema returns a JSON-Schema-flavored
// description of the EXACT envelope the caller should POST to
// /v1/merge-recipes/{id}/run. It's the merge analog of the per-template
// schema endpoint and powers the "Integrate" tab of the recipe builder
// (copy-paste cURL/JS/Python snippets, machine-readable JSON Schema for
// ajv-style client-side validation, sample payload).
//
// Where the data shape comes from
//
// Each template component contributes a sub-object under `data`, keyed
// by its `data_key` (or by the template name when data_key is empty).
// The sub-object's shape is what the existing per-template schema
// endpoint already produces — we just merge those individual schemas
// into one composite. File components don't contribute fields (they're
// static bytes; they may consume `pages` but pages live in the recipe
// definition, not in the run-time payload).
//
// Why a wrapper, not just a passthrough
//
// A recipe can have N template components, each reading from a
// different sub-key. The composite schema lets the integrator see the
// whole shape ("here's exactly what JSON to send") in one place,
// instead of cross-referencing N template-schema docs.

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"sort"
	"strings"

	"github.com/docforge/api/internal/auth"
	"github.com/docforge/api/internal/generate/acroform"
	"github.com/go-chi/chi/v5"
)

// Schema is GET /v1/merge-recipes/{id}/schema.
//
// We piece the response together by walking each template component
// and pulling the same field shape the per-template schema endpoint
// produces. To keep this package decoupled from internal/templates we
// re-derive the field list inline from the template's mode + config +
// fields/widgets, which is the same source data /v1/templates/:id/schema
// reads from.
func (h *Handler) Schema(w http.ResponseWriter, r *http.Request) {
	c, _ := r.Context().Value(auth.UserCtxKey).(*auth.Claims)
	if c == nil {
		writeErr(w, 401, "unauthorized", "missing claims")
		return
	}
	id := chi.URLParam(r, "id")

	dto, err := h.loadRecipe(r.Context(), c.OrgID, id)
	if err != nil {
		writeErr(w, 404, "not_found", "recipe not found")
		return
	}

	// Per-component sub-schemas, keyed by data_key (or a synthesized key
	// when data_key is empty — happens for trivial one-template recipes).
	subSchemas := map[string]map[string]any{}
	subExamples := map[string]map[string]any{}
	notes := []string{}

	for i, cmp := range dto.Components {
		if cmp.Kind != "template" {
			continue
		}
		key := strings.TrimSpace(cmp.DataKey)
		if key == "" {
			// Empty data_key means "the template reads from the WHOLE
			// data object". When two empty-data_key templates coexist
			// in one recipe the run handler will pass them the same
			// data — that's the integrator's call (and we surface it as
			// a note here so it's not a silent footgun).
			key = "_root"
			notes = append(notes,
				fmt.Sprintf("components[%d] has no data_key — it reads the entire `data` object. Use distinct data_keys when multiple templates need disjoint payloads.", i))
		}
		fields, err := h.loadTemplateFields(r.Context(), c.OrgID, cmp.TemplateID)
		if err != nil {
			notes = append(notes, fmt.Sprintf("components[%d]: %s", i, err.Error()))
			continue
		}
		schema := buildJSONSchema(fields)
		example := buildExample(fields)

		// Merge into existing sub-schema (when two components share a
		// data_key — typical when the same data drives multiple
		// templates, e.g. a candidate offer + NDA from the same
		// `candidate` payload).
		if existing, ok := subSchemas[key]; ok {
			subSchemas[key] = mergeSchemas(existing, schema)
			subExamples[key] = mergeExamples(subExamples[key], example)
		} else {
			subSchemas[key] = schema
			subExamples[key] = example
		}
	}

	// Compose the top-level data envelope.
	dataProps := map[string]any{}
	dataExample := map[string]any{}
	var requiredKeys []string
	for k, sch := range subSchemas {
		if k == "_root" {
			// "_root" is virtual — flatten its properties up to the
			// top-level data object.
			if rootProps, ok := sch["properties"].(map[string]any); ok {
				for pk, pv := range rootProps {
					dataProps[pk] = pv
				}
			}
			if req, ok := sch["required"].([]string); ok {
				requiredKeys = append(requiredKeys, req...)
			}
			for ek, ev := range subExamples[k] {
				dataExample[ek] = ev
			}
			continue
		}
		dataProps[k] = sch
		dataExample[k] = subExamples[k]
	}
	sort.Strings(requiredKeys)

	dataSchema := map[string]any{
		"$schema":              "http://json-schema.org/draft-07/schema#",
		"type":                 "object",
		"properties":           dataProps,
		"additionalProperties": true,
	}
	if len(requiredKeys) > 0 {
		dataSchema["required"] = requiredKeys
	}

	notes = append(notes,
		"Run the recipe by POSTing { data, async?, outputName? } to the URL below.",
		"Each template component reads only `data[<dataKey>]` — different files in the recipe can have different field names without collision.",
		"`async: true` returns { jobId } immediately; poll GET /v1/merge-jobs/{jobId} until status='done'.",
	)

	writeJSON(w, 200, map[string]any{
		"recipeId":   dto.ID,
		"recipeName": dto.Name,
		"endpoint": map[string]any{
			"url":         fmt.Sprintf("/v1/merge-recipes/%s/run", dto.ID),
			"method":      "POST",
			"contentType": "application/json",
			"authSchemes": []string{
				"Bearer <api-key>  (keys starting with fk_, scope merge:write — recommended for server-to-server)",
				"Bearer <session-jwt>  (from /v1/auth/login, useful for in-app testing)",
			},
		},
		"components": dto.Components,
		"jsonSchema": map[string]any{
			"$schema": "http://json-schema.org/draft-07/schema#",
			"type":    "object",
			"properties": map[string]any{
				"data":       dataSchema,
				"async":      map[string]any{"type": "boolean", "description": "Force async execution; returns {jobId} for polling."},
				"outputName": map[string]any{"type": "string", "description": "Optional override for the output file name."},
			},
			"required": []string{"data"},
		},
		"example": map[string]any{
			"data":       dataExample,
			"outputName": "",
		},
		"notes": notes,
	})
}

// =====================================================================
//   Field extraction (duplicate-but-decoupled from internal/templates)
// =====================================================================
//
// We re-derive a per-template field list here rather than calling into
// internal/templates because:
//   (a) templates.Schema is an HTTP handler, not a callable function;
//   (b) wiring an export from templates.* would create a churn-prone
//       coupling between two otherwise-independent packages.
//
// The shape we emit is intentionally identical to the one
// internal/templates/schema.go produces, so the frontend renderer can
// reuse the same React components for both endpoints.

type schemaField struct {
	Key         string
	Label       string
	Type        string
	Required    bool
	Default     string
	Description string
	Constraints map[string]any
	Options     []string
	Page        int
}

func (h *Handler) loadTemplateFields(ctx context.Context, orgID, tplID string) ([]schemaField, error) {
	var mode string
	var cfgRaw []byte
	if err := h.DB.QueryRow(ctx,
		`SELECT mode, config_json FROM templates WHERE id=$1 AND org_id=$2`, tplID, orgID,
	).Scan(&mode, &cfgRaw); err != nil {
		return nil, fmt.Errorf("template not found")
	}
	var cfg struct {
		Mappings     map[string]acroform.Mapping         `json:"mappings"`
		Placeholders []string                            `json:"placeholders"`
		Validations  map[string]*acroform.ValidationRule `json:"validations"`
		Required     []string                            `json:"required"`
	}
	_ = json.Unmarshal(cfgRaw, &cfg)

	switch mode {
	case "acroform":
		return h.fieldsForAcroform(ctx, tplID, cfg.Mappings)
	case "static":
		return h.fieldsForStatic(ctx, tplID)
	case "html", "markdown", "doc":
		return fieldsForPlaceholders(cfg.Placeholders, cfg.Required, cfg.Validations), nil
	}
	return []schemaField{}, nil
}

func (h *Handler) fieldsForAcroform(ctx context.Context, tplID string, mappings map[string]acroform.Mapping) ([]schemaField, error) {
	rows, err := h.DB.Query(ctx,
		`SELECT name, type, COALESCE(page,0), COALESCE(options,'[]'::jsonb)
		   FROM template_fields WHERE template_id=$1 ORDER BY page, name`, tplID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	seen := map[string]bool{}
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
			continue
		}
		seen[dataKey] = true
		var options []string
		_ = json.Unmarshal(optsRaw, &options)
		f := schemaField{
			Key:      dataKey,
			Label:    fieldName,
			Type:     "string",
			Required: m.Required,
			Default:  m.Default,
			Options:  options,
			Page:     page,
		}
		switch strings.ToLower(fieldType) {
		case "checkbox":
			f.Type = "boolean"
		case "radiobutton":
			if len(options) > 0 {
				f.Type = "choice"
			} else {
				f.Type = "boolean"
			}
		case "combobox", "dropdown", "listbox":
			f.Type = "choice"
		case "date":
			f.Type = "date"
		}
		if m.Validation != nil {
			if m.Validation.Type != "" {
				f.Type = m.Validation.Type
			}
			f.Constraints = constraintsFromRule(m.Validation)
		}
		out = append(out, f)
	}
	return out, nil
}

func (h *Handler) fieldsForStatic(ctx context.Context, tplID string) ([]schemaField, error) {
	rows, err := h.DB.Query(ctx,
		`SELECT type, page, data_key FROM template_widgets
		  WHERE template_id=$1 AND COALESCE(data_key,'') <> ''
		  ORDER BY page, data_key`, tplID)
	if err != nil {
		return nil, err
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
			Key:  dataKey,
			Type: typeForStaticWidget(wtype),
			Page: page,
		})
	}
	return out, nil
}

func fieldsForPlaceholders(placeholders, required []string, validations map[string]*acroform.ValidationRule) []schemaField {
	requiredSet := map[string]bool{}
	for _, k := range required {
		requiredSet[k] = true
	}
	seen := map[string]bool{}
	out := []schemaField{}
	for _, p := range placeholders {
		if seen[p] {
			continue
		}
		seen[p] = true
		f := schemaField{Key: p, Type: "string", Required: requiredSet[p]}
		if rule, ok := validations[p]; ok && rule != nil {
			if rule.Type != "" {
				f.Type = rule.Type
			}
			f.Constraints = constraintsFromRule(rule)
		}
		out = append(out, f)
	}
	// Validation-only keys (declared but not in placeholders).
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
			if rule.Type != "" {
				f.Type = rule.Type
			}
			f.Constraints = constraintsFromRule(rule)
		}
		out = append(out, f)
	}
	return out
}

func typeForStaticWidget(t string) string {
	switch strings.ToLower(t) {
	case "text", "paragraph", "label":
		return "string"
	case "date", "datetime":
		return "date"
	case "checkbox", "boolean":
		return "boolean"
	case "image", "qrcode", "barcode":
		return "string"
	case "number", "currency":
		return "number"
	}
	return "string"
}

func constraintsFromRule(r *acroform.ValidationRule) map[string]any {
	if r == nil {
		return nil
	}
	out := map[string]any{}
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
	if len(out) == 0 {
		return nil
	}
	return out
}

// buildJSONSchema mirrors templates.buildJSONSchema, kept local so the
// recipe schema endpoint stays decoupled from internal/templates.
func buildJSONSchema(fields []schemaField) map[string]any {
	props := map[string]any{}
	var required []string
	for _, f := range fields {
		prop := map[string]any{}
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
		props[f.Key] = prop
		if f.Required {
			required = append(required, f.Key)
		}
	}
	out := map[string]any{
		"type":                 "object",
		"properties":           props,
		"additionalProperties": true,
	}
	if len(required) > 0 {
		out["required"] = required
	}
	return out
}

func buildExample(fields []schemaField) map[string]any {
	out := map[string]any{}
	for _, f := range fields {
		if f.Default != "" {
			out[f.Key] = f.Default
			continue
		}
		out[f.Key] = exampleValue(f)
	}
	return out
}

func exampleValue(f schemaField) any {
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
	}
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
		return "1250.00"
	case strings.Contains(k, "addr"), strings.Contains(k, "street"):
		return "123 Main Street"
	case strings.Contains(k, "city"):
		return "Portland"
	case strings.Contains(k, "zip"), strings.Contains(k, "postal"):
		return "97201"
	}
	return "sample value"
}

// mergeSchemas combines two sub-schemas under the same data_key. This
// only happens when the recipe has multiple templates pointing at the
// same data namespace (typical for "render N variations of one
// dataset"). The shallow-merge is intentional — collisions on the same
// property name keep the first one (templates declared earlier win),
// which matches the order-of-component-position the integrator sees in
// the builder.
func mergeSchemas(a, b map[string]any) map[string]any {
	out := map[string]any{}
	for k, v := range a {
		out[k] = v
	}
	if propsA, _ := out["properties"].(map[string]any); propsA != nil {
		if propsB, _ := b["properties"].(map[string]any); propsB != nil {
			for k, v := range propsB {
				if _, exists := propsA[k]; !exists {
					propsA[k] = v
				}
			}
		}
	}
	if reqA, _ := out["required"].([]string); reqA != nil {
		if reqB, _ := b["required"].([]string); reqB != nil {
			seen := map[string]bool{}
			for _, k := range reqA {
				seen[k] = true
			}
			for _, k := range reqB {
				if !seen[k] {
					reqA = append(reqA, k)
					seen[k] = true
				}
			}
			out["required"] = reqA
		}
	} else if reqB, _ := b["required"].([]string); reqB != nil {
		out["required"] = reqB
	}
	return out
}

func mergeExamples(a, b map[string]any) map[string]any {
	out := map[string]any{}
	for k, v := range a {
		out[k] = v
	}
	for k, v := range b {
		if _, exists := out[k]; !exists {
			out[k] = v
		}
	}
	return out
}

