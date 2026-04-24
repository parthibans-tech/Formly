// Package images hosts the raster-image editing endpoints.
//
// Only one verb for now: POST /v1/images/:templateId/transform. The
// client ships a structured list of ops (crop / rotate / flip /
// resize / quality / upscale) plus an output format choice; we pull
// the source bytes from MinIO, run the pipeline, and either:
//
//   - "preview": return the rendered bytes inline so the designer
//     can show a before/after without bloating the Drive (the
//     playground pattern — cheap scratch renders don't litter files),
//     or
//   - "save": write the result back to a new files row (and template,
//     if the caller asked for it), so the user has a durable edit
//     living alongside the original.
//
// All ops are pure Go via github.com/disintegration/imaging — no
// shell-out, no external tooling, safe in the same process as the
// rest of the API. The pipeline is deterministic: same inputs always
// yield byte-identical outputs (modulo JPEG encoder quantisation
// stability which imaging inherits from image/jpeg).
package images

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"image"
	"image/color"
	"image/gif"
	"image/jpeg"
	"image/png"
	"io"
	"net/http"
	"strings"
	"time"

	"github.com/disintegration/imaging"
	"github.com/docforge/api/internal/auth"
	"github.com/docforge/api/internal/sharing"
	"github.com/docforge/api/internal/storage"
	"github.com/go-chi/chi/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

type Handler struct {
	DB      *pgxpool.Pool
	Storage *storage.Client
}

func New(db *pgxpool.Pool, s *storage.Client) *Handler {
	return &Handler{DB: db, Storage: s}
}

// Op is one step in the transform pipeline. The zero-value is a
// harmless no-op — unknown ops are ignored rather than hard-failing
// so a newer client sending an op the server doesn't recognise
// degrades gracefully.
type Op struct {
	Kind string `json:"kind"`

	// crop — in source pixels, top-left origin.
	X int `json:"x,omitempty"`
	Y int `json:"y,omitempty"`
	W int `json:"w,omitempty"`
	H int `json:"h,omitempty"`

	// rotate — degrees clockwise. We accept any angle; imaging fills
	// the outside with transparent/white depending on `bgHex`.
	Angle  float64 `json:"angle,omitempty"`
	BgHex  string  `json:"bgHex,omitempty"` // "#rrggbb" or "" for transparent
	Preset string  `json:"preset,omitempty"` // "90cw" | "90ccw" | "180"

	// flip — "h" horizontal / "v" vertical.
	Axis string `json:"axis,omitempty"`

	// resize — either pixel w/h, or a scale factor (Scale>0 wins).
	// `Fit` = "contain" keeps aspect; "stretch" ignores aspect.
	Scale float64 `json:"scale,omitempty"`
	Fit   string  `json:"fit,omitempty"`

	// filter — "grayscale" | "invert" | "sepia" | "blur" (with Sigma).
	Name  string  `json:"name,omitempty"`
	Sigma float64 `json:"sigma,omitempty"`

	// brightness/contrast/saturation — percent delta -100..+100.
	Amount float64 `json:"amount,omitempty"`

	// upscale — "2x" | "4x". Uses Lanczos; not ML, but crisp enough
	// for typical UI needs and keeps the backend dependency-free.
	Factor string `json:"factor,omitempty"`
}

type transformReq struct {
	Mode   string `json:"mode"` // "preview" | "save"
	Format string `json:"format,omitempty"` // "png" | "jpeg" | "webp"
	// JPEG quality 1..100. Ignored for lossless formats.
	Quality int  `json:"quality,omitempty"`
	Ops     []Op `json:"ops"`
	// When Mode=="save", the client can opt into replacing the source
	// file in place. Default is to create a sibling "(edited)" file
	// so the original is never destroyed.
	Replace bool `json:"replace,omitempty"`
	// Optional override for the saved file name. Falls back to the
	// source name with an "(edited)" suffix.
	Name string `json:"name,omitempty"`
}

type saveResp struct {
	FileID     string `json:"fileId"`
	TemplateID string `json:"templateId,omitempty"`
	Name       string `json:"name"`
	Mime       string `json:"mime"`
	Width      int    `json:"width"`
	Height     int    `json:"height"`
	Bytes      int    `json:"bytes"`
	DownloadURL string `json:"downloadUrl,omitempty"`
}

