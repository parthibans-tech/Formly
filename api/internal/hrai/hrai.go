// Package hrai owns the category-level AI endpoints for the HR
// starter family (offer-letter, JD, perf-review, PIP, NDA-employment,
// onboarding checklist, etc.).
//
// Endpoints:
//
//	POST /v1/starters/hr/ai/jd               — role brief → structured JD
//	POST /v1/starters/hr/ai/perf-review      — facts → 3-section review draft
//	POST /v1/starters/hr/ai/pip              — issues → PIP plan with milestones
//
// All three follow the same aitools.RunStructured pattern. The output
// shapes are designed so the frontend can drop the result into the
// matching starter's data tree without re-mapping field names.
package hrai

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
	maxJDTokens          = 1100
	maxReviewTokens      = 1000
	maxPIPTokens         = 1100
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

	r.With(timeout).Post("/v1/starters/hr/ai/jd", h.JDHTTP)
	r.With(timeout).Post("/v1/starters/hr/ai/perf-review", h.PerfReviewHTTP)
	r.With(timeout).Post("/v1/starters/hr/ai/pip", h.PIPHTTP)
}

/* --------------------------------- JD --------------------------------- */

type JDRequest struct {
	Role       string   `json:"role"`
	Level      string   `json:"level,omitempty"`     // intern | jr | mid | sr | staff | principal
	Company    string   `json:"company,omitempty"`
	Location   string   `json:"location,omitempty"`
	Mode       string   `json:"mode,omitempty"`      // remote | hybrid | onsite
	MustHaves  []string `json:"mustHaves,omitempty"` // free-text bullets
	NiceToHave []string `json:"niceToHave,omitempty"`
}

type JDResponse struct {
	Title           string   `json:"title"`
	Summary         string   `json:"summary"`
	Responsibilities []string `json:"responsibilities"`
	Requirements    []string `json:"requirements"`
	NiceToHave      []string `json:"niceToHave"`
	Benefits        []string `json:"benefits"`
	Provider        string   `json:"provider"`
	Model           string   `json:"model,omitempty"`
}

const jdSystemPrompt = `You write job descriptions. Output strict JSON:

{
  "title": "<final job title>",
  "summary": "<2-3 sentence overview>",
  "responsibilities": ["<bullet>", "..."],
  "requirements": ["<bullet>", "..."],
  "niceToHave": ["<bullet>", "..."],
  "benefits": ["<bullet>", "..."]
}

Rules:
- Output only the JSON object — no commentary, no fences.
- 5-8 responsibilities. 4-7 requirements. 0-5 niceToHave. 0-6 benefits.
- Avoid US-only legal boilerplate (EEO, etc.) — leave room for the org to add it.
- Keep bullets concrete; avoid "rockstar/ninja" filler.`

func (h *Handler) JDHTTP(w http.ResponseWriter, r *http.Request) {
	c, _ := r.Context().Value(auth.UserCtxKey).(*auth.Claims)

	var req JDRequest
	if err := aitools.DecodeJSON(w, r, &req, aitools.SmallReqCap); err != nil {
		aitools.WriteErr(w, r, http.StatusBadRequest, "invalid_payload", err.Error())
		return
	}
	if strings.TrimSpace(req.Role) == "" {
		aitools.WriteErr(w, r, http.StatusBadRequest, "invalid_payload",
			"`role` must be non-empty")
		return
	}

	ctx, cancel := context.WithTimeout(r.Context(), h.PromptTimeout)
	defer cancel()

	user := fmt.Sprintf(
		"Role: %s\nLevel: %s\nCompany: %s\nLocation: %s\nMode: %s\nMust-haves: %s\nNice-to-haves: %s",
		req.Role,
		aitools.Coalesce(req.Level, "(unspecified)"),
		aitools.Coalesce(req.Company, "(unspecified)"),
		aitools.Coalesce(req.Location, "(unspecified)"),
		aitools.Coalesce(req.Mode, "(unspecified)"),
		bulletize(req.MustHaves),
		bulletize(req.NiceToHave),
	)

	var parsed JDResponse
	res, err := aitools.RunStructured(ctx, h.AI, aitools.StructuredOpts{
		System:      jdSystemPrompt,
		User:        user,
		Temperature: 0.4,
		MaxTokens:   maxJDTokens,
		Out:         &parsed,
	})
	if err != nil {
		aitools.WriteAIErr(w, r, err)
		return
	}
	parsed.Provider = res.Provider
	parsed.Model = res.Model
	if !res.ParsedOK {
		parsed.Title = req.Role
		parsed.Summary = strings.TrimSpace(res.Raw)
	}
	ensureSlice(&parsed.Responsibilities)
	ensureSlice(&parsed.Requirements)
	ensureSlice(&parsed.NiceToHave)
	ensureSlice(&parsed.Benefits)

	if h.Log != nil && c != nil {
		h.Log.Info("hrai.jd",
			"org_id", c.OrgID, "user_id", c.UserID,
			"role", req.Role, "level", req.Level,
			"provider", res.Provider, "model", res.Model)
	}
	aitools.WriteJSON(w, http.StatusOK, parsed)
}

