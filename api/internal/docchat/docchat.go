// Package docchat is the HTTP surface and orchestration for the
// "Summarize / Ask in document preview" AI feature. It owns:
//
//	POST /v1/files/{id}/extract-text → { text, mime, truncated }    (no LLM)
//	POST /v1/files/{id}/summarize    → { summary, keyPoints, suggestedQuestions }
//	POST /v1/files/{id}/ask          → { answer }   body: { question }
//
// /extract-text is the cheap path: ACL + AV gate + blob fetch + OCR/
// extraction, then return the raw text. Useful as a first-class action
// when the user just wants to see what's printed on a PAN/Aadhaar/
// receipt image — the full /summarize round-trip can take 90+ seconds
// on a memory-constrained box because ollama has to fault the chat
// model into RAM. /extract-text bypasses that entirely.
//
// # Why a separate package
//
// Same reasoning as aisearch: AI features have a hard dependency on
// ai.Client + embeddings text extraction, and we don't want every
// non-AI endpoint to drag those imports through review when AI is the
// thing being changed. Keeping each feature in its own package also
// means a 503 path that's easy to reason about — when AI is off, only
// these two routes return ai_disabled.
//
// # Off-by-default contract
//
// Both endpoints return 503 ai_disabled when the AI client is the
// Disabled provider OR the configured provider lacks Chat capability.
// The frontend gates UI on /v1/ai/config so users on a disabled
// deployment never see the buttons; the 503 path is defense in depth
// for stale page loads + direct API hits.
//
// # ACL model
//
// We re-use sharing.CanAccessFile — the same gate Download/InlinePreview
// use. A user who can't see a file via /v1/files can't summarize or ask
// about it either. AV scan-status is also re-checked: feeding an
// infected blob into the LLM would still leak its content into our
// chat-completion logs even if we never serve the bytes back.
//
// # Bound on cost
//
// Every prompt is clipped to MaxPromptChars before it leaves this
// process so a 50MB DOCX doesn't burn a whole context window on a
// single request. The cap is intentionally generous (~16KB ≈ 4K
// tokens) so a typical 5-page contract fits whole; bigger files get a
// "summary based on the first ~16KB" footer in the response so the UI
// can label results honestly.
package docchat

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"os"
	"strconv"
	"strings"
	"time"

	"github.com/docforge/api/internal/ai"
	"github.com/docforge/api/internal/auth"
	"github.com/docforge/api/internal/embeddings"
	"github.com/docforge/api/internal/ocr"
	"github.com/docforge/api/internal/ocrprofiles"
	"github.com/docforge/api/internal/scanner"
	"github.com/docforge/api/internal/sharing"
	"github.com/docforge/api/internal/storage"
	"github.com/go-chi/chi/v5"
	"github.com/go-chi/chi/v5/middleware"
	"github.com/jackc/pgx/v5/pgxpool"
)

// Tunables. Kept conservative — chat completion is the dominant cost
// and a single careless request shouldn't be able to spike the bill.
const (
	// MaxPromptChars caps the document excerpt we send to the model.
	// 16K characters ≈ 4K tokens on most BPE tokenizers — a 5-page
	// contract or 8-page report fits whole; longer files are flagged
	// truncated in the response so the UI can disclose it.
	MaxPromptChars = 16_000
	// MaxQuestionLen caps the user question. Defends against a 1MB
	// POST that pins a worker on tokenization; real questions are
	// short.
	MaxQuestionLen = 2_000
	// MaxAnswerTokens caps the model's reply. Prevents a chatty
	// provider from streaming a novel back when the user asked a
	// one-line question.
	MaxAnswerTokens = 600
	// MaxSummaryTokens — slightly higher than answers because a
	// summary inherently produces more output than a typical Q&A.
	MaxSummaryTokens = 700
	// DefaultPromptTimeout — per-call deadline used when the operator
	// hasn't set DOCCHAT_TIMEOUT_SEC. 180s is generous on purpose: a
	// cold-load of llama3.1:8b on a CPU-only laptop can spend 60–120s
	// just memory-mapping the model into RAM before the first token
	// streams. Hot calls return in seconds; the long tail is cold start.
	// The previous 90s value 502'd most first-of-the-day requests on
	// memory-pressured dev boxes — the symptom is the user reporting
	// `context deadline exceeded` on /summarize even when the same call
	// 30 seconds later succeeds.
	//
	// The actual value used at runtime lives on Handler.PromptTimeout
	// (so tests can override and ops can tune via env). This constant
	// is the fallback when New() doesn't read an override.
	DefaultPromptTimeout = 180 * time.Second
)

// PromptTimeout is preserved for backwards compatibility with any
// external caller that imported the constant. New code should read
// Handler.PromptTimeout (the env-tuned per-instance value) instead.
const PromptTimeout = DefaultPromptTimeout

