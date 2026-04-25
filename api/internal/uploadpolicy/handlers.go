// HTTP layer for the layered upload policy:
//
//   GET    /v1/admin/product-config       — super-admin: read product defaults
//   PATCH  /v1/admin/product-config       — super-admin: update product defaults
//
//   GET    /v1/settings/upload-policy     — org admin: read effective + raw overrides
//   PATCH  /v1/settings/upload-policy     — org admin: update overrides
//   DELETE /v1/settings/upload-policy     — org admin: clear overrides (inherit fully)
//
// Authorization is enforced one level up (route registration in cmd/api):
// the product-config routes mount behind requireSuperAdmin, the
// settings/upload-policy routes behind the standard auth middleware.
// Handlers do their own org-admin gate (c.IsAdmin()) for the org routes.

package uploadpolicy

import (
	"encoding/json"
	"net/http"
	"strings"
	"time"

	"github.com/docforge/api/internal/audit"
	"github.com/docforge/api/internal/auth"
)

// Handler ties the Service to HTTP routes. Construct with NewHandler so
// the audit dependency is wired.
type Handler struct {
	Svc *Service
}

func NewHandler(svc *Service) *Handler { return &Handler{Svc: svc} }

// productDTO is the wire shape for product_config — same fields as Policy
// plus an updated_at hint for the UI.
type productDTO struct {
	MaxUploadBytes          int64    `json:"maxUploadBytes"`
	AllowedMimeTypes        []string `json:"allowedMimeTypes"`
	BlockedExtensions       []string `json:"blockedExtensions"`
	MimeSniffEnabled        bool     `json:"mimeSniffEnabled"`
	ScanEnabled             bool     `json:"scanEnabled"`
	MaxFilenameLen          int      `json:"maxFilenameLen"`
	ForceAttachmentForRisky bool     `json:"forceAttachmentForRisky"`
	PreviewCSP              string   `json:"previewCsp"`
	PreviewIframeSandbox    string   `json:"previewIframeSandbox"`
	PdfHardenEnabled        bool     `json:"pdfHardenEnabled"`
	PdfBlockedFeatures      []string `json:"pdfBlockedFeatures"`
	EmbedAllowedOrigins     []string `json:"embedAllowedOrigins"`
	UpdatedAt               string   `json:"updatedAt,omitempty"`
}

func toProductDTO(p ProductPolicy) productDTO {
	dto := productDTO{
		MaxUploadBytes:          p.MaxUploadBytes,
		AllowedMimeTypes:        normalizeStringSlice(p.AllowedMimeTypes),
		BlockedExtensions:       normalizeStringSlice(p.BlockedExtensions),
		MimeSniffEnabled:        p.MimeSniffEnabled,
		ScanEnabled:             p.ScanEnabled,
		MaxFilenameLen:          p.MaxFilenameLen,
		ForceAttachmentForRisky: p.ForceAttachmentForRisky,
		PreviewCSP:              p.PreviewCSP,
		PreviewIframeSandbox:    p.PreviewIframeSandbox,
		PdfHardenEnabled:        p.PdfHardenEnabled,
		PdfBlockedFeatures:      normalizeStringSlice(p.PdfBlockedFeatures),
		EmbedAllowedOrigins:     normalizeOriginSlice(p.EmbedAllowedOrigins),
	}
	if !p.UpdatedAt.IsZero() {
		dto.UpdatedAt = p.UpdatedAt.UTC().Format(time.RFC3339)
	}
	return dto
}

// ----- Super-admin: product_config -----------------------------------

// GetProduct returns the singleton product_config row.
func (h *Handler) GetProduct(w http.ResponseWriter, r *http.Request) {
	pp, err := h.Svc.Product(r.Context())
	if err != nil {
		writeErr(w, 500, "policy_error", err.Error())
		return
	}
	writeJSON(w, 200, toProductDTO(pp))
}

