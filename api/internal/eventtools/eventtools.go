// Package eventtools owns the non-AI category-level endpoints for
// Events (invitation, agenda, RSVP-card, programme) and the QR-code
// generator used by certificates / event tickets.
//
// Endpoints:
//
//	POST /v1/starters/events/ics     — event spec → text/calendar download
//	POST /v1/starters/qr             — string → PNG QR code
//
// Both are pure-function — no AI, no DB. Naming: we couldn't reuse
// `internal/events/` (it's the in-process event bus); `eventtools`
// is unambiguous.
package eventtools

import (
	"bytes"
	"crypto/sha1"
	"encoding/hex"
	"fmt"
	"log/slog"
	"net/http"
	"strings"
	"time"

	"github.com/docforge/api/internal/aitools"
	"github.com/go-chi/chi/v5"
	"github.com/skip2/go-qrcode"
)

const (
	// MaxICSDescriptionChars caps the description field. iCal files
	// over a few KB break some clients; this keeps us comfortably under.
	MaxICSDescriptionChars = 4_000
	// MaxQRPayloadChars caps the QR payload. Version-40 QR codes top out
	// around 4296 alphanumeric chars; we cap below that to leave error
	// correction headroom.
	MaxQRPayloadChars = 3_500
	// QR module size in pixels — yields ~512px output for typical URLs
	// at level M error correction.
	defaultQRSize = 512
	maxQRSize     = 1024
	minQRSize     = 128
)

type Handler struct {
	Log *slog.Logger
}

func New(log *slog.Logger) *Handler {
	return &Handler{Log: log}
}

func (h *Handler) Mount(r chi.Router) {
	r.Post("/v1/starters/events/ics", h.ICSHTTP)
	r.Post("/v1/starters/qr", h.QRHTTP)
}

/* --------------------------------- ICS --------------------------------- */

type ICSRequest struct {
	Title       string `json:"title"`
	Start       string `json:"start"` // RFC3339
	End         string `json:"end"`   // RFC3339; if empty, +1h
	AllDay      bool   `json:"allDay,omitempty"`
	Location    string `json:"location,omitempty"`
	Description string `json:"description,omitempty"`
	URL         string `json:"url,omitempty"`
	Organizer   string `json:"organizer,omitempty"` // mailto address
}

func (h *Handler) ICSHTTP(w http.ResponseWriter, r *http.Request) {
	var req ICSRequest
	if err := aitools.DecodeJSON(w, r, &req, aitools.SmallReqCap); err != nil {
		aitools.WriteErr(w, r, http.StatusBadRequest, "invalid_payload", err.Error())
		return
	}
	if strings.TrimSpace(req.Title) == "" || strings.TrimSpace(req.Start) == "" {
		aitools.WriteErr(w, r, http.StatusBadRequest, "invalid_payload",
			"`title` and `start` must be non-empty")
		return
	}
	start, err := time.Parse(time.RFC3339, req.Start)
	if err != nil {
		aitools.WriteErr(w, r, http.StatusBadRequest, "invalid_payload",
			"`start` must be RFC3339")
		return
	}
	var end time.Time
	if strings.TrimSpace(req.End) == "" {
		end = start.Add(time.Hour)
	} else {
		end, err = time.Parse(time.RFC3339, req.End)
		if err != nil {
			aitools.WriteErr(w, r, http.StatusBadRequest, "invalid_payload",
				"`end` must be RFC3339")
			return
		}
	}
	if !end.After(start) {
		aitools.WriteErr(w, r, http.StatusBadRequest, "invalid_payload",
			"`end` must be after `start`")
		return
	}

	ics := buildICS(req, start, end)

	w.Header().Set("Content-Type", "text/calendar; charset=utf-8")
	w.Header().Set("Content-Disposition", `attachment; filename="event.ics"`)
	_, _ = w.Write([]byte(ics))
}