// ErrAIDisabled is returned by Summarize / Ask when the AI client is
// the Disabled provider or the active provider can't chat. The
// handler maps it to 503.
var ErrAIDisabled = errors.New("docchat: AI is disabled")

// ErrNotTextual is returned when a file's MIME isn't supported by the
// configured Extractor (currently text/*, application/pdf, and DOCX —
// legacy .doc, images, spreadsheets, etc. fall through to this). Also
// returned for PDFs whose content is image-only (scanned, no embedded
// text layer). The handler maps it to 415 so the UI can render a
// clearer "preview-only" message than a generic 500.
var ErrNotTextual = errors.New("docchat: file content is not text-extractable")

// Handler holds the dependencies needed to extract a file's text and
// run a chat completion against it. Constructed once in main.go and
// shared across requests.
type Handler struct {
	DB      *pgxpool.Pool
	Storage *storage.Client
	AI      ai.Client
	Log     *slog.Logger

	// Extract reuses the embeddings package's seam. Defaults to
	// PlainTextExtractor when nil. Same swap-in story as autotag /
	// embeddings: a richer PDF/DOCX extractor plugs in here once it
	// exists.
	Extract embeddings.Extractor

	// OCR is the base OCR config, retained on the handler so the
	// profile-aware /extract-text path can clone it and apply
	// per-profile overrides (PSM, language, preprocess) without
	// going through the general Extract chain. Zero value =
	// disabled; the profile-aware path falls back to the chained
	// Extract in that case.
	OCR ocr.Config

	// Profiles is the OCR profile registry. Nil = use the default
	// built-in registry. Exposed so tests can inject a stub.
	Profiles ocrprofiles.Registry

	// PromptTimeout is the per-call deadline used by Summarize / Ask /
	// ExtractText for the LLM portion of the work. Defaults to
	// DefaultPromptTimeout (180s); operators can lower for hosted
	// providers (Anthropic responds in <30s) or raise on truly slow
	// boxes via DOCCHAT_TIMEOUT_SEC. Mount() also installs a chi
	// middleware.Timeout slightly larger than this so the inner
	// context cancellation fires first with a clean 502/503 instead
	// of chi cutting the response mid-stream.
	PromptTimeout time.Duration
}

// New builds a Handler with sane defaults.
//
// We default to embeddings.DispatchExtractor (not PlainTextExtractor)
// because the document preview surface is overwhelmingly PDFs — the
// PlainText-only fallback would 415 on every "Summarize" click in
// FilePreviewDialog. The dispatcher routes PDF→PDFTextExtractor and
// text/*→PlainTextExtractor, with empty string on every other MIME so
// the 415 mapping in writeFileErr still lights up correctly.
//
// To enable OCR (scanned PDFs + image uploads), chain WithOCR after
// New — see main.go for the env-driven wiring.
func New(db *pgxpool.Pool, store *storage.Client, c ai.Client, log *slog.Logger) *Handler {
	return &Handler{
		DB:            db,
		Storage:       store,
		AI:            c,
		Log:           log,
		Extract:       embeddings.DispatchExtractor,
		PromptTimeout: parsePromptTimeout(),
	}
}

// parsePromptTimeout reads DOCCHAT_TIMEOUT_SEC and returns a Duration.
// Falls back to DefaultPromptTimeout (180s) on missing / unparseable /
// non-positive values — we'd rather use the safe default than mis-parse
// a typo into "0s = no timeout" and hang every request.
func parsePromptTimeout() time.Duration {
	raw := strings.TrimSpace(os.Getenv("DOCCHAT_TIMEOUT_SEC"))
	if raw == "" {
		return DefaultPromptTimeout
	}
	n, err := strconv.Atoi(raw)
	if err != nil || n <= 0 {
		return DefaultPromptTimeout
	}
	return time.Duration(n) * time.Second
}

// WithOCR plugs an OCR engine into the extraction chain. When the
// primary extractor returns no text for an OCR-eligible MIME
// (scanned PDFs without a text layer, image uploads), the chained
// extractor falls through to ocr.Config and returns the recognised
// text instead of "".
//
// Calling with a disabled Config is a no-op — the operator can flip
// OCR_ENABLED at deploy time without restructuring main.go.
//
// Returns the same Handler so callers can chain at construction:
//
//	dcH := docchat.New(...).WithOCR(ocr.FromEnv())
func (h *Handler) WithOCR(oc ocr.Config) *Handler {
	if !oc.Enabled {
		return h
	}
	primary := h.Extract
	if primary == nil {
		primary = embeddings.DispatchExtractor
	}
	h.Extract = chainOCR(primary, oc, h.Log)
	h.OCR = oc
	return h
}

// profiles resolves the registry, defaulting to the static built-in set
// when no DB-backed registry was injected. In production main.go wires
// a DBRegistry; the static fallback here keeps tests and offline dev
// boxes working without a DB seed.
func (h *Handler) profiles() ocrprofiles.Registry {
	if h.Profiles != nil {
		return h.Profiles
	}
	return ocrprofiles.StaticDefault()
}

