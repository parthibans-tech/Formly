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
	"github.com/docforge/api/internal/generate/pathtpl"
	"github.com/docforge/api/internal/generate/pdfencrypt"
	gstatic "github.com/docforge/api/internal/generate/static"
	"github.com/docforge/api/internal/i18n"
	"github.com/docforge/api/internal/layout"
	"github.com/docforge/api/internal/storage"
	"github.com/docforge/api/internal/uploadpolicy"
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

// RunOptions carries per-call overrides for output naming/placement and
// security. All fields are optional. Pass nil (or a zero value) to fall
// back to the template's config_json defaults.
//
// The config_json shape this complements:
//
//	{
//	  "output": {
//	    "folderPath":       "clients/{{customerName}}/{{year}}",
//	    "filenameTemplate": "Invoice-{{invoiceNumber}}.pdf"
//	  },
//	  "security": {
//	    "ownerPassword": "...",
//	    "userPassword":  "...",
//	    "encryption":    "AES-256",     // or "AES-128"
//	    "permissions":   { "print": true, "copy": false, "modify": false, "annotate": false }
//	  }
//	}
//
// Per-call overrides win over config defaults. Security cannot be
// overridden from the request body — it's a template-level policy and
// integrators shouldn't be able to weaken it via JSON.
type RunOptions struct {
	// OutputName overrides config.output.filenameTemplate. Used by
	// integrators who want a per-call filename without touching the
	// template config (e.g. "Invoice-2024-001.pdf"). Placeholders are
	// resolved against `data` just like the template-level value.
	OutputName string

	// OutputPath overrides config.output.folderPath. Same placeholder
	// rules. Empty string means "no folder override" — the template's
	// config_json folderPath (if any) is still used.
	OutputPath string
}

// outputConfig is the parsed shape of config_json.output. Kept private —
// callers go through the resolver helpers below.
type outputConfig struct {
	FolderPath       string `json:"folderPath"`
	FilenameTemplate string `json:"filenameTemplate"`
}

// securityConfig is the parsed shape of config_json.security.
type securityConfig struct {
	OwnerPassword string `json:"ownerPassword"`
	UserPassword  string `json:"userPassword"`
	// "AES-128" | "AES-256". Empty → AES-256 default.
	Encryption  string                 `json:"encryption"`
	Permissions map[string]interface{} `json:"permissions"`
}

func (s securityConfig) toOptions() (pdfencrypt.Options, error) {
	opts := pdfencrypt.Options{
		OwnerPassword: s.OwnerPassword,
		UserPassword:  s.UserPassword,
	}
	switch strings.ToUpper(strings.ReplaceAll(s.Encryption, " ", "")) {
	case "", "AES-256", "AES256":
		opts.KeyLength = 256
	case "AES-128", "AES128":
		opts.KeyLength = 128
	default:
		return opts, fmt.Errorf("unsupported encryption %q (use AES-128 or AES-256)", s.Encryption)
	}
	// Permissions map: missing keys default to false (deny). When the
	// map itself is absent we keep the same defaults so an unset
	// permissions block doesn't silently grant everything.
	getBool := func(key string) bool {
		if v, ok := s.Permissions[key]; ok {
			if b, ok := v.(bool); ok {
				return b
			}
		}
		return false
	}
	if _, hasAll := s.Permissions["all"]; hasAll {
		opts.PermissionsAll = getBool("all")
	}
	opts.AllowPrint = getBool("print")
	opts.AllowCopy = getBool("copy")
	opts.AllowModify = getBool("modify")
	opts.AllowAnnotate = getBool("annotate")
	return opts, nil
}

// renderResult bundles everything render() learns from the template,
// so Run/RunPreview can apply post-processing (security, path/filename
// resolution) without re-reading config_json a second time.
type renderResult struct {
	output   []byte
	tplName  string
	cfgRaw   []byte // raw config_json — Run uses it for output{} resolution
}

