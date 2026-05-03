package ai

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

// captureServer is a tiny httptest server that records the last
// request body so tests can assert on the wire shape providers emit.
type captureServer struct {
	*httptest.Server
	lastBody []byte
}

func newCapture(t *testing.T, response string) *captureServer {
	cs := &captureServer{}
	cs.Server = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body, _ := io.ReadAll(r.Body)
		cs.lastBody = body
		w.Header().Set("Content-Type", "application/json")
		_, _ = io.WriteString(w, response)
	}))
	t.Cleanup(cs.Close)
	return cs
}

/* -------------------------- Anthropic -------------------------- */

func TestAnthropic_TextOnly_StaysString(t *testing.T) {
	cs := newCapture(t, `{"model":"x","content":[{"type":"text","text":"ok"}]}`)
	c := newAnthropic(Config{
		Provider: ProviderAnthropic, BaseURL: cs.URL,
		APIKey: "k", ChatModel: "claude-x", Timeout: 5 * time.Second,
	})
	if _, err := c.Chat(context.Background(), ChatRequest{
		Messages: []ChatMessage{{Role: "user", Content: "hello"}},
	}); err != nil {
		t.Fatalf("Chat: %v", err)
	}
	var got map[string]any
	if err := json.Unmarshal(cs.lastBody, &got); err != nil {
		t.Fatalf("decode: %v\nbody: %s", err, cs.lastBody)
	}
	msgs := got["messages"].([]any)
	first := msgs[0].(map[string]any)
	if _, isStr := first["content"].(string); !isStr {
		t.Errorf("text-only message content not a string: %T", first["content"])
	}
}

func TestAnthropic_WithImage_EmitsContentBlocks(t *testing.T) {
	cs := newCapture(t, `{"model":"x","content":[{"type":"text","text":"ok"}]}`)
	c := newAnthropic(Config{
		Provider: ProviderAnthropic, BaseURL: cs.URL,
		APIKey: "k", ChatModel: "claude-x", Timeout: 5 * time.Second,
	})
	imgBytes := []byte{0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a} // PNG header
	if _, err := c.Chat(context.Background(), ChatRequest{
		Messages: []ChatMessage{{
			Role:    "user",
			Content: "find the fields",
			Images:  []ImagePart{{MIME: "image/png", Data: imgBytes}},
		}},
	}); err != nil {
		t.Fatalf("Chat: %v", err)
	}

	var got map[string]any
	if err := json.Unmarshal(cs.lastBody, &got); err != nil {
		t.Fatalf("decode: %v\nbody: %s", err, cs.lastBody)
	}
	msgs := got["messages"].([]any)
	first := msgs[0].(map[string]any)
	blocks, ok := first["content"].([]any)
	if !ok {
		t.Fatalf("content not an array: %T", first["content"])
	}
	if len(blocks) != 2 {
		t.Fatalf("got %d blocks, want 2 (image + text)", len(blocks))
	}
	imgBlock := blocks[0].(map[string]any)
	if imgBlock["type"] != "image" {
		t.Errorf("first block type = %v, want image (images first per Anthropic guide)", imgBlock["type"])
	}
	src := imgBlock["source"].(map[string]any)
	if src["type"] != "base64" {
		t.Errorf("source type = %v, want base64", src["type"])
	}
	if src["media_type"] != "image/png" {
		t.Errorf("media_type = %v, want image/png", src["media_type"])
	}
	wantB64 := base64.StdEncoding.EncodeToString(imgBytes)
	if src["data"] != wantB64 {
		t.Errorf("data = %v, want base64 %q", src["data"], wantB64)
	}
	textBlock := blocks[1].(map[string]any)
	if textBlock["type"] != "text" {
		t.Errorf("second block type = %v, want text", textBlock["type"])
	}
	if textBlock["text"] != "find the fields" {
		t.Errorf("text = %v, want \"find the fields\"", textBlock["text"])
	}
}

func TestAnthropic_DefaultMimeIsPNG(t *testing.T) {
	cs := newCapture(t, `{"model":"x","content":[{"type":"text","text":"ok"}]}`)
	c := newAnthropic(Config{Provider: ProviderAnthropic, BaseURL: cs.URL, APIKey: "k", Timeout: 5 * time.Second})
	if _, err := c.Chat(context.Background(), ChatRequest{
		Messages: []ChatMessage{{
			Role: "user", Content: "x",
			Images: []ImagePart{{Data: []byte{0x00}}}, // no MIME
		}},
	}); err != nil {
		t.Fatalf("Chat: %v", err)
	}
	if !strings.Contains(string(cs.lastBody), `"media_type":"image/png"`) {
		t.Errorf("missing default media_type=image/png in body:\n%s", cs.lastBody)
	}
}

/* --------------------------- Ollama ---------------------------- */

func TestOllama_TextOnly_NoImagesField(t *testing.T) {
	cs := newCapture(t, `{"model":"x","message":{"role":"assistant","content":"ok"}}`)
	c := newOllama(Config{Provider: ProviderOllama, BaseURL: cs.URL, ChatModel: "llava", Timeout: 5 * time.Second})
	if _, err := c.Chat(context.Background(), ChatRequest{
		Messages: []ChatMessage{{Role: "user", Content: "hi"}},
	}); err != nil {
		t.Fatalf("Chat: %v", err)
	}
	if strings.Contains(string(cs.lastBody), `"images"`) {
		t.Errorf("text-only request emitted images field:\n%s", cs.lastBody)
	}
}

