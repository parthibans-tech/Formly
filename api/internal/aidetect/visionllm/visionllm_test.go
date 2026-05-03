package visionllm

import (
	"context"
	"encoding/base64"
	"errors"
	"strings"
	"testing"

	"github.com/docforge/api/internal/ai"
	"github.com/docforge/api/internal/ocr"
)

// fakeClient is an ai.Client double that captures the request and
// returns a scripted response. Tests assert on the captured request
// to verify the prompt + image bytes reach the seam correctly.
type fakeClient struct {
	enabled    bool
	vision     bool
	resp       ai.ChatResponse
	respErr    error
	calls      int
	lastReq    ai.ChatRequest
	respByCall []ai.ChatResponse // optional: round-robin per call
}

func (f *fakeClient) Enabled() bool                { return f.enabled }
func (f *fakeClient) Provider() string             { return "fake" }
func (f *fakeClient) Capabilities() ai.Capabilities {
	return ai.Capabilities{Chat: true, Embed: false, Vision: f.vision}
}
func (f *fakeClient) Chat(_ context.Context, req ai.ChatRequest) (ai.ChatResponse, error) {
	f.lastReq = req
	idx := f.calls
	f.calls++
	if f.respErr != nil {
		return ai.ChatResponse{}, f.respErr
	}
	if idx < len(f.respByCall) {
		return f.respByCall[idx], nil
	}
	return f.resp, nil
}
func (f *fakeClient) Embed(context.Context, ai.EmbedRequest) (ai.EmbedResponse, error) {
	return ai.EmbedResponse{}, errors.New("not implemented")
}

// rasterPage builds a synthetic RasterPage with the given dimensions.
// Bytes are arbitrary — tests that need the exact bytes round-trip
// inspect lastReq.Messages[1].Images[0].Data.
func rasterPage(w, h int, bytes []byte) ocr.RasterPage {
	return ocr.RasterPage{
		W:         w,
		H:         h,
		PNGBase64: base64.StdEncoding.EncodeToString(bytes),
	}
}

func TestDetect_DisabledClientReturnsNil(t *testing.T) {
	fc := &fakeClient{enabled: false, vision: true}
	got, err := Detect(context.Background(), fc, []ocr.RasterPage{rasterPage(100, 100, []byte{1})})
	if err != nil {
		t.Fatalf("err = %v, want nil", err)
	}
	if got != nil {
		t.Errorf("got %d fields, want nil for disabled client", len(got))
	}
	if fc.calls != 0 {
		t.Errorf("Chat called %d times on disabled client", fc.calls)
	}
}

func TestDetect_NoVisionCapabilityReturnsNil(t *testing.T) {
	fc := &fakeClient{enabled: true, vision: false}
	got, err := Detect(context.Background(), fc, []ocr.RasterPage{rasterPage(100, 100, []byte{1})})
	if err != nil {
		t.Fatalf("err = %v, want nil", err)
	}
	if got != nil {
		t.Errorf("got %d fields, want nil when vision=false", len(got))
	}
	if fc.calls != 0 {
		t.Errorf("Chat called %d times when vision=false", fc.calls)
	}
}

func TestDetect_NilClientReturnsNil(t *testing.T) {
	got, err := Detect(context.Background(), nil, []ocr.RasterPage{rasterPage(100, 100, []byte{1})})
	if err != nil {
		t.Fatalf("err = %v, want nil", err)
	}
	if got != nil {
		t.Errorf("got %d fields, want nil for nil client", len(got))
	}
}

func TestDetect_EmptyPagesReturnsNil(t *testing.T) {
	fc := &fakeClient{enabled: true, vision: true}
	got, err := Detect(context.Background(), fc, nil)
	if err != nil {
		t.Fatalf("err = %v, want nil", err)
	}
	if got != nil {
		t.Errorf("got %d fields, want nil for empty pages", len(got))
	}
}

