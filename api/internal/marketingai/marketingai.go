// Package marketingai owns the AI endpoints for the Marketing
// starter family (one-pager, brochure, proposal, pitch-deck-page,
// case-study, landing-page, etc.).
//
// Endpoints:
//
//	POST /v1/starters/marketing/ai/section   — section name + brief → drafted block
//	POST /v1/starters/marketing/ai/headline  — brief → array of headline candidates
//
// /headline returns a top-level JSON array, so we use AcceptArray on
// the shared aitools helper.
package marketingai

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
	DefaultPromptTimeout = 150 * time.Second
	maxSectionTokens     = 700
	maxHeadlineTokens    = 350
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
	r.With(timeout).Post("/v1/starters/marketing/ai/section", h.SectionHTTP)
	r.With(timeout).Post("/v1/starters/marketing/ai/headline", h.HeadlineHTTP)
}

/* ------------------------------ Section ------------------------------ */

type SectionRequest struct {
	// Name: hero | features | cta | about | testimonial | pricing |
	// problem | solution | how-it-works — the section's role on the
	// page. Free-text accepted; common values get the best prompts.
	Name string `json:"name"`
	// Brief: short product description / context the section should be
	// grounded in.
	Brief string `json:"brief"`
	// Audience: who's reading. Free-text.
	Audience string `json:"audience,omitempty"`
	// Tone: bold | friendly | technical | playful (default friendly).
	Tone string `json:"tone,omitempty"`
}

type SectionResponse struct {
	Heading    string   `json:"heading"`
	Subheading string   `json:"subheading,omitempty"`
	Body       string   `json:"body"`
	Bullets    []string `json:"bullets,omitempty"`
	CTA        string   `json:"cta,omitempty"`
	Provider   string   `json:"provider"`
	Model      string   `json:"model,omitempty"`
}

const sectionSystemPrompt = `You draft marketing-page sections. Output strict JSON:

{
  "heading": "<short, scannable>",
  "subheading": "<optional, one sentence>",
  "body": "<one short paragraph, 2-4 sentences>",
  "bullets": ["<bullet>", "..."],
  "cta": "<optional, short call to action>"
}

Rules:
- Output only the JSON object — no commentary, no fences.
- 0-5 bullets. Every field except "heading" and "body" is optional —
  omit (or leave empty) what doesn't fit the section's role.
- Avoid superlatives unless they're verifiable from the brief.
- Match the requested tone.`

func (h *Handler) SectionHTTP(w http.ResponseWriter, r *http.Request) {
	c, _ := r.Context().Value(auth.UserCtxKey).(*auth.Claims)

	var req SectionRequest
	if err := aitools.DecodeJSON(w, r, &req, aitools.SmallReqCap); err != nil {
		aitools.WriteErr(w, r, http.StatusBadRequest, "invalid_payload", err.Error())
		return
	}
	if strings.TrimSpace(req.Name) == "" || strings.TrimSpace(req.Brief) == "" {
		aitools.WriteErr(w, r, http.StatusBadRequest, "invalid_payload",
			"`name` and `brief` must be non-empty")
		return
	}
	tone := strings.ToLower(strings.TrimSpace(req.Tone))
	switch tone {
	case "", "friendly":
		tone = "friendly"
	case "bold", "technical", "playful":
	default:
		aitools.WriteErr(w, r, http.StatusBadRequest, "invalid_payload",
			"`tone` must be bold, friendly, technical, or playful")
		return
	}

	ctx, cancel := context.WithTimeout(r.Context(), h.PromptTimeout)
	defer cancel()

	user := fmt.Sprintf("Section: %s\nAudience: %s\nTone: %s\n\nBrief:\n%s",
		req.Name,
		aitools.Coalesce(req.Audience, "(unspecified)"),
		tone,
		aitools.Truncate(req.Brief, 4000))

	var parsed SectionResponse
	res, err := aitools.RunStructured(ctx, h.AI, aitools.StructuredOpts{
		System:      sectionSystemPrompt,
		User:        user,
		Temperature: 0.6,
		MaxTokens:   maxSectionTokens,
		Out:         &parsed,
	})
	if err != nil {
		aitools.WriteAIErr(w, r, err)
		return
	}
	parsed.Provider = res.Provider
	parsed.Model = res.Model
	if !res.ParsedOK {
		parsed.Heading = req.Name
		parsed.Body = strings.TrimSpace(res.Raw)
	}
	if parsed.Bullets == nil {
		parsed.Bullets = []string{}
	}

	if h.Log != nil && c != nil {
		h.Log.Info("marketingai.section",
			"org_id", c.OrgID, "user_id", c.UserID,
			"section", req.Name, "tone", tone,
			"provider", res.Provider, "model", res.Model)
	}
	aitools.WriteJSON(w, http.StatusOK, parsed)
}

