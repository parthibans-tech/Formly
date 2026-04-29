// Package legalai owns the category-level endpoints for the Legal
// starter family (NDA, MoU, contract, will, lease, employment-offer,
// service-agreement, partnership, IP-assignment, etc.).
//
// Endpoints:
//
//	POST /v1/starters/legal/ai/explain         — clause → plain-English
//	POST /v1/starters/legal/ai/clause-suggest  — context → drafted clause
//	POST /v1/starters/legal/redline            — pure tree diff, no AI
//
// /redline is deliberately offline — it's a structured diff between two
// data trees (typically the same template, before vs after edits). We
// don't trust an LLM to flag every change in a legal document; the
// tree-diff result is canonical, and a future endpoint can layer an
// LLM "explain this change in plain English" step on top.
package legalai

import (
	"context"
	"fmt"
	"log/slog"
	"net/http"
	"reflect"
	"sort"
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
	maxExplainTokens     = 700
	maxClauseTokens      = 800

	// MaxClauseChars caps the input clause text. Legal clauses are
	// rarely longer than this in practice; bigger paste is almost
	// always a multi-clause paste that should be split first.
	MaxClauseChars = 16_000
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

	r.With(timeout).Post("/v1/starters/legal/ai/explain", h.ExplainHTTP)
	r.With(timeout).Post("/v1/starters/legal/ai/clause-suggest", h.ClauseSuggestHTTP)
	// /redline is pure CPU; no AI budget needed.
	r.Post("/v1/starters/legal/redline", h.RedlineHTTP)
}

/* ------------------------------ Explain ------------------------------ */

// ExplainRequest takes a single clause's text and asks the model for a
// plain-English explanation plus a flagged-risks list.
type ExplainRequest struct {
	StarterID string `json:"starterId,omitempty"`
	// Clause is the verbatim clause text. Truncated to MaxClauseChars
	// before being sent to the model.
	Clause string `json:"clause"`
	// Audience: layperson | counsel — biases vocabulary. Defaults to
	// layperson because that's the surface the in-app helper targets.
	Audience string `json:"audience,omitempty"`
	// Jurisdiction is informational — the model uses it to flag
	// jurisdiction-specific concerns. Free-text; we don't validate.
	Jurisdiction string `json:"jurisdiction,omitempty"`
}

type ExplainResponse struct {
	Plain    string         `json:"plain"`
	Bullets  []string       `json:"bullets"`
	Risks    []ExplainRisk  `json:"risks"`
	Provider string         `json:"provider"`
	Model    string         `json:"model,omitempty"`
}

type ExplainRisk struct {
	Severity string `json:"severity"` // low | med | high
	Note     string `json:"note"`
}

const explainSystemPrompt = `You are a legal writing assistant. Given a single contract clause, output strict JSON explaining what it does in plain language.

Schema:
{
  "plain": "<2-3 sentence plain-English summary>",
  "bullets": ["<short bullet>", "..."],
  "risks": [{ "severity": "low|med|high", "note": "<one line>" }]
}

Rules:
- Output only the JSON object — no commentary, no fences.
- Do NOT give legal advice; describe what the clause says, not what to do about it.
- "risks" should flag asymmetric obligations, perpetual terms, broad indemnities, etc.
- 3-6 bullets. 0-5 risks. If no risks are obvious, return an empty array.`

func (h *Handler) ExplainHTTP(w http.ResponseWriter, r *http.Request) {
	c, _ := r.Context().Value(auth.UserCtxKey).(*auth.Claims)

	var req ExplainRequest
	if err := aitools.DecodeJSON(w, r, &req, aitools.MediumReqCap); err != nil {
		aitools.WriteErr(w, r, http.StatusBadRequest, "invalid_payload", err.Error())
		return
	}
	if strings.TrimSpace(req.Clause) == "" {
		aitools.WriteErr(w, r, http.StatusBadRequest, "invalid_payload",
			"`clause` must be non-empty")
		return
	}
	audience := strings.ToLower(strings.TrimSpace(req.Audience))
	switch audience {
	case "", "layperson":
		audience = "layperson"
	case "counsel":
	default:
		aitools.WriteErr(w, r, http.StatusBadRequest, "invalid_payload",
			"`audience` must be layperson or counsel")
		return
	}

	ctx, cancel := context.WithTimeout(r.Context(), h.PromptTimeout)
	defer cancel()

	user := fmt.Sprintf("Audience: %s\nJurisdiction: %s\n\nClause:\n%s",
		audience,
		aitools.Coalesce(req.Jurisdiction, "(unspecified)"),
		aitools.Truncate(req.Clause, MaxClauseChars))

	var parsed struct {
		Plain   string        `json:"plain"`
		Bullets []string      `json:"bullets"`
		Risks   []ExplainRisk `json:"risks"`
	}
	res, err := aitools.RunStructured(ctx, h.AI, aitools.StructuredOpts{
		System:      explainSystemPrompt,
		User:        user,
		Temperature: 0.2,
		MaxTokens:   maxExplainTokens,
		Out:         &parsed,
	})
	if err != nil {
		aitools.WriteAIErr(w, r, err)
		return
	}
	if !res.ParsedOK {
		// Degrade: the raw model output as a single bullet.
		parsed.Plain = "Could not parse the model's structured response."
		parsed.Bullets = []string{strings.TrimSpace(res.Raw)}
		parsed.Risks = []ExplainRisk{}
	}
	if parsed.Bullets == nil {
		parsed.Bullets = []string{}
	}
	if parsed.Risks == nil {
		parsed.Risks = []ExplainRisk{}
	}

	if h.Log != nil && c != nil {
		h.Log.Info("legalai.explain",
			"org_id", c.OrgID, "user_id", c.UserID,
			"audience", audience, "clause_len", len(req.Clause),
			"risks", len(parsed.Risks),
			"provider", res.Provider, "model", res.Model)
	}

	aitools.WriteJSON(w, http.StatusOK, ExplainResponse{
		Plain:    strings.TrimSpace(parsed.Plain),
		Bullets:  parsed.Bullets,
		Risks:    parsed.Risks,
		Provider: res.Provider,
		Model:    res.Model,
	})
}