// render is the pure rendering pipeline: load the template, expand
// computed fields, dispatch to the mode-specific renderer, and return
// the raw output bytes along with the template name (for downstream
// filename construction). It does NOT touch the files table or upload
// anything — those are orchestrated separately by Run (persist + save
// to Drive) vs. RunPreview (temp blob, no Drive row).
//
// Security (passwords / permissions) IS applied here so both Run and
// RunPreview produce identically-protected bytes — a previewed PDF
// shows the same lock prompt the integrator's end users will see.
func (r *Runner) render(ctx context.Context, orgID, templateID string, data map[string]interface{}, flatten bool) (renderResult, error) {
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
		return renderResult{}, fmt.Errorf("load template: %w", err)
	}

	pdfBytes, err := r.Storage.GetBytes(ctx, storageKey)
	if err != nil {
		return renderResult{}, fmt.Errorf("load source pdf: %w", err)
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
			return renderResult{}, vErr
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
			return renderResult{}, err
		}
		output, err = acroform.Fill(pdfBytes, fields, cfg.Mappings, data, flatten)
		if err != nil {
			return renderResult{}, fmt.Errorf("acroform fill: %w", err)
		}
	case "static":
		widgets, err := loadWidgets(ctx, r.DB, templateID)
		if err != nil {
			return renderResult{}, err
		}
		output, err = gstatic.Fill(pdfBytes, widgets, data, pageLayout)
		if err != nil {
			return renderResult{}, fmt.Errorf("static fill: %w", err)
		}
	case "html":
		// Source file contains the HTML template (pdfBytes is actually HTML bytes here).
		output, err = ghtml.RenderWithLocale(ctx, string(pdfBytes), data, pageLayout, locale, i18nCfg)
		if err != nil {
			return renderResult{}, fmt.Errorf("html render: %w", err)
		}
	case "markdown":
		output, err = gmarkdown.RenderWithLocale(ctx, string(pdfBytes), data, pageLayout, locale, i18nCfg)
		if err != nil {
			return renderResult{}, fmt.Errorf("markdown render: %w", err)
		}
	case "doc":
		// Source file contains the JSON AST envelope.
		output, err = gdoc.RenderWithLocale(ctx, string(pdfBytes), data, pageLayout, locale, i18nCfg)
		if err != nil {
			return renderResult{}, fmt.Errorf("doc render: %w", err)
		}
	default:
		return renderResult{}, fmt.Errorf("unsupported mode %q", mode)
	}

	// Apply PDF security if the template config asked for it. Done here
	// (not in Run) so previews see the same locked output integrators'
	// end users will see — surprises like "preview opens fine but the
	// downloaded PDF prompts for a password" are exactly the kind of
	// bug that erodes trust in the playground.
	if sec, ok := parseSecurityConfig(cfgRaw); ok && sec.IsEnabled() {
		encOpts, err := sec.toOptions()
		if err != nil {
			return renderResult{}, fmt.Errorf("security config: %w", err)
		}
		encrypted, err := pdfencrypt.Apply(output, encOpts)
		if err != nil {
			return renderResult{}, fmt.Errorf("apply security: %w", err)
		}
		output = encrypted
	}

	return renderResult{output: output, tplName: tplName, cfgRaw: cfgRaw}, nil
}

// parseSecurityConfig pulls out the `security` block from config_json.
// Returns (cfg, true) only when the block is present — the caller still
// has to consult IsEnabled to know whether encryption is actually
// requested (an empty `security: {}` block counts as "not enabled").
func parseSecurityConfig(cfgRaw []byte) (securityConfig, bool) {
	var wrap struct {
		Security *securityConfig `json:"security"`
	}
	if err := json.Unmarshal(cfgRaw, &wrap); err != nil || wrap.Security == nil {
		return securityConfig{}, false
	}
	return *wrap.Security, true
}

// IsEnabled mirrors pdfencrypt.Options.IsEnabled — true when at least
// one password is set, which is the trigger for actually encrypting.
func (s securityConfig) IsEnabled() bool {
	return s.OwnerPassword != "" || s.UserPassword != ""
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
	res, err := r.render(ctx, orgID, templateID, data, flatten)
	if err != nil {
		return nil, "", err
	}
	return res.output, res.tplName, nil
}

// Run loads a template and renders it with the supplied data. The output is
// persisted as a new File row and uploaded to MinIO. Returns a Result.
//
// Callers are responsible for tracking job status/audit if they're async.
//
// Output naming and folder placement come from the template's
// config_json.output (filenameTemplate / folderPath) — both support
// {{key}} substitution against the request data. For per-call overrides
// (e.g. "this one invoice should be named X.pdf"), use RunWithOpts.
func (r *Runner) Run(ctx context.Context, orgID, userID, templateID string, data map[string]interface{}, flatten bool) (*Result, error) {
	return r.RunWithOpts(ctx, orgID, userID, templateID, data, flatten, nil)
}

