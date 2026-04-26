// HTTP handler for /v1/ai/* — currently only /config, which the
// frontend polls once at boot to learn whether AI features should
// render at all.
//
// The response is intentionally tiny: enabled flag, provider name,
// capability bits, and a feature map for the toggleable user-facing
// features that are layered on top. Keeping `features` server-driven
// (rather than baking them into the frontend) means we can flip a
// single feature off without a frontend deploy — useful when, say,
// transcription costs a customer too much and they want it gone for
// the rest of the month.

package ai

import (
	"encoding/json"
	"net/http"

	"github.com/go-chi/chi/v5"
)

// Handler exposes the public AI configuration endpoint. It holds a
// reference to the active Client so its `Enabled` / `Provider` /
// `Capabilities` are the source of truth — there's no second config
// surface that could drift.
type Handler struct {
	client Client
}

// NewHandler wraps a Client for HTTP exposure. main.go constructs
// exactly one of these and mounts it on the authenticated router so
// only logged-in users see the config (no point leaking provider
// info to anonymous traffic).
func NewHandler(c Client) *Handler {
	if c == nil {
		c = Disabled{}
	}
	return &Handler{client: c}
}

// FeatureFlags enumerates the user-facing AI features the UI can
// mount. Each maps to a future endpoint family; for now we just
// declare them so the frontend can branch on individual flags rather
// than re-deriving them from `enabled + provider`.
type FeatureFlags struct {
	// SmartSearch: semantic search across files. Requires Embed.
	SmartSearch bool `json:"smartSearch"`
	// AutoTag: post-upload filename / tag suggestions.
	AutoTag bool `json:"autoTag"`
	// TemplatePrefill: extract source-doc fields into a template form.
	TemplatePrefill bool `json:"templatePrefill"`
	// Summarize: long-document summary on demand.
	Summarize bool `json:"summarize"`
	// PIIScan: detect sensitive content before sharing.
	PIIScan bool `json:"piiScan"`
	// Transcribe: audio/video → text. Independent of LLM provider
	// (driven by a separate whisper.cpp pipeline) — surfaced through
	// the same flag so the UI has a single capability source.
	Transcribe bool `json:"transcribe"`
}

type configResponse struct {
	Enabled      bool         `json:"enabled"`
	Provider     string       `json:"provider"`
	Capabilities Capabilities `json:"capabilities"`
	Features     FeatureFlags `json:"features"`
}

// Config is the GET /v1/ai/config handler.
//
// Response shape — even when AI is OFF — is the same; only the values
// differ. That keeps the frontend simple: one fetch, one parse, branch
// on `enabled`.
func (h *Handler) Config(w http.ResponseWriter, r *http.Request) {
	enabled := h.client.Enabled()
	caps := h.client.Capabilities()
	resp := configResponse{
		Enabled:      enabled,
		Provider:     h.client.Provider(),
		Capabilities: caps,
		// Feature defaults: derive from capabilities. Operators can
		// later override individual flags through a settings table —
		// this struct is the place that lookup will land. Until then
		// the rule is "if the model can do it, the feature shows".
		Features: FeatureFlags{
			SmartSearch:     enabled && caps.Embed,
			AutoTag:         enabled && caps.Chat,
			TemplatePrefill: enabled && caps.Chat,
			Summarize:       enabled && caps.Chat,
			PIIScan:         enabled && caps.Chat,
			// Transcription is driven by a separate pipeline, but
			// gating it behind the master AI flag keeps the UI
			// consistent — flipping AI off hides every "magic"
			// feature in one go.
			Transcribe: enabled,
		},
	}
	writeJSON(w, http.StatusOK, resp)
}

// Mount wires the routes under the parent router. Caller is
// responsible for any auth middleware; we only mount paths.
func (h *Handler) Mount(r chi.Router) {
	r.Get("/v1/ai/config", h.Config)
}

func writeJSON(w http.ResponseWriter, code int, v interface{}) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(code)
	_ = json.NewEncoder(w).Encode(v)
}
