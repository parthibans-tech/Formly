// Package generate wires the three generation modes behind a single Run() entrypoint.
// Both the sync HTTP handler and the async worker delegate here so there's one code path.
package generate

import (
	"context"
	"encoding/json"
	"fmt"
	"path/filepath"
	"strings"
	"time"

	"github.com/docforge/api/internal/compute"
	"github.com/docforge/api/internal/events"
	"github.com/docforge/api/internal/generate/acroform"
	gdoc "github.com/docforge/api/internal/generate/doc"
	ghtml "github.com/docforge/api/internal/generate/html"
	gmarkdown "github.com/docforge/api/internal/generate/markdown"
	gstatic "github.com/docforge/api/internal/generate/static"
	"github.com/docforge/api/internal/i18n"
	"github.com/docforge/api/internal/layout"
	"github.com/docforge/api/internal/storage"
	"github.com/jackc/pgx/v5/pgxpool"
)

type Runner struct {
	DB      *pgxpool.Pool
	Storage *storage.Client
}

type Result struct {
	OutputFileID string
	OutputKey    string
	OutputName   string
	Bytes        int
}

// render is the pure rendering pipeline: load the template, expand
// computed fields, dispatch to the mode-specific renderer, and return
// the raw output bytes along with the template name (for downstream
// filename construction). It does NOT touch the files table or upload
// anything — those are orchestrated separately by Run (persist + save
// to Drive) vs. RunPreview (temp blob, no Drive row).
func (r *Runner) render(ctx context.Context, orgID, templateID string, data map[string]interface{}, flatten bool) ([]byte, string, error) {
	var (
		mode, storageKey, tplName string
		cfgRaw                    []byte
	)
	err := r.DB.QueryRow(ctx,
		`SELECT t.mode, t.name, t.config_json, f.storage_key
		 FROM templates t JOIN files f ON f.id=t.file_id
		 WHERE t.id=$1 AND t.org_id=$2`, templateID, orgID,
	).Scan(&mode, &tplName, &cfgRaw, &storageKey)
	if err != nil {
		return nil, "", fmt.Errorf("load template: %w", err)
	}

	pdfBytes, err := r.Storage.GetBytes(ctx, storageKey)
	if err != nil {
		return nil, "", fmt.Errorf("load source pdf: %w", err)
	}

	pageLayout := layout.FromConfig(cfgRaw)
	i18nCfg := i18n.FromConfig(cfgRaw)
	locale := i18n.ResolveLocale(i18nCfg, data)

	// Expand computed fields on top of the caller's data payload.
	data, _ = compute.Eval(compute.FromConfig(cfgRaw), data)

	// Cross-mode schema validation. AcroForm does its own validation
	// inside Fill() (because it needs access to per-PDF-field mapping
	// context); for the other modes the config can optionally carry
	// `required: []` and `validations: { key: ValidationRule }` blocks,
	// which we apply here so the integrator experience is consistent:
	// same error shape, same HTTP status (400 fill_failed wrapping an
	// acroform.FillErrors), regardless of template mode.
	if mode != "acroform" {
		if vErr := validateAgainstConfig(cfgRaw, data); vErr != nil {
			return nil, "", vErr
		}
	}

	var output []byte
	switch mode {
	case "acroform":
		var cfg struct {
			Mappings map[string]acroform.Mapping `json:"mappings"`
		}
		_ = json.Unmarshal(cfgRaw, &cfg)
		if cfg.Mappings == nil {
			cfg.Mappings = map[string]acroform.Mapping{}
		}
		fields, err := loadFieldSpecs(ctx, r.DB, templateID)
		if err != nil {
			return nil, "", err
		}
		output, err = acroform.Fill(pdfBytes, fields, cfg.Mappings, data, flatten)
		if err != nil {
			return nil, "", fmt.Errorf("acroform fill: %w", err)
		}
	case "static":
		widgets, err := loadWidgets(ctx, r.DB, templateID)
		if err != nil {
			return nil, "", err
		}
		output, err = gstatic.Fill(pdfBytes, widgets, data, pageLayout)
		if err != nil {
			return nil, "", fmt.Errorf("static fill: %w", err)
		}
	case "html":
		// Source file contains the HTML template (pdfBytes is actually HTML bytes here).
		output, err = ghtml.RenderWithLocale(ctx, string(pdfBytes), data, pageLayout, locale, i18nCfg)
		if err != nil {
			return nil, "", fmt.Errorf("html render: %w", err)
		}
	case "markdown":
		output, err = gmarkdown.RenderWithLocale(ctx, string(pdfBytes), data, pageLayout, locale, i18nCfg)
		if err != nil {
			return nil, "", fmt.Errorf("markdown render: %w", err)
		}
	case "doc":
		// Source file contains the JSON AST envelope.
		output, err = gdoc.RenderWithLocale(ctx, string(pdfBytes), data, pageLayout, locale, i18nCfg)
		if err != nil {
			return nil, "", fmt.Errorf("doc render: %w", err)
		}
	default:
		return nil, "", fmt.Errorf("unsupported mode %q", mode)
	}
	return output, tplName, nil
}

