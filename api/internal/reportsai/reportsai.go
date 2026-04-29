// Package reportsai owns the AI endpoints for the Reports starter
// family (meeting-minutes, project-status, weekly-update,
// retro-summary, incident-postmortem, board-update, etc.).
//
// Endpoints:
//
//	POST /v1/starters/reports/ai/extract-actions — text → action items
//	POST /v1/starters/reports/ai/summarize       — long doc → exec summary
//
// Both endpoints share a single tolerance pass for prose-wrapped JSON.
package reportsai

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
	maxActionsTokens     = 800
	maxSummarizeTokens   = 900
	MaxInputChars        = 32_000
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
	timeout := middleware.Timeout(budget)
	r.With(timeout).Post("/v1/starters/reports/ai/extract-actions", h.ExtractActionsHTTP)
	r.With(timeout).Post("/v1/starters/reports/ai/summarize", h.SummarizeHTTP)
}

/* -------------------------- ExtractActions -------------------------- */

type ExtractActionsRequest struct {
	// Source: "minutes" | "transcript" | "notes" | "" — biases parsing.
	Source string `json:"source,omitempty"`
	Text   string `json:"text"`
}

type ActionItem struct {
	Owner   string `json:"owner,omitempty"`
	Task    string `json:"task"`
	DueDate string `json:"dueDate,omitempty"` // YYYY-MM-DD when stated; empty otherwise
	Notes   string `json:"notes,omitempty"`
}

type ExtractActionsResponse struct {
	Actions  []ActionItem `json:"actions"`
	Provider string       `json:"provider"`
	Model    string       `json:"model,omitempty"`
}

const extractActionsSystemPrompt = `You extract action items from meeting text. Output strict JSON:

{ "actions": [ { "owner": "<name or empty>", "task": "<short imperative>", "dueDate": "YYYY-MM-DD or empty", "notes": "<optional>" } ] }

Rules:
- Output only the JSON object — no commentary, no fences.
- Only include items that are clearly actionable. Skip discussion points.
- Preserve names verbatim from the source. Do not invent owners.
- Convert relative dates ("by Friday", "next sprint") only if a clear
  reference date is present in the text; otherwise leave dueDate empty.`

func (h *Handler) ExtractActionsHTTP(w http.ResponseWriter, r *http.Request) {
	c, _ := r.Context().Value(auth.UserCtxKey).(*auth.Claims)

	var req ExtractActionsRequest
	if err := aitools.DecodeJSON(w, r, &req, aitools.LargeReqCap); err != nil {
		aitools.WriteErr(w, r, http.StatusBadRequest, "invalid_payload", err.Error())
		return
	}
	if strings.TrimSpace(req.Text) == "" {
		aitools.WriteErr(w, r, http.StatusBadRequest, "invalid_payload",
			"`text` must be non-empty")
		return
	}

	ctx, cancel := context.WithTimeout(r.Context(), h.PromptTimeout)
	defer cancel()

	user := fmt.Sprintf("Source: %s\n\nText:\n%s",
		aitools.Coalesce(req.Source, "(unspecified)"),
		aitools.Truncate(req.Text, MaxInputChars))

	var parsed struct {
		Actions []ActionItem `json:"actions"`
	}
	res, err := aitools.RunStructured(ctx, h.AI, aitools.StructuredOpts{
		System:      extractActionsSystemPrompt,
		User:        user,
		Temperature: 0.1,
		MaxTokens:   maxActionsTokens,
		Out:         &parsed,
	})
	if err != nil {
		aitools.WriteAIErr(w, r, err)
		return
	}
	if !res.ParsedOK || parsed.Actions == nil {
		parsed.Actions = []ActionItem{}
	}

	if h.Log != nil && c != nil {
		h.Log.Info("reportsai.extract_actions",
			"org_id", c.OrgID, "user_id", c.UserID,
			"actions", len(parsed.Actions),
			"provider", res.Provider, "model", res.Model)
	}
	aitools.WriteJSON(w, http.StatusOK, ExtractActionsResponse{
		Actions:  parsed.Actions,
		Provider: res.Provider,
		Model:    res.Model,
	})
}

