// Package starterai is the HTTP surface for the in-app resume / certificate
// designer at /starters/[id]. It exposes five endpoints that wire up the
// previously-dead UI in web/components/starter-fill/fill-page.tsx:
//
//	POST /v1/starters/ai/profile-summary  → one-shot LLM, fills the resume's
//	                                        "summary" field
//	POST /v1/starters/ai/cover-letter     → drafts a cover letter from the
//	                                        same form data, optionally
//	                                        targeted at a job posting
//	POST /v1/starters/ai/review           → returns a structured critique
//	                                        keyed by section so the UI can
//	                                        render checks/warnings/fails
//	POST /v1/starters/{id}/export         → renders the starter HTML + form
//	                                        data through chromium, returns a
//	                                        presigned download URL (PDF)
//	POST /v1/starters/{id}/save-to-drive  → same render, but persisted as a
//	                                        real File row in Drive
//
// # Why a separate package
//
// Same reasoning as docchat / aisearch. AI features have a hard dependency
// on ai.Client; export/save have a hard dependency on the HTML render
// pipeline + storage. Keeping each surface in its own package means
// non-AI endpoints don't drag any of these imports through review.
//
// # HTML-in-payload contract
//
// Unlike the document-mode renderer (which loads template HTML from a
// `templates` row), the starter designer sends the template HTML inline
// in the request body. Reasons:
//
//  1. Starters live in the frontend repo (web/lib/starters/*.ts) and are
//     edited there. Mirroring them into Go would create two sources of
//     truth and a deploy-coupling we don't want.
//  2. The request is already authenticated and carries a reasonable size
//     cap (MaxStarterHTMLBytes), so the surface is no riskier than
//     docchat's "extract-text on user-uploaded PDF".
//  3. It lets a future "user-customisable starter" land without a
//     migration — the same endpoint accepts whatever HTML the editor produces.
//
// # Off-by-default contract
//
// The three AI endpoints return 503 ai_disabled when the Client is the
// Disabled provider OR the active provider lacks Chat capability. The
// frontend hides those buttons via /v1/ai/config; the 503 path is
// defense-in-depth for stale page loads.
//
// The render endpoints (export / save-to-drive) do NOT depend on AI and
// run regardless of AI flag state.
package starterai

import (
	"errors"
	"log/slog"
	"net/http"
	"os"
	"strconv"
	"strings"
	"time"

	"github.com/docforge/api/internal/ai"
	"github.com/docforge/api/internal/storage"
	"github.com/go-chi/chi/v5"
	"github.com/go-chi/chi/v5/middleware"
	"github.com/jackc/pgx/v5/pgxpool"
)

// Tunables. Conservative limits — chat completion is the dominant cost
// and a single careless request shouldn't be able to spike the bill.
const (
	// MaxStarterHTMLBytes caps the inline HTML payload. 512KB covers
	// every starter we ship today (the largest is ~40KB) with comfy
	// headroom for user-customised ones, while still bounding the cost
	// of a chromium render.
	MaxStarterHTMLBytes = 512 * 1024
	// MaxFormDataBytes caps the JSON `data` blob. 256KB is well above
	// any realistic resume's worth of text + structured fields.
	MaxFormDataBytes = 256 * 1024
	// MaxJobDescriptionChars caps the optional `job.description` field
	// for cover-letter generation. 8KB ≈ 2K tokens — enough to capture
	// a typical job posting without blowing the prompt budget.
	MaxJobDescriptionChars = 8_000
	// MaxSummaryTokens — output cap for the profile-summary endpoint.
	MaxSummaryTokens = 400
	// MaxCoverLetterTokens — output cap for cover-letter generation.
	// Higher than summary because cover letters are intrinsically longer.
	MaxCoverLetterTokens = 900
	// MaxReviewTokens — output cap for the structured review JSON.
	MaxReviewTokens = 1200

	// DefaultPromptTimeout — per-call deadline for LLM endpoints. Same
	// reasoning as docchat: 180s tolerates ollama cold-load on a
	// memory-pressured laptop.
	DefaultPromptTimeout = 180 * time.Second
	// DefaultRenderTimeout — chromium's first paint is fast (sub-second
	// on a warm pool) but cold-allocator + multi-page resume can hit
	// ~25s. 60s is plenty.
	DefaultRenderTimeout = 60 * time.Second
)

// ErrAIDisabled is returned by the AI endpoints when the Client is
// disabled or lacks Chat capability. Mapped to 503.
var ErrAIDisabled = errors.New("starterai: AI is disabled")