// chainOCR wraps a primary extractor with an OCR fallback. The
// fallback only fires when:
//
//  1. The primary returned no error AND empty text (so we don't
//     re-OCR a PDF that has a perfectly good text layer, and we
//     don't paper over a real extract error).
//  2. The MIME is OCR-eligible — currently PDFs and the common
//     image formats tesseract can read.
//
// Any other case passes the primary's result through unchanged. We
// intentionally never propagate ocr.ErrDisabled out — that would
// turn a successful "no text" into a hard error for callers who
// asked the dispatcher about a non-image MIME.
func chainOCR(primary embeddings.Extractor, oc ocr.Config, log *slog.Logger) embeddings.Extractor {
	return func(ctx context.Context, mime string, body []byte) (string, error) {
		text, err := primary(ctx, mime, body)
		if err != nil {
			return "", err
		}
		if strings.TrimSpace(text) != "" {
			return text, nil
		}
		switch {
		case isOCRablePDF(mime):
			if log != nil {
				log.Info("docchat.ocr_fallback", "kind", "pdf", "bytes", len(body))
			}
			return oc.PDFToText(ctx, body)
		case isOCRableImage(mime):
			if log != nil {
				log.Info("docchat.ocr_fallback", "kind", "image", "bytes", len(body))
			}
			return oc.ImageToText(ctx, body)
		}
		return text, nil
	}
}

// isOCRablePDF mirrors embeddings.looksPDF. We duplicate the small
// switch rather than export a private helper so embeddings stays free
// of any "OCR consumer" coupling.
func isOCRablePDF(mime string) bool {
	switch strings.ToLower(strings.TrimSpace(mime)) {
	case "application/pdf", "application/x-pdf",
		"application/acrobat", "applications/vnd.pdf",
		"text/pdf", "text/x-pdf":
		return true
	}
	return false
}

// isOCRableImage matches the formats tesseract reads natively. We
// don't try TIFF multi-page or HEIC — those would need an extra
// rasterization step (or a libheif build dep).
func isOCRableImage(mime string) bool {
	switch strings.ToLower(strings.TrimSpace(mime)) {
	case "image/png", "image/jpeg", "image/jpg",
		"image/webp", "image/bmp", "image/tiff":
		return true
	}
	return false
}

// Mount wires the routes under the parent (already-authenticated)
// router. Each AI route gets a per-route middleware.Timeout that
// overrides the global 90-second budget, because Ollama / vLLM
// cold-loads alone can blow past 90s on a CPU-only box. The route
// budget is `PromptTimeout + 15s` so the inner context.WithTimeout
// inside each handler fires first with a clean error envelope rather
// than chi cutting the response mid-stream.
func (h *Handler) Mount(r chi.Router) {
	budget := h.PromptTimeout + 15*time.Second
	if budget < 30*time.Second {
		// Defensive: an operator setting DOCCHAT_TIMEOUT_SEC=5 would
		// produce a 20s route budget which is fine, but a zero/negative
		// value (already filtered in parsePromptTimeout) shouldn't
		// reach here. Floor at 30s just in case.
		budget = 30 * time.Second
	}
	timeout := middleware.Timeout(budget)
	r.With(timeout).Post("/v1/files/{id}/extract-text", h.ExtractTextHTTP)
	r.With(timeout).Post("/v1/files/{id}/summarize", h.SummarizeHTTP)
	r.With(timeout).Post("/v1/files/{id}/ask", h.AskHTTP)
}

/* -------------------------- DTOs ------------------------------ */

// SummaryResponse is the JSON shape returned by /summarize. KeyPoints
// is optional; some short documents don't have meaningful bullets and
// returning [] is preferable to inventing them.
type SummaryResponse struct {
	Summary             string   `json:"summary"`
	KeyPoints           []string `json:"keyPoints"`
	SuggestedQuestions  []string `json:"suggestedQuestions"`
	Truncated           bool     `json:"truncated"`
	Provider            string   `json:"provider"`
	Model               string   `json:"model,omitempty"`
}

// ExtractTextResponse is the JSON shape returned by /extract-text.
// Carries:
//
//   - Text       — the raw OCR / extracted text. Always populated when
//                  the request succeeds; the UI's "Extracted text"
//                  drawer shows this verbatim.
//   - Mime       — original file MIME, for the UI's "OCR / text layer"
//                  badge.
//   - Truncated  — true when Text was clipped to MaxPromptChars.
//   - Profile    — the slug of the profile that was applied. Always
//                  set; defaults to "generic" when the caller didn't
//                  pass one.
//   - Fields     — structured fields produced by the profile's regex
//                  extractors and/or LLM cleanup. Empty when the
//                  generic profile is in use.
//   - Cleaned    — human-readable rendering of the LLM-cleaned fields.
//                  Empty when AI is off, the profile has no LLM
//                  prompt, or the model returned unparsable output.
type ExtractTextResponse struct {
	Text      string         `json:"text"`
	Mime      string         `json:"mime"`
	Truncated bool           `json:"truncated"`
	Profile   string         `json:"profile"`
	Fields    map[string]any `json:"fields,omitempty"`
	Cleaned   string         `json:"cleaned,omitempty"`
}

