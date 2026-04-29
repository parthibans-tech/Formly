// export.go — the two render-bound handlers (/export and
// /save-to-drive). Both share an internal `renderStarter` helper that
// runs the chromium HTML→PDF pipeline against the inline starter HTML
// the frontend POSTs.
//
// # Why we don't go through generate.Runner
//
// generate.Runner.render() loads template HTML from a `templates` row
// in Postgres. Starter mode never persists those rows — the HTML lives
// in web/lib/starters/*.ts and is shipped to the browser at page-load
// time. Going through Runner would require either a DB write per click
// (wasteful) or a synthetic templates row (leaky abstraction). Instead
// we call ghtml.RenderWithLocale directly with the inline HTML; the
// chromium half (RenderHTML) is identical to the path generate.Runner
// uses, so the output PDF matches what the document-mode editor produces.
//
// # Customise overlay
//
// The `customize` block is merged into `data` under a reserved
// `__theme` key before substitution. Starters that opt in can read
// {{ .__theme.primary }} etc.; starters that don't simply ignore it.
// Keeping this contract optional means none of the existing 60+
// starters need to change to ship the Customize tab.

package starterai

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"strings"
	"time"

	"github.com/docforge/api/internal/auth"
	ghtml "github.com/docforge/api/internal/generate/html"
	"github.com/docforge/api/internal/i18n"
	"github.com/docforge/api/internal/layout"
	"github.com/docforge/api/internal/uploadpolicy"
	"github.com/go-chi/chi/v5"
)

/* ------------------------------ DTOs ------------------------------ */

// ExportRequest is the wire shape for POST /v1/starters/{id}/export.
// {id} in the URL is the starter id (e.g. "resume-tech") — purely
// informational on the server side; the actual HTML is in `html`.
type ExportRequest struct {
	HTML      string         `json:"html"`
	Data      map[string]any `json:"data"`
	Customize map[string]any `json:"customize,omitempty"`
	Format    string         `json:"format,omitempty"`   // pdf | html (default pdf)
	Filename  string         `json:"filename,omitempty"` // suggested download name
	Layout    *LayoutHints   `json:"layout,omitempty"`   // optional page-size override
}

// LayoutHints lets the frontend pin paper size / orientation /
// margins. All fields optional — zero values fall through to the
// renderer's defaults, which match the @page CSS in each starter.
type LayoutHints struct {
	PageSize    string  `json:"pageSize,omitempty"`    // Letter | A4 | Legal | A3 | A5
	Orientation string  `json:"orientation,omitempty"` // portrait | landscape
	MarginIn    float64 `json:"marginIn,omitempty"`    // uniform margin in inches
}

// ExportResponse — presigned URL the browser uses to download the
// rendered PDF/HTML. expiresAt is informational; the URL itself is
// signed for the same window.
type ExportResponse struct {
	URL       string    `json:"url"`
	ExpiresAt time.Time `json:"expiresAt"`
	Size      int       `json:"size"`
	Filename  string    `json:"filename"`
	Format    string    `json:"format"`
}

// SaveToDriveRequest extends ExportRequest with the Drive-side fields.
type SaveToDriveRequest struct {
	HTML      string         `json:"html"`
	Data      map[string]any `json:"data"`
	Customize map[string]any `json:"customize,omitempty"`
	Format    string         `json:"format,omitempty"`
	Filename  string         `json:"filename,omitempty"`
	FolderID  string         `json:"folderId,omitempty"`
	Layout    *LayoutHints   `json:"layout,omitempty"`
}

// SaveToDriveResponse — the new Drive file's id + a deep-link the UI
// can router.push to.
type SaveToDriveResponse struct {
	FileID   string `json:"fileId"`
	Filename string `json:"filename"`
	URL      string `json:"url"` // /drive/d/{fileId}
	Size     int    `json:"size"`
}

/* ---------------------------- Handlers ---------------------------- */