/* ---------------------------- PerfReview ---------------------------- */

type PerfReviewRequest struct {
	Employee    string         `json:"employee"`
	Role        string         `json:"role,omitempty"`
	Period      string         `json:"period,omitempty"` // "Q1 2026", "H2", "Annual 2025"
	Tone        string         `json:"tone,omitempty"`   // candid | encouraging | balanced (default)
	// Facts: structured inputs the model should ground itself in. Keys
	// are flexible — typical entries are achievements, gaps, peer notes.
	Facts map[string]any `json:"facts,omitempty"`
}

type PerfReviewResponse struct {
	Strengths       []string  `json:"strengths"`
	GrowthAreas     []string  `json:"growthAreas"`
	OverallNarrative string   `json:"overallNarrative"`
	Rating          string    `json:"rating,omitempty"` // exceeds | meets | below
	Provider        string    `json:"provider"`
	Model           string    `json:"model,omitempty"`
}

const perfReviewSystemPrompt = `You draft performance reviews from manager-supplied facts. Output strict JSON:

{
  "strengths": ["<bullet>", "..."],
  "growthAreas": ["<bullet>", "..."],
  "overallNarrative": "<one paragraph, 4-7 sentences>",
  "rating": "exceeds|meets|below"
}

Rules:
- Output only the JSON object — no commentary, no fences.
- Ground every bullet in the facts provided; do not invent achievements.
- 3-6 strengths. 2-5 growthAreas.
- The "rating" is your honest read of the inputs; if there's not enough
  signal to pick one, return an empty string.
- Match the requested tone:
    * candid: direct, names gaps clearly
    * encouraging: emphasises momentum, frames gaps as learning opportunities
    * balanced (default): even-handed across both halves`

func (h *Handler) PerfReviewHTTP(w http.ResponseWriter, r *http.Request) {
	c, _ := r.Context().Value(auth.UserCtxKey).(*auth.Claims)

	var req PerfReviewRequest
	if err := aitools.DecodeJSON(w, r, &req, aitools.MediumReqCap); err != nil {
		aitools.WriteErr(w, r, http.StatusBadRequest, "invalid_payload", err.Error())
		return
	}
	if strings.TrimSpace(req.Employee) == "" {
		aitools.WriteErr(w, r, http.StatusBadRequest, "invalid_payload",
			"`employee` must be non-empty")
		return
	}
	tone := strings.ToLower(strings.TrimSpace(req.Tone))
	switch tone {
	case "", "balanced":
		tone = "balanced"
	case "candid", "encouraging":
	default:
		aitools.WriteErr(w, r, http.StatusBadRequest, "invalid_payload",
			"`tone` must be candid, encouraging, or balanced")
		return
	}

	ctx, cancel := context.WithTimeout(r.Context(), h.PromptTimeout)
	defer cancel()

	user := fmt.Sprintf(
		"Employee: %s\nRole: %s\nPeriod: %s\nTone: %s\n\nFacts (JSON):\n%s",
		req.Employee,
		aitools.Coalesce(req.Role, "(unspecified)"),
		aitools.Coalesce(req.Period, "(unspecified)"),
		tone,
		aitools.CompactJSON(req.Facts),
	)

	var parsed PerfReviewResponse
	res, err := aitools.RunStructured(ctx, h.AI, aitools.StructuredOpts{
		System:      perfReviewSystemPrompt,
		User:        user,
		Temperature: 0.3,
		MaxTokens:   maxReviewTokens,
		Out:         &parsed,
	})
	if err != nil {
		aitools.WriteAIErr(w, r, err)
		return
	}
	parsed.Provider = res.Provider
	parsed.Model = res.Model
	if !res.ParsedOK {
		parsed.OverallNarrative = strings.TrimSpace(res.Raw)
	}
	ensureSlice(&parsed.Strengths)
	ensureSlice(&parsed.GrowthAreas)

	if h.Log != nil && c != nil {
		h.Log.Info("hrai.perf_review",
			"org_id", c.OrgID, "user_id", c.UserID,
			"tone", tone,
			"provider", res.Provider, "model", res.Model)
	}
	aitools.WriteJSON(w, http.StatusOK, parsed)
}

/* -------------------------------- PIP -------------------------------- */

type PIPRequest struct {
	Employee string   `json:"employee"`
	Role     string   `json:"role,omitempty"`
	Issues   []string `json:"issues"` // 1-N concrete performance issues
	// Duration in weeks. Defaults to 4. Capped at 26.
	DurationWeeks int `json:"durationWeeks,omitempty"`
}