// extractTextRequest is the optional JSON body. All fields are
// optional — an empty body falls back to the generic profile, no
// LLM cleanup. We accept the body conditionally (only parse when the
// Content-Type indicates JSON) so existing callers that POST without
// a body keep working unchanged.
type extractTextRequest struct {
	Profile string `json:"profile"`
	// Cleanup, if explicitly set to false, suppresses the LLM cleanup
	// pass even when the profile has a prompt and AI is enabled. Lets
	// the UI offer a "fast" path for users who only care about raw
	// text. Pointer so we can distinguish "unset" (use profile
	// default) from "explicitly false".
	Cleanup *bool `json:"cleanup,omitempty"`
}

type askRequest struct {
	Question string `json:"question"`
}

// AskResponse is the JSON shape returned by /ask. Truncated is true
// when the document was clipped to MaxPromptChars before answering —
// the UI surfaces a small "answer based on the first ~16KB" footnote.
type AskResponse struct {
	Answer    string `json:"answer"`
	Truncated bool   `json:"truncated"`
	Provider  string `json:"provider"`
	Model     string `json:"model,omitempty"`
}

/* ----------------------- HTTP handlers ------------------------ */

// ExtractTextHTTP serves POST /v1/files/{id}/extract-text. Runs
// only the extraction pipeline (which includes OCR fallback for
// images and scanned PDFs) and returns the raw text — no LLM call.
//
// Why this is a separate endpoint rather than a flag on /summarize:
// the latency profiles are wildly different. /extract-text is
// dominated by tesseract (sub-second for an image, a few seconds for
// a 30-page scanned PDF), and never blocks on model load. /summarize
// piles a chat completion on top of the same pipeline and inherits
// ollama's cold-load tail. Surfacing them as siblings lets the UI
// offer "I just want the text" as a fast first click and "Summarize"
// as a slower follow-up.
//
// Auth, ACL, AV gating, and ErrNotTextual mapping are all delegated
// to loadDocText, so the contract here matches /summarize exactly
// minus the AI step.
func (h *Handler) ExtractTextHTTP(w http.ResponseWriter, r *http.Request) {
	c := r.Context().Value(auth.UserCtxKey).(*auth.Claims)
	id := chi.URLParam(r, "id")

	// Optional JSON body carries the profile slug + cleanup toggle.
	// We tolerate both an empty body (legacy callers) and a malformed
	// one (degrade to generic) — picking a profile is convenience,
	// not a contract.
	var body extractTextRequest
	if r.ContentLength > 0 && strings.HasPrefix(r.Header.Get("Content-Type"), "application/json") {
		_ = json.NewDecoder(r.Body).Decode(&body)
	}
	profile, _ := h.profiles().Get(r.Context(), c.OrgID, body.Profile)

	// Load the bytes + the no-OCR portion of the extraction. We
	// always need the raw blob path for profile-aware OCR; the
	// generic loadDocText runs the chained extractor (which already
	// does OCR fallback) and that's exactly what we want for the
	// "generic" profile. For non-generic profiles we want to bypass
	// the operator-tuned OCR config so the per-profile PSM/lang
	// overrides actually apply — see ocrWithProfile.
	text, mime, _, truncated, err := h.loadDocTextForExtract(r.Context(), c, id, profile)
	if err != nil {
		h.writeFileErr(w, err)
		return
	}

	resp := ExtractTextResponse{
		Text:      text,
		Mime:      mime,
		Truncated: truncated,
		Profile:   profile.Slug,
	}
	// Run regex extractors first — cheap, runs even when AI is off.
	// The LLM cleanup result will overlay these when available, but
	// we always carry the regex output so the UI has *something* to
	// render even when the model call times out.
	if regexFields := profile.Extract(text); len(regexFields) > 0 {
		resp.Fields = make(map[string]any, len(regexFields))
		for k, v := range regexFields {
			resp.Fields[k] = v
		}
	}
	// LLM cleanup is opt-out: if the profile has a prompt and AI is
	// available, we run it unless the request explicitly asks us not
	// to. The cleanup function self-degrades on parser failures (the
	// model returned non-JSON) so an unreliable model doesn't break
	// the endpoint — we just ship the regex fields without overlay.
	wantCleanup := profile.HasLLMPrompt() && (body.Cleanup == nil || *body.Cleanup)
	if wantCleanup {
		ctx, cancel := context.WithTimeout(r.Context(), h.PromptTimeout)
		defer cancel()
		cu, err := ocrprofiles.RunCleanup(ctx, h.AI, profile, text)
		switch {
		case err == nil:
			if len(cu.Fields) > 0 {
				if resp.Fields == nil {
					resp.Fields = map[string]any{}
				}
				// LLM-cleaned values take precedence over regex —
				// the cleanup pass exists specifically to fix the
				// regex output's mistranscriptions.
				for k, v := range cu.Fields {
					resp.Fields[k] = v
				}
			}
			if cu.CleanedText != "" {
				resp.Cleaned = cu.CleanedText
			}
		case errors.Is(err, ocrprofiles.ErrCleanupUnavailable):
			// AI is off — silently skip. The regex fields we've
			// already populated are the entire payload.
		default:
			if h.Log != nil {
				h.Log.Warn("docchat.cleanup_failed",
					"file_id", id, "profile", profile.Slug, "error", err.Error())
			}
		}
	}

	if h.Log != nil {
		h.Log.Info("docchat.extract_text", "file_id", id,
			"mime", mime, "chars", len(text), "truncated", truncated,
			"profile", profile.Slug, "fields", len(resp.Fields), "cleaned", resp.Cleaned != "")
	}
	writeJSON(w, http.StatusOK, resp)
}