func TestDetect_BareJSONResponseParses(t *testing.T) {
	fc := &fakeClient{
		enabled: true, vision: true,
		resp: ai.ChatResponse{Content: `{"fields":[
			{"type":"text","x":100,"y":50,"w":200,"h":20,"label":"Name","confidence":0.8},
			{"type":"checkbox","x":50,"y":100,"w":12,"h":12,"label":"Subscribe"}
		]}`},
	}
	got, err := Detect(context.Background(), fc, []ocr.RasterPage{rasterPage(800, 1000, []byte{1, 2, 3})})
	if err != nil {
		t.Fatalf("Detect: %v", err)
	}
	if len(got) != 2 {
		t.Fatalf("got %d fields, want 2", len(got))
	}
	if got[0].Type != "text" || got[0].Label != "Name" || got[0].Confidence != 0.8 {
		t.Errorf("field 0 = %+v, want text Name @0.8", got[0])
	}
	if got[1].Type != "checkbox" || got[1].Confidence != DefaultConfidence {
		t.Errorf("field 1 = %+v, want checkbox @DefaultConfidence", got[1])
	}
	if got[0].PageW != 800 || got[0].PageH != 1000 {
		t.Errorf("page dims = %dx%d, want 800x1000", got[0].PageW, got[0].PageH)
	}
}

func TestDetect_MarkdownFencedJSONParses(t *testing.T) {
	fc := &fakeClient{
		enabled: true, vision: true,
		resp: ai.ChatResponse{Content: "Here are the fields:\n```json\n{\"fields\":[{\"type\":\"signature\",\"x\":10,\"y\":20,\"w\":220,\"h\":36,\"label\":\"Sign here\"}]}\n```\n"},
	}
	got, err := Detect(context.Background(), fc, []ocr.RasterPage{rasterPage(800, 1000, []byte{1})})
	if err != nil {
		t.Fatalf("Detect: %v", err)
	}
	if len(got) != 1 || got[0].Type != "signature" {
		t.Fatalf("fields = %+v, want one signature", got)
	}
}

func TestDetect_LooseJSONExtractedFromProse(t *testing.T) {
	fc := &fakeClient{
		enabled: true, vision: true,
		resp: ai.ChatResponse{Content: `I found 1 field. Output: {"fields":[{"type":"text","x":1,"y":1,"w":50,"h":10,"label":"X"}]} Hope that helps!`},
	}
	got, err := Detect(context.Background(), fc, []ocr.RasterPage{rasterPage(100, 100, []byte{1})})
	if err != nil {
		t.Fatalf("Detect: %v", err)
	}
	if len(got) != 1 {
		t.Fatalf("got %d fields, want 1", len(got))
	}
}

func TestDetect_MalformedResponseSkipsPage(t *testing.T) {
	fc := &fakeClient{
		enabled: true, vision: true,
		resp: ai.ChatResponse{Content: `not json at all, model gave up`},
	}
	got, err := Detect(context.Background(), fc, []ocr.RasterPage{rasterPage(100, 100, []byte{1})})
	if err != nil {
		// Per-page failure should be swallowed, not surfaced.
		t.Fatalf("Detect: want nil error on malformed response, got %v", err)
	}
	if got != nil && len(got) != 0 {
		t.Errorf("got %d fields, want 0", len(got))
	}
}

func TestDetect_OnePageFailsOthersSucceed(t *testing.T) {
	fc := &fakeClient{
		enabled: true, vision: true,
		respByCall: []ai.ChatResponse{
			{Content: `{"fields":[{"type":"text","x":1,"y":1,"w":80,"h":12,"label":"P1"}]}`},
			{Content: `garbled`},
			{Content: `{"fields":[{"type":"checkbox","x":5,"y":5,"w":12,"h":12,"label":"P3"}]}`},
		},
	}
	pages := []ocr.RasterPage{
		rasterPage(100, 100, []byte{1}),
		rasterPage(100, 100, []byte{2}),
		rasterPage(100, 100, []byte{3}),
	}
	got, err := Detect(context.Background(), fc, pages)
	if err != nil {
		t.Fatalf("Detect: %v", err)
	}
	if len(got) != 2 {
		t.Fatalf("got %d fields, want 2 (page 2 dropped)", len(got))
	}
	if got[0].Page != 1 || got[0].Label != "P1" {
		t.Errorf("field 0 = %+v, want P1 on page 1", got[0])
	}
	if got[1].Page != 3 || got[1].Label != "P3" {
		t.Errorf("field 1 = %+v, want P3 on page 3", got[1])
	}
}

