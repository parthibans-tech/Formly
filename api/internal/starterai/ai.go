// ai.go — the three LLM-backed handlers (profile summary, cover
// letter, review). Each one shares the same skeleton:
//
//   1. parse + validate the request
//   2. bail with 503 ai_disabled when the AI client can't chat
//   3. build a user prompt from the form data (compact JSON)
//   4. call ai.Client.Chat with a tight token budget
//   5. parse the JSON the model returned, tolerantly
//   6. return the typed response
//
// The tolerant parser mirrors docchat.parseSummary — it strips fences,
// finds the first balanced {...} block, and unmarshals. On total
// failure each handler degrades to the most useful shape it can
// produce so the UI never sees a 502 for "the model returned prose
// instead of JSON".

package starterai

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"strings"

	"github.com/docforge/api/internal/ai"
	"github.com/docforge/api/internal/auth"
)

/* ------------------------------- DTOs ------------------------------- */

// ProfileSummaryRequest is the wire shape for POST /v1/starters/ai/profile-summary.
type ProfileSummaryRequest struct {
	StarterID  string         `json:"starterId"`
	Data       map[string]any `json:"data"`
	Tone       string         `json:"tone,omitempty"`       // confident | neutral | warm
	Length     string         `json:"length,omitempty"`     // short | medium | long
	TargetRole string         `json:"targetRole,omitempty"` // optional bias
}

// ProfileSummaryResponse is what /profile-summary returns on success.
type ProfileSummaryResponse struct {
	Summary      string   `json:"summary"`
	Alternatives []string `json:"alternatives"`
	Provider     string   `json:"provider"`
	Model        string   `json:"model,omitempty"`
}

// CoverLetterRequest carries the resume data plus an optional job
// posting. When `job` is set the model uses it to bias paragraph 2's
// evidence selection.
type CoverLetterRequest struct {
	StarterID string         `json:"starterId"`
	Data      map[string]any `json:"data"`
	Job       *JobPosting    `json:"job,omitempty"`
	Tone      string         `json:"tone,omitempty"`
	Length    string         `json:"length,omitempty"`
	Format    string         `json:"format,omitempty"` // html | markdown | plain (default html)
}

// JobPosting is a deliberately small shape — only the fields the model
// actually uses to tailor its output. Larger fields are bounded by
// MaxJobDescriptionChars at parse time.
type JobPosting struct {
	Company     string `json:"company,omitempty"`
	Title       string `json:"title,omitempty"`
	Description string `json:"description,omitempty"`
	URL         string `json:"url,omitempty"`
}

// CoverLetterPayload is the structured letter the model returns.
type CoverLetterPayload struct {
	Greeting string `json:"greeting"`
	Body     string `json:"body"`
	Closing  string `json:"closing"`
	Format   string `json:"format"`
}

// CoverLetterResponse — the wrapper that also pre-shapes a
// `coverLetterStarter`-compatible payload so the frontend can route
// the user straight into a draft cover letter without re-mapping.
type CoverLetterResponse struct {
	CoverLetter CoverLetterPayload `json:"coverLetter"`
	StarterID   string             `json:"starterId"`   // "cover-letter"
	StarterData map[string]any     `json:"starterData"` // ready to seed coverLetterStarter
	Provider    string             `json:"provider"`
	Model       string             `json:"model,omitempty"`
}

// ReviewRequest powers POST /v1/starters/ai/review.
type ReviewRequest struct {
	StarterID  string         `json:"starterId"`
	Data       map[string]any `json:"data"`
	TargetRole string         `json:"targetRole,omitempty"`
}

// ReviewSection mirrors the JSON shape we instruct the model to emit.
type ReviewSection struct {
	ID              string             `json:"id"`
	Label           string             `json:"label"`
	Status          string             `json:"status"` // good | warn | fail
	Notes           string             `json:"notes"`
	Suggestions     []ReviewSuggestion `json:"suggestions,omitempty"`
	MissingKeywords []string           `json:"missingKeywords,omitempty"`
}

