// Anthropic provider — calls the Messages API at api.anthropic.com.
// Implements `Chat` only; Anthropic does not currently expose a
// first-party embeddings endpoint, so `Embed` returns ErrUnsupported
// and Capabilities reports `Embed: false`. Operators who need
// embeddings should keep Ollama (or vLLM with a sidecar embedding
// model) as the active provider — the higher-level "smart search"
// feature is gated on Capabilities.Embed exactly so it can hide when
// the active backend can't produce vectors.

package ai

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strings"
)

// ErrUnsupported is returned when a provider doesn't implement an
// operation that other providers do. Distinct from ErrDisabled — AI
// is on, this particular call just isn't backed by the active
// provider.
var ErrUnsupported = errors.New("ai: operation not supported by active provider")

const anthropicVersion = "2023-06-01"

type anthropicClient struct {
	cfg  Config
	http *http.Client
	base string
}

func newAnthropic(cfg Config) Client {
	base := strings.TrimRight(cfg.BaseURL, "/")
	if base == "" {
		base = "https://api.anthropic.com"
	}
	if cfg.ChatModel == "" {
		// Default to a small, fast Claude model. Operators should
		// override via AI_CHAT_MODEL when they need Sonnet-class
		// quality on long contracts.
		cfg.ChatModel = "claude-3-5-haiku-20241022"
	}
	return &anthropicClient{
		cfg:  cfg,
		http: &http.Client{Timeout: cfg.Timeout},
		base: base,
	}
}

func (c *anthropicClient) Enabled() bool    { return true }
func (c *anthropicClient) Provider() string { return ProviderAnthropic }
func (c *anthropicClient) Capabilities() Capabilities {
	return Capabilities{
		Chat:   true,
		Embed:  false,
		Vision: true, // Claude vision works through the same Messages endpoint.
	}
}

type anthropicChatReq struct {
	Model     string             `json:"model"`
	System    string             `json:"system,omitempty"`
	Messages  []anthropicMessage `json:"messages"`
	MaxTokens int                `json:"max_tokens"`
	Temp      float64            `json:"temperature,omitempty"`
}

type anthropicMessage struct {
	Role    string `json:"role"`
	Content string `json:"content"`
}

type anthropicChatResp struct {
	Model   string `json:"model"`
	Content []struct {
		Type string `json:"type"`
		Text string `json:"text"`
	} `json:"content"`
}

func (c *anthropicClient) Chat(ctx context.Context, req ChatRequest) (ChatResponse, error) {
	model := req.Model
	if model == "" {
		model = c.cfg.ChatModel
	}
	// Anthropic separates "system" from the message list; pull any
	// system messages out of the head and concat them into the
	// dedicated field. This keeps the public ChatRequest shape
	// simple (one slice) without the caller knowing about the
	// distinction.
	var system string
	var msgs []anthropicMessage
	for _, m := range req.Messages {
		if m.Role == "system" {
			if system != "" {
				system += "\n\n"
			}
			system += m.Content
			continue
		}
		msgs = append(msgs, anthropicMessage{Role: m.Role, Content: m.Content})
	}
	maxTok := req.MaxTokens
	if maxTok <= 0 {
		maxTok = 1024
	}
	body := anthropicChatReq{
		Model:     model,
		System:    system,
		Messages:  msgs,
		MaxTokens: maxTok,
		Temp:      req.Temperature,
	}
	var out anthropicChatResp
	if err := c.post(ctx, "/v1/messages", body, &out); err != nil {
		return ChatResponse{}, fmt.Errorf("anthropic chat: %w", err)
	}
	// Concatenate text parts. Tool-use parts (if we add them later)
	// would need a richer return shape; for now the content blocks
	// are always plain text.
	var sb strings.Builder
	for _, p := range out.Content {
		if p.Type == "text" {
			sb.WriteString(p.Text)
		}
	}
	return ChatResponse{Content: sb.String(), Model: out.Model}, nil
}

func (c *anthropicClient) Embed(context.Context, EmbedRequest) (EmbedResponse, error) {
	return EmbedResponse{}, fmt.Errorf("anthropic embed: %w", ErrUnsupported)
}

func (c *anthropicClient) post(ctx context.Context, path string, body, out any) error {
	if c.cfg.APIKey == "" {
		return errors.New("AI_API_KEY is required for the anthropic provider")
	}
	buf, err := json.Marshal(body)
	if err != nil {
		return err
	}
	req, err := http.NewRequestWithContext(ctx, "POST", c.base+path, bytes.NewReader(buf))
	if err != nil {
		return err
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("x-api-key", c.cfg.APIKey)
	req.Header.Set("anthropic-version", anthropicVersion)
	resp, err := c.http.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode >= 300 {
		b, _ := io.ReadAll(io.LimitReader(resp.Body, 4096))
		return fmt.Errorf("anthropic %s: %s — %s", path, resp.Status, strings.TrimSpace(string(b)))
	}
	return json.NewDecoder(resp.Body).Decode(out)
}