// PatchProduct upserts the product_config row. Every field is required
// in the request — partial updates would invite drift between what the
// admin sees and what the server stores.
func (h *Handler) PatchProduct(w http.ResponseWriter, r *http.Request) {
	c, _ := r.Context().Value(auth.UserCtxKey).(*auth.Claims)
	if c == nil {
		writeErr(w, 401, "unauthorized", "auth required")
		return
	}
	var req productDTO
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeErr(w, 400, "invalid_body", err.Error())
		return
	}
	policy := Policy{
		MaxUploadBytes:          req.MaxUploadBytes,
		AllowedMimeTypes:        normalizeStringSlice(req.AllowedMimeTypes),
		BlockedExtensions:       normalizeExtSlice(req.BlockedExtensions),
		MimeSniffEnabled:        req.MimeSniffEnabled,
		ScanEnabled:             req.ScanEnabled,
		MaxFilenameLen:          req.MaxFilenameLen,
		ForceAttachmentForRisky: req.ForceAttachmentForRisky,
		PreviewCSP:              strings.TrimSpace(req.PreviewCSP),
		PreviewIframeSandbox:    strings.TrimSpace(req.PreviewIframeSandbox),
		PdfHardenEnabled:        req.PdfHardenEnabled,
		PdfBlockedFeatures:      normalizeStringSlice(req.PdfBlockedFeatures),
		EmbedAllowedOrigins:     normalizeOriginSlice(req.EmbedAllowedOrigins),
	}
	if err := h.Svc.UpdateProduct(r.Context(), c.UserID, policy); err != nil {
		if pe, ok := IsError(err); ok {
			writeErr(w, pe.Status, pe.Code, pe.Message)
			return
		}
		writeErr(w, 500, "policy_error", err.Error())
		return
	}
	audit.LogHTTP(r, h.Svc.db, "super_admin.product_config.updated", "product_config", "default",
		map[string]any{
			"maxUploadBytes":          policy.MaxUploadBytes,
			"allowedMimeTypes":        policy.AllowedMimeTypes,
			"blockedExtensions":       policy.BlockedExtensions,
			"mimeSniffEnabled":        policy.MimeSniffEnabled,
			"scanEnabled":             policy.ScanEnabled,
			"maxFilenameLen":          policy.MaxFilenameLen,
			"forceAttachmentForRisky": policy.ForceAttachmentForRisky,
			"previewCsp":              policy.PreviewCSP,
			"previewIframeSandbox":    policy.PreviewIframeSandbox,
			"pdfHardenEnabled":        policy.PdfHardenEnabled,
			"pdfBlockedFeatures":      policy.PdfBlockedFeatures,
			"embedAllowedOrigins":     policy.EmbedAllowedOrigins,
		})
	pp, _ := h.Svc.Product(r.Context())
	writeJSON(w, 200, toProductDTO(pp))
}

// ----- Org admin: org_upload_config ----------------------------------

// orgPolicyResp tells the org-admin UI both what's currently in effect
// and what they've explicitly overridden — so a "reset to default" UX
// can be unambiguous.
type orgPolicyResp struct {
	Effective productDTO   `json:"effective"`
	Overrides overridesDTO `json:"overrides"`
	Product   productDTO   `json:"product"`
}

// overridesDTO uses pointers so the JSON faithfully represents NULL:
// a missing/null field means "inherit from product".
type overridesDTO struct {
	MaxUploadBytes          *int64    `json:"maxUploadBytes,omitempty"`
	AllowedMimeTypes        *[]string `json:"allowedMimeTypes,omitempty"`
	BlockedExtensions       *[]string `json:"blockedExtensions,omitempty"`
	MimeSniffEnabled        *bool     `json:"mimeSniffEnabled,omitempty"`
	ScanEnabled             *bool     `json:"scanEnabled,omitempty"`
	MaxFilenameLen          *int      `json:"maxFilenameLen,omitempty"`
	ForceAttachmentForRisky *bool     `json:"forceAttachmentForRisky,omitempty"`
	PreviewCSP              *string   `json:"previewCsp,omitempty"`
	PreviewIframeSandbox    *string   `json:"previewIframeSandbox,omitempty"`
	PdfHardenEnabled        *bool     `json:"pdfHardenEnabled,omitempty"`
	PdfBlockedFeatures      *[]string `json:"pdfBlockedFeatures,omitempty"`
	EmbedAllowedOrigins     *[]string `json:"embedAllowedOrigins,omitempty"`
}

