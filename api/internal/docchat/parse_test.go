package docchat

// Tests for parseSummary — the tolerant decoder for /summarize
// responses. The model is instructed to return strict JSON, but in
// practice it occasionally:
//
//   - Wraps the JSON in ``` fences (Anthropic and Ollama both do this
//     when their system prompt is loose).
//   - Prepends a one-line "Sure, here's the summary:" preamble.
//   - Returns plain prose instead of JSON when the document is too
//     short to fill the contract — degrading to a single-paragraph
//     summary is preferable to a 502.
//
// These tests pin the parser's behaviour against each of those.

import (
	"strings"
	"testing"
)

func TestParseSummary_CleanJSON(t *testing.T) {
	raw := `{"summary":"A test doc.","keyPoints":["one","two"],"suggestedQuestions":["why?"]}`
	got := parseSummary(raw)
	if got.Summary != "A test doc." {
		t.Errorf("summary = %q, want %q", got.Summary, "A test doc.")
	}
	if len(got.KeyPoints) != 2 || got.KeyPoints[0] != "one" {
		t.Errorf("keyPoints = %#v", got.KeyPoints)
	}
	if len(got.SuggestedQuestions) != 1 || got.SuggestedQuestions[0] != "why?" {
		t.Errorf("suggestedQuestions = %#v", got.SuggestedQuestions)
	}
}

func TestParseSummary_FencedJSON(t *testing.T) {
	raw := "```json\n" +
		`{"summary":"Fenced.","keyPoints":[],"suggestedQuestions":[]}` +
		"\n```"
	got := parseSummary(raw)
	if got.Summary != "Fenced." {
		t.Errorf("summary = %q, want %q (fence-strip failed)", got.Summary, "Fenced.")
	}
}

func TestParseSummary_LeadingPreamble(t *testing.T) {
	raw := `Sure! Here's the summary you asked for:
{"summary":"Worked despite preamble.","keyPoints":["a"],"suggestedQuestions":["b"]}`
	got := parseSummary(raw)
	if got.Summary != "Worked despite preamble." {
		t.Errorf("summary = %q, want %q", got.Summary, "Worked despite preamble.")
	}
}

func TestParseSummary_NoJSONFallsBackToPlain(t *testing.T) {
	// Model returned prose. We degrade to "raw response as summary" so
	// the user sees something useful instead of 502.
	raw := `This document is too short to summarise meaningfully.`
	got := parseSummary(raw)
	if got.Summary != raw {
		t.Errorf("summary = %q, want raw text passthrough", got.Summary)
	}
	if got.KeyPoints == nil || got.SuggestedQuestions == nil {
		t.Error("KeyPoints/SuggestedQuestions must be non-nil even on fallback (json marshalling)")
	}
}

func TestParseSummary_MalformedJSONFallsBack(t *testing.T) {
	raw := `{"summary": "missing close bracket", "keyPoints": [`
	got := parseSummary(raw)
	// On malformed JSON we should still return *something* (the raw
	// blob as summary) rather than crash or return a zero value.
	if got.Summary == "" {
		t.Error("expected non-empty summary on malformed-JSON fallback")
	}
	if !strings.Contains(got.Summary, "missing close bracket") {
		t.Errorf("expected raw text in fallback summary, got %q", got.Summary)
	}
}

func TestParseSummary_EmptyInput(t *testing.T) {
	got := parseSummary("")
	if got.Summary != "" || len(got.KeyPoints) != 0 || len(got.SuggestedQuestions) != 0 {
		t.Errorf("empty input should yield zero value, got %#v", got)
	}
}

func TestParseSummary_NullArrays(t *testing.T) {
	// Provider returns the JSON shape but with null arrays. The frontend
	// expects [] (it iterates without a null-check), so the parser
	// normalises null → empty slice.
	raw := `{"summary":"ok","keyPoints":null,"suggestedQuestions":null}`
	got := parseSummary(raw)
	if got.KeyPoints == nil {
		t.Error("KeyPoints must be normalised to non-nil empty slice")
	}
	if got.SuggestedQuestions == nil {
		t.Error("SuggestedQuestions must be normalised to non-nil empty slice")
	}
}