// RenderInline returns the rendered bytes WITHOUT persisting them to
// the files table or uploading to storage. Used by merge-recipes when
// a template component participates in a stitched output: the template
// PDF is an intermediate artefact, not a file the user expects to see
// in their drive. The merge-recipes runner pipes these bytes straight
// into pdfmerge.AssembleInline.
//
// Returns (output bytes, template name) — the latter is handy for
// fallback filenames when the recipe doesn't set output_name_template.
func (r *Runner) RenderInline(ctx context.Context, orgID, templateID string, data map[string]interface{}, flatten bool) ([]byte, string, error) {
	return r.render(ctx, orgID, templateID, data, flatten)
}

// Run loads a template and renders it with the supplied data. The output is
// persisted as a new File row and uploaded to MinIO. Returns a Result.
//
// Callers are responsible for tracking job status/audit if they're async.
func (r *Runner) Run(ctx context.Context, orgID, userID, templateID string, data map[string]interface{}, flatten bool) (*Result, error) {
	output, tplName, err := r.render(ctx, orgID, templateID, data, flatten)
	if err != nil {
		return nil, err
	}

	outName := strings.TrimSuffix(tplName, filepath.Ext(tplName)) + "-filled-" + time.Now().Format("20060102-150405") + ".pdf"
	var outFileID string
	err = r.DB.QueryRow(ctx,
		`INSERT INTO files (org_id, owner_id, name, mime, size, storage_key, status)
		 VALUES ($1,$2,$3,'application/pdf',$4,'','active') RETURNING id`,
		orgID, userID, outName, len(output),
	).Scan(&outFileID)
	if err != nil {
		return nil, fmt.Errorf("create file row: %w", err)
	}
	outKey := fmt.Sprintf("orgs/%s/outputs/%s/%s", orgID, outFileID, outName)
	if _, err := r.DB.Exec(ctx, `UPDATE files SET storage_key=$1 WHERE id=$2`, outKey, outFileID); err != nil {
		return nil, err
	}
	if err := r.Storage.PutBytes(ctx, outKey, "application/pdf", output); err != nil {
		return nil, fmt.Errorf("upload output: %w", err)
	}

	events.Publish(ctx, events.GenerateCompleted, orgID, map[string]interface{}{
		"templateId":   templateID,
		"templateName": tplName,
		"outputFileId": outFileID,
		"outputName":   outName,
		"bytes":        len(output),
	})

	return &Result{OutputFileID: outFileID, OutputKey: outKey, OutputName: outName, Bytes: len(output)}, nil
}

// PreviewResult carries just enough to iframe the rendered output —
// no files row is created, so there's no OutputFileID. The URL returned
// is presigned with `Content-Disposition: inline` so browsers render
// instead of downloading.
type PreviewResult struct {
	URL   string
	Bytes int
}

// RunPreview renders a template to bytes and uploads them to a
// deterministic per-(user, template) temp key, then returns an
// inline-disposition presigned URL. No files row is created — this is
// the path taken by the playground "Run" button and the view-only
// template page, where a preview should NOT pollute the user's Drive.
//
// Using a deterministic key (one per user × template) means every
// subsequent preview overwrites the same blob rather than piling up new
// objects in MinIO — so a user can click Run 50 times without leaving
// any footprint besides the latest preview.
func (r *Runner) RunPreview(ctx context.Context, orgID, userID, templateID string, data map[string]interface{}, flatten bool) (*PreviewResult, error) {
	output, _, err := r.render(ctx, orgID, templateID, data, flatten)
	if err != nil {
		return nil, err
	}
	key := fmt.Sprintf("orgs/%s/previews/%s/%s.pdf", orgID, userID, templateID)
	if err := r.Storage.PutBytes(ctx, key, "application/pdf", output); err != nil {
		return nil, fmt.Errorf("upload preview: %w", err)
	}
	url, err := r.Storage.PresignGetInline(ctx, key, 10*time.Minute)
	if err != nil {
		return nil, fmt.Errorf("presign preview: %w", err)
	}
	return &PreviewResult{URL: url, Bytes: len(output)}, nil
}