func toOverridesDTO(ov Overrides) overridesDTO {
	dto := overridesDTO{
		MaxUploadBytes:          ov.MaxUploadBytes,
		MimeSniffEnabled:        ov.MimeSniffEnabled,
		ScanEnabled:             ov.ScanEnabled,
		MaxFilenameLen:          ov.MaxFilenameLen,
		ForceAttachmentForRisky: ov.ForceAttachmentForRisky,
		PreviewCSP:              ov.PreviewCSP,
		PreviewIframeSandbox:    ov.PreviewIframeSandbox,
		PdfHardenEnabled:        ov.PdfHardenEnabled,
	}
	if ov.PdfBlockedFeatures != nil {
		s := normalizeStringSlice(ov.PdfBlockedFeatures)
		dto.PdfBlockedFeatures = &s
	}
	if ov.AllowedMimeTypes != nil {
		s := normalizeStringSlice(ov.AllowedMimeTypes)
		dto.AllowedMimeTypes = &s
	}
	if ov.BlockedExtensions != nil {
		s := normalizeStringSlice(ov.BlockedExtensions)
		dto.BlockedExtensions = &s
	}
	if ov.EmbedAllowedOrigins != nil {
		s := normalizeOriginSlice(ov.EmbedAllowedOrigins)
		dto.EmbedAllowedOrigins = &s
	}
	return dto
}

// GetOrg returns effective + raw overrides + product defaults so the org
// admin UI can render a "your value | default" comparison without a
// second round-trip.
func (h *Handler) GetOrg(w http.ResponseWriter, r *http.Request) {
	c, _ := r.Context().Value(auth.UserCtxKey).(*auth.Claims)
	if c == nil {
		writeErr(w, 401, "unauthorized", "auth required")
		return
	}
	if !c.IsAdmin() {
		writeErr(w, 403, "forbidden", "admin role required")
		return
	}
	prod, err := h.Svc.Product(r.Context())
	if err != nil {
		writeErr(w, 500, "policy_error", err.Error())
		return
	}
	ov, err := h.Svc.OrgOverrides(r.Context(), c.OrgID)
	if err != nil {
		writeErr(w, 500, "policy_error", err.Error())
		return
	}
	eff, err := h.Svc.Effective(r.Context(), c.OrgID)
	if err != nil {
		writeErr(w, 500, "policy_error", err.Error())
		return
	}
	writeJSON(w, 200, orgPolicyResp{
		Effective: toProductDTO(ProductPolicy{Policy: eff}),
		Overrides: toOverridesDTO(ov),
		Product:   toProductDTO(prod),
	})
}

// PatchOrg accepts an overridesDTO and upserts. Any field omitted /
// explicitly null clears that override (back to inherit).
func (h *Handler) PatchOrg(w http.ResponseWriter, r *http.Request) {
	c, _ := r.Context().Value(auth.UserCtxKey).(*auth.Claims)
	if c == nil {
		writeErr(w, 401, "unauthorized", "auth required")
		return
	}
	if !c.IsAdmin() {
		writeErr(w, 403, "forbidden", "admin role required")
		return
	}
	var req overridesDTO
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeErr(w, 400, "invalid_body", err.Error())
		return
	}
	ov := Overrides{
		MaxUploadBytes:          req.MaxUploadBytes,
		MimeSniffEnabled:        req.MimeSniffEnabled,
		ScanEnabled:             req.ScanEnabled,
		MaxFilenameLen:          req.MaxFilenameLen,
		ForceAttachmentForRisky: req.ForceAttachmentForRisky,
		PreviewCSP:              trimStringPtr(req.PreviewCSP),
		PreviewIframeSandbox:    trimStringPtr(req.PreviewIframeSandbox),
		PdfHardenEnabled:        req.PdfHardenEnabled,
	}
	if req.AllowedMimeTypes != nil {
		ov.AllowedMimeTypes = normalizeStringSlice(*req.AllowedMimeTypes)
	}
	if req.BlockedExtensions != nil {
		ov.BlockedExtensions = normalizeExtSlice(*req.BlockedExtensions)
	}
	if req.PdfBlockedFeatures != nil {
		// Normalize but keep as a non-nil slice (possibly empty) so the
		// "report-only mode" override (explicit empty list) survives the
		// round-trip without collapsing back to inherit.
		ov.PdfBlockedFeatures = normalizeStringSlice(*req.PdfBlockedFeatures)
		if ov.PdfBlockedFeatures == nil {
			ov.PdfBlockedFeatures = []string{}
		}
	}
	if req.EmbedAllowedOrigins != nil {
		// Same tri-state preservation as PdfBlockedFeatures: an explicit
		// empty list means "lock down to same-origin only" (overriding a
		// product default that might be wider in the future). Collapsing
		// to nil here would silently re-inherit, undoing the admin's
		// intent. Validation runs in Service.UpdateOrg.
		ov.EmbedAllowedOrigins = normalizeOriginSlice(*req.EmbedAllowedOrigins)
		if ov.EmbedAllowedOrigins == nil {
			ov.EmbedAllowedOrigins = []string{}
		}
	}
	if err := h.Svc.UpdateOrg(r.Context(), c.UserID, c.OrgID, ov); err != nil {
		if pe, ok := IsError(err); ok {
			writeErr(w, pe.Status, pe.Code, pe.Message)
			return
		}
		writeErr(w, 500, "policy_error", err.Error())
		return
	}
	audit.LogHTTP(r, h.Svc.db, "org.upload_policy.updated", "org_upload_config", c.OrgID, nil)
	h.GetOrg(w, r)
}