// Handler holds the dependencies for every route in this package.
// Constructed once in main.go and shared across requests.
type Handler struct {
	DB      *pgxpool.Pool
	Storage *storage.Client
	AI      ai.Client
	Log     *slog.Logger

	// PromptTimeout — per-call deadline for LLM-bound endpoints.
	// Defaults to DefaultPromptTimeout; operators can tune via
	// STARTERAI_PROMPT_TIMEOUT_SEC.
	PromptTimeout time.Duration

	// RenderTimeout — per-call deadline for the chromium render in
	// /export and /save-to-drive. Defaults to DefaultRenderTimeout;
	// tunable via STARTERAI_RENDER_TIMEOUT_SEC.
	RenderTimeout time.Duration
}

// New builds a Handler with sane defaults. Callers should chain
// nothing else — every collaborator is required at construction time.
func New(db *pgxpool.Pool, store *storage.Client, c ai.Client, log *slog.Logger) *Handler {
	if c == nil {
		c = ai.Disabled{}
	}
	return &Handler{
		DB:            db,
		Storage:       store,
		AI:            c,
		Log:           log,
		PromptTimeout: parseTimeout("STARTERAI_PROMPT_TIMEOUT_SEC", DefaultPromptTimeout),
		RenderTimeout: parseTimeout("STARTERAI_RENDER_TIMEOUT_SEC", DefaultRenderTimeout),
	}
}

// parseTimeout reads the env var as a positive integer of seconds and
// returns a Duration. Falls back on missing / unparseable / non-positive
// values — we'd rather use the safe default than mis-parse a typo.
func parseTimeout(envVar string, fallback time.Duration) time.Duration {
	raw := strings.TrimSpace(os.Getenv(envVar))
	if raw == "" {
		return fallback
	}
	n, err := strconv.Atoi(raw)
	if err != nil || n <= 0 {
		return fallback
	}
	return time.Duration(n) * time.Second
}

// Mount wires the routes under the parent (already-authenticated)
// router. Each AI route gets a per-route middleware.Timeout slightly
// larger than PromptTimeout so the inner context.WithTimeout fires
// first with a clean error envelope rather than chi cutting the
// response mid-stream.
func (h *Handler) Mount(r chi.Router) {
	aiBudget := h.PromptTimeout + 15*time.Second
	if aiBudget < 30*time.Second {
		aiBudget = 30 * time.Second
	}
	renderBudget := h.RenderTimeout + 15*time.Second
	if renderBudget < 30*time.Second {
		renderBudget = 30 * time.Second
	}

	aiTimeout := middleware.Timeout(aiBudget)
	renderTimeout := middleware.Timeout(renderBudget)

	r.With(aiTimeout).Post("/v1/starters/ai/profile-summary", h.ProfileSummaryHTTP)
	r.With(aiTimeout).Post("/v1/starters/ai/cover-letter", h.CoverLetterHTTP)
	r.With(aiTimeout).Post("/v1/starters/ai/review", h.ReviewHTTP)
	r.With(renderTimeout).Post("/v1/starters/{id}/export", h.ExportHTTP)
	r.With(renderTimeout).Post("/v1/starters/{id}/save-to-drive", h.SaveToDriveHTTP)
}

// aiAvailable reports whether the AI client is enabled AND can chat.
// AI handlers should call this first and bail with ErrAIDisabled.
func (h *Handler) aiAvailable() bool {
	return h.AI != nil && h.AI.Enabled() && h.AI.Capabilities().Chat
}

// writeAIErr maps the standard error set onto HTTP responses. Used by
// every AI handler so the wire shape (JSON {error, message, requestId})
// is identical across the surface.
//
// Upstream provider errors (network, 4xx/5xx from OpenAI/Ollama, model
// output too long, etc.) become a 502 ai_upstream. We log the underlying
// error here — the wire body carries it too, but operators reading the
// API logs need the same string under a stable key to grep for.
func (h *Handler) writeAIErr(w http.ResponseWriter, r *http.Request, err error) {
	if errors.Is(err, ErrAIDisabled) {
		writeErr(w, r, http.StatusServiceUnavailable, "ai_disabled",
			"AI features are disabled on this deployment")
		return
	}
	if h.Log != nil {
		provider := ""
		if h.AI != nil {
			provider = h.AI.Provider()
		}
		h.Log.Warn("starterai.ai_upstream",
			"path", r.URL.Path,
			"provider", provider,
			"err", err.Error())
	}
	writeErr(w, r, http.StatusBadGateway, "ai_upstream", err.Error())
}