// PutRaw uploads an already-built byte buffer (e.g. a batch ZIP) and creates a File row.
func (r *Runner) PutRaw(ctx context.Context, orgID, userID, name, mime string, data []byte) (*Result, error) {
	var id string
	err := r.DB.QueryRow(ctx,
		`INSERT INTO files (org_id, owner_id, name, mime, size, storage_key, status)
		 VALUES ($1,$2,$3,$4,$5,'','active') RETURNING id`,
		orgID, userID, name, mime, len(data),
	).Scan(&id)
	if err != nil {
		return nil, err
	}
	key := fmt.Sprintf("orgs/%s/outputs/%s/%s", orgID, id, name)
	if _, err := r.DB.Exec(ctx, `UPDATE files SET storage_key=$1 WHERE id=$2`, key, id); err != nil {
		return nil, err
	}
	if err := r.Storage.PutBytes(ctx, key, mime, data); err != nil {
		return nil, err
	}
	return &Result{OutputFileID: id, OutputKey: key, OutputName: name, Bytes: len(data)}, nil
}

// validateAgainstConfig runs required-key and per-rule checks declared
// in a template's config_json for the html/markdown/doc modes. It
// returns an *acroform.FillErrors so the HTTP handler's existing 422
// branch ("this is a validation problem, show per-field messages")
// applies uniformly across every template mode — one error shape,
// regardless of whether the template is AcroForm or HTML.
//
// Expected config shape (all optional — absent means "no validation"):
//
//	{
//	  "required": ["email", "customerName"],
//	  "validations": {
//	    "email":       { "type": "email" },
//	    "age":         { "type": "number", "min": 0, "max": 150 },
//	    "postalCode":  { "pattern": "^\\d{5}$", "message": "must be a 5-digit zip" }
//	  }
//	}
//
// Returns nil when everything passes, nil when the config carries no
// schema (opt-in — we don't want to break templates that never declared
// one), or a non-nil *acroform.FillErrors with one entry per failing key.
func validateAgainstConfig(cfgRaw []byte, data map[string]interface{}) error {
	var cfg struct {
		Required    []string                               `json:"required"`
		Validations map[string]*acroform.ValidationRule    `json:"validations"`
	}
	if err := json.Unmarshal(cfgRaw, &cfg); err != nil {
		return nil
	}
	if len(cfg.Required) == 0 && len(cfg.Validations) == 0 {
		return nil
	}
	var errs []acroform.ValidationError
	for _, key := range cfg.Required {
		if isMissing(data, key) {
			errs = append(errs, acroform.ValidationError{
				Field: key, DataKey: key, Message: "is required",
			})
		}
	}
	for key, rule := range cfg.Validations {
		if rule == nil {
			continue
		}
		msgs := acroform.ValidateValue(data[key], rule)
		for _, m := range msgs {
			errs = append(errs, acroform.ValidationError{
				Field: key, DataKey: key, Message: m,
			})
		}
	}
	if len(errs) == 0 {
		return nil
	}
	return &acroform.FillErrors{Errors: errs}
}

// isMissing returns true when a map key is absent, nil, or an empty
// string. Numbers/booleans/arrays all count as present — "0" is a
// legitimate user value for a required numeric field.
func isMissing(data map[string]interface{}, key string) bool {
	v, ok := data[key]
	if !ok || v == nil {
		return true
	}
	if s, ok := v.(string); ok && s == "" {
		return true
	}
	return false
}

func loadFieldSpecs(ctx context.Context, db *pgxpool.Pool, tplID string) ([]acroform.FieldSpec, error) {
	rows, err := db.Query(ctx, `SELECT name, type FROM template_fields WHERE template_id=$1`, tplID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []acroform.FieldSpec{}
	for rows.Next() {
		var f acroform.FieldSpec
		if err := rows.Scan(&f.Name, &f.Type); err != nil {
			return nil, err
		}
		out = append(out, f)
	}
	return out, nil
}

func loadWidgets(ctx context.Context, db *pgxpool.Pool, tplID string) ([]gstatic.Widget, error) {
	rows, err := db.Query(ctx,
		`SELECT id, type, page, x, y, w, h, data_key, z_index, props_json
		 FROM template_widgets WHERE template_id=$1 ORDER BY page, z_index`, tplID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []gstatic.Widget{}
	for rows.Next() {
		var w gstatic.Widget
		var propsRaw []byte
		if err := rows.Scan(&w.ID, &w.Type, &w.Page, &w.X, &w.Y, &w.W, &w.H, &w.DataKey, &w.ZIndex, &propsRaw); err != nil {
			return nil, err
		}
		_ = json.Unmarshal(propsRaw, &w.Props)
		out = append(out, w)
	}
	return out, nil
}