func TestDetect_AttachesImageToRequest(t *testing.T) {
	imgBytes := []byte{0x89, 0x50, 0x4e, 0x47, 1, 2, 3, 4}
	fc := &fakeClient{
		enabled: true, vision: true,
		resp: ai.ChatResponse{Content: `{"fields":[]}`},
	}
	_, _ = Detect(context.Background(), fc, []ocr.RasterPage{rasterPage(800, 1000, imgBytes)})
	if fc.calls != 1 {
		t.Fatalf("Chat called %d times, want 1", fc.calls)
	}
	msgs := fc.lastReq.Messages
	if len(msgs) != 2 {
		t.Fatalf("got %d messages, want 2 (system + user)", len(msgs))
	}
	if msgs[0].Role != "system" {
		t.Errorf("msg 0 role = %q, want system", msgs[0].Role)
	}
	if msgs[1].Role != "user" {
		t.Errorf("msg 1 role = %q, want user", msgs[1].Role)
	}
	if len(msgs[1].Images) != 1 {
		t.Fatalf("user msg has %d images, want 1", len(msgs[1].Images))
	}
	if msgs[1].Images[0].MIME != "image/png" {
		t.Errorf("MIME = %q, want image/png", msgs[1].Images[0].MIME)
	}
	if string(msgs[1].Images[0].Data) != string(imgBytes) {
		t.Errorf("attached image bytes don't match input")
	}
	if !strings.Contains(msgs[1].Content, "800x1000") {
		t.Errorf("user prompt missing page dims, got %q", msgs[1].Content)
	}
	if fc.lastReq.Temperature != 0 {
		t.Errorf("temperature = %v, want 0 for deterministic JSON", fc.lastReq.Temperature)
	}
}

func TestDetect_DropsInvalidTypes(t *testing.T) {
	fc := &fakeClient{
		enabled: true, vision: true,
		resp: ai.ChatResponse{Content: `{"fields":[
			{"type":"text","x":1,"y":1,"w":50,"h":10,"label":"OK"},
			{"type":"button","x":1,"y":1,"w":50,"h":10,"label":"Bad type"},
			{"type":"dropdown","x":1,"y":1,"w":50,"h":10,"label":"Also bad"}
		]}`},
	}
	got, _ := Detect(context.Background(), fc, []ocr.RasterPage{rasterPage(100, 100, []byte{1})})
	if len(got) != 1 || got[0].Label != "OK" {
		t.Errorf("got %d fields (%+v), want only the text field", len(got), got)
	}
}

func TestDetect_DropsZeroAreaBoxes(t *testing.T) {
	fc := &fakeClient{
		enabled: true, vision: true,
		resp: ai.ChatResponse{Content: `{"fields":[
			{"type":"text","x":10,"y":10,"w":0,"h":10,"label":"zero w"},
			{"type":"text","x":10,"y":10,"w":50,"h":-5,"label":"neg h"},
			{"type":"text","x":10,"y":10,"w":50,"h":10,"label":"OK"}
		]}`},
	}
	got, _ := Detect(context.Background(), fc, []ocr.RasterPage{rasterPage(100, 100, []byte{1})})
	if len(got) != 1 || got[0].Label != "OK" {
		t.Errorf("got %+v, want only OK", got)
	}
}

