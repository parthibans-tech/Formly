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
	"github.com/docforge/api/internal/folders"
	"github.com/docforge/api/internal/generate/acroform"
	"github.com/docforge/api/internal/generate/delivery"
	gdoc "github.com/docforge/api/internal/generate/doc"
	ghtml "github.com/docforge/api/internal/generate/html"
	gmarkdown "github.com/docforge/api/internal/generate/markdown"
	"github.com/docforge/api/internal/generate/pathtpl"
	"github.com/docforge/api/internal/generate/pdfdecor"
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

	// ShareCreator and Mailer are optional. When nil, the
	// post-render delivery fan-out (auto-share-link / auto-email)
	// is silently skipped — the rest of the pipeline still runs,
	// so legacy callers and tests that construct a Runner with
	// just DB + Storage continue to work. cmd/api wires the real
	// adapters at boot.
	ShareCreator delivery.ShareCreator
	Mailer       delivery.EmailSender
}

type Result struct {
	OutputFileID string
	OutputKey    string
	OutputName   string
	Bytes        int

	// DownloadURL is a long-lived (24h) presigned URL for the
	// output file. Always populated by RunWithOpts so webhook
	// payloads / API responses can hand the integrator something
	// they can act on without a second round-trip. May be empty
	// when the underlying presign call failed (the render itself
	// is still considered successful — the URL is best-effort).
	DownloadURL string

	// ShareID / ShareURL / EmailSendID are populated when the
	// template's delivery config asked for an auto-share-link or
	// auto-email and that step succeeded. Empty otherwise.
	ShareID     string
	ShareURL    string
	EmailSendID string
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
//	    "filenameTemplate": "Invoice-{{invoiceNumber}}.pdf",
//	    "flattenDefault":   true
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

	// Flatten overrides config.output.flattenDefault. Pointer so we can
	// distinguish "not provided, fall back to template default" (nil)
	// from "explicitly false, do NOT flatten even if the template would"
	// (&false). When nil, render() consults outputConfig.FlattenDefault;
	// when that's also unset, the legacy behaviour (don't flatten) wins.
	Flatten *bool

	// Persist controls whether the rendered PDF lands in Drive.
	// Pointer so callers can distinguish "default" (nil → save to Drive,
	// preserving legacy behaviour for unmodified callers) from explicit
	// false (don't save — return a short-lived presigned URL instead and
	// skip the files row entirely). The web designer's Generate dialog
	// sends &false unless the user ticks "Save to Drive", so a routine
	// "test render" doesn't pollute the file list.
	Persist *bool

	// Security overrides config.security for this single render. Pointer
	// so the request body can distinguish "not provided" (nil → use the
	// template's security block, if any) from "explicit empty" (provided
	// but with no passwords, which means "render unprotected even if the
	// template would have encrypted").
	//
	// Permitted because the integrator already has render rights, and
	// per-call passwords are a common requirement (e.g. "encrypt with
	// the customer's email-derived password"). The per-call shape mirrors
	// config_json.security so the same JSON can be saved or sent inline.
	Security *SecurityOverride
}

// SecurityOverride is the per-call shape of config_json.security.
// Mirrors securityConfig but exported so HTTP handlers / callers can
// build it without reaching into internal/generate.
type SecurityOverride struct {
	OwnerPassword string                 `json:"ownerPassword"`
	UserPassword  string                 `json:"userPassword"`
	Encryption    string                 `json:"encryption"`
	Permissions   map[string]interface{} `json:"permissions"`
}

func (s *SecurityOverride) toSecurityConfig() securityConfig {
	if s == nil {
		return securityConfig{}
	}
	return securityConfig{
		OwnerPassword: s.OwnerPassword,
		UserPassword:  s.UserPassword,
		Encryption:    s.Encryption,
		Permissions:   s.Permissions,
	}
}