// loadDocTextForExtract is the profile-aware twin of loadDocText.
//
// For the "generic" profile (or when OCR is disabled / the file is
// non-OCR — e.g. a plain text file or a PDF with a text layer) it
// behaves identically to loadDocText: the chained Extract handles
// everything.
//
// For non-generic OCR-eligible files (image uploads, scanned PDFs)
// it runs OCR directly with a per-profile config so the profile's
// PSM and language actually take effect. Otherwise the chained
// extractor would use the operator's OCR_PSM / OCR_LANG defaults
// regardless of which profile the user picked, defeating the point.
func (h *Handler) loadDocTextForExtract(ctx context.Context, c *auth.Claims, fileID string, profile ocrprofiles.Profile) (text, mime, name string, truncated bool, err error) {
	// Same ACL/AV/blob-fetch preamble as loadDocText. Inlined here
	// because loadDocText runs the extractor at the bottom and we
	// need to short-circuit before that for the profile path. The
	// duplication is worth not threading a "should I extract?" flag
	// through the existing helper which Summarize and Ask also use.
	ok, err := sharing.CanAccessFile(ctx, h.DB, c, fileID)
	if err != nil {
		return "", "", "", false, fmt.Errorf("acl: %w", err)
	}
	if !ok {
		return "", "", "", false, errFileNotFound
	}
	var key, scanStatus, scanSig string
	if err := h.DB.QueryRow(ctx,
		`SELECT storage_key, name, COALESCE(mime, ''),
		        COALESCE(scan_status, 'skipped'), COALESCE(scan_signature, '')
		   FROM files
		  WHERE id=$1 AND org_id=$2 AND trashed_at IS NULL`,
		fileID, c.OrgID,
	).Scan(&key, &name, &mime, &scanStatus, &scanSig); err != nil {
		return "", "", "", false, errFileNotFound
	}
	if msg, _, _, blocked := scanner.GateBlock(scanStatus, scanSig); blocked {
		return "", "", "", false, fmt.Errorf("scan: %s", msg)
	}
	body, err := h.Storage.GetBytes(ctx, key)
	if err != nil {
		return "", "", "", false, fmt.Errorf("fetch blob: %w", err)
	}
	if len(body) == 0 {
		return "", "", "", false, ErrNotTextual
	}
	if len(body) > embeddings.MaxBytes {
		return "", "", "", false, fmt.Errorf("file too large: %d bytes (cap %d)", len(body), embeddings.MaxBytes)
	}

	// Profile-aware OCR path. We only branch here when:
	//   1. OCR is actually enabled on this deployment.
	//   2. The profile asks for non-default settings (PSM/lang/
	//      preprocess override) — for "generic" with all defaults
	//      the chained extractor already does the right thing and
	//      we save a duplicate code path.
	//   3. The MIME is OCR-eligible — for plain text / DOCX / PDFs
	//      with a text layer we want the existing extractor chain.
	if h.OCR.Enabled && profileWantsOCROverride(profile) {
		if isOCRableImage(mime) {
			oc := h.OCR.WithProfile(profile.Lang, profile.PSM, profile.Preprocess)
			text, err = oc.ImageToText(ctx, body)
			if err != nil {
				return "", "", "", false, fmt.Errorf("ocr: %w", err)
			}
		} else if isOCRablePDF(mime) {
			// For PDFs we still try the text-layer extractor first —
			// a profile request shouldn't force OCR when the PDF
			// already has a perfectly good text layer. The chained
			// extractor already does the "empty? then OCR" dance,
			// so we run it once with the per-profile OCR override
			// substituted in.
			primary := embeddings.DispatchExtractor
			text, err = primary(ctx, mime, body)
			if err != nil {
				return "", "", "", false, fmt.Errorf("extract: %w", err)
			}
			if strings.TrimSpace(text) == "" {
				oc := h.OCR.WithProfile(profile.Lang, profile.PSM, profile.Preprocess)
				text, err = oc.PDFToText(ctx, body)
				if err != nil {
					return "", "", "", false, fmt.Errorf("ocr: %w", err)
				}
			}
		} else {
			// Non-OCR MIME — fall through to the chained extractor.
			extract := h.Extract
			if extract == nil {
				extract = embeddings.PlainTextExtractor
			}
			text, err = extract(ctx, mime, body)
			if err != nil {
				return "", "", "", false, fmt.Errorf("extract: %w", err)
			}
		}
	} else {
		extract := h.Extract
		if extract == nil {
			extract = embeddings.PlainTextExtractor
		}
		text, err = extract(ctx, mime, body)
		if err != nil {
			return "", "", "", false, fmt.Errorf("extract: %w", err)
		}
	}

	if strings.TrimSpace(text) == "" {
		return "", "", "", false, ErrNotTextual
	}
	if len(text) > MaxPromptChars {
		runes := []rune(text)
		if len(runes) > MaxPromptChars {
			runes = runes[:MaxPromptChars]
		}
		text = string(runes)
		truncated = true
	}
	return text, mime, name, truncated, nil
}