// ReviewSuggestion is a single before/after rewrite anchored to a
// dot-path inside the input data; the UI applies the diff on click.
type ReviewSuggestion struct {
	Path   string `json:"path"`
	Before string `json:"before"`
	After  string `json:"after"`
}

// ReviewResponse — the public wire shape.
type ReviewResponse struct {
	Score    int             `json:"score"`
	Verdict  string          `json:"verdict"`
	Sections []ReviewSection `json:"sections"`
	Provider string          `json:"provider"`
	Model    string          `json:"model,omitempty"`
}

/* ----------------------------- Handlers ----------------------------- */

// ProfileSummaryHTTP serves POST /v1/starters/ai/profile-summary.
func (h *Handler) ProfileSummaryHTTP(w http.ResponseWriter, r *http.Request) {
	c, _ := r.Context().Value(auth.UserCtxKey).(*auth.Claims)

	var req ProfileSummaryRequest
	if err := decodeJSON(w, r, &req, MaxFormDataBytes); err != nil {
		writeErr(w, r, http.StatusBadRequest, "invalid_payload", err.Error())
		return
	}
	if len(req.Data) == 0 {
		writeErr(w, r, http.StatusBadRequest, "invalid_payload",
			"`data` must be a non-empty object")
		return
	}
	if !h.aiAvailable() {
		writeErr(w, r, http.StatusServiceUnavailable, "ai_disabled",
			"AI features are disabled on this deployment")
		return
	}

	ctx, cancel := context.WithTimeout(r.Context(), h.PromptTimeout)
	defer cancel()

	resp, err := h.profileSummary(ctx, req)
	if err != nil {
		h.writeAIErr(w, r, err)
		return
	}

	if h.Log != nil && c != nil {
		h.Log.Info("starterai.profile_summary",
			"org_id", c.OrgID, "user_id", c.UserID,
			"starter_id", req.StarterID,
			"length", coalesce(req.Length, "medium"),
			"tone", coalesce(req.Tone, "neutral"),
			"provider", resp.Provider, "model", resp.Model)
	}
	writeJSON(w, http.StatusOK, resp)
}

// CoverLetterHTTP serves POST /v1/starters/ai/cover-letter.
func (h *Handler) CoverLetterHTTP(w http.ResponseWriter, r *http.Request) {
	c, _ := r.Context().Value(auth.UserCtxKey).(*auth.Claims)

	var req CoverLetterRequest
	if err := decodeJSON(w, r, &req, MaxFormDataBytes); err != nil {
		writeErr(w, r, http.StatusBadRequest, "invalid_payload", err.Error())
		return
	}
	if len(req.Data) == 0 {
		writeErr(w, r, http.StatusBadRequest, "invalid_payload",
			"`data` must be a non-empty object")
		return
	}
	// Truncate the JD on the way in so the prompt budget is bounded
	// regardless of what the user pasted.
	if req.Job != nil && len(req.Job.Description) > MaxJobDescriptionChars {
		req.Job.Description = truncate(req.Job.Description, MaxJobDescriptionChars)
	}
	if req.Format == "" {
		req.Format = "html"
	}
	switch req.Format {
	case "html", "markdown", "plain":
	default:
		writeErr(w, r, http.StatusBadRequest, "invalid_payload",
			"`format` must be html, markdown, or plain")
		return
	}
	if !h.aiAvailable() {
		writeErr(w, r, http.StatusServiceUnavailable, "ai_disabled",
			"AI features are disabled on this deployment")
		return
	}

	ctx, cancel := context.WithTimeout(r.Context(), h.PromptTimeout)
	defer cancel()

	resp, err := h.coverLetter(ctx, req)
	if err != nil {
		h.writeAIErr(w, r, err)
		return
	}

	if h.Log != nil && c != nil {
		h.Log.Info("starterai.cover_letter",
			"org_id", c.OrgID, "user_id", c.UserID,
			"starter_id", req.StarterID, "format", req.Format,
			"provider", resp.Provider, "model", resp.Model)
	}
	writeJSON(w, http.StatusOK, resp)
}