// ExportHTTP serves POST /v1/starters/{id}/export.
//
// Renders the supplied HTML+data, uploads the bytes to a per-(user,
// starter) preview key, and returns an inline-presigned URL the
// browser can download from. Inline disposition is fine because the
// content is server-generated PDF; the browser still saves to disk
// when the user clicks "Save as".
func (h *Handler) ExportHTTP(w http.ResponseWriter, r *http.Request) {
	c, _ := r.Context().Value(auth.UserCtxKey).(*auth.Claims)
	if c == nil {
		writeErr(w, r, http.StatusUnauthorized, "unauthorized", "missing auth claims")
		return
	}
	starterID := chi.URLParam(r, "id")
	if starterID == "" {
		writeErr(w, r, http.StatusBadRequest, "invalid_payload", "missing starter id in path")
		return
	}

	var req ExportRequest
	// Cap the inbound body at HTML cap + data cap with some slack for
	// JSON overhead and the customize/layout blocks.
	if err := decodeJSON(w, r, &req, MaxStarterHTMLBytes+MaxFormDataBytes+16*1024); err != nil {
		writeErr(w, r, http.StatusBadRequest, "invalid_payload", err.Error())
		return
	}
	if err := validateRenderRequest(req.HTML, req.Data); err != nil {
		writeErr(w, r, http.StatusBadRequest, "invalid_payload", err.Error())
		return
	}
	format := strings.ToLower(strings.TrimSpace(req.Format))
	if format == "" {
		format = "pdf"
	}
	if format != "pdf" && format != "html" {
		writeErr(w, r, http.StatusBadRequest, "invalid_payload",
			"`format` must be pdf or html")
		return
	}

	ctx, cancel := context.WithTimeout(r.Context(), h.RenderTimeout)
	defer cancel()

	bytes, mime, err := h.renderStarter(ctx, req.HTML, req.Data, req.Customize, req.Layout, format)
	if err != nil {
		writeErr(w, r, http.StatusBadGateway, "render_failed", err.Error())
		return
	}

	filename := safeFilename(req.Filename)
	if !strings.Contains(filename, ".") {
		filename += extForFormat(format)
	}

	// Per-(user, starter) preview-style key — overwrites on every
	// click rather than piling up objects in MinIO. Same rationale as
	// generate.Runner.RunPreview.
	key := fmt.Sprintf("orgs/%s/starter-exports/%s/%s%s",
		c.OrgID, c.UserID, uploadpolicy.SafeStorageSlug(starterID), extForFormat(format))
	if err := h.Storage.PutBytes(ctx, key, mime, bytes); err != nil {
		writeErr(w, r, http.StatusInternalServerError, "storage_failed", err.Error())
		return
	}

	// PDFs render inline (server-generated, safe). HTML must download
	// — never inline-serve attacker-influenced HTML even when the
	// caller is authenticated.
	const ttl = 10 * time.Minute
	var url string
	if format == "pdf" {
		url, err = h.Storage.PresignGetInline(ctx, key, mime, ttl)
	} else {
		url, err = h.Storage.PresignGet(ctx, key, mime, filename, ttl)
	}
	if err != nil {
		writeErr(w, r, http.StatusInternalServerError, "presign_failed", err.Error())
		return
	}

	if h.Log != nil {
		h.Log.Info("starterai.export",
			"org_id", c.OrgID, "user_id", c.UserID,
			"starter_id", starterID, "format", format, "bytes", len(bytes))
	}
	writeJSON(w, http.StatusOK, ExportResponse{
		URL:       url,
		ExpiresAt: time.Now().Add(ttl),
		Size:      len(bytes),
		Filename:  filename,
		Format:    format,
	})
}

// SaveToDriveHTTP serves POST /v1/starters/{id}/save-to-drive.
//
// Same render as Export, but persists the bytes as a real File row so
// it appears in the user's Drive list, gets indexed, etc. Reuses the
// canonical files key path so any tooling that operates on
// orgs/{org}/files/{id}/... continues to work uniformly.
func (h *Handler) SaveToDriveHTTP(w http.ResponseWriter, r *http.Request) {
	c, _ := r.Context().Value(auth.UserCtxKey).(*auth.Claims)
	if c == nil {
		writeErr(w, r, http.StatusUnauthorized, "unauthorized", "missing auth claims")
		return
	}
	starterID := chi.URLParam(r, "id")
	if starterID == "" {
		writeErr(w, r, http.StatusBadRequest, "invalid_payload", "missing starter id in path")
		return
	}

	var req SaveToDriveRequest
	if err := decodeJSON(w, r, &req, MaxStarterHTMLBytes+MaxFormDataBytes+16*1024); err != nil {
		writeErr(w, r, http.StatusBadRequest, "invalid_payload", err.Error())
		return
	}
	if err := validateRenderRequest(req.HTML, req.Data); err != nil {
		writeErr(w, r, http.StatusBadRequest, "invalid_payload", err.Error())
		return
	}
	format := strings.ToLower(strings.TrimSpace(req.Format))
	if format == "" {
		format = "pdf"
	}
	if format != "pdf" && format != "html" {
		writeErr(w, r, http.StatusBadRequest, "invalid_payload",
			"`format` must be pdf or html")
		return
	}

	ctx, cancel := context.WithTimeout(r.Context(), h.RenderTimeout)
	defer cancel()

	bytes, mime, err := h.renderStarter(ctx, req.HTML, req.Data, req.Customize, req.Layout, format)
	if err != nil {
		writeErr(w, r, http.StatusBadGateway, "render_failed", err.Error())
		return
	}

	filename := safeFilename(req.Filename)
	if !strings.Contains(filename, ".") {
		filename += extForFormat(format)
	}

	// Folder fk: nil for "root" folder. We don't validate ownership
	// here — the FK + org_id scope on `folders` does that on insert.
	var folderArg any
	if id := strings.TrimSpace(req.FolderID); id != "" {
		folderArg = id
	}

	var fileID string
	if err := h.DB.QueryRow(ctx,
		`INSERT INTO files (org_id, owner_id, name, mime, size, storage_key, folder_id, status)
		 VALUES ($1,$2,$3,$4,$5,'',$6,'active') RETURNING id`,
		c.OrgID, c.UserID, filename, mime, len(bytes), folderArg,
	).Scan(&fileID); err != nil {
		writeErr(w, r, http.StatusInternalServerError, "db_error", err.Error())
		return
	}

	key := fmt.Sprintf("orgs/%s/files/%s/%s",
		c.OrgID, fileID, uploadpolicy.SafeStorageSlug(filename))
	if _, err := h.DB.Exec(ctx,
		`UPDATE files SET storage_key=$1 WHERE id=$2`, key, fileID); err != nil {
		writeErr(w, r, http.StatusInternalServerError, "db_error", err.Error())
		return
	}
	if err := h.Storage.PutBytes(ctx, key, mime, bytes); err != nil {
		writeErr(w, r, http.StatusInternalServerError, "storage_failed", err.Error())
		return
	}

	if h.Log != nil {
		h.Log.Info("starterai.save_to_drive",
			"org_id", c.OrgID, "user_id", c.UserID,
			"starter_id", starterID, "file_id", fileID,
			"format", format, "bytes", len(bytes))
	}
	writeJSON(w, http.StatusOK, SaveToDriveResponse{
		FileID:   fileID,
		Filename: filename,
		URL:      "/drive/d/" + fileID,
		Size:     len(bytes),
	})
}