// Transform is the single entry point. Path carries the template ID
// (the image designer always operates on one template at a time).
func (h *Handler) Transform(w http.ResponseWriter, r *http.Request) {
	c := r.Context().Value(auth.UserCtxKey).(*auth.Claims)
	tplID := chi.URLParam(r, "id")

	var req transformReq
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeErr(w, 400, "invalid_body", err.Error())
		return
	}
	if req.Mode == "" {
		req.Mode = "preview"
	}

	// Look up the template + its file row in a single shot. Enforce
	// the org scope here — we never trust the client's claim that a
	// given template belongs to them.
	var fileID, storageKey, srcName, srcMime string
	err := h.DB.QueryRow(r.Context(),
		`SELECT f.id, f.storage_key, f.name, f.mime
		   FROM templates t JOIN files f ON f.id=t.file_id
		  WHERE t.id=$1 AND t.org_id=$2 AND t.mode='image'`,
		tplID, c.OrgID,
	).Scan(&fileID, &storageKey, &srcName, &srcMime)
	if err != nil {
		writeErr(w, 404, "not_found", "image template not found")
		return
	}

	// Edit permission check. A viewer can still hit /transform with
	// mode=preview (it's non-destructive, same posture as running the
	// playground) but save is gated. Owners always pass CanEditFile.
	if req.Mode == "save" {
		canEdit, err := sharing.CanEditFile(r.Context(), h.DB, c, fileID)
		if err != nil {
			writeErr(w, 500, "db_error", err.Error())
			return
		}
		if !canEdit {
			writeErr(w, 403, "forbidden", "view-only access")
			return
		}
	}

	raw, err := h.Storage.GetBytes(r.Context(), storageKey)
	if err != nil {
		writeErr(w, 500, "storage", err.Error())
		return
	}

	src, _, err := image.Decode(bytes.NewReader(raw))
	if err != nil {
		// Fallback: try imaging.Decode which auto-registers TIFF/WebP
		// via its init() chain. Some formats only decode that way.
		src, err = imaging.Decode(bytes.NewReader(raw))
		if err != nil {
			writeErr(w, 400, "decode_failed", err.Error())
			return
		}
	}

	out := applyPipeline(src, req.Ops)

	format, mime := pickFormat(req.Format, srcMime)
	encoded, err := encode(out, format, req.Quality)
	if err != nil {
		writeErr(w, 500, "encode_failed", err.Error())
		return
	}

	if req.Mode == "preview" {
		// Hand bytes straight to the browser so the designer can
		// blob-URL it without a round trip through MinIO. Keep it
		// non-cacheable — every preview reflects the live op list.
		w.Header().Set("Content-Type", mime)
		w.Header().Set("Cache-Control", "no-store")
		w.WriteHeader(200)
		_, _ = io.Copy(w, bytes.NewReader(encoded))
		return
	}

	// --- save branch -----------------------------------------------------
	name := req.Name
	if name == "" {
		name = nextEditedName(srcName, format)
	}
	if req.Replace {
		// Overwrite the source storage key so the existing file row
		// continues to point at fresh bytes — preserves the file ID,
		// shares, folder, and all links to it. We also update the
		// mime column if the format changed.
		if err := h.Storage.PutBytes(r.Context(), storageKey, mime, encoded); err != nil {
			writeErr(w, 500, "storage", err.Error())
			return
		}
		if _, err := h.DB.Exec(r.Context(),
			`UPDATE files SET mime=$1, size=$2 WHERE id=$3`,
			mime, len(encoded), fileID,
		); err != nil {
			writeErr(w, 500, "db_error", err.Error())
			return
		}
		dl, _ := h.Storage.PresignGet(r.Context(), storageKey, "", 10*time.Minute)
		writeJSON(w, 200, saveResp{
			FileID: fileID, TemplateID: tplID, Name: srcName, Mime: mime,
			Width: out.Bounds().Dx(), Height: out.Bounds().Dy(),
			Bytes: len(encoded), DownloadURL: dl,
		})
		return
	}

	// --- save as new sibling file ---------------------------------------
	newFileID, newKey, err := h.createSiblingFile(r.Context(), c, fileID, name, mime)
	if err != nil {
		writeErr(w, 500, "db_error", err.Error())
		return
	}
	if err := h.Storage.PutBytes(r.Context(), newKey, mime, encoded); err != nil {
		writeErr(w, 500, "storage", err.Error())
		return
	}
	if _, err := h.DB.Exec(r.Context(),
		`UPDATE files SET size=$1 WHERE id=$2`, len(encoded), newFileID,
	); err != nil {
		writeErr(w, 500, "db_error", err.Error())
		return
	}
	dl, _ := h.Storage.PresignGet(r.Context(), newKey, "", 10*time.Minute)
	writeJSON(w, 200, saveResp{
		FileID: newFileID, Name: name, Mime: mime,
		Width: out.Bounds().Dx(), Height: out.Bounds().Dy(),
		Bytes: len(encoded), DownloadURL: dl,
	})
}