/* ---------------------------- ClauseSuggest --------------------------- */

// ClauseSuggestRequest asks for drafted clause text given a prompt.
type ClauseSuggestRequest struct {
	StarterID string `json:"starterId,omitempty"`
	// Topic — the kind of clause the user wants ("non-compete",
	// "termination for convenience", etc.). Free-text.
	Topic string `json:"topic"`
	// Context — surrounding facts the user wants the clause tuned to
	// ("12-month term", "California-governed", "B2B SaaS").
	Context string `json:"context,omitempty"`
	// Style: formal (default) | plain — controls vocabulary register.
	Style string `json:"style,omitempty"`
}

type ClauseSuggestResponse struct {
	Clauses  []ClauseDraft `json:"clauses"`
	Provider string        `json:"provider"`
	Model    string        `json:"model,omitempty"`
}

type ClauseDraft struct {
	Heading string `json:"heading"`
	Body    string `json:"body"`
}

const clauseSuggestSystemPrompt = `You draft contract clauses on request. Output strict JSON:

{ "clauses": [ { "heading": "<short title>", "body": "<clause text>" } ] }

Rules:
- Output only the JSON object — no commentary, no fences.
- Provide 2-3 alternative drafts of the requested clause, each with its own heading.
- Do NOT include placeholder square-bracketed terms unless the input asks for them.
- Each body should be self-contained — a single, balanced paragraph (or two short paragraphs).
- This is starting-point text, not legal advice. Do not editorialise inside the body.`

func (h *Handler) ClauseSuggestHTTP(w http.ResponseWriter, r *http.Request) {
	c, _ := r.Context().Value(auth.UserCtxKey).(*auth.Claims)

	var req ClauseSuggestRequest
	if err := aitools.DecodeJSON(w, r, &req, aitools.SmallReqCap); err != nil {
		aitools.WriteErr(w, r, http.StatusBadRequest, "invalid_payload", err.Error())
		return
	}
	if strings.TrimSpace(req.Topic) == "" {
		aitools.WriteErr(w, r, http.StatusBadRequest, "invalid_payload",
			"`topic` must be non-empty")
		return
	}
	style := strings.ToLower(strings.TrimSpace(req.Style))
	switch style {
	case "", "formal":
		style = "formal"
	case "plain":
	default:
		aitools.WriteErr(w, r, http.StatusBadRequest, "invalid_payload",
			"`style` must be formal or plain")
		return
	}

	ctx, cancel := context.WithTimeout(r.Context(), h.PromptTimeout)
	defer cancel()

	user := fmt.Sprintf("Topic: %s\nStyle: %s\nContext: %s",
		aitools.Truncate(req.Topic, 500),
		style,
		aitools.Coalesce(aitools.Truncate(req.Context, 4000), "(none provided)"))

	var parsed struct {
		Clauses []ClauseDraft `json:"clauses"`
	}
	res, err := aitools.RunStructured(ctx, h.AI, aitools.StructuredOpts{
		System:      clauseSuggestSystemPrompt,
		User:        user,
		Temperature: 0.5,
		MaxTokens:   maxClauseTokens,
		Out:         &parsed,
	})
	if err != nil {
		aitools.WriteAIErr(w, r, err)
		return
	}
	if !res.ParsedOK || len(parsed.Clauses) == 0 {
		// Degrade: one entry containing the raw model output.
		parsed.Clauses = []ClauseDraft{{
			Heading: req.Topic,
			Body:    strings.TrimSpace(res.Raw),
		}}
	}

	if h.Log != nil && c != nil {
		h.Log.Info("legalai.clause_suggest",
			"org_id", c.OrgID, "user_id", c.UserID,
			"topic_len", len(req.Topic), "style", style,
			"drafts", len(parsed.Clauses),
			"provider", res.Provider, "model", res.Model)
	}

	aitools.WriteJSON(w, http.StatusOK, ClauseSuggestResponse{
		Clauses:  parsed.Clauses,
		Provider: res.Provider,
		Model:    res.Model,
	})
}