// buildICS assembles a single-event VCALENDAR string. We deliberately
// do NOT depend on a third-party iCal library — the spec is small,
// and the surface (one VEVENT, no recurrence, no alarms) is too
// narrow to justify the dependency.
//
// Reference: RFC 5545. The folding rule (lines > 75 octets must be
// folded onto continuation lines) matters in practice — Google Calendar
// rejects long unfolded DESCRIPTION lines. We fold conservatively at
// 73 chars including the leading space on continuations.
func buildICS(req ICSRequest, start, end time.Time) string {
	dtfmt := func(t time.Time) string {
		// All-day events use VALUE=DATE form (YYYYMMDD); timed events
		// use UTC Z form to side-step VTIMEZONE complexity. Calendar
		// clients render Z times in the user's local TZ correctly.
		if req.AllDay {
			return t.UTC().Format("20060102")
		}
		return t.UTC().Format("20060102T150405Z")
	}
	uid := makeUID(req)

	var b strings.Builder
	b.WriteString("BEGIN:VCALENDAR\r\n")
	b.WriteString("VERSION:2.0\r\n")
	b.WriteString("PRODID:-//Formly//Starters//EN\r\n")
	b.WriteString("CALSCALE:GREGORIAN\r\n")
	b.WriteString("METHOD:PUBLISH\r\n")
	b.WriteString("BEGIN:VEVENT\r\n")
	fold(&b, "UID:"+uid)
	fold(&b, "DTSTAMP:"+time.Now().UTC().Format("20060102T150405Z"))
	if req.AllDay {
		fold(&b, "DTSTART;VALUE=DATE:"+dtfmt(start))
		fold(&b, "DTEND;VALUE=DATE:"+dtfmt(end))
	} else {
		fold(&b, "DTSTART:"+dtfmt(start))
		fold(&b, "DTEND:"+dtfmt(end))
	}
	fold(&b, "SUMMARY:"+icsEscape(req.Title))
	if loc := strings.TrimSpace(req.Location); loc != "" {
		fold(&b, "LOCATION:"+icsEscape(loc))
	}
	if desc := strings.TrimSpace(req.Description); desc != "" {
		if len(desc) > MaxICSDescriptionChars {
			desc = desc[:MaxICSDescriptionChars]
		}
		fold(&b, "DESCRIPTION:"+icsEscape(desc))
	}
	if u := strings.TrimSpace(req.URL); u != "" {
		fold(&b, "URL:"+u)
	}
	if org := strings.TrimSpace(req.Organizer); org != "" {
		// Accept either "mailto:foo@bar" or bare "foo@bar".
		if !strings.HasPrefix(strings.ToLower(org), "mailto:") {
			org = "mailto:" + org
		}
		fold(&b, "ORGANIZER:"+org)
	}
	b.WriteString("END:VEVENT\r\n")
	b.WriteString("END:VCALENDAR\r\n")
	return b.String()
}

// fold writes a line, folding it at 73 chars per RFC 5545 §3.1. We
// pick 73 (not 75) so that even multi-byte UTF-8 sequences land safely
// inside the spec limit when measured in octets.
func fold(b *strings.Builder, line string) {
	const limit = 73
	if len(line) <= limit {
		b.WriteString(line)
		b.WriteString("\r\n")
		return
	}
	first := true
	for len(line) > limit {
		if !first {
			b.WriteString(" ")
		}
		b.WriteString(line[:limit])
		b.WriteString("\r\n")
		line = line[limit:]
		first = false
	}
	if len(line) > 0 {
		b.WriteString(" ")
		b.WriteString(line)
		b.WriteString("\r\n")
	}
}

// icsEscape escapes the four reserved characters per RFC 5545 §3.3.11.
func icsEscape(s string) string {
	r := strings.NewReplacer(
		`\`, `\\`,
		"\n", `\n`,
		";", `\;`,
		",", `\,`,
	)
	return r.Replace(s)
}

// makeUID derives a stable UID from the input so refreshing the same
// event yields the same UID — calendar clients use UID to dedupe.
func makeUID(req ICSRequest) string {
	h := sha1.New()
	_, _ = fmt.Fprintf(h, "%s|%s|%s|%s",
		req.Title, req.Start, req.End, req.Location)
	return hex.EncodeToString(h.Sum(nil)) + "@formly"
}

/* ---------------------------------- QR ---------------------------------- */

type QRRequest struct {
	Payload string `json:"payload"`
	// Size in pixels. Defaults to 512; clamped to [128, 1024].
	Size int `json:"size,omitempty"`
	// Level: L | M | Q | H — error-correction level. Defaults to M.
	Level string `json:"level,omitempty"`
}

func (h *Handler) QRHTTP(w http.ResponseWriter, r *http.Request) {
	var req QRRequest
	if err := aitools.DecodeJSON(w, r, &req, aitools.SmallReqCap); err != nil {
		aitools.WriteErr(w, r, http.StatusBadRequest, "invalid_payload", err.Error())
		return
	}
	if strings.TrimSpace(req.Payload) == "" {
		aitools.WriteErr(w, r, http.StatusBadRequest, "invalid_payload",
			"`payload` must be non-empty")
		return
	}
	if len(req.Payload) > MaxQRPayloadChars {
		aitools.WriteErr(w, r, http.StatusBadRequest, "invalid_payload",
			"`payload` exceeds the QR capacity limit")
		return
	}
	size := req.Size
	if size <= 0 {
		size = defaultQRSize
	}
	if size < minQRSize {
		size = minQRSize
	}
	if size > maxQRSize {
		size = maxQRSize
	}
	level := strings.ToUpper(strings.TrimSpace(req.Level))
	var rl qrcode.RecoveryLevel
	switch level {
	case "", "M":
		rl = qrcode.Medium
	case "L":
		rl = qrcode.Low
	case "Q":
		rl = qrcode.High
	case "H":
		rl = qrcode.Highest
	default:
		aitools.WriteErr(w, r, http.StatusBadRequest, "invalid_payload",
			"`level` must be L, M, Q, or H")
		return
	}

	png, err := qrcode.Encode(req.Payload, rl, size)
	if err != nil {
		aitools.WriteErr(w, r, http.StatusBadRequest, "qr_encode_failed", err.Error())
		return
	}
	w.Header().Set("Content-Type", "image/png")
	w.Header().Set("Cache-Control", "private, max-age=300")
	_, _ = w.Write(bytes.TrimSpace(png))
}