// ReviewHTTP serves POST /v1/starters/ai/review.
func (h *Handler) ReviewHTTP(w http.ResponseWriter, r *http.Request) {
	c, _ := r.Context().Value(auth.UserCtxKey).(*auth.Claims)

	var req ReviewRequest
	if err := decodeJSON(w, r, &req, MaxFormDataBytes); err != nil {
		writeErr(w, r, http.StatusBadRequest, "invalid_payload", err.Error())
		return
	}
	if len(req.Data) == 0 {
		writeErr(w, r, http.StatusBadRequest, "invalid_payload",
			"`data` must be a non-empty object")
		return
	}
	if !h.aiAvailable() {
		writeErr(w, r, http.StatusServiceUnavailable, "ai_disabled",
			"AI features are disabled on this deployment")
		return
	}

	ctx, cancel := context.WithTimeout(r.Context(), h.PromptTimeout)
	defer cancel()

	resp, err := h.review(ctx, req)
	if err != nil {
		h.writeAIErr(w, r, err)
		return
	}

	if h.Log != nil && c != nil {
		h.Log.Info("starterai.review",
			"org_id", c.OrgID, "user_id", c.UserID,
			"starter_id", req.StarterID,
			"score", resp.Score, "sections", len(resp.Sections),
			"provider", resp.Provider, "model", resp.Model)
	}
	writeJSON(w, http.StatusOK, resp)
}

/* --------------------------- Orchestrators --------------------------- */

func (h *Handler) profileSummary(ctx context.Context, req ProfileSummaryRequest) (ProfileSummaryResponse, error) {
	if !h.aiAvailable() {
		return ProfileSummaryResponse{}, ErrAIDisabled
	}
	user := buildProfileSummaryUserPrompt(req)
	resp, err := h.AI.Chat(ctx, ai.ChatRequest{
		Temperature: 0.4,
		MaxTokens:   MaxSummaryTokens,
		Messages: []ai.ChatMessage{
			{Role: "system", Content: profileSummarySystemPrompt},
			{Role: "user", Content: user},
		},
	})
	if err != nil {
		return ProfileSummaryResponse{}, err
	}
	out := parseProfileSummary(resp.Content)
	out.Provider = h.AI.Provider()
	out.Model = resp.Model
	return out, nil
}

func (h *Handler) coverLetter(ctx context.Context, req CoverLetterRequest) (CoverLetterResponse, error) {
	if !h.aiAvailable() {
		return CoverLetterResponse{}, ErrAIDisabled
	}
	user := buildCoverLetterUserPrompt(req)
	resp, err := h.AI.Chat(ctx, ai.ChatRequest{
		Temperature: 0.5,
		MaxTokens:   MaxCoverLetterTokens,
		Messages: []ai.ChatMessage{
			{Role: "system", Content: coverLetterSystemPrompt},
			{Role: "user", Content: user},
		},
	})
	if err != nil {
		return CoverLetterResponse{}, err
	}
	letter := parseCoverLetter(resp.Content, req.Format)
	out := CoverLetterResponse{
		CoverLetter: letter,
		StarterID:   "cover-letter",
		StarterData: shapeCoverLetterStarterData(req, letter),
		Provider:    h.AI.Provider(),
		Model:       resp.Model,
	}
	return out, nil
}

func (h *Handler) review(ctx context.Context, req ReviewRequest) (ReviewResponse, error) {
	if !h.aiAvailable() {
		return ReviewResponse{}, ErrAIDisabled
	}
	user := buildReviewUserPrompt(req)
	resp, err := h.AI.Chat(ctx, ai.ChatRequest{
		Temperature: 0.2, // critique should be stable across retries
		MaxTokens:   MaxReviewTokens,
		Messages: []ai.ChatMessage{
			{Role: "system", Content: reviewSystemPrompt},
			{Role: "user", Content: user},
		},
	})
	if err != nil {
		return ReviewResponse{}, err
	}
	out := parseReview(resp.Content)
	out.Provider = h.AI.Provider()
	out.Model = resp.Model
	return out, nil
}

/* ----------------------------- Prompts ------------------------------ */

