// Package letterai owns the AI endpoint for the Correspondence
// starter family (cover-letter, business-letter, complaint-letter,
// recommendation-letter, resignation-letter, thank-you-note, etc.).
//
// Endpoint:
//
//	POST /v1/starters/letters/ai/rewrite — text + tone shift → rewritten letter
//
// Rewrite is the most-asked-for AI feature on these starters: the user
// has a draft and wants a different register (more formal, shorter,
// warmer). One endpoint covers all of those by parameterising the
// instruction.
package letterai

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
	DefaultPromptTimeout = 180 * time.Second
	maxRewriteTokens     = 1100
	MaxBodyChars         = 12_000
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
		Post("/v1/starters/letters/ai/rewrite", h.RewriteHTTP)
}

type RewriteRequest struct {
	Body string `json:"body"`
	// Goal: what the rewrite should achieve. Free-text, e.g. "shorter,
	// less apologetic", "more formal", "match a senior-exec voice".
	Goal string `json:"goal"`
	// Tone: friendly | formal | direct | apologetic — convenience
	// short-hand. Goal still applies; tone adds a stable preset.
	Tone string `json:"tone,omitempty"`
	// Format: html (default) | markdown | plain — output shape.
	Format string `json:"format,omitempty"`
}

type RewriteResponse struct {
	Body     string   `json:"body"`
	Notes    []string `json:"notes"`
	Format   string   `json:"format"`
	Provider string   `json:"provider"`
	Model    string   `json:"model,omitempty"`
}

const rewriteSystemPrompt = `You rewrite letters to match a requested goal and tone. Output strict JSON:

{
  "body": "<rewritten letter, in the requested format>",
  "notes": ["<short note explaining one rewrite choice>", "..."]
}

Rules:
- Output only the JSON object — no commentary, no fences.
- "body" matches the requested format exactly:
    * html: a single fragment, no <html>/<head>; paragraphs as <p>
    * markdown: paragraphs separated by blank lines
    * plain: paragraphs separated by \\n\\n
- Preserve facts. Do not invent dates, names, amounts.
- 0-4 notes; one short sentence each.`

func (h *Handler) RewriteHTTP(w http.ResponseWriter, r *http.Request) {
	c, _ := r.Context().Value(auth.UserCtxKey).(*auth.Claims)

	var req RewriteRequest
	if err := aitools.DecodeJSON(w, r, &req, aitools.MediumReqCap); err != nil {
		aitools.WriteErr(w, r, http.StatusBadRequest, "invalid_payload", err.Error())
		return
	}
	if strings.TrimSpace(req.Body) == "" {
		aitools.WriteErr(w, r, http.StatusBadRequest, "invalid_payload",
			"`body` must be non-empty")
		return
	}
	if strings.TrimSpace(req.Goal) == "" {
		aitools.WriteErr(w, r, http.StatusBadRequest, "invalid_payload",
			"`goal` must be non-empty")
		return
	}
	tone := strings.ToLower(strings.TrimSpace(req.Tone))
	switch tone {
	case "", "neutral":
		tone = "neutral"
	case "friendly", "formal", "direct", "apologetic":
	default:
		aitools.WriteErr(w, r, http.StatusBadRequest, "invalid_payload",
			"`tone` must be one of friendly, formal, direct, apologetic, or empty")
		return
	}
	format := strings.ToLower(strings.TrimSpace(req.Format))
	switch format {
	case "", "html":
		format = "html"
	case "markdown", "plain":
	default:
		aitools.WriteErr(w, r, http.StatusBadRequest, "invalid_payload",
			"`format` must be html, markdown, or plain")
		return
	}

	ctx, cancel := context.WithTimeout(r.Context(), h.PromptTimeout)
	defer cancel()

	user := fmt.Sprintf("Goal: %s\nTone: %s\nFormat: %s\n\nOriginal body:\n%s",
		aitools.Truncate(req.Goal, 1000),
		tone, format,
		aitools.Truncate(req.Body, MaxBodyChars))

	var parsed struct {
		Body  string   `json:"body"`
		Notes []string `json:"notes"`
	}
	res, err := aitools.RunStructured(ctx, h.AI, aitools.StructuredOpts{
		System:      rewriteSystemPrompt,
		User:        user,
		Temperature: 0.4,
		MaxTokens:   maxRewriteTokens,
		Out:         &parsed,
	})
	if err != nil {
		aitools.WriteAIErr(w, r, err)
		return
	}
	if !res.ParsedOK {
		parsed.Body = strings.TrimSpace(res.Raw)
		parsed.Notes = []string{}
	}
	if parsed.Notes == nil {
		parsed.Notes = []string{}
	}

	if h.Log != nil && c != nil {
		h.Log.Info("letterai.rewrite",
			"org_id", c.OrgID, "user_id", c.UserID,
			"tone", tone, "format", format, "body_len", len(req.Body),
			"provider", res.Provider, "model", res.Model)
	}
	aitools.WriteJSON(w, http.StatusOK, RewriteResponse{
		Body:     parsed.Body,
		Notes:    parsed.Notes,
		Format:   format,
		Provider: res.Provider,
		Model:    res.Model,
	})
}
