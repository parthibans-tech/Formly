// vLLM provider — speaks the OpenAI-compatible HTTP surface that vLLM
// (and TGI / SGLang / LM-Studio / many others) expose by default. The
// same client therefore works against any OpenAI-API-compatible
// inference server with no code change; the operator just points
// AI_BASE_URL at it.
//
// Endpoints:
//
//   POST {base}/v1/chat/completions  (OpenAI shape)
//   POST {base}/v1/embeddings        (OpenAI shape)
//
// We implement Embed against the same endpoint so a vLLM deployment
// running an embedding model alongside a chat model gets `Embed`
// support out of the box. Capabilities.Embed is reported true
// unconditionally — operators who haven't loaded an embedding model
// will see real 4xx errors at call-time, which is louder and more
// debuggable than silent feature-hiding.

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

type vllmClient struct {
	cfg  Config
	http *http.Client
	base string
}

func newVLLM(cfg Config) Client {
	base := strings.TrimRight(cfg.BaseURL, "/")
	if base == "" {
		base = "http://localhost:8000"
	}
	if cfg.ChatModel == "" {
		cfg.ChatModel = "meta-llama/Meta-Llama-3.1-8B-Instruct"
	}
	if cfg.EmbedModel == "" {
		cfg.EmbedModel = "nomic-ai/nomic-embed-text-v1.5"
	}
	return &vllmClient{
		cfg:  cfg,
		http: &http.Client{Timeout: cfg.Timeout},
		base: base,
	}
}

func (c *vllmClient) Enabled() bool    { return true }
func (c *vllmClient) Provider() string { return ProviderVLLM }
func (c *vllmClient) Capabilities() Capabilities {
	return Capabilities{
		Chat:   true,
		Embed:  true,
		Vision: c.cfg.VisionModel != "",
	}
}

type oaiChatReq struct {
	Model       string        `json:"model"`
	Messages    []ChatMessage `json:"messages"`
	Temperature float64       `json:"temperature,omitempty"`
	MaxTokens   int           `json:"max_tokens,omitempty"`
}

type oaiChatResp struct {
	Model   string `json:"model"`
	Choices []struct {
		Message ChatMessage `json:"message"`
	} `json:"choices"`
}

func (c *vllmClient) Chat(ctx context.Context, req ChatRequest) (ChatResponse, error) {
	model := req.Model
	if model == "" {
		model = c.cfg.ChatModel
	}
	body := oaiChatReq{
		Model:       model,
		Messages:    req.Messages,
		Temperature: req.Temperature,
		MaxTokens:   req.MaxTokens,
	}
	var out oaiChatResp
	if err := c.post(ctx, "/v1/chat/completions", body, &out); err != nil {
		return ChatResponse{}, fmt.Errorf("vllm chat: %w", err)
	}
	if len(out.Choices) == 0 {
		return ChatResponse{}, errors.New("vllm chat: empty response")
	}
	return ChatResponse{Content: out.Choices[0].Message.Content, Model: out.Model}, nil
}

type oaiEmbedReq struct {
	Model string `json:"model"`
	Input string `json:"input"`
}

type oaiEmbedResp struct {
	Model string `json:"model"`
	Data  []struct {
		Embedding []float32 `json:"embedding"`
	} `json:"data"`
}

func (c *vllmClient) Embed(ctx context.Context, req EmbedRequest) (EmbedResponse, error) {
	model := req.Model
	if model == "" {
		model = c.cfg.EmbedModel
	}
	body := oaiEmbedReq{Model: model, Input: req.Input}
	var out oaiEmbedResp
	if err := c.post(ctx, "/v1/embeddings", body, &out); err != nil {
		return EmbedResponse{}, fmt.Errorf("vllm embed: %w", err)
	}
	if len(out.Data) == 0 {
		return EmbedResponse{}, errors.New("vllm embed: empty response")
	}
	return EmbedResponse{Embedding: out.Data[0].Embedding, Model: out.Model}, nil
}

func (c *vllmClient) post(ctx context.Context, path string, body, out any) error {
	buf, err := json.Marshal(body)
	if err != nil {
		return err
	}
	req, err := http.NewRequestWithContext(ctx, "POST", c.base+path, bytes.NewReader(buf))
	if err != nil {
		return err
	}
	req.Header.Set("Content-Type", "application/json")
	if c.cfg.APIKey != "" {
		req.Header.Set("Authorization", "Bearer "+c.cfg.APIKey)
	}
	resp, err := c.http.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode >= 300 {
		b, _ := io.ReadAll(io.LimitReader(resp.Body, 4096))
		return fmt.Errorf("vllm %s: %s — %s", path, resp.Status, strings.TrimSpace(string(b)))
	}
	return json.NewDecoder(resp.Body).Decode(out)
}
