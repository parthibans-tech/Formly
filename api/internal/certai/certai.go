// Package certai owns the AI endpoint for the Certificates starter
// family (achievement, completion, recognition, participation).
//
// Endpoint:
//
//	POST /v1/starters/certificates/ai/citation — recipient + reason → 1-2 sentence formal citation
//
// Just one endpoint here because certificates have a small surface:
// the rest of the layout (border, font, heraldry) is template-driven
// and doesn't benefit from AI. The QR-code generator that some
// certificates use lives in eventtools.
package certai

import (
	"context"
	"fmt"
	"log/slog"
	"net/http"
	"strings"
	"time"

	"github.com/docforge/api/internal/ai"
	"github.com/docforge/api/internal/aitools"
	"github.com/docforge/api/internal/auth"
	"github.com/go-chi/chi/v5"
	"github.com/go-chi/chi/v5/middleware"
)

const (
	DefaultPromptTimeout = 120 * time.Second
	maxCitationTokens    = 350
)

type Handler struct {
	AI            ai.Client
	Log           *slog.Logger
	PromptTimeout time.Duration
}

func New(c ai.Client, log *slog.Logger) *Handler {
	if c == nil {
		c = ai.Disabled{}
	}
	return &Handler{AI: c, Log: log, PromptTimeout: DefaultPromptTimeout}
}

func (h *Handler) Mount(r chi.Router) {
	budget := h.PromptTimeout + 15*time.Second
	if budget < 30*time.Second {
		budget = 30 * time.Second
	}
	r.With(middleware.Timeout(budget)).
		Post("/v1/starters/certificates/ai/citation", h.CitationHTTP)
}

type CitationRequest struct {
	Recipient string `json:"recipient"`
	Reason    string `json:"reason"`
	// Style: formal (default) | warm — biases vocabulary register.
	Style string `json:"style,omitempty"`
	// Length: short (default, ~1 sentence) | medium (2 sentences).
	Length string `json:"length,omitempty"`
}

type CitationResponse struct {
	Citation     string   `json:"citation"`
	Alternatives []string `json:"alternatives"`
	Provider     string   `json:"provider"`
	Model        string   `json:"model,omitempty"`
}

const citationSystemPrompt = `You write formal certificate citations. Output strict JSON:

{ "citation": "<primary 1-2 sentence citation>", "alternatives": ["<...>", "<...>"] }

Rules:
- Output only the JSON object — no commentary, no fences.
- The citation reads as engraved-on-paper text — no "Dear", no signoff.
- Address the recipient by name once, near the start.
- 2 alternatives total, each genuinely different in phrasing.
- Match the requested style (formal/warm) and length.`

func (h *Handler) CitationHTTP(w http.ResponseWriter, r *http.Request) {
	c, _ := r.Context().Value(auth.UserCtxKey).(*auth.Claims)

	var req CitationRequest
	if err := aitools.DecodeJSON(w, r, &req, aitools.SmallReqCap); err != nil {
		aitools.WriteErr(w, r, http.StatusBadRequest, "invalid_payload", err.Error())
		return
	}
	if strings.TrimSpace(req.Recipient) == "" || strings.TrimSpace(req.Reason) == "" {
		aitools.WriteErr(w, r, http.StatusBadRequest, "invalid_payload",
			"`recipient` and `reason` must be non-empty")
		return
	}
	style := strings.ToLower(strings.TrimSpace(req.Style))
	switch style {
	case "", "formal":
		style = "formal"
	case "warm":
	default:
		aitools.WriteErr(w, r, http.StatusBadRequest, "invalid_payload",
			"`style` must be formal or warm")
		return
	}
	length := strings.ToLower(strings.TrimSpace(req.Length))
	switch length {
	case "", "short":
		length = "short"
	case "medium":
	default:
		aitools.WriteErr(w, r, http.StatusBadRequest, "invalid_payload",
			"`length` must be short or medium")
		return
	}

	ctx, cancel := context.WithTimeout(r.Context(), h.PromptTimeout)
	defer cancel()

	user := fmt.Sprintf("Recipient: %s\nReason: %s\nStyle: %s\nLength: %s",
		req.Recipient,
		aitools.Truncate(req.Reason, 1500),
		style, length)

	var parsed struct {
		Citation     string   `json:"citation"`
		Alternatives []string `json:"alternatives"`
	}
	res, err := aitools.RunStructured(ctx, h.AI, aitools.StructuredOpts{
		System:      citationSystemPrompt,
		User:        user,
		Temperature: 0.6,
		MaxTokens:   maxCitationTokens,
		Out:         &parsed,
	})
	if err != nil {
		aitools.WriteAIErr(w, r, err)
		return
	}
	if !res.ParsedOK {
		parsed.Citation = strings.TrimSpace(res.Raw)
		parsed.Alternatives = []string{}
	}
	if parsed.Alternatives == nil {
		parsed.Alternatives = []string{}
	}

	if h.Log != nil && c != nil {
		h.Log.Info("certai.citation",
			"org_id", c.OrgID, "user_id", c.UserID,
			"style", style, "length", length,
			"provider", res.Provider, "model", res.Model)
	}
	aitools.WriteJSON(w, http.StatusOK, CitationResponse{
		Citation:     strings.TrimSpace(parsed.Citation),
		Alternatives: parsed.Alternatives,
		Provider:     res.Provider,
		Model:        res.Model,
	})
}
