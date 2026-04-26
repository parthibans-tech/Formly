// Ollama provider — talks to the Ollama HTTP API at AI_BASE_URL
// (defaults to http://localhost:11434). Implements both `Chat` and
// `Embed`; vision is reported via Capabilities only when AI_VISION_MODEL
// is set, since most operators run a text-only model.
//
// The Ollama API surface we use:
//
//   POST /api/chat       - chat completion
//   POST /api/embeddings - text → vector
//
// We deliberately don't use Ollama's streaming mode here: the higher
// layers (extraction, summarization) want one round-trip per request,
// and the latency win from streaming would surface up through several
// abstraction layers before reaching the user.

package ai

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"
)

type ollamaClient struct {
	cfg  Config
	http *http.Client
	base string
}

func newOllama(cfg Config) Client {
	base := strings.TrimRight(cfg.BaseURL, "/")
	if base == "" {
		base = "http://localhost:11434"
	}
	if cfg.ChatModel == "" {
		cfg.ChatModel = "llama3.1:8b"
	}
	if cfg.EmbedModel == "" {
		cfg.EmbedModel = "nomic-embed-text"
	}
	return &ollamaClient{
		cfg:  cfg,
		http: &http.Client{Timeout: cfg.Timeout},
		base: base,
	}
}

func (c *ollamaClient) Enabled() bool    { return true }
func (c *ollamaClient) Provider() string { return ProviderOllama }
func (c *ollamaClient) Capabilities() Capabilities {
	return Capabilities{
		Chat:   true,
		Embed:  true,
		Vision: c.cfg.VisionModel != "",
	}
}

type ollamaChatReq struct {
	Model    string        `json:"model"`
	Messages []ChatMessage `json:"messages"`
	Stream   bool          `json:"stream"`
	Options  map[string]any `json:"options,omitempty"`
}

type ollamaChatResp struct {
	Model   string `json:"model"`
	Message struct {
		Role    string `json:"role"`
		Content string `json:"content"`
	} `json:"message"`
}

func (c *ollamaClient) Chat(ctx context.Context, req ChatRequest) (ChatResponse, error) {
	model := req.Model
	if model == "" {
		model = c.cfg.ChatModel
	}
	body := ollamaChatReq{
		Model:    model,
		Messages: req.Messages,
		Stream:   false,
	}
	if req.Temperature > 0 || req.MaxTokens > 0 {
		body.Options = map[string]any{}
		if req.Temperature > 0 {
			body.Options["temperature"] = req.Temperature
		}
		if req.MaxTokens > 0 {
			// Ollama calls it `num_predict`. Keep the public surface
			// the same shape across providers.
			body.Options["num_predict"] = req.MaxTokens
		}
	}
	var out ollamaChatResp
	if err := c.post(ctx, "/api/chat", body, &out); err != nil {
		return ChatResponse{}, fmt.Errorf("ollama chat: %w", err)
	}
	return ChatResponse{Content: out.Message.Content, Model: out.Model}, nil
}

type ollamaEmbedReq struct {
	Model  string `json:"model"`
	Prompt string `json:"prompt"`
}

type ollamaEmbedResp struct {
	Embedding []float32 `json:"embedding"`
}

func (c *ollamaClient) Embed(ctx context.Context, req EmbedRequest) (EmbedResponse, error) {
	model := req.Model
	if model == "" {
		model = c.cfg.EmbedModel
	}
	body := ollamaEmbedReq{Model: model, Prompt: req.Input}
	var out ollamaEmbedResp
	if err := c.post(ctx, "/api/embeddings", body, &out); err != nil {
		return EmbedResponse{}, fmt.Errorf("ollama embed: %w", err)
	}
	return EmbedResponse{Embedding: out.Embedding, Model: model}, nil
}

func (c *ollamaClient) post(ctx context.Context, path string, body, out any) error {
	buf, err := json.Marshal(body)
	if err != nil {
		return err
	}
	req, err := http.NewRequestWithContext(ctx, "POST", c.base+path, bytes.NewReader(buf))
	if err != nil {
		return err
	}
	req.Header.Set("Content-Type", "application/json")
	resp, err := c.http.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode >= 300 {
		// Surface the upstream message so misconfigured model names
		// ("model not found") aren't lost behind a generic 500.
		b, _ := io.ReadAll(io.LimitReader(resp.Body, 4096))
		return fmt.Errorf("ollama %s: %s — %s", path, resp.Status, strings.TrimSpace(string(b)))
	}
	return json.NewDecoder(resp.Body).Decode(out)
}