func TestOllama_WithImage_EmitsBase64ImagesArray(t *testing.T) {
	cs := newCapture(t, `{"model":"x","message":{"role":"assistant","content":"ok"}}`)
	c := newOllama(Config{Provider: ProviderOllama, BaseURL: cs.URL, ChatModel: "llava", VisionModel: "llava", Timeout: 5 * time.Second})
	imgBytes := []byte{1, 2, 3, 4, 5}
	if _, err := c.Chat(context.Background(), ChatRequest{
		Messages: []ChatMessage{{
			Role: "user", Content: "ocr",
			Images: []ImagePart{{MIME: "image/png", Data: imgBytes}},
		}},
	}); err != nil {
		t.Fatalf("Chat: %v", err)
	}
	var got map[string]any
	if err := json.Unmarshal(cs.lastBody, &got); err != nil {
		t.Fatalf("decode: %v\nbody: %s", err, cs.lastBody)
	}
	msgs := got["messages"].([]any)
	first := msgs[0].(map[string]any)
	imgs, ok := first["images"].([]any)
	if !ok {
		t.Fatalf("images not an array: %T", first["images"])
	}
	if len(imgs) != 1 {
		t.Fatalf("got %d images, want 1", len(imgs))
	}
	wantB64 := base64.StdEncoding.EncodeToString(imgBytes)
	if imgs[0] != wantB64 {
		t.Errorf("image[0] = %v, want base64 %q", imgs[0], wantB64)
	}
}

func TestOllama_VisionCapability_GatedOnVisionModel(t *testing.T) {
	c := newOllama(Config{Provider: ProviderOllama, ChatModel: "llama3"})
	if c.Capabilities().Vision {
		t.Errorf("Vision = true without AI_VISION_MODEL")
	}
	c2 := newOllama(Config{Provider: ProviderOllama, ChatModel: "llama3", VisionModel: "llava"})
	if !c2.Capabilities().Vision {
		t.Errorf("Vision = false with AI_VISION_MODEL set")
	}
}

/* ---------------------------- vLLM ----------------------------- */

func TestVLLM_TextOnly_StaysString(t *testing.T) {
	cs := newCapture(t, `{"model":"x","choices":[{"message":{"role":"assistant","content":"ok"}}]}`)
	c := newVLLM(Config{Provider: ProviderVLLM, BaseURL: cs.URL, ChatModel: "x", Timeout: 5 * time.Second})
	if _, err := c.Chat(context.Background(), ChatRequest{
		Messages: []ChatMessage{{Role: "user", Content: "hi"}},
	}); err != nil {
		t.Fatalf("Chat: %v", err)
	}
	var got map[string]any
	if err := json.Unmarshal(cs.lastBody, &got); err != nil {
		t.Fatalf("decode: %v", err)
	}
	msgs := got["messages"].([]any)
	first := msgs[0].(map[string]any)
	if _, isStr := first["content"].(string); !isStr {
		t.Errorf("text-only content not a string: %T", first["content"])
	}
}

func TestVLLM_WithImage_EmitsDataURIPart(t *testing.T) {
	cs := newCapture(t, `{"model":"x","choices":[{"message":{"role":"assistant","content":"ok"}}]}`)
	c := newVLLM(Config{Provider: ProviderVLLM, BaseURL: cs.URL, ChatModel: "x", VisionModel: "vx", Timeout: 5 * time.Second})
	imgBytes := []byte{0xff, 0xd8, 0xff, 0xe0} // JPEG header
	if _, err := c.Chat(context.Background(), ChatRequest{
		Messages: []ChatMessage{{
			Role: "user", Content: "look",
			Images: []ImagePart{{MIME: "image/jpeg", Data: imgBytes}},
		}},
	}); err != nil {
		t.Fatalf("Chat: %v", err)
	}
	var got map[string]any
	if err := json.Unmarshal(cs.lastBody, &got); err != nil {
		t.Fatalf("decode: %v", err)
	}
	msgs := got["messages"].([]any)
	first := msgs[0].(map[string]any)
	parts, ok := first["content"].([]any)
	if !ok {
		t.Fatalf("content not an array: %T", first["content"])
	}
	if len(parts) != 2 {
		t.Fatalf("got %d parts, want 2", len(parts))
	}
	imgPart := parts[0].(map[string]any)
	if imgPart["type"] != "image_url" {
		t.Errorf("first part type = %v, want image_url", imgPart["type"])
	}
	urlBlock := imgPart["image_url"].(map[string]any)
	wantPrefix := "data:image/jpeg;base64,"
	url, _ := urlBlock["url"].(string)
	if !strings.HasPrefix(url, wantPrefix) {
		t.Errorf("url = %q, want prefix %q", url, wantPrefix)
	}
	if !strings.HasSuffix(url, base64.StdEncoding.EncodeToString(imgBytes)) {
		t.Errorf("url base64 doesn't match input")
	}
}
