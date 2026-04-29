// Package eduai owns the AI endpoint for the Education starter
// family (syllabus, lesson-plan, study-guide, course-outline).
//
// Endpoint:
//
//	POST /v1/starters/edu/ai/syllabus — course brief → structured syllabus
//
// One endpoint covers the category for the same reason as opsai —
// the variants share a request shape; differences are which output
// fields the consuming starter renders.
package eduai

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
	maxSyllabusTokens    = 1500
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
		Post("/v1/starters/edu/ai/syllabus", h.SyllabusHTTP)
}

type SyllabusRequest struct {
	Course string `json:"course"` // "Intro to Linear Algebra"
	// Level: highschool | undergrad | grad | adult-ed (free-text accepted)
	Level    string `json:"level,omitempty"`
	Weeks    int    `json:"weeks,omitempty"`    // course duration; default 14
	HoursPerWeek int `json:"hoursPerWeek,omitempty"` // default 3
	// Outcomes: optional learning outcomes the syllabus must cover.
	Outcomes []string `json:"outcomes,omitempty"`
}

type SyllabusModule struct {
	Week     int      `json:"week"`
	Title    string   `json:"title"`
	Topics   []string `json:"topics"`
	Readings []string `json:"readings,omitempty"`
	Activity string   `json:"activity,omitempty"`
}

type SyllabusAssessment struct {
	Name    string `json:"name"`
	Type    string `json:"type"` // homework | quiz | midterm | final | project
	Weight  int    `json:"weight"` // percentage
	Week    int    `json:"week,omitempty"` // when due
}

type SyllabusResponse struct {
	Course       string               `json:"course"`
	Description  string               `json:"description"`
	Outcomes     []string             `json:"outcomes"`
	Prerequisites []string            `json:"prerequisites"`
	Modules      []SyllabusModule     `json:"modules"`
	Assessments  []SyllabusAssessment `json:"assessments"`
	Policies     []string             `json:"policies,omitempty"`
	Provider     string               `json:"provider"`
	Model        string               `json:"model,omitempty"`
}

const syllabusSystemPrompt = `You design course syllabi. Output strict JSON:

{
  "course": "<official-sounding course title>",
  "description": "<one paragraph overview>",
  "outcomes": ["<bullet>", "..."],
  "prerequisites": ["<bullet>", "..."],
  "modules": [
    { "week": 1, "title": "<short>", "topics": ["<topic>", "..."], "readings": ["<optional>"], "activity": "<optional>" }
  ],
  "assessments": [
    { "name": "<short>", "type": "homework|quiz|midterm|final|project", "weight": <int>, "week": <optional int> }
  ],
  "policies": ["<bullet>", "..."]
}

Rules:
- Output only the JSON object — no commentary, no fences.
- One module per week of the requested duration. No gaps.
- Sum of assessment weights = 100.
- 4-8 outcomes. 3-7 policies (attendance, late-work, academic integrity, etc.).
- Honour any outcomes the user supplied — incorporate them verbatim into the outcomes list.`

func (h *Handler) SyllabusHTTP(w http.ResponseWriter, r *http.Request) {
	c, _ := r.Context().Value(auth.UserCtxKey).(*auth.Claims)

	var req SyllabusRequest
	if err := aitools.DecodeJSON(w, r, &req, aitools.SmallReqCap); err != nil {
		aitools.WriteErr(w, r, http.StatusBadRequest, "invalid_payload", err.Error())
		return
	}
	if strings.TrimSpace(req.Course) == "" {
		aitools.WriteErr(w, r, http.StatusBadRequest, "invalid_payload",
			"`course` must be non-empty")
		return
	}
	if req.Weeks <= 0 {
		req.Weeks = 14
	}
	if req.Weeks > 52 {
		req.Weeks = 52
	}
	if req.HoursPerWeek <= 0 {
		req.HoursPerWeek = 3
	}
	if req.HoursPerWeek > 40 {
		req.HoursPerWeek = 40
	}

	ctx, cancel := context.WithTimeout(r.Context(), h.PromptTimeout)
	defer cancel()

	user := fmt.Sprintf(
		"Course: %s\nLevel: %s\nDuration: %d weeks (%d hours/week)\n\nUser-supplied outcomes:\n%s",
		req.Course,
		aitools.Coalesce(req.Level, "(unspecified)"),
		req.Weeks, req.HoursPerWeek,
		bulletize(req.Outcomes),
	)

	var parsed SyllabusResponse
	res, err := aitools.RunStructured(ctx, h.AI, aitools.StructuredOpts{
		System:      syllabusSystemPrompt,
		User:        user,
		Temperature: 0.4,
		MaxTokens:   maxSyllabusTokens,
		Out:         &parsed,
	})
	if err != nil {
		aitools.WriteAIErr(w, r, err)
		return
	}
	parsed.Provider = res.Provider
	parsed.Model = res.Model
	if !res.ParsedOK {
		parsed.Course = req.Course
		parsed.Description = strings.TrimSpace(res.Raw)
	}
	if parsed.Outcomes == nil {
		parsed.Outcomes = []string{}
	}
	if parsed.Prerequisites == nil {
		parsed.Prerequisites = []string{}
	}
	if parsed.Modules == nil {
		parsed.Modules = []SyllabusModule{}
	}
	if parsed.Assessments == nil {
		parsed.Assessments = []SyllabusAssessment{}
	}

	if h.Log != nil && c != nil {
		h.Log.Info("eduai.syllabus",
			"org_id", c.OrgID, "user_id", c.UserID,
			"weeks", req.Weeks, "modules", len(parsed.Modules),
			"provider", res.Provider, "model", res.Model)
	}
	aitools.WriteJSON(w, http.StatusOK, parsed)
}

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
