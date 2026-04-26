// Package ai is the single seam through which the rest of the API
// reaches a language model. It abstracts over three concrete back-ends
// — Ollama (default for self-hosted), vLLM (production SaaS), and
// Anthropic (cloud quality tier) — plus a Disabled provider that
// returns ErrDisabled for every call.
//
// # Off-by-default contract
//
// AI is OFF unless the operator opts in. The constructor returns a
// Disabled client when the env var `AI_ENABLED` is anything other than
// "1" / "true" / "yes" — including unset. Code that wants to call
// `Chat`/`Embed` should always check `Enabled()` first or handle
// ErrDisabled, never panic on it.
//
// The same flag drives the public `/v1/ai/config` endpoint, which the
// frontend calls once at boot to decide whether to show AI buttons.
// One source of truth on the server, one fetch on the client — no way
// for the UI to drift from the backend's actual capability.
//
// # Why an interface, not just a struct
//
// Three reasons:
//
//  1. The Disabled provider needs to satisfy the same shape so callers
//     can hold a `Client` field unconditionally and not nil-check.
//  2. Tests can drop in a fake without spinning up Ollama.
//  3. We expect on-prem deployments to swap Ollama for vLLM (or the
//     other way around) with one config change.
//
// # Capabilities
//
// Not every provider supports every operation. Anthropic, for
// instance, has no first-party embedding endpoint at the time of
// writing. The `Capabilities` struct lets the frontend hide UI for
// operations the active provider can't fulfil — e.g. show the
// "Smart search" tab only when `Embed: true`.
package ai

import (
	"context"
	"errors"
	"fmt"
	"os"
	"strconv"
	"strings"
	"time"
)

// ErrDisabled is returned by every method on the Disabled provider and
// should be wrapped (not replaced) by call-sites that want to surface
// a friendlier message.
var ErrDisabled = errors.New("ai: feature disabled")

// Provider names. Stable strings — we expose them through `/v1/ai/config`
// so the frontend can branch on provider when it needs to (e.g. show a
// "Powered by Anthropic" footer in the UI).
const (
	ProviderDisabled  = "disabled"
	ProviderOllama    = "ollama"
	ProviderVLLM      = "vllm"
	ProviderAnthropic = "anthropic"
)

// Capabilities describes what the active provider can do. The
// frontend reads this through `/v1/ai/config` to decide which AI
// features to mount in the UI.
type Capabilities struct {
	// Chat: free-form / structured chat completion. Required for
	// summarization, extraction, tag suggestions.
	Chat bool `json:"chat"`
	// Embed: vector embeddings. Required for semantic search.
	Embed bool `json:"embed"`
	// Vision: multi-modal input (images). Required for receipt /
	// invoice OCR-style flows.
	Vision bool `json:"vision"`
}

// ChatMessage is a minimal role/content pair. Extended later (tool
// calls, image parts) without breaking callers.
type ChatMessage struct {
	Role    string `json:"role"`    // "system" | "user" | "assistant"
	Content string `json:"content"`
}

// ChatRequest is provider-agnostic. We deliberately keep the surface
// small — Temperature/MaxTokens cover the 90% case and anything more
// exotic would leak provider specifics.
type ChatRequest struct {
	Model       string        `json:"model,omitempty"`
	Messages    []ChatMessage `json:"messages"`
	Temperature float64       `json:"temperature,omitempty"`
	MaxTokens   int           `json:"max_tokens,omitempty"`
}

// ChatResponse is what every provider's `Chat` returns after we
// normalise the wire-level shape.
type ChatResponse struct {
	Content string `json:"content"`
	Model   string `json:"model"`
}

// EmbedRequest / EmbedResponse: one input string in, one float vector
// out. Batched callers should range over inputs themselves — we keep
// the API single-shot so error semantics stay obvious (one input ↔ one
// embedding ↔ one error). The provider implementations may still
// batch under the hood when given a slice via `EmbedBatch`.
type EmbedRequest struct {
	Model string `json:"model,omitempty"`
	Input string `json:"input"`
}

type EmbedResponse struct {
	Embedding []float32 `json:"embedding"`
	Model     string    `json:"model"`
}

// Client is the seam every higher-level package depends on. Always
// non-nil; check `Enabled()` rather than nil-checking the field.
type Client interface {
	// Enabled reports whether AI features are turned on. The Disabled
	// provider always returns false.
	Enabled() bool
	// Provider returns one of the Provider* constants. Useful for
	// telemetry and the public /v1/ai/config response.
	Provider() string
	// Capabilities reports what the active provider supports.
	Capabilities() Capabilities

	// Chat runs a single chat-completion round. Returns ErrDisabled on
	// the Disabled provider.
	Chat(ctx context.Context, req ChatRequest) (ChatResponse, error)
	// Embed turns a single input string into a vector. Returns
	// ErrDisabled on the Disabled provider, or a wrapped error on
	// providers without embedding support.
	Embed(ctx context.Context, req EmbedRequest) (EmbedResponse, error)
}