func TestDetect_ClampsBoxesToPageFrame(t *testing.T) {
	fc := &fakeClient{
		enabled: true, vision: true,
		resp: ai.ChatResponse{Content: `{"fields":[
			{"type":"text","x":-10,"y":-10,"w":50,"h":50,"label":"NW overflow"},
			{"type":"text","x":80,"y":80,"w":50,"h":50,"label":"SE overflow"},
			{"type":"text","x":200,"y":200,"w":50,"h":50,"label":"fully outside"}
		]}`},
	}
	got, _ := Detect(context.Background(), fc, []ocr.RasterPage{rasterPage(100, 100, []byte{1})})
	if len(got) != 2 {
		t.Fatalf("got %d, want 2 (the third is fully off-page)", len(got))
	}
	// NW overflow: clamps to (0,0,40,40)
	if got[0].X != 0 || got[0].Y != 0 || got[0].W != 40 || got[0].H != 40 {
		t.Errorf("NW overflow clamp = %+v, want (0,0,40,40)", got[0])
	}
	// SE overflow: clamps to (80,80,20,20)
	if got[1].X != 80 || got[1].Y != 80 || got[1].W != 20 || got[1].H != 20 {
		t.Errorf("SE overflow clamp = %+v, want (80,80,20,20)", got[1])
	}
}

func TestDetect_ClampsConfidence(t *testing.T) {
	fc := &fakeClient{
		enabled: true, vision: true,
		resp: ai.ChatResponse{Content: `{"fields":[
			{"type":"text","x":1,"y":1,"w":50,"h":10,"label":"high","confidence":1.5},
			{"type":"text","x":1,"y":1,"w":50,"h":10,"label":"low","confidence":0.05},
			{"type":"text","x":1,"y":1,"w":50,"h":10,"label":"ok","confidence":0.7}
		]}`},
	}
	got, _ := Detect(context.Background(), fc, []ocr.RasterPage{rasterPage(100, 100, []byte{1})})
	if len(got) != 3 {
		t.Fatalf("got %d, want 3", len(got))
	}
	if got[0].Confidence != MaxConfidence {
		t.Errorf("high conf = %v, want %v", got[0].Confidence, MaxConfidence)
	}
	if got[1].Confidence != MinConfidence {
		t.Errorf("low conf = %v, want %v", got[1].Confidence, MinConfidence)
	}
	if got[2].Confidence != 0.7 {
		t.Errorf("ok conf = %v, want 0.7", got[2].Confidence)
	}
}

func TestDetect_OversizedImageRejected(t *testing.T) {
	huge := make([]byte, MaxImageBytes+1)
	fc := &fakeClient{
		enabled: true, vision: true,
		resp: ai.ChatResponse{Content: `{"fields":[]}`},
	}
	_, err := Detect(context.Background(), fc, []ocr.RasterPage{rasterPage(100, 100, huge)})
	if err != nil {
		// Per-page error is swallowed; we just need to verify the
		// model wasn't called for the oversized page.
		t.Fatalf("Detect: %v", err)
	}
	if fc.calls != 0 {
		t.Errorf("Chat called %d times for oversized image, want 0", fc.calls)
	}
}

func TestDetect_AIErrorSkipsPage(t *testing.T) {
	fc := &fakeClient{
		enabled: true, vision: true,
		respErr: errors.New("model 503"),
	}
	got, err := Detect(context.Background(), fc, []ocr.RasterPage{rasterPage(100, 100, []byte{1})})
	if err != nil {
		t.Fatalf("Detect: %v, want nil (per-page error swallowed)", err)
	}
	if len(got) != 0 {
		t.Errorf("got %d fields, want 0", len(got))
	}
}

func TestExtractFirstJSONObject_HandlesNestedAndStrings(t *testing.T) {
	in := `prefix {"fields":[{"label":"with } brace in string","type":"text"}]} suffix`
	got := extractFirstJSONObject(in)
	want := `{"fields":[{"label":"with } brace in string","type":"text"}]}`
	if got != want {
		t.Errorf("extractFirstJSONObject:\n got %q\nwant %q", got, want)
	}
}

func TestStripCodeFences_VariousShapes(t *testing.T) {
	cases := []struct{ in, want string }{
		{"plain text", "plain text"},
		{"```json\n{\"x\":1}\n```", `{"x":1}`},
		{"```\n{\"x\":1}\n```", `{"x":1}`},
		{"```{\"x\":1}```", `{"x":1}`},
	}
	for _, c := range cases {
		if got := stripCodeFences(c.in); got != c.want {
			t.Errorf("stripCodeFences(%q) = %q, want %q", c.in, got, c.want)
		}
	}
}