/* ---------------------------- Summarize ---------------------------- */

type SummarizeRequest struct {
	Text string `json:"text"`
	// Audience: exec | team | client (default exec) — controls vocabulary
	// and what's foregrounded.
	Audience string `json:"audience,omitempty"`
	// Length: brief (default, 3-5 sentences) | medium (1 paragraph) | bullets
	Length string `json:"length,omitempty"`
}

type SummarizeResponse struct {
	Summary    string   `json:"summary"`
	Highlights []string `json:"highlights"`
	Risks      []string `json:"risks"`
	Provider   string   `json:"provider"`
	Model      string   `json:"model,omitempty"`
}

const summarizeSystemPrompt = `You summarise long status documents for the requested audience. Output strict JSON:

{
  "summary": "<paragraph or bullet block matching the requested length>",
  "highlights": ["<bullet>", "..."],
  "risks": ["<bullet>", "..."]
}

Rules:
- Output only the JSON object — no commentary, no fences.
- "summary" length:
    * brief: 3-5 sentences, single paragraph
    * medium: ~1 paragraph (5-8 sentences)
    * bullets: 5-8 newline-separated bullet lines, each starting with "- "
- 3-6 highlights, 0-5 risks. Risks may be empty if none are evident.
- Do not invent numbers; only cite figures present in the source.`

func (h *Handler) SummarizeHTTP(w http.ResponseWriter, r *http.Request) {
	c, _ := r.Context().Value(auth.UserCtxKey).(*auth.Claims)

	var req SummarizeRequest
	if err := aitools.DecodeJSON(w, r, &req, aitools.LargeReqCap); err != nil {
		aitools.WriteErr(w, r, http.StatusBadRequest, "invalid_payload", err.Error())
		return
	}
	if strings.TrimSpace(req.Text) == "" {
		aitools.WriteErr(w, r, http.StatusBadRequest, "invalid_payload",
			"`text` must be non-empty")
		return
	}
	audience := strings.ToLower(strings.TrimSpace(req.Audience))
	switch audience {
	case "", "exec":
		audience = "exec"
	case "team", "client":
	default:
		aitools.WriteErr(w, r, http.StatusBadRequest, "invalid_payload",
			"`audience` must be exec, team, or client")
		return
	}
	length := strings.ToLower(strings.TrimSpace(req.Length))
	switch length {
	case "", "brief":
		length = "brief"
	case "medium", "bullets":
	default:
		aitools.WriteErr(w, r, http.StatusBadRequest, "invalid_payload",
			"`length` must be brief, medium, or bullets")
		return
	}

	ctx, cancel := context.WithTimeout(r.Context(), h.PromptTimeout)
	defer cancel()

	user := fmt.Sprintf("Audience: %s\nLength: %s\n\nText:\n%s",
		audience, length, aitools.Truncate(req.Text, MaxInputChars))

	var parsed struct {
		Summary    string   `json:"summary"`
		Highlights []string `json:"highlights"`
		Risks      []string `json:"risks"`
	}
	res, err := aitools.RunStructured(ctx, h.AI, aitools.StructuredOpts{
		System:      summarizeSystemPrompt,
		User:        user,
		Temperature: 0.2,
		MaxTokens:   maxSummarizeTokens,
		Out:         &parsed,
	})
	if err != nil {
		aitools.WriteAIErr(w, r, err)
		return
	}
	if !res.ParsedOK {
		parsed.Summary = strings.TrimSpace(res.Raw)
	}
	if parsed.Highlights == nil {
		parsed.Highlights = []string{}
	}
	if parsed.Risks == nil {
		parsed.Risks = []string{}
	}

	if h.Log != nil && c != nil {
		h.Log.Info("reportsai.summarize",
			"org_id", c.OrgID, "user_id", c.UserID,
			"audience", audience, "length", length,
			"provider", res.Provider, "model", res.Model)
	}
	aitools.WriteJSON(w, http.StatusOK, SummarizeResponse{
		Summary:    parsed.Summary,
		Highlights: parsed.Highlights,
		Risks:      parsed.Risks,
		Provider:   res.Provider,
		Model:      res.Model,
	})
}