// Config is the operator-supplied configuration. Populated from env
// vars by NewFromEnv but exposed as a struct so tests can build
// clients without setenv shenanigans.
type Config struct {
	Enabled      bool
	Provider     string
	BaseURL      string        // Ollama / vLLM endpoint
	APIKey       string        // Anthropic / vLLM bearer
	ChatModel    string        // e.g. "llama3.1:8b" / "claude-3-5-sonnet-20241022"
	EmbedModel   string        // e.g. "nomic-embed-text"
	Timeout      time.Duration // per-request timeout; defaults to 60s
	VisionModel  string        // optional, only set if vision is supported
}

// NewFromEnv builds a Client from environment variables. The contract
// is intentionally narrow:
//
//   - AI_ENABLED   — required to opt in. Anything other than 1/true/yes
//                    yields a Disabled client and main.go should still
//                    boot cleanly.
//   - AI_PROVIDER  — ollama | vllm | anthropic. Defaults to ollama.
//   - AI_BASE_URL  — provider endpoint. Defaults per provider.
//   - AI_API_KEY   — bearer for cloud providers.
//   - AI_CHAT_MODEL / AI_EMBED_MODEL — model identifiers; defaults
//                    pick a reasonable model per provider.
//
// Callers should log the returned `Provider()` once at startup so
// "AI looks broken" support tickets immediately reveal whether the
// flag is even on.
func NewFromEnv() Client {
	cfg := Config{
		Enabled:     parseBool(os.Getenv("AI_ENABLED")),
		Provider:    strings.ToLower(strings.TrimSpace(os.Getenv("AI_PROVIDER"))),
		BaseURL:     strings.TrimSpace(os.Getenv("AI_BASE_URL")),
		APIKey:      strings.TrimSpace(os.Getenv("AI_API_KEY")),
		ChatModel:   strings.TrimSpace(os.Getenv("AI_CHAT_MODEL")),
		EmbedModel:  strings.TrimSpace(os.Getenv("AI_EMBED_MODEL")),
		VisionModel: strings.TrimSpace(os.Getenv("AI_VISION_MODEL")),
		Timeout:     parseTimeoutSec(os.Getenv("AI_TIMEOUT_SEC")),
	}
	return New(cfg)
}

// parseTimeoutSec reads AI_TIMEOUT_SEC and returns a Duration. The
// default of 180s is deliberately generous: ollama / vllm cold loads
// on a memory-pressured laptop can take 90-150s for a 2-3B model
// (disk → RAM swap, mmap fault-in), and we'd rather have the user
// wait a bit on first call than 502 a real request. Hot calls return
// in seconds — the long tail only hits cold-start. Override down for
// hosted providers (anthropic responds in <30s) or up if you're on a
// truly slow disk.
func parseTimeoutSec(raw string) time.Duration {
	const fallback = 180 * time.Second
	if raw == "" {
		return fallback
	}
	n, err := strconv.Atoi(strings.TrimSpace(raw))
	if err != nil || n <= 0 {
		return fallback
	}
	return time.Duration(n) * time.Second
}

// New builds a Client from an explicit Config. Splitting this out of
// NewFromEnv lets tests construct providers directly and lets the
// future "platform admin can flip AI on/off through the UI" path
// reuse the same factory after persisting the config row.
func New(cfg Config) Client {
	if !cfg.Enabled {
		return Disabled{}
	}
	if cfg.Timeout <= 0 {
		cfg.Timeout = 180 * time.Second
	}
	switch cfg.Provider {
	case "", ProviderOllama:
		return newOllama(cfg)
	case ProviderVLLM:
		return newVLLM(cfg)
	case ProviderAnthropic:
		return newAnthropic(cfg)
	default:
		// Misconfigured provider: fall back to Disabled rather than
		// panicking. The /v1/ai/config endpoint will report
		// provider="disabled" so the operator can spot it.
		return Disabled{}
	}
}

/* ------------------------- Disabled provider ------------------------- */

// Disabled is the no-op provider that satisfies Client when AI is off.
// Every operation returns ErrDisabled wrapped with the method name so
// stack-trace-only logs are still actionable.
type Disabled struct{}

func (Disabled) Enabled() bool       { return false }
func (Disabled) Provider() string    { return ProviderDisabled }
func (Disabled) Capabilities() Capabilities { return Capabilities{} }
func (Disabled) Chat(context.Context, ChatRequest) (ChatResponse, error) {
	return ChatResponse{}, fmt.Errorf("chat: %w", ErrDisabled)
}
func (Disabled) Embed(context.Context, EmbedRequest) (EmbedResponse, error) {
	return EmbedResponse{}, fmt.Errorf("embed: %w", ErrDisabled)
}

/* ----------------------------- helpers ------------------------------- */

func parseBool(s string) bool {
	switch strings.ToLower(strings.TrimSpace(s)) {
	case "1", "true", "yes", "on":
		return true
	}
	return false
}