// buildProfileSummaryUserPrompt assembles the user-side message. We
// hand the model the data verbatim as JSON — every provider tokenises
// JSON cheaply, and a structured input outperforms a marshalled prose
// version on small models. Length / tone / target-role are stitched in
// as a small instruction block at the top, NOT as system-prompt
// edits — keeping the system prompt static lets us cache it across
// requests on providers that support prefix caching.
func buildProfileSummaryUserPrompt(req ProfileSummaryRequest) string {
	dataJSON := compactJSON(req.Data)

	var b strings.Builder
	b.WriteString("Generate a professional summary for the candidate described below.\n\n")
	if req.TargetRole != "" {
		fmt.Fprintf(&b, "Target role: %s\n", strings.TrimSpace(req.TargetRole))
	}
	fmt.Fprintf(&b, "Tone: %s\n", coalesce(req.Tone, "neutral"))
	fmt.Fprintf(&b, "Length: %s\n", coalesce(req.Length, "medium"))
	b.WriteString("\nResume data (JSON):\n")
	b.WriteString(dataJSON)
	return b.String()
}

func buildCoverLetterUserPrompt(req CoverLetterRequest) string {
	dataJSON := compactJSON(req.Data)

	var b strings.Builder
	b.WriteString("Draft a cover letter for the candidate described below.\n\n")
	fmt.Fprintf(&b, "Tone: %s\n", coalesce(req.Tone, "neutral"))
	fmt.Fprintf(&b, "Length: %s\n", coalesce(req.Length, "medium"))
	fmt.Fprintf(&b, "Body format: %s\n", req.Format)
	if req.Job != nil {
		b.WriteString("\nJob posting:\n")
		if req.Job.Company != "" {
			fmt.Fprintf(&b, "  Company: %s\n", req.Job.Company)
		}
		if req.Job.Title != "" {
			fmt.Fprintf(&b, "  Title: %s\n", req.Job.Title)
		}
		if req.Job.URL != "" {
			fmt.Fprintf(&b, "  URL: %s\n", req.Job.URL)
		}
		if d := strings.TrimSpace(req.Job.Description); d != "" {
			b.WriteString("  Description:\n")
			b.WriteString(d)
			b.WriteString("\n")
		}
	}
	b.WriteString("\nResume data (JSON):\n")
	b.WriteString(dataJSON)
	return b.String()
}

func buildReviewUserPrompt(req ReviewRequest) string {
	dataJSON := compactJSON(req.Data)

	var b strings.Builder
	b.WriteString("Critique the resume data below.\n\n")
	if req.TargetRole != "" {
		fmt.Fprintf(&b, "Target role: %s\n", strings.TrimSpace(req.TargetRole))
	}
	b.WriteString("\nResume data (JSON):\n")
	b.WriteString(dataJSON)
	return b.String()
}

/* --------------------------- JSON parsers --------------------------- */

// parseProfileSummary tolerates fenced output, leading prose, and
// missing alternatives. On total failure it degrades to using the raw
// content as the summary so the UI gets *something* useful.
func parseProfileSummary(raw string) ProfileSummaryResponse {
	body := extractJSON(raw)
	if body == "" {
		return ProfileSummaryResponse{Summary: strings.TrimSpace(raw), Alternatives: []string{}}
	}
	var out struct {
		Summary      string   `json:"summary"`
		Alternatives []string `json:"alternatives"`
	}
	if err := json.Unmarshal([]byte(body), &out); err != nil {
		return ProfileSummaryResponse{Summary: strings.TrimSpace(raw), Alternatives: []string{}}
	}
	if out.Alternatives == nil {
		out.Alternatives = []string{}
	}
	return ProfileSummaryResponse{
		Summary:      strings.TrimSpace(out.Summary),
		Alternatives: out.Alternatives,
	}
}

// parseCoverLetter is similarly tolerant. The raw `format` from the
// request is echoed back verbatim so the client doesn't have to trust
// the model to round-trip it.
func parseCoverLetter(raw, format string) CoverLetterPayload {
	body := extractJSON(raw)
	if body == "" {
		return CoverLetterPayload{Body: strings.TrimSpace(raw), Format: format}
	}
	var out CoverLetterPayload
	if err := json.Unmarshal([]byte(body), &out); err != nil {
		return CoverLetterPayload{Body: strings.TrimSpace(raw), Format: format}
	}
	out.Format = format
	return out
}

