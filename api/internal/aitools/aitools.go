// Package aitools collects the half-dozen helpers every category-level
// AI handler in this codebase needs. It exists because the alternative —
// each new package re-implementing decodeJSON, writeErr, extractJSON,
// and the "call Chat then parse JSON" round-trip — produced verbatim
// duplicates across starterai, hrai, legalai, and friends.
//
// The contract:
//
//   - WriteJSON / WriteErr emit the same envelope shape (`{error: {code,
//     message, requestId}}`) the web client's api() helper unpacks at
//     web/lib/api.ts:170. Sticking to it lets every category-level
//     endpoint surface ApiError uniformly to the frontend.
//
//   - DecodeJSON pairs http.MaxBytesReader with json.DisallowUnknownFields
//     so a 10MB body can't slip through and a typo in a field name fails
//     fast instead of silently dropping data.
//
//   - ExtractJSON / CompactJSON mirror the docchat / starterai tolerance
//     pattern: strip ``` fences, find the first balanced {...} block,
//     unmarshal. Nothing exotic — just the same handful of lines we kept
//     pasting around.
//
//   - RunStructured is the single LLM round-trip: build messages, call
//     ai.Client.Chat, parse the JSON, handle Disabled cleanly. Most
//     category endpoints in this codebase end up being a 30-line wrapper
//     over this one helper.
package aitools

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"strings"

	"github.com/docforge/api/internal/ai"
	"github.com/go-chi/chi/v5/middleware"
)

// ErrAIDisabled is the canonical sentinel a category handler returns
// when its h.AI is the Disabled provider. The HTTP layer maps it to a
// 503 ai_disabled — same shape every category uses.
var ErrAIDisabled = errors.New("aitools: AI is disabled")

/* ----------------------------- envelopes ----------------------------- */

type errorPayload struct {
	Code      string `json:"code"`
	Message   string `json:"message"`
	RequestID string `json:"requestId,omitempty"`
}

type errorBody struct {
	Error errorPayload `json:"error"`
}

// WriteJSON serialises v as JSON with the given status. Any encoding
// error is non-fatal — the status code is already committed.
func WriteJSON(w http.ResponseWriter, code int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(code)
	_ = json.NewEncoder(w).Encode(v)
}

// WriteErr emits a stable JSON error envelope. `code` is the short
// identifier the frontend branches on (`invalid_payload`, `ai_disabled`,
// etc.); `msg` is the user-facing message rendered in toasts.
func WriteErr(w http.ResponseWriter, r *http.Request, status int, code, msg string) {
	WriteJSON(w, status, errorBody{
		Error: errorPayload{
			Code:      code,
			Message:   msg,
			RequestID: middleware.GetReqID(r.Context()),
		},
	})
}

/* ------------------------------ decode ------------------------------- */

// DecodeJSON reads a JSON body into v with a soft size cap. Returns a
// short error suitable for the `message` field of WriteErr; nil when
// the body parsed cleanly.
func DecodeJSON(w http.ResponseWriter, r *http.Request, v any, maxBytes int64) error {
	r.Body = http.MaxBytesReader(w, r.Body, maxBytes)
	dec := json.NewDecoder(r.Body)
	dec.DisallowUnknownFields()
	return dec.Decode(v)
}

/* --------------------------- LLM tolerance --------------------------- */