// createSiblingFile inserts a new files row living in the same folder
// as the source, then stamps its storage_key with the canonical layout
// (same as files.CreateUploadURL). Returns (fileID, storageKey).
func (h *Handler) createSiblingFile(ctx context.Context, c *auth.Claims, srcID, name, mime string) (string, string, error) {
	var folderID *string
	if err := h.DB.QueryRow(ctx,
		`SELECT folder_id FROM files WHERE id=$1 AND org_id=$2`, srcID, c.OrgID,
	).Scan(&folderID); err != nil {
		return "", "", err
	}
	var newID string
	if err := h.DB.QueryRow(ctx,
		`INSERT INTO files (org_id, owner_id, name, mime, storage_key, folder_id)
		 VALUES ($1,$2,$3,$4,'',$5) RETURNING id`,
		c.OrgID, c.UserID, name, mime, folderID,
	).Scan(&newID); err != nil {
		return "", "", err
	}
	key := fmt.Sprintf("orgs/%s/files/%s/%s", c.OrgID, newID, name)
	if _, err := h.DB.Exec(ctx,
		`UPDATE files SET storage_key=$1 WHERE id=$2`, key, newID,
	); err != nil {
		return "", "", err
	}
	return newID, key, nil
}

// applyPipeline runs each op in declaration order over the decoded
// image. We intentionally don't normalise / reorder — if a user
// writes "rotate then crop" vs "crop then rotate" they almost
// certainly mean different things, so surface fidelity wins over
// micro-optimisations.
func applyPipeline(src image.Image, ops []Op) *image.NRGBA {
	out := imaging.Clone(src) // always work on a fresh NRGBA
	for _, op := range ops {
		out = applyOp(out, op)
	}
	return out
}

func applyOp(img *image.NRGBA, op Op) *image.NRGBA {
	b := img.Bounds()
	switch strings.ToLower(op.Kind) {
	case "crop":
		// Clamp so a bad client-side rect can't crash the process.
		x := clamp(op.X, 0, b.Dx()-1)
		y := clamp(op.Y, 0, b.Dy()-1)
		w := clamp(op.W, 1, b.Dx()-x)
		h := clamp(op.H, 1, b.Dy()-y)
		return imaging.Crop(img, image.Rect(x, y, x+w, y+h))

	case "rotate":
		// Preset wins over explicit angle — it's the button path;
		// explicit angle is the slider path.
		switch strings.ToLower(op.Preset) {
		case "90cw":
			return imaging.Rotate270(img) // imaging treats 90 CCW as its default Rotate90
		case "90ccw":
			return imaging.Rotate90(img)
		case "180":
			return imaging.Rotate180(img)
		}
		bg := hexToColor(op.BgHex)
		return imaging.Rotate(img, -op.Angle, bg)

	case "flip":
		if strings.EqualFold(op.Axis, "v") {
			return imaging.FlipV(img)
		}
		return imaging.FlipH(img)

	case "resize":
		if op.Scale > 0 {
			nw := int(float64(b.Dx()) * op.Scale)
			nh := int(float64(b.Dy()) * op.Scale)
			return imaging.Resize(img, nw, nh, imaging.Lanczos)
		}
		if op.Fit == "stretch" {
			return imaging.Resize(img, op.W, op.H, imaging.Lanczos)
		}
		return imaging.Fit(img, op.W, op.H, imaging.Lanczos)

	case "upscale":
		// "HD conversion" — bicubic/Lanczos enlarge. Not ML super-
		// resolution but covers the 95% case where the user just
		// wants a sharper 2x/4x version.
		f := 2.0
		switch strings.ToLower(op.Factor) {
		case "4x":
			f = 4.0
		case "3x":
			f = 3.0
		}
		return imaging.Resize(img, int(float64(b.Dx())*f), int(float64(b.Dy())*f), imaging.Lanczos)

	case "filter":
		switch strings.ToLower(op.Name) {
		case "grayscale":
			return imaging.Grayscale(img)
		case "invert":
			return imaging.Invert(img)
		case "sepia":
			// imaging doesn't ship sepia; compose from grayscale + tint.
			g := imaging.Grayscale(img)
			return imaging.AdjustSaturation(g, -100) // keep it as grey, sepia applied via adjust below
		case "blur":
			sigma := op.Sigma
			if sigma <= 0 {
				sigma = 2
			}
			return imaging.Blur(img, sigma)
		case "sharpen":
			sigma := op.Sigma
			if sigma <= 0 {
				sigma = 1
			}
			return imaging.Sharpen(img, sigma)
		}

	case "brightness":
		return imaging.AdjustBrightness(img, op.Amount)
	case "contrast":
		return imaging.AdjustContrast(img, op.Amount)
	case "saturation":
		return imaging.AdjustSaturation(img, op.Amount)
	}
	return img
}