// parseReview decodes the structured critique. On parse failure we
// degrade to a single "review" section carrying the model's raw output
// so the UI still has something to render.
func parseReview(raw string) ReviewResponse {
	body := extractJSON(raw)
	if body == "" {
		return degradeReview(raw)
	}
	var out ReviewResponse
	if err := json.Unmarshal([]byte(body), &out); err != nil {
		return degradeReview(raw)
	}
	if out.Sections == nil {
		out.Sections = []ReviewSection{}
	}
	for i := range out.Sections {
		if out.Sections[i].Suggestions == nil {
			out.Sections[i].Suggestions = []ReviewSuggestion{}
		}
		if out.Sections[i].MissingKeywords == nil {
			out.Sections[i].MissingKeywords = []string{}
		}
	}
	return out
}

func degradeReview(raw string) ReviewResponse {
	return ReviewResponse{
		Score:   0,
		Verdict: "Could not parse the AI response — showing raw output below.",
		Sections: []ReviewSection{
			{
				ID:     "raw",
				Label:  "Raw response",
				Status: "warn",
				Notes:  strings.TrimSpace(raw),
			},
		},
	}
}

/* ------------------------ Cover-letter shaping ----------------------- */

// shapeCoverLetterStarterData turns the AI output into a payload the
// frontend can drop straight into the existing `coverLetterStarter`'s
// sampleData. We deliberately keep this loose — the cover-letter
// starter has known field names, but a future starter swap can
// override it from the client side without a server round-trip.
func shapeCoverLetterStarterData(req CoverLetterRequest, letter CoverLetterPayload) map[string]any {
	out := map[string]any{
		"greeting": letter.Greeting,
		"body":     letter.Body,
		"closing":  letter.Closing,
	}

	// Pull a sender block out of the resume data when present. Our
	// resume starters store the candidate under person / contact;
	// we look in both places. Anything we don't find stays absent —
	// the cover-letter starter falls back to its own defaults.
	if person, ok := req.Data["person"].(map[string]any); ok {
		if v, ok := person["name"].(string); ok && v != "" {
			out["sender"] = map[string]any{"name": v}
		}
	}
	if contact, ok := req.Data["contact"].(map[string]any); ok {
		sender, _ := out["sender"].(map[string]any)
		if sender == nil {
			sender = map[string]any{}
		}
		for _, k := range []string{"email", "phone", "location"} {
			if v, ok := contact[k].(string); ok && v != "" {
				sender[k] = v
			}
		}
		out["sender"] = sender
	}

	if req.Job != nil {
		recipient := map[string]any{}
		if req.Job.Company != "" {
			recipient["company"] = req.Job.Company
		}
		if req.Job.Title != "" {
			recipient["title"] = req.Job.Title
		}
		if len(recipient) > 0 {
			out["recipient"] = recipient
		}
	}
	return out
}

/* ------------------------------ Helpers ----------------------------- */

// extractJSON pulls the first balanced {...} block out of a string,
// stripping fenced code blocks first. Mirrors docchat / autotag's
// tolerance — the model occasionally adds prose before or after the
// JSON despite the prompt telling it not to.
func extractJSON(raw string) string {
	s := strings.TrimSpace(raw)
	if s == "" {
		return ""
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
		return ""
	}
	return s[start : end+1]
}

// compactJSON marshals v to a single-line JSON string. We swallow
// errors deliberately: every input has already been decoded from JSON,
// so a re-marshal can only fail on something exotic — and a non-empty
// fallback is more useful to the model than nothing.
func compactJSON(v any) string {
	b, err := json.Marshal(v)
	if err != nil {
		return "{}"
	}
	return string(b)
}

// coalesce returns s when non-empty, fallback otherwise.
func coalesce(s, fallback string) string {
	if strings.TrimSpace(s) == "" {
		return fallback
	}
	return s
}
