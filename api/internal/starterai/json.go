// json.go — small helpers shared across handlers in this package. The
// shape is identical to docchat's writeJSON / writeErr so the public
// API surface stays consistent: callers can branch on `error` codes
// the same way no matter which AI feature they hit.

package starterai

import (
	"encoding/json"
	"net/http"
	"strings"

	"github.com/go-chi/chi/v5/middleware"
)

// writeJSON serialises v as JSON with the given status. Any encoding
// error is non-fatal — we've already committed the status code so the
// best we can do is log; callers don't need to branch on it.
func writeJSON(w http.ResponseWriter, code int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(code)
	_ = json.NewEncoder(w).Encode(v)
}

// errorPayload is the nested error shape the web client's api()
// helper unpacks at web/lib/api.ts:170. Sticking to it lets callers
// branch on `code` cleanly instead of having to special-case a flat
// envelope. We add `requestId` so support tickets can be
// cross-referenced against the server logs without an extra header
// dance.
type errorPayload struct {
	Code      string `json:"code"`
	Message   string `json:"message"`
	RequestID string `json:"requestId,omitempty"`
}

type errorBody struct {
	Error errorPayload `json:"error"`
}

// writeErr emits a stable JSON error envelope. `code` is one of the
// short identifiers the frontend branches on (see the docs in
// starterai.go); `msg` is the human-readable message rendered in
// toasts.
func writeErr(w http.ResponseWriter, r *http.Request, status int, code, msg string) {
	writeJSON(w, status, errorBody{
		Error: errorPayload{
			Code:      code,
			Message:   msg,
			RequestID: middleware.GetReqID(r.Context()),
		},
	})
}

// decodeJSON reads a JSON body into v with a soft size cap. Returns a
// short error string suitable for the `message` field of writeErr; nil
// when the body parsed cleanly. We use http.MaxBytesReader so callers
// that send a 10MB body are rejected at the network layer rather than
// after we've already buffered them.
func decodeJSON(w http.ResponseWriter, r *http.Request, v any, maxBytes int64) error {
	r.Body = http.MaxBytesReader(w, r.Body, maxBytes)
	dec := json.NewDecoder(r.Body)
	dec.DisallowUnknownFields()
	return dec.Decode(v)
}

// truncate returns at most n runes of s with a trailing ellipsis when
// trimmed. Used to keep prompt-side excerpts honest when we have to
// clip a long input — we'd rather the model see "..." than be silently
// fed a torso.
func truncate(s string, n int) string {
	r := []rune(s)
	if len(r) <= n {
		return s
	}
	return string(r[:n]) + "..."
}

// safeFilename strips path separators and trims surrounding whitespace
// so a caller-supplied filename doesn't end up traversing storage keys.
// Callers should still pass the result to uploadpolicy.SafeStorageSlug
// when persisting; this is the inbound-clean step.
func safeFilename(s string) string {
	s = strings.TrimSpace(s)
	s = strings.ReplaceAll(s, "/", "_")
	s = strings.ReplaceAll(s, "\\", "_")
	s = strings.ReplaceAll(s, "..", "_")
	if s == "" {
		return "starter-export"
	}
	if len(s) > 200 {
		s = s[:200]
	}
	return s
}
