// Package opsai owns the AI endpoint for the Operations starter
// family (SOP, runbook, checklist, work-instruction, training-doc).
//
// Endpoint:
//
//	POST /v1/starters/ops/ai/sop — task description → structured SOP
//
// One endpoint covers the category because the request shape is
// uniform across SOP variants — the difference is which sections of
// the output the consuming starter renders.
package opsai

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
	maxSOPTokens         = 1300
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
		Post("/v1/starters/ops/ai/sop", h.SOPHTTP)
}

type SOPRequest struct {
	// Task — one-line description of what the SOP covers.
	Task string `json:"task"`
	// Audience — who's executing the procedure (free-text).
	Audience string `json:"audience,omitempty"`
	// Constraints — bullets the model must respect (compliance,
	// hardware, environment, etc.).
	Constraints []string `json:"constraints,omitempty"`
	// IncludeRoles — when true, ask the model to populate a RACI-ish
	// matrix. Defaults to false to keep output compact.
	IncludeRoles bool `json:"includeRoles,omitempty"`
}

type SOPStep struct {
	Number      int      `json:"number"`
	Title       string   `json:"title"`
	Detail      string   `json:"detail"`
	Tools       []string `json:"tools,omitempty"`
	WarningFlag bool     `json:"warningFlag,omitempty"`
	Warning     string   `json:"warning,omitempty"`
}

type SOPRole struct {
	Role         string `json:"role"`
	Responsibility string `json:"responsibility"`
}

type SOPResponse struct {
	Title           string    `json:"title"`
	Purpose         string    `json:"purpose"`
	Scope           string    `json:"scope,omitempty"`
	Prerequisites   []string  `json:"prerequisites"`
	Steps           []SOPStep `json:"steps"`
	Roles           []SOPRole `json:"roles,omitempty"`
	SuccessCriteria []string  `json:"successCriteria"`
	Provider        string    `json:"provider"`
	Model           string    `json:"model,omitempty"`
}

const sopSystemPrompt = `You write Standard Operating Procedures (SOPs). Output strict JSON:

{
  "title": "<short, action-oriented>",
  "purpose": "<1-2 sentences>",
  "scope": "<optional: what's in/out>",
  "prerequisites": ["<bullet>", "..."],
  "steps": [
    { "number": 1, "title": "<short>", "detail": "<imperative paragraph>",
      "tools": ["<optional>"], "warningFlag": false, "warning": "<set when warningFlag>" }
  ],
  "roles": [ { "role": "<title>", "responsibility": "<one line>" } ],
  "successCriteria": ["<bullet>", "..."]
}

Rules:
- Output only the JSON object — no commentary, no fences.
- Steps are imperative, ordered, and small enough to mark "done" individually.
- 5-12 steps unless the task is genuinely simpler.
- Set warningFlag=true and provide a warning string for any step that
  carries safety / data-loss risk.
- Omit "roles" entirely when the request did not ask for them.`

func (h *Handler) SOPHTTP(w http.ResponseWriter, r *http.Request) {
	c, _ := r.Context().Value(auth.UserCtxKey).(*auth.Claims)

	var req SOPRequest
	if err := aitools.DecodeJSON(w, r, &req, aitools.MediumReqCap); err != nil {
		aitools.WriteErr(w, r, http.StatusBadRequest, "invalid_payload", err.Error())
		return
	}
	if strings.TrimSpace(req.Task) == "" {
		aitools.WriteErr(w, r, http.StatusBadRequest, "invalid_payload",
			"`task` must be non-empty")
		return
	}

	ctx, cancel := context.WithTimeout(r.Context(), h.PromptTimeout)
	defer cancel()

	rolesNote := "Do NOT include a roles section."
	if req.IncludeRoles {
		rolesNote = "Include a roles section with 2-5 entries."
	}
	user := fmt.Sprintf(
		"Task: %s\nAudience: %s\n%s\n\nConstraints:\n%s",
		aitools.Truncate(req.Task, 1500),
		aitools.Coalesce(req.Audience, "(unspecified)"),
		rolesNote,
		bulletize(req.Constraints),
	)

	var parsed SOPResponse
	res, err := aitools.RunStructured(ctx, h.AI, aitools.StructuredOpts{
		System:      sopSystemPrompt,
		User:        user,
		Temperature: 0.3,
		MaxTokens:   maxSOPTokens,
		Out:         &parsed,
	})
	if err != nil {
		aitools.WriteAIErr(w, r, err)
		return
	}
	parsed.Provider = res.Provider
	parsed.Model = res.Model
	if !res.ParsedOK {
		parsed.Title = req.Task
		parsed.Purpose = strings.TrimSpace(res.Raw)
	}
	if parsed.Steps == nil {
		parsed.Steps = []SOPStep{}
	}
	if parsed.Prerequisites == nil {
		parsed.Prerequisites = []string{}
	}
	if parsed.SuccessCriteria == nil {
		parsed.SuccessCriteria = []string{}
	}
	if !req.IncludeRoles {
		// Drop roles regardless of what the model emitted — caller didn't
		// ask for them and we don't want them rendering in the UI.
		parsed.Roles = nil
	} else if parsed.Roles == nil {
		parsed.Roles = []SOPRole{}
	}

	if h.Log != nil && c != nil {
		h.Log.Info("opsai.sop",
			"org_id", c.OrgID, "user_id", c.UserID,
			"steps", len(parsed.Steps), "include_roles", req.IncludeRoles,
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