/* ------------------------------ Headline ------------------------------ */

type HeadlineRequest struct {
	Brief string `json:"brief"`
	// Count of candidates to return. Defaults to 8, capped at 20.
	Count int `json:"count,omitempty"`
	// Style: punchy | benefit-led | curiosity (default benefit-led).
	Style string `json:"style,omitempty"`
}

type HeadlineResponse struct {
	Headlines []string `json:"headlines"`
	Provider  string   `json:"provider"`
	Model     string   `json:"model,omitempty"`
}

const headlineSystemPrompt = `You generate marketing headline candidates. Output strict JSON — a top-level array of strings:

["<headline 1>", "<headline 2>", "..."]

Rules:
- Output ONLY the JSON array — no object wrapper, no commentary, no fences.
- Each headline is one short line (≤ 12 words ideally).
- Genuine variety across candidates — different angles, not paraphrases.
- Match the requested style:
    * punchy: short, declarative, often imperative
    * benefit-led: leads with the user-visible outcome
    * curiosity: opens a loop without being clickbait`

func (h *Handler) HeadlineHTTP(w http.ResponseWriter, r *http.Request) {
	c, _ := r.Context().Value(auth.UserCtxKey).(*auth.Claims)

	var req HeadlineRequest
	if err := aitools.DecodeJSON(w, r, &req, aitools.SmallReqCap); err != nil {
		aitools.WriteErr(w, r, http.StatusBadRequest, "invalid_payload", err.Error())
		return
	}
	if strings.TrimSpace(req.Brief) == "" {
		aitools.WriteErr(w, r, http.StatusBadRequest, "invalid_payload",
			"`brief` must be non-empty")
		return
	}
	if req.Count <= 0 {
		req.Count = 8
	}
	if req.Count > 20 {
		req.Count = 20
	}
	style := strings.ToLower(strings.TrimSpace(req.Style))
	switch style {
	case "", "benefit-led":
		style = "benefit-led"
	case "punchy", "curiosity":
	default:
		aitools.WriteErr(w, r, http.StatusBadRequest, "invalid_payload",
			"`style` must be punchy, benefit-led, or curiosity")
		return
	}

	ctx, cancel := context.WithTimeout(r.Context(), h.PromptTimeout)
	defer cancel()

	user := fmt.Sprintf("Style: %s\nCount: %d\n\nBrief:\n%s",
		style, req.Count, aitools.Truncate(req.Brief, 4000))

	var parsed []string
	res, err := aitools.RunStructured(ctx, h.AI, aitools.StructuredOpts{
		System:      headlineSystemPrompt,
		User:        user,
		Temperature: 0.8,
		MaxTokens:   maxHeadlineTokens,
		Out:         &parsed,
		AcceptArray: true,
	})
	if err != nil {
		aitools.WriteAIErr(w, r, err)
		return
	}
	if !res.ParsedOK || len(parsed) == 0 {
		// Degrade: split raw on lines.
		parsed = nil
		for _, line := range strings.Split(strings.TrimSpace(res.Raw), "\n") {
			line = strings.TrimSpace(line)
			line = strings.TrimPrefix(line, "- ")
			line = strings.TrimPrefix(line, "* ")
			if line != "" {
				parsed = append(parsed, line)
			}
		}
	}
	if len(parsed) > req.Count {
		parsed = parsed[:req.Count]
	}
	if parsed == nil {
		parsed = []string{}
	}

	if h.Log != nil && c != nil {
		h.Log.Info("marketingai.headline",
			"org_id", c.OrgID, "user_id", c.UserID,
			"style", style, "count", len(parsed),
			"provider", res.Provider, "model", res.Model)
	}
	aitools.WriteJSON(w, http.StatusOK, HeadlineResponse{
		Headlines: parsed,
		Provider:  res.Provider,
		Model:     res.Model,
	})
}