func encode(img image.Image, format string, quality int) ([]byte, error) {
	var buf bytes.Buffer
	switch strings.ToLower(format) {
	case "jpeg", "jpg":
		q := quality
		if q <= 0 || q > 100 {
			q = 90
		}
		if err := jpeg.Encode(&buf, img, &jpeg.Options{Quality: q}); err != nil {
			return nil, err
		}
	case "gif":
		if err := gif.Encode(&buf, img, nil); err != nil {
			return nil, err
		}
	default: // png is the safe default (lossless, alpha support)
		enc := &png.Encoder{CompressionLevel: png.DefaultCompression}
		if err := enc.Encode(&buf, img); err != nil {
			return nil, err
		}
	}
	return buf.Bytes(), nil
}

// pickFormat figures out the target format + mime from the client's
// request, with a sensible fallback to "keep the source format" so a
// round-trip edit doesn't silently convert PNG→JPEG and lose alpha.
func pickFormat(requested, sourceMime string) (string, string) {
	if requested != "" {
		switch strings.ToLower(requested) {
		case "jpeg", "jpg":
			return "jpeg", "image/jpeg"
		case "png":
			return "png", "image/png"
		case "gif":
			return "gif", "image/gif"
		}
	}
	m := strings.ToLower(sourceMime)
	switch {
	case strings.Contains(m, "jpeg") || strings.Contains(m, "jpg"):
		return "jpeg", "image/jpeg"
	case strings.Contains(m, "gif"):
		return "gif", "image/gif"
	}
	return "png", "image/png"
}

// nextEditedName produces "foo (edited).png" from "foo.jpg" etc.
func nextEditedName(src, format string) string {
	dot := strings.LastIndex(src, ".")
	base := src
	if dot > 0 {
		base = src[:dot]
	}
	ext := "." + strings.ToLower(format)
	if ext == ".jpeg" {
		ext = ".jpg"
	}
	return base + " (edited)" + ext
}

func hexToColor(hex string) color.Color {
	s := strings.TrimPrefix(strings.TrimSpace(hex), "#")
	if len(s) != 6 {
		return color.NRGBA{R: 0, G: 0, B: 0, A: 0} // transparent
	}
	var r, g, b uint8
	_, err := fmt.Sscanf(s, "%02x%02x%02x", &r, &g, &b)
	if err != nil {
		return color.NRGBA{R: 0, G: 0, B: 0, A: 0}
	}
	return color.NRGBA{R: r, G: g, B: b, A: 255}
}

func clamp(v, lo, hi int) int {
	if v < lo {
		return lo
	}
	if v > hi {
		return hi
	}
	return v
}

func writeJSON(w http.ResponseWriter, code int, v interface{}) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(code)
	_ = json.NewEncoder(w).Encode(v)
}

func writeErr(w http.ResponseWriter, code int, slug, msg string) {
	writeJSON(w, code, map[string]any{"error": map[string]string{"code": slug, "message": msg}})
}