// ExtractJSON pulls the first balanced {...} block out of raw, stripping
// fenced code blocks first. Mirrors docchat / starterai tolerance — the
// model occasionally adds prose around the JSON despite the prompt.
func ExtractJSON(raw string) string {
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

// ExtractJSONArray is the same tolerance pass but for prompts where the
// expected output is a top-level array, not an object. We have a few
// of those (e.g. ai/headline returns `["...","...",...]`).
func ExtractJSONArray(raw string) string {
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
	start := strings.Index(s, "[")
	end := strings.LastIndex(s, "]")
	if start < 0 || end <= start {
		return ""
	}
	return s[start : end+1]
}

// CompactJSON marshals v to a single-line JSON string. Errors are
// swallowed deliberately — every input has already been decoded from
// JSON, so a re-marshal can only fail on something exotic.
func CompactJSON(v any) string {
	b, err := json.Marshal(v)
	if err != nil {
		return "{}"
	}
	return string(b)
}

// Truncate returns at most n runes of s with a trailing ellipsis when
// trimmed. Used to keep prompt-side excerpts honest when we have to
// clip a long input.
func Truncate(s string, n int) string {
	r := []rune(s)
	if len(r) <= n {
		return s
	}
	return string(r[:n]) + "..."
}

// Coalesce returns s when non-empty, fallback otherwise.
func Coalesce(s, fallback string) string {
	if strings.TrimSpace(s) == "" {
		return fallback
	}
	return s
}

/* ----------------------------- LLM round-trip ----------------------------- */

// StructuredOpts is the per-call knob set for RunStructured. Sane
// defaults come from the call-site; only Temperature/MaxTokens vary
// significantly across categories.
type StructuredOpts struct {
	System      string
	User        string
	Temperature float64
	MaxTokens   int
	// Out: pointer to the caller's destination struct. RunStructured
	// json.Unmarshals the model's output into Out, applying ExtractJSON
	// first to tolerate prose-wrapped responses.
	Out any
	// AcceptArray: when true, parse a top-level JSON array instead of
	// an object. Out must be a *[]T.
	AcceptArray bool
}

// StructuredResult carries the wire-level metadata callers want to
// echo back in the response (provider name, resolved model). The
// parsed payload itself lives wherever opts.Out points.
type StructuredResult struct {
	Provider string
	Model    string
	// Raw is the verbatim model output. Surfaced so a degraded handler
	// can fall back to it when the JSON parse fails.
	Raw string
	// ParsedOK reports whether opts.Out was populated successfully.
	// When false the caller is expected to degrade gracefully (return a
	// "raw text" view to the user) rather than 500.
	ParsedOK bool
}

// RunStructured runs one Chat round-trip and parses the result into
// opts.Out. It does NOT 502 on a parse failure — instead it sets
// ParsedOK=false and returns the raw text in StructuredResult so the
// caller can choose between (a) returning a degraded shape to the user
// and (b) bubbling an error.
//
// Returns an error only when:
//   - the AI client is disabled (ErrAIDisabled — caller should map to 503)
//   - Chat itself errored (network, timeout, provider 4xx/5xx — caller
//     should map to 502 ai_upstream)
func RunStructured(ctx context.Context, c ai.Client, opts StructuredOpts) (StructuredResult, error) {
	if c == nil || !c.Enabled() || !c.Capabilities().Chat {
		return StructuredResult{}, ErrAIDisabled
	}
	resp, err := c.Chat(ctx, ai.ChatRequest{
		Temperature: opts.Temperature,
		MaxTokens:   opts.MaxTokens,
		Messages: []ai.ChatMessage{
			{Role: "system", Content: opts.System},
			{Role: "user", Content: opts.User},
		},
	})
	if err != nil {
		return StructuredResult{}, fmt.Errorf("chat: %w", err)
	}
	out := StructuredResult{
		Provider: c.Provider(),
		Model:    resp.Model,
		Raw:      resp.Content,
	}
	if opts.Out == nil {
		out.ParsedOK = true
		return out, nil
	}
	body := ""
	if opts.AcceptArray {
		body = ExtractJSONArray(resp.Content)
	} else {
		body = ExtractJSON(resp.Content)
	}
	if body == "" {
		// No JSON object found — caller decides whether to degrade.
		return out, nil
	}
	if err := json.Unmarshal([]byte(body), opts.Out); err != nil {
		return out, nil // parse failure → ParsedOK stays false
	}
	out.ParsedOK = true
	return out, nil
}

/* --------------------------- HTTP error mapping --------------------------- */

// WriteAIErr is the standard mapping every category handler uses for
// errors out of RunStructured. ErrAIDisabled → 503; anything else is
// treated as an upstream provider failure → 502 ai_upstream. Pass `log`
// nil to skip server-side logging.
func WriteAIErr(w http.ResponseWriter, r *http.Request, err error) {
	if errors.Is(err, ErrAIDisabled) {
		WriteErr(w, r, http.StatusServiceUnavailable, "ai_disabled",
			"AI features are disabled on this deployment")
		return
	}
	WriteErr(w, r, http.StatusBadGateway, "ai_upstream", err.Error())
}

/* ----------------------------- size caps ----------------------------- */

// Common request size caps. Categories pick whichever fits; using
// constants keeps every handler's cap consistent and reviewable.
const (
	// SmallReqCap covers 99% of category AI requests — a few KB of form
	// data plus a structured spec. 64KB is a comfortable bound that
	// rejects pathological payloads at the network layer.
	SmallReqCap = 64 * 1024
	// MediumReqCap is for category endpoints that may carry a free-text
	// blob (notes, log, description). 256KB covers the longest realistic
	// inputs without inviting abuse.
	MediumReqCap = 256 * 1024
	// LargeReqCap is reserved for endpoints that may carry a full
	// document body — clauses, redline diffs of two trees, etc.
	LargeReqCap = 512 * 1024
)