// DeleteOrg clears every override — equivalent to "use product defaults".
func (h *Handler) DeleteOrg(w http.ResponseWriter, r *http.Request) {
	c, _ := r.Context().Value(auth.UserCtxKey).(*auth.Claims)
	if c == nil {
		writeErr(w, 401, "unauthorized", "auth required")
		return
	}
	if !c.IsAdmin() {
		writeErr(w, 403, "forbidden", "admin role required")
		return
	}
	if err := h.Svc.ResetOrg(r.Context(), c.OrgID); err != nil {
		writeErr(w, 500, "policy_error", err.Error())
		return
	}
	audit.LogHTTP(r, h.Svc.db, "org.upload_policy.reset", "org_upload_config", c.OrgID, nil)
	h.GetOrg(w, r)
}

// ----- helpers -------------------------------------------------------

func normalizeStringSlice(s []string) []string {
	if s == nil {
		return []string{}
	}
	out := make([]string, 0, len(s))
	for _, v := range s {
		v = strings.ToLower(strings.TrimSpace(v))
		if v != "" {
			out = append(out, v)
		}
	}
	return out
}

// normalizeOriginSlice canonicalises stored embed origins on the way in
// (PATCH) and out (GET). Each entry is run through NormalizeEmbedOrigin
// so "Https://Customer.com/" and "https://customer.com" collapse to the
// same value, and duplicates after that collapse are deduped. We do
// NOT call ValidateEmbedOrigin here — invalid entries are caught at the
// Service.UpdateOrg / UpdateProduct boundary so the admin sees a clear
// 400 with the offending value, instead of having it silently dropped.
func normalizeOriginSlice(s []string) []string {
	if s == nil {
		return []string{}
	}
	seen := map[string]bool{}
	out := make([]string, 0, len(s))
	for _, v := range s {
		v = strings.TrimSpace(v)
		if v == "" {
			continue
		}
		n := NormalizeEmbedOrigin(v)
		if n == "" || seen[n] {
			continue
		}
		seen[n] = true
		out = append(out, n)
	}
	return out
}

// normalizeExtSlice trims, lowercases, and ensures every entry starts
// with a dot so "exe" and ".EXE" both store as ".exe".
func normalizeExtSlice(s []string) []string {
	if s == nil {
		return []string{}
	}
	out := make([]string, 0, len(s))
	for _, v := range s {
		v = strings.ToLower(strings.TrimSpace(v))
		if v == "" {
			continue
		}
		if !strings.HasPrefix(v, ".") {
			v = "." + v
		}
		out = append(out, v)
	}
	return out
}

// trimStringPtr returns a *string with the value trimmed, preserving the
// "nil = inherit" semantics of override fields. An explicit empty string
// (""!=nil) is honored — that's how an org expresses "I want this knob
// blank" (e.g. `previewIframeSandbox: ""` for a maximally locked iframe).
func trimStringPtr(p *string) *string {
	if p == nil {
		return nil
	}
	v := strings.TrimSpace(*p)
	return &v
}

func writeJSON(w http.ResponseWriter, status int, body any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(body)
}

func writeErr(w http.ResponseWriter, status int, code, msg string) {
	writeJSON(w, status, map[string]any{"error": map[string]any{"code": code, "message": msg}})
}