type PIPMilestone struct {
	WeekFrom int    `json:"weekFrom"`
	WeekTo   int    `json:"weekTo"`
	Goal     string `json:"goal"`
	Measure  string `json:"measure"`
}

type PIPResponse struct {
	Summary       string         `json:"summary"`
	Expectations  []string       `json:"expectations"`
	Milestones    []PIPMilestone `json:"milestones"`
	SuccessCriteria []string     `json:"successCriteria"`
	Consequences  string         `json:"consequences"`
	DurationWeeks int            `json:"durationWeeks"`
	Provider      string         `json:"provider"`
	Model         string         `json:"model,omitempty"`
}

const pipSystemPrompt = `You draft Performance Improvement Plans (PIPs). Output strict JSON:

{
  "summary": "<2-3 sentence framing of the plan>",
  "expectations": ["<bullet>", "..."],
  "milestones": [
    { "weekFrom": <int>, "weekTo": <int>, "goal": "<short>", "measure": "<observable success criterion>" }
  ],
  "successCriteria": ["<bullet>", "..."],
  "consequences": "<one paragraph: what happens if criteria are not met>"
}

Rules:
- Output only the JSON object — no commentary, no fences.
- Ground every bullet and milestone in the issues provided.
- Milestones must be observable — "be more proactive" is NOT acceptable;
  "ship two design reviews per week, both reviewed by manager" is.
- Milestones should fully cover the requested duration with no gaps.
- "consequences" should be neutral and factual; do not threaten.`

func (h *Handler) PIPHTTP(w http.ResponseWriter, r *http.Request) {
	c, _ := r.Context().Value(auth.UserCtxKey).(*auth.Claims)

	var req PIPRequest
	if err := aitools.DecodeJSON(w, r, &req, aitools.MediumReqCap); err != nil {
		aitools.WriteErr(w, r, http.StatusBadRequest, "invalid_payload", err.Error())
		return
	}
	if strings.TrimSpace(req.Employee) == "" {
		aitools.WriteErr(w, r, http.StatusBadRequest, "invalid_payload",
			"`employee` must be non-empty")
		return
	}
	if len(req.Issues) == 0 {
		aitools.WriteErr(w, r, http.StatusBadRequest, "invalid_payload",
			"`issues` must list at least one item")
		return
	}
	if req.DurationWeeks <= 0 {
		req.DurationWeeks = 4
	}
	if req.DurationWeeks > 26 {
		req.DurationWeeks = 26
	}

	ctx, cancel := context.WithTimeout(r.Context(), h.PromptTimeout)
	defer cancel()

	user := fmt.Sprintf(
		"Employee: %s\nRole: %s\nDuration: %d weeks\n\nIssues:\n%s",
		req.Employee,
		aitools.Coalesce(req.Role, "(unspecified)"),
		req.DurationWeeks,
		bulletize(req.Issues),
	)

	var parsed PIPResponse
	res, err := aitools.RunStructured(ctx, h.AI, aitools.StructuredOpts{
		System:      pipSystemPrompt,
		User:        user,
		Temperature: 0.3,
		MaxTokens:   maxPIPTokens,
		Out:         &parsed,
	})
	if err != nil {
		aitools.WriteAIErr(w, r, err)
		return
	}
	parsed.Provider = res.Provider
	parsed.Model = res.Model
	parsed.DurationWeeks = req.DurationWeeks
	if !res.ParsedOK {
		parsed.Summary = strings.TrimSpace(res.Raw)
	}
	if parsed.Milestones == nil {
		parsed.Milestones = []PIPMilestone{}
	}
	ensureSlice(&parsed.Expectations)
	ensureSlice(&parsed.SuccessCriteria)

	if h.Log != nil && c != nil {
		h.Log.Info("hrai.pip",
			"org_id", c.OrgID, "user_id", c.UserID,
			"duration_weeks", req.DurationWeeks, "issues", len(req.Issues),
			"provider", res.Provider, "model", res.Model)
	}
	aitools.WriteJSON(w, http.StatusOK, parsed)
}

/* ------------------------------ Helpers ------------------------------ */

// bulletize renders a string slice as a "- foo\n- bar" block, or
// "(none)" when empty. Cheaper-to-tokenise than a JSON array for these
// small lists, and reads more naturally in the prompt.
func bulletize(items []string) string {
	if len(items) == 0 {
		return "(none)"
	}
	var b strings.Builder
	for _, s := range items {
		s = strings.TrimSpace(s)
		if s == "" {
			continue
		}
		b.WriteString("- ")
		b.WriteString(s)
		b.WriteString("\n")
	}
	if b.Len() == 0 {
		return "(none)"
	}
	return b.String()
}

func ensureSlice(s *[]string) {
	if *s == nil {
		*s = []string{}
	}
}