// RunWithOpts is Run + per-call output overrides. Callers (the HTTP
// handler) populate opts.OutputName / opts.OutputPath from the request
// body so integrators can name a single render without baking it into
// the template config.
func (r *Runner) RunWithOpts(ctx context.Context, orgID, userID, templateID string, data map[string]interface{}, flatten bool, opts *RunOptions) (*Result, error) {
	res, err := r.render(ctx, orgID, templateID, data, flatten)
	if err != nil {
		return nil, err
	}
	output, tplName, cfgRaw := res.output, res.tplName, res.cfgRaw

	// Resolve filename: per-call override > config template > legacy
	// "<tplName>-filled-<timestamp>.pdf" fallback.
	fallback := strings.TrimSuffix(tplName, filepath.Ext(tplName)) + "-filled-" + time.Now().Format("20060102-150405") + ".pdf"
	outCfg := parseOutputConfig(cfgRaw)
	filenameTpl := outCfg.FilenameTemplate
	if opts != nil && strings.TrimSpace(opts.OutputName) != "" {
		filenameTpl = opts.OutputName
	}
	outName := pathtpl.ResolveFilename(filenameTpl, data, fallback)

	// Resolve folder: per-call override > config template > "" (empty
	// means "no logical subfolder", which keeps existing behaviour).
	folderTpl := outCfg.FolderPath
	if opts != nil && strings.TrimSpace(opts.OutputPath) != "" {
		folderTpl = opts.OutputPath
	}
	folder := pathtpl.ResolvePath(folderTpl, data)

	var outFileID string
	err = r.DB.QueryRow(ctx,
		`INSERT INTO files (org_id, owner_id, name, mime, size, storage_key, status)
		 VALUES ($1,$2,$3,'application/pdf',$4,'','active') RETURNING id`,
		orgID, userID, outName, len(output),
	).Scan(&outFileID)
	if err != nil {
		return nil, fmt.Errorf("create file row: %w", err)
	}
	// Storage key stays under orgs/<id>/outputs/<fileId>/ — the resolved
	// folder is inserted as a logical sub-prefix between the file ID and
	// the filename so MinIO listings stay organised by tenant first,
	// integrator-defined hierarchy second. Folder segments were already
	// sanitised by pathtpl.ResolvePath so they're safe to embed here.
	var outKey string
	if folder != "" {
		outKey = fmt.Sprintf("orgs/%s/outputs/%s/%s/%s",
			orgID, outFileID, folder, uploadpolicy.SafeStorageSlug(outName))
	} else {
		outKey = fmt.Sprintf("orgs/%s/outputs/%s/%s",
			orgID, outFileID, uploadpolicy.SafeStorageSlug(outName))
	}
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
		"outputFolder": folder,
		"bytes":        len(output),
	})

	return &Result{OutputFileID: outFileID, OutputKey: outKey, OutputName: outName, Bytes: len(output)}, nil
}

// parseOutputConfig pulls config_json.output. Returns the zero value
// when the block is absent — callers treat zero as "use legacy
// behaviour" without needing an extra ok flag.
func parseOutputConfig(cfgRaw []byte) outputConfig {
	var wrap struct {
		Output *outputConfig `json:"output"`
	}
	if err := json.Unmarshal(cfgRaw, &wrap); err != nil || wrap.Output == nil {
		return outputConfig{}
	}
	return *wrap.Output
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
	res, err := r.render(ctx, orgID, templateID, data, flatten)
	if err != nil {
		return nil, err
	}
	output := res.output
	key := fmt.Sprintf("orgs/%s/previews/%s/%s.pdf", orgID, userID, templateID)
	if err := r.Storage.PutBytes(ctx, key, "application/pdf", output); err != nil {
		return nil, fmt.Errorf("upload preview: %w", err)
	}
	// Always PDF for previews — server-generated, never user-supplied,
	// safe to render inline. Pass the explicit MIME so the storage
	// hardening logic doesn't have to second-guess.
	url, err := r.Storage.PresignGetInline(ctx, key, "application/pdf", 10*time.Minute)
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
	key := fmt.Sprintf("orgs/%s/outputs/%s/%s",
		orgID, id, uploadpolicy.SafeStorageSlug(name))
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