// profileWantsOCROverride is true when the profile asks for any
// non-default OCR setting. Lets us skip the duplicated OCR codepath
// for the "generic" profile (where every override is "inherit") and
// keep the existing chained extractor in charge.
func profileWantsOCROverride(p ocrprofiles.Profile) bool {
	if p.PSM >= 0 && p.PSM <= 13 {
		return true
	}
	if p.Lang != "" {
		return true
	}
	if p.Preprocess != nil {
		return true
	}
	return false
}

// SummarizeHTTP serves POST /v1/files/{id}/summarize.
func (h *Handler) SummarizeHTTP(w http.ResponseWriter, r *http.Request) {
	c := r.Context().Value(auth.UserCtxKey).(*auth.Claims)
	id := chi.URLParam(r, "id")

	text, mime, name, truncated, err := h.loadDocText(r.Context(), c, id)
	if err != nil {
		h.writeFileErr(w, err)
		return
	}

	ctx, cancel := context.WithTimeout(r.Context(), h.PromptTimeout)
	defer cancel()
	resp, err := h.summarize(ctx, name, mime, text, truncated)
	if err != nil {
		if errors.Is(err, ErrAIDisabled) {
			writeErr(w, http.StatusServiceUnavailable, "ai_disabled",
				"AI features are disabled on this deployment")
			return
		}
		writeErr(w, http.StatusBadGateway, "ai_error", err.Error())
		return
	}
	writeJSON(w, http.StatusOK, resp)
}

// AskHTTP serves POST /v1/files/{id}/ask. Body: { "question": "..." }.
func (h *Handler) AskHTTP(w http.ResponseWriter, r *http.Request) {
	c := r.Context().Value(auth.UserCtxKey).(*auth.Claims)
	id := chi.URLParam(r, "id")

	var body askRequest
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeErr(w, http.StatusBadRequest, "invalid_body", err.Error())
		return
	}
	q := strings.TrimSpace(body.Question)
	if q == "" {
		writeErr(w, http.StatusBadRequest, "empty_question",
			"question must be non-empty")
		return
	}
	if len(q) > MaxQuestionLen {
		writeErr(w, http.StatusRequestEntityTooLarge, "question_too_long",
			fmt.Sprintf("question exceeds %d characters", MaxQuestionLen))
		return
	}

	text, mime, name, truncated, err := h.loadDocText(r.Context(), c, id)
	if err != nil {
		h.writeFileErr(w, err)
		return
	}

	ctx, cancel := context.WithTimeout(r.Context(), h.PromptTimeout)
	defer cancel()
	resp, err := h.ask(ctx, name, mime, text, q, truncated)
	if err != nil {
		if errors.Is(err, ErrAIDisabled) {
			writeErr(w, http.StatusServiceUnavailable, "ai_disabled",
				"AI features are disabled on this deployment")
			return
		}
		writeErr(w, http.StatusBadGateway, "ai_error", err.Error())
		return
	}
	writeJSON(w, http.StatusOK, resp)
}

/* --------------------- file loading + ACL --------------------- */

