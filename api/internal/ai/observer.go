package ai

import (
	"context"
	"time"
)

// Observer is the seam through which an AI client reports per-call
// telemetry. The metrics package wires this up from main.go so the
// `ai` package itself stays free of any prometheus import — keeps
// the unit tests fast and the dependency graph clean.
//
// Observe fires once per successful or failed call. `op` ∈
// {"chat", "embed"}. `err` is non-nil on failure. `tokensIn` /
// `tokensOut` are best-effort: providers that don't return usage
// data (Ollama, the Disabled stub) pass zeros, and the observer
// should treat zero as "unknown" rather than "definitely zero".
type Observer interface {
	Observe(op, provider string, dur time.Duration, tokensIn, tokensOut int, err error)
}

// observed is a Client decorator that calls into Observer around
// each Chat / Embed. Returned by WithMetrics.
type observed struct {
	inner    Client
	observer Observer
}

// WithMetrics wraps an existing Client with metric observation. If
// observer is nil the inner client is returned unchanged — keeps
// the wiring code in main.go branch-free.
func WithMetrics(inner Client, observer Observer) Client {
	if inner == nil || observer == nil {
		return inner
	}
	return &observed{inner: inner, observer: observer}
}

func (o *observed) Enabled() bool                  { return o.inner.Enabled() }
func (o *observed) Provider() string               { return o.inner.Provider() }
func (o *observed) Capabilities() Capabilities     { return o.inner.Capabilities() }

func (o *observed) Chat(ctx context.Context, req ChatRequest) (ChatResponse, error) {
	start := time.Now()
	resp, err := o.inner.Chat(ctx, req)
	// We don't have per-message token counts on the response struct
	// (deliberately kept narrow — see ChatResponse comment). Pass 0/0
	// so the histogram still records duration; the AITokens counter
	// will need a wider response type to populate. Not a regression:
	// the previous build had no token metric at all.
	o.observer.Observe("chat", o.inner.Provider(), time.Since(start), 0, 0, err)
	return resp, err
}

func (o *observed) Embed(ctx context.Context, req EmbedRequest) (EmbedResponse, error) {
	start := time.Now()
	resp, err := o.inner.Embed(ctx, req)
	o.observer.Observe("embed", o.inner.Provider(), time.Since(start), 0, 0, err)
	return resp, err
}