/* ---------------------------- Render core ---------------------------- */

// renderStarter is the shared core for /export and /save-to-drive.
// Returns the rendered bytes plus the MIME so the caller can route
// them to either inline-presign or files-table persistence without
// duplicating the format dispatch.
func (h *Handler) renderStarter(
	ctx context.Context,
	html string,
	data map[string]any,
	customize map[string]any,
	hints *LayoutHints,
	format string,
) ([]byte, string, error) {
	// Merge customize into data under a reserved key. Existing
	// starters ignore it; new ones can opt in with {{ .__theme.X }}.
	if data == nil {
		data = map[string]any{}
	}
	if len(customize) > 0 {
		data["__theme"] = customize
	}

	switch format {
	case "html":
		// Substitute only — no chromium round-trip. Useful when the
		// user wants the source HTML for further editing.
		out, err := ghtml.SubstituteWithLocale(html, data, "", i18n.Config{})
		if err != nil {
			return nil, "", fmt.Errorf("substitute: %w", err)
		}
		return []byte(out), "text/html; charset=utf-8", nil
	case "pdf":
		l := layoutFromHints(hints)
		out, err := ghtml.RenderWithLocale(ctx, html, data, l, "", i18n.Config{})
		if err != nil {
			return nil, "", fmt.Errorf("render: %w", err)
		}
		return out, "application/pdf", nil
	}
	return nil, "", fmt.Errorf("unsupported format %q", format)
}

// layoutFromHints builds a layout.Layout from the optional
// LayoutHints block. Returning nil is a valid signal to ghtml — it
// uses Letter portrait with default margins. We only allocate when the
// caller actually overrode something so the common path stays
// allocation-free.
func layoutFromHints(h *LayoutHints) *layout.Layout {
	if h == nil {
		return nil
	}
	if h.PageSize == "" && h.Orientation == "" && h.MarginIn == 0 {
		return nil
	}
	out := &layout.Layout{
		PageSize:    h.PageSize,
		Orientation: h.Orientation,
	}
	if h.MarginIn > 0 {
		out.Margins = layout.Margins{
			Top: h.MarginIn, Right: h.MarginIn,
			Bottom: h.MarginIn, Left: h.MarginIn,
		}
	}
	return out
}

/* ----------------------------- Validation ---------------------------- */

// validateRenderRequest enforces the shape every render endpoint
// requires. We deliberately keep these checks loose: the worst that
// happens with unusual HTML is a render error, which is already mapped
// to 502 render_failed — we don't want to reject every starter that
// uses, say, a CSS gradient in a way our naive parser doesn't expect.
func validateRenderRequest(html string, data map[string]any) error {
	if strings.TrimSpace(html) == "" {
		return fmt.Errorf("`html` must be non-empty")
	}
	if len(html) > MaxStarterHTMLBytes {
		return fmt.Errorf("`html` exceeds %d bytes", MaxStarterHTMLBytes)
	}
	if data == nil {
		// Empty data is fine — a starter with no template fields is
		// legitimate. Make sure the marshal step downstream sees a
		// non-nil map.
		return nil
	}
	// Round-trip the data through the JSON encoder once so we fail
	// fast here on cycles / unsupported types instead of mid-render.
	if _, err := json.Marshal(data); err != nil {
		return fmt.Errorf("`data` is not JSON-serialisable: %w", err)
	}
	return nil
}

func extForFormat(format string) string {
	switch format {
	case "html":
		return ".html"
	case "pdf":
		return ".pdf"
	}
	return ""
}