/* ------------------------------ Redline ------------------------------ */

// RedlineRequest compares two data trees. The result is a flat list of
// dot-paths plus before/after values, suitable for rendering as a
// change list in the UI.
type RedlineRequest struct {
	StarterID string         `json:"starterId,omitempty"`
	Before    map[string]any `json:"before"`
	After     map[string]any `json:"after"`
}

type RedlineChange struct {
	// Op: add | remove | change
	Op string `json:"op"`
	// Path is a dot/bracket-path into the document, e.g.
	// "parties.0.name" or "term.duration".
	Path   string `json:"path"`
	Before any    `json:"before,omitempty"`
	After  any    `json:"after,omitempty"`
}

type RedlineResponse struct {
	Changes []RedlineChange `json:"changes"`
	Counts  RedlineCounts   `json:"counts"`
}

type RedlineCounts struct {
	Added   int `json:"added"`
	Removed int `json:"removed"`
	Changed int `json:"changed"`
}

func (h *Handler) RedlineHTTP(w http.ResponseWriter, r *http.Request) {
	var req RedlineRequest
	if err := aitools.DecodeJSON(w, r, &req, aitools.LargeReqCap); err != nil {
		aitools.WriteErr(w, r, http.StatusBadRequest, "invalid_payload", err.Error())
		return
	}
	changes := Diff(req.Before, req.After)
	out := RedlineResponse{Changes: changes}
	for _, c := range changes {
		switch c.Op {
		case "add":
			out.Counts.Added++
		case "remove":
			out.Counts.Removed++
		case "change":
			out.Counts.Changed++
		}
	}
	aitools.WriteJSON(w, http.StatusOK, out)
}

// Diff returns the flat redline between two arbitrary JSON trees.
// Exported so other category packages (HR offer-letter revisions,
// quote-to-invoice conversion) can reuse it.
//
// Semantics:
//   - Maps: recurse on each key; missing key on either side becomes
//     an add/remove at that path.
//   - Slices: index-aligned compare. We don't try to detect inserts
//     in the middle (that would require LCS); the typical starter
//     usage edits in place.
//   - Scalars: deep-equal compare via reflect.DeepEqual; differing
//     values yield a single "change" entry.
//
// Output is sorted by path for stable rendering.
func Diff(before, after map[string]any) []RedlineChange {
	var out []RedlineChange
	walk("", before, after, &out)
	sort.SliceStable(out, func(i, j int) bool { return out[i].Path < out[j].Path })
	return out
}

func walk(prefix string, b, a any, out *[]RedlineChange) {
	switch bv := b.(type) {
	case map[string]any:
		av, ok := a.(map[string]any)
		if !ok {
			// Type changed (object → something else, or removed entirely).
			*out = append(*out, RedlineChange{Op: opFor(b, a), Path: prefix, Before: b, After: a})
			return
		}
		// Union of keys, sorted for determinism.
		seen := map[string]bool{}
		for k := range bv {
			seen[k] = true
		}
		for k := range av {
			seen[k] = true
		}
		keys := make([]string, 0, len(seen))
		for k := range seen {
			keys = append(keys, k)
		}
		sort.Strings(keys)
		for _, k := range keys {
			walk(joinPath(prefix, k), bv[k], av[k], out)
		}
	case []any:
		av, ok := a.([]any)
		if !ok {
			*out = append(*out, RedlineChange{Op: opFor(b, a), Path: prefix, Before: b, After: a})
			return
		}
		n := len(bv)
		if len(av) > n {
			n = len(av)
		}
		for i := 0; i < n; i++ {
			var bi, ai any
			if i < len(bv) {
				bi = bv[i]
			}
			if i < len(av) {
				ai = av[i]
			}
			walk(fmt.Sprintf("%s.%d", prefix, i), bi, ai, out)
		}
	default:
		if reflect.DeepEqual(b, a) {
			return
		}
		*out = append(*out, RedlineChange{Op: opFor(b, a), Path: prefix, Before: b, After: a})
	}
}

func opFor(b, a any) string {
	if isNil(b) && !isNil(a) {
		return "add"
	}
	if !isNil(b) && isNil(a) {
		return "remove"
	}
	return "change"
}

func isNil(v any) bool {
	if v == nil {
		return true
	}
	switch x := v.(type) {
	case string:
		return x == ""
	case []any:
		return len(x) == 0
	case map[string]any:
		return len(x) == 0
	}
	return false
}

func joinPath(prefix, key string) string {
	if prefix == "" {
		return key
	}
	return prefix + "." + key
}