// loadDocText runs the visibility check, vault gate (skipped for now —
// docchat doesn't have a vault hook because it never returns the
// bytes), AV scan-status gate, blob fetch, and text extraction.
// Returns the extracted text along with mime+name (for prompt context)
// and whether the body had to be truncated.
//
// The extractor seam is the only place "this file isn't textual" gets
// decided — we propagate ErrNotTextual when extraction returns "" so
// the HTTP handler can map it to 415.
func (h *Handler) loadDocText(ctx context.Context, c *auth.Claims, fileID string) (text, mime, name string, truncated bool, err error) {
	ok, err := sharing.CanAccessFile(ctx, h.DB, c, fileID)
	if err != nil {
		return "", "", "", false, fmt.Errorf("acl: %w", err)
	}
	if !ok {
		return "", "", "", false, errFileNotFound
	}

	var key, scanStatus, scanSig string
	if err := h.DB.QueryRow(ctx,
		`SELECT storage_key, name, COALESCE(mime, ''),
		        COALESCE(scan_status, 'skipped'), COALESCE(scan_signature, '')
		   FROM files
		  WHERE id=$1 AND org_id=$2 AND trashed_at IS NULL`,
		fileID, c.OrgID,
	).Scan(&key, &name, &mime, &scanStatus, &scanSig); err != nil {
		return "", "", "", false, errFileNotFound
	}
	// Same fail-closed AV semantics as Download: don't summarize a
	// known-infected blob and don't burn a model call on a still-
	// scanning one.
	if msg, _, _, blocked := scanner.GateBlock(scanStatus, scanSig); blocked {
		return "", "", "", false, fmt.Errorf("scan: %s", msg)
	}
	body, err := h.Storage.GetBytes(ctx, key)
	if err != nil {
		return "", "", "", false, fmt.Errorf("fetch blob: %w", err)
	}
	if len(body) == 0 {
		return "", "", "", false, ErrNotTextual
	}
	if len(body) > embeddings.MaxBytes {
		// Larger than the embedder's cap. Don't try — we'd just
		// extract MaxBytes worth and hand the user a partial answer
		// indistinguishable from a clean one.
		return "", "", "", false, fmt.Errorf("file too large: %d bytes (cap %d)", len(body), embeddings.MaxBytes)
	}
	extract := h.Extract
	if extract == nil {
		extract = embeddings.PlainTextExtractor
	}
	text, err = extract(ctx, mime, body)
	if err != nil {
		return "", "", "", false, fmt.Errorf("extract: %w", err)
	}
	if strings.TrimSpace(text) == "" {
		return "", "", "", false, ErrNotTextual
	}
	if len(text) > MaxPromptChars {
		// Trim on rune boundary — the extracted text is UTF-8 (the
		// extractor enforces this) so an arbitrary byte cut could
		// leave a half-codepoint and break some tokenizers.
		runes := []rune(text)
		if len(runes) > MaxPromptChars {
			runes = runes[:MaxPromptChars]
		}
		text = string(runes)
		truncated = true
	}
	return text, mime, name, truncated, nil
}

// errFileNotFound is the sentinel writeFileErr maps to 404. Kept
// distinct from a wrapped error so a real DB failure doesn't get
// rendered as "not found" and confuse operators.
var errFileNotFound = errors.New("docchat: file not found or not accessible")

// writeFileErr translates the loadDocText error set into HTTP
// responses. Anything not specifically recognised becomes a 500.
func (h *Handler) writeFileErr(w http.ResponseWriter, err error) {
	switch {
	case errors.Is(err, errFileNotFound):
		writeErr(w, http.StatusNotFound, "not_found", "file not found")
	case errors.Is(err, ErrNotTextual):
		writeErr(w, http.StatusUnsupportedMediaType, "not_textual",
			"this file isn't text-extractable — supported: PDFs, Word .docx, text/markdown/code/csv/json/html, and (when OCR is enabled) image uploads + scanned PDFs")
	default:
		writeErr(w, http.StatusInternalServerError, "load_error", err.Error())
	}
}

/* ------------------------ orchestration ----------------------- */

// summarize runs the system+user prompt and parses the JSON shape we
// instruct the model to return. We use the same defensive parser as
// autotag — fenced code blocks, leading prose, and trailing commas all
// handled.
func (h *Handler) summarize(ctx context.Context, name, mime, text string, truncated bool) (SummaryResponse, error) {
	if h.AI == nil || !h.AI.Enabled() || !h.AI.Capabilities().Chat {
		return SummaryResponse{}, ErrAIDisabled
	}
	resp, err := h.AI.Chat(ctx, ai.ChatRequest{
		Temperature: 0.2,
		MaxTokens:   MaxSummaryTokens,
		Messages: []ai.ChatMessage{
			{Role: "system", Content: summarizeSystemPrompt},
			{Role: "user", Content: buildDocPrompt(name, mime, text, "")},
		},
	})
	if err != nil {
		return SummaryResponse{}, err
	}
	parsed := parseSummary(resp.Content)
	parsed.Truncated = truncated
	parsed.Provider = h.AI.Provider()
	parsed.Model = resp.Model
	if h.Log != nil {
		h.Log.Info("docchat.summarize", "provider", parsed.Provider,
			"model", parsed.Model, "truncated", truncated, "len", len(text))
	}
	return parsed, nil
}