// outputConfig is the parsed shape of config_json.output. Kept private —
// callers go through the resolver helpers below.
type outputConfig struct {
	FolderPath       string `json:"folderPath"`
	FilenameTemplate string `json:"filenameTemplate"`
	// FlattenDefault is the template-author-provided "if the caller
	// doesn't specify, should we flatten?" knob. Pointer so the JSON
	// shape can distinguish absent (nil → no opinion) from explicit
	// false (don't flatten). Resolution precedence: per-call override >
	// this template default > legacy bool param (false).
	FlattenDefault *bool `json:"flattenDefault,omitempty"`
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
// renderOverrides bundles per-call inputs that influence render() itself
// (as opposed to RunOptions inputs that only affect persistence).
// Security is here because it's applied INSIDE render so previews see the
// same encrypted bytes the saved file would have.
type renderOverrides struct {
	flatten  *bool
	security *SecurityOverride
}

func (r *Runner) render(ctx context.Context, orgID, templateID string, data map[string]interface{}, ov renderOverrides) (renderResult, error) {
	flatten := ov.flatten
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

	// Resolve flatten precedence: explicit per-call > template-level
	// output.flattenDefault > false. Done here (inside render) so every
	// entry point — sync, async, preview, RenderInline — gets the same
	// resolution without each caller having to re-parse config_json.
	resolvedFlatten := false
	if flatten != nil {
		resolvedFlatten = *flatten
	} else if outCfg := parseOutputConfig(cfgRaw); outCfg.FlattenDefault != nil {
		resolvedFlatten = *outCfg.FlattenDefault
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
		output, err = acroform.Fill(pdfBytes, fields, cfg.Mappings, data, resolvedFlatten)
		if err != nil {
			return renderResult{}, fmt.Errorf("acroform fill: %w", err)
		}
		// Compose pass — the unified designer lets users stamp static
		// overlays (text, image, signature, QR, page-number, etc.) on
		// top of an AcroForm template. Those overlays live in the
		// template_widgets table just like static-mode templates;
		// here we run them through the overlay-only path AFTER the
		// AcroForm fields are filled. Order matters: filling first
		// keeps the form-field annotations intact, stamping last keeps
		// fonts/resources properly migrated by pdfcpu's
		// AddWatermarksFile (same rationale as static.Fill's own
		// inject-then-stamp ordering).
		widgets, err := loadWidgets(ctx, r.DB, templateID)
		if err != nil {
			return renderResult{}, fmt.Errorf("load widgets: %w", err)
		}
		if len(widgets) > 0 {
			output, err = gstatic.Overlay(output, widgets, data, pageLayout)
			if err != nil {
				return renderResult{}, fmt.Errorf("acroform overlay compose: %w", err)
			}
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

	// Apply decorations (watermarks, headers, footers) BEFORE encryption
	// — pdfcpu refuses to stamp an encrypted PDF, and re-encrypting after
	// stamping would force pdfdecor to know the password. Decorations
	// also live in render() (not Run) so previews show the same
	// watermark/footer the integrator's end users will see.
	if dec, ok := parseDecorationsConfig(cfgRaw); ok && dec.IsEnabled() {
		decorated, err := pdfdecor.Apply(output, dec, data)
		if err != nil {
			return renderResult{}, fmt.Errorf("apply decorations: %w", err)
		}
		output = decorated
	}

	// Apply PDF security. Per-call override (from RunOptions.Security)
	// wins over the template's config_json.security block. The override
	// is treated as authoritative even when its passwords are empty —
	// "explicit empty" means the integrator wants this one render
	// unprotected, e.g. a sample/test render of a normally-encrypted
	// template. Done here (not in Run) so previews see the same locked
	// output integrators' end users will see.
	var sec securityConfig
	var hasSec bool
	if ov.security != nil {
		sec = ov.security.toSecurityConfig()
		hasSec = true
	} else {
		sec, hasSec = parseSecurityConfig(cfgRaw)
	}
	if hasSec && sec.IsEnabled() {
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

// parseDeliveryConfig pulls the `delivery` block from config_json.
// Returns (cfg, true) when the block is present. The caller still
// needs to check IsEnabled to know whether anything besides the
// canonical download URL will be produced.
func parseDeliveryConfig(cfgRaw []byte) (delivery.Config, bool) {
	var wrap struct {
		Delivery *delivery.Config `json:"delivery"`
	}
	if err := json.Unmarshal(cfgRaw, &wrap); err != nil || wrap.Delivery == nil {
		return delivery.Config{}, false
	}
	return *wrap.Delivery, true
}

// parseDecorationsConfig pulls the `decorations` block from config_json.
// Returns (cfg, true) only when the block is present in the source — an
// empty `decorations: {}` is treated as "block exists but no content",
// which lets pdfdecor.IsEnabled short-circuit without us double-checking
// here. Mirrors parseSecurityConfig so future post-processing blocks can
// follow the same pattern.
func parseDecorationsConfig(cfgRaw []byte) (pdfdecor.Config, bool) {
	var wrap struct {
		Decorations *pdfdecor.Config `json:"decorations"`
	}
	if err := json.Unmarshal(cfgRaw, &wrap); err != nil || wrap.Decorations == nil {
		return pdfdecor.Config{}, false
	}
	return *wrap.Decorations, true
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
	// Wrap into *bool because mergerecipes always carries an explicit
	// per-component flatten flag (sourced from the recipe row), so the
	// template's flattenDefault should NOT override it.
	res, err := r.render(ctx, orgID, templateID, data, renderOverrides{flatten: &flatten})
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
	// Legacy callers (mail-merge, formlinks, batch ZIP, scheduled jobs)
	// pass `false` because they had no integrator surface to override
	// it. We honour the template's flattenDefault for them too — if a
	// template explicitly opts in, every code path should respect that.
	// Callers that need to force a specific value go through RunWithOpts
	// with a non-nil opts.Flatten.
	var override *bool
	if flatten {
		override = &flatten
	}
	return r.RunWithOpts(ctx, orgID, userID, templateID, data, &RunOptions{Flatten: override})
}

// RunWithOpts is Run + per-call output overrides. Callers (the HTTP
// handler) populate opts.OutputName / opts.OutputPath / opts.Flatten
// from the request body so integrators can name and tune a single
// render without baking it into the template config.
func (r *Runner) RunWithOpts(ctx context.Context, orgID, userID, templateID string, data map[string]interface{}, opts *RunOptions) (*Result, error) {
	var flatten *bool
	var sec *SecurityOverride
	if opts != nil {
		flatten = opts.Flatten
		sec = opts.Security
	}
	res, err := r.render(ctx, orgID, templateID, data, renderOverrides{flatten: flatten, security: sec})
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

	// Persist switch: when explicitly false, skip the files-row + Drive
	// upload entirely and short-circuit with a temp blob + presigned URL.
	// Used by the designer's "Generate without saving" flow so authors
	// can sanity-check a render without polluting Drive. Delivery fan-out
	// (auto-share / auto-email) is also skipped — there's no persisted
	// file to share, and an ephemeral blob expiring in minutes isn't a
	// useful share target.
	if opts != nil && opts.Persist != nil && !*opts.Persist {
		key := fmt.Sprintf("orgs/%s/ephemeral/%s/%s/%s.pdf",
			orgID, userID, templateID, time.Now().Format("20060102-150405.000"))
		if err := r.Storage.PutBytes(ctx, key, "application/pdf", output); err != nil {
			return nil, fmt.Errorf("upload ephemeral output: %w", err)
		}
		url, err := r.Storage.PresignGet(ctx, key, "application/pdf", outName, 10*time.Minute)
		if err != nil {
			return nil, fmt.Errorf("presign ephemeral output: %w", err)
		}
		return &Result{
			OutputFileID: "", // intentionally empty — no Drive row exists
			OutputKey:    key,
			OutputName:   outName,
			Bytes:        len(output),
			DownloadURL:  url,
		}, nil
	}

	// Resolve the user-facing Drive folder. The `folder` string above
	// is what pathtpl produced from the template — it's used both for
	// storage-key organisation (MinIO key path, harmless) AND, here,
	// for finding-or-creating the matching folder hierarchy in the
	// Drive UI. Without this step, the file row's folder_id stays NULL
	// and the user sees the PDF at root even though they asked for
	// "clients/test/" — which was the surprise we're fixing.
	//
	// Idempotent: if "clients/test" already exists in the user's Drive,
	// EnsurePath reuses it; otherwise it walks the path and creates
	// missing segments. Errors here are non-fatal — we'd rather still
	// produce the PDF (with folder_id=NULL) than fail the whole render
	// because of a folder hiccup, so we log via the event payload below
	// instead of returning early.
	var driveFolderID *string
	var folderErr error
	if folder != "" {
		driveFolderID, folderErr = folders.EnsurePath(ctx, r.DB, orgID, userID, folder, nil)
		if folderErr != nil {
			// Don't fail the render — fall back to root and surface the
			// error in the event payload so subscribers can react.
			driveFolderID = nil
		}
	}

	var outFileID string
	err = r.DB.QueryRow(ctx,
		`INSERT INTO files (org_id, owner_id, name, mime, size, storage_key, status, folder_id)
		 VALUES ($1,$2,$3,'application/pdf',$4,'','active',$5) RETURNING id`,
		orgID, userID, outName, len(output), driveFolderID,
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

	// Post-upload fan-out: produce the canonical 24h presigned
	// download URL, and (when the template opts in via config_json
	// .delivery) mint a share link + auto-email the recipients.
	// Failures inside Apply are best-effort — they're folded into
	// the event payload so subscribers can react, but they don't
	// fail the render itself. A successful render with a failed
	// email is still "the PDF exists" from the integrator's POV.
	delCfg, _ := parseDeliveryConfig(cfgRaw)
	delRes, _ := delivery.Apply(ctx, delCfg, delivery.Deps{
		Presign: r.Storage,
		Share:   r.ShareCreator,
		Mail:    r.Mailer,
	}, delivery.Args{
		OrgID:        orgID,
		UserID:       userID,
		TemplateID:   templateID,
		TemplateName: tplName,
		OutputFileID: outFileID,
		OutputKey:    outKey,
		OutputName:   outName,
		OutputBytes:  output,
		Data:         data,
	})

	// Enriched event payload. Webhook subscribers receive `data`
	// (the original request payload) so they can correlate a render
	// with whatever business object kicked it off, plus
	// `downloadUrl` so the consumer can fetch the PDF without
	// having to re-authenticate to the API. `shareUrl` /
	// `emailSendId` are present only when the template opted in.
	payload := map[string]interface{}{
		"templateId":   templateID,
		"templateName": tplName,
		"outputFileId": outFileID,
		"outputName":   outName,
		"outputFolder": folder,
		"bytes":        len(output),
		"data":         data,
	}
	if driveFolderID != nil {
		payload["driveFolderId"] = *driveFolderID
	}
	if folderErr != nil {
		// Surfaced rather than swallowed — webhook subscribers should
		// know the PDF landed at root, not under the requested path.
		payload["folderError"] = folderErr.Error()
	}
	if delRes.DownloadURL != "" {
		payload["downloadUrl"] = delRes.DownloadURL
	}
	if delRes.ShareID != "" {
		payload["shareId"] = delRes.ShareID
		payload["shareUrl"] = delRes.ShareURL
	}
	if delRes.EmailSendID != "" {
		payload["emailSendId"] = delRes.EmailSendID
	}
	if delRes.ShareError != nil {
		payload["shareError"] = delRes.ShareError.Error()
	}
	if delRes.EmailError != nil {
		payload["emailError"] = delRes.EmailError.Error()
	}
	events.Publish(ctx, events.GenerateCompleted, orgID, payload)

	return &Result{
		OutputFileID: outFileID,
		OutputKey:    outKey,
		OutputName:   outName,
		Bytes:        len(output),
		DownloadURL:  delRes.DownloadURL,
		ShareID:      delRes.ShareID,
		ShareURL:     delRes.ShareURL,
		EmailSendID:  delRes.EmailSendID,
	}, nil
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
func (r *Runner) RunPreview(ctx context.Context, orgID, userID, templateID string, data map[string]interface{}, flatten *bool) (*PreviewResult, error) {
	res, err := r.render(ctx, orgID, templateID, data, renderOverrides{flatten: flatten})
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