// ask runs a free-form Q&A turn. We instruct the model to answer ONLY
// from the document and to say "I don't know" when the answer isn't
// present — that's the single biggest UX improvement vs. a generic
// system prompt: hallucinated answers about a contract are worse than
// no answer.
func (h *Handler) ask(ctx context.Context, name, mime, text, question string, truncated bool) (AskResponse, error) {
	if h.AI == nil || !h.AI.Enabled() || !h.AI.Capabilities().Chat {
		return AskResponse{}, ErrAIDisabled
	}
	resp, err := h.AI.Chat(ctx, ai.ChatRequest{
		Temperature: 0.2,
		MaxTokens:   MaxAnswerTokens,
		Messages: []ai.ChatMessage{
			{Role: "system", Content: askSystemPrompt},
			{Role: "user", Content: buildDocPrompt(name, mime, text, question)},
		},
	})
	if err != nil {
		return AskResponse{}, err
	}
	answer := strings.TrimSpace(resp.Content)
	if h.Log != nil {
		h.Log.Info("docchat.ask", "provider", h.AI.Provider(),
			"model", resp.Model, "truncated", truncated,
			"qlen", len(question), "alen", len(answer))
	}
	return AskResponse{
		Answer:    answer,
		Truncated: truncated,
		Provider:  h.AI.Provider(),
		Model:     resp.Model,
	}, nil
}

/* --------------------------- prompts -------------------------- */

const summarizeSystemPrompt = `You are a precise document summariser. Given a single document's contents, produce a short executive summary, 3–5 key points, and 3 follow-up questions a reader of this document might ask.

Respond with a single JSON object on one line, no prose, no code fences:
{"summary":"...","keyPoints":["...","..."],"suggestedQuestions":["...","...","..."]}

Rules:
  - The summary must be 1–3 sentences. Plain English. No marketing voice.
  - Key points are short (≤120 characters each). Concrete details, names, dates, amounts when present.
  - Suggested questions must be answerable from the document — they're prompts the user might want to ask next.
  - If the document is too short or the content is opaque, return empty arrays / a one-line summary describing what little you can see, rather than guessing.`

const askSystemPrompt = `You are answering a user's question about a single document. The document text is provided in the user message; the user's question is at the bottom.

Rules:
  - Answer ONLY from the document. If the document doesn't contain the answer, say so plainly: "The document doesn't say." Do not speculate.
  - Quote short fragments inline when it strengthens your answer. Do not invent quotes.
  - Be concise. Two or three sentences is usually enough.
  - Plain prose. No markdown headers, no bullet lists unless the user asked for one.`

// buildDocPrompt frames the user-side message identically for both
// flows so the system prompt is the only thing that changes between
// summarize and ask. The user question (when present) is appended
// after the document so the model can read context first and answer
// last — a small but consistent quality bump on weaker models.
func buildDocPrompt(name, mime, text, question string) string {
	var b strings.Builder
	fmt.Fprintf(&b, "Filename: %s\nMIME: %s\n\n--- begin document ---\n", name, mime)
	b.WriteString(text)
	b.WriteString("\n--- end document ---")
	if question != "" {
		b.WriteString("\n\nQuestion: ")
		b.WriteString(question)
	}
	return b.String()
}

/* ------------------------ JSON parsing ------------------------ */

// parseSummary is a tolerant decoder mirroring autotag.parseSuggestion —
// strips code fences, finds the first balanced {...} block, and
// unmarshals. On failure we degrade to a "raw response as summary"
// shape so the user gets *something* useful rather than a 502.
func parseSummary(raw string) SummaryResponse {
	s := strings.TrimSpace(raw)
	if s == "" {
		return SummaryResponse{}
	}
	if strings.HasPrefix(s, "```") {
		s = strings.TrimPrefix(s, "```")
		if i := strings.Index(s, "\n"); i >= 0 {
			s = s[i+1:]
		}
		if i := strings.LastIndex(s, "```"); i >= 0 {
			s = s[:i]
		}
		s = strings.TrimSpace(s)
	}
	start := strings.Index(s, "{")
	end := strings.LastIndex(s, "}")
	if start < 0 || end <= start {
		// Degrade gracefully — the model didn't follow the JSON
		// contract but still produced text. Return that as the summary
		// so the UI doesn't show "AI failed" for what is actually a
		// minor format violation.
		return SummaryResponse{Summary: strings.TrimSpace(raw), KeyPoints: []string{}, SuggestedQuestions: []string{}}
	}
	var out SummaryResponse
	if err := json.Unmarshal([]byte(s[start:end+1]), &out); err != nil {
		return SummaryResponse{Summary: strings.TrimSpace(raw), KeyPoints: []string{}, SuggestedQuestions: []string{}}
	}
	if out.KeyPoints == nil {
		out.KeyPoints = []string{}
	}
	if out.SuggestedQuestions == nil {
		out.SuggestedQuestions = []string{}
	}
	return out
}

/* ----------------------- response helpers --------------------- */

func writeJSON(w http.ResponseWriter, code int, v interface{}) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(code)
	_ = json.NewEncoder(w).Encode(v)
}

func writeErr(w http.ResponseWriter, code int, kind, msg string) {
	writeJSON(w, code, map[string]string{"error": kind, "message": msg})
}
