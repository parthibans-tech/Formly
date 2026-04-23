package observability

import (
	"context"
	"encoding/json"
	"net/http"
	"strings"

	"github.com/jackc/pgx/v5/pgxpool"
)

// ErrorEvent is the structured record written to the error_events table.
type ErrorEvent struct {
	OrgID     string
	Component string // api | worker | webhook | scheduled
	Kind      string // panic | http_5xx | job_failed | health_fail
	Message   string
	Context   map[string]any
	RequestID string
	Path      string
	Status    int
	ActorID   string
	IP        string
}

// RecordError writes an error_events row. Never blocks the caller; failures
// are swallowed so observability bugs can't cascade into user-facing errors.
func RecordError(ctx context.Context, db *pgxpool.Pool, e ErrorEvent) {
	if e.Component == "" {
		e.Component = "api"
	}
	if e.Kind == "" {
		e.Kind = "error"
	}
	if e.Context == nil {
		e.Context = map[string]any{}
	}
	ctxJSON, _ := json.Marshal(e.Context)

	ip := e.IP
	if i := strings.LastIndex(ip, ":"); i > 0 && !strings.Contains(ip, "]") {
		ip = ip[:i]
	}

	_, _ = db.Exec(ctx, `
		INSERT INTO error_events
		  (org_id, component, kind, message, context, request_id, path,
		   status, actor_id, ip_addr)
		VALUES
		  (NULLIF($1,'')::uuid, $2, $3, $4, $5::jsonb, NULLIF($6,''),
		   NULLIF($7,''), NULLIF($8,0), NULLIF($9,'')::uuid,
		   NULLIF($10,'')::inet)
	`, e.OrgID, e.Component, e.Kind, e.Message, string(ctxJSON),
		e.RequestID, e.Path, e.Status, e.ActorID, ip)
}

// ErrorCapture wraps the router to record 5xx responses automatically. Panics
// are caught by chi's Recoverer middleware, but we also want to see any
// handler that voluntarily writes a 500 — this catches those.
func ErrorCapture(db *pgxpool.Pool) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			sr := &captureWriter{ResponseWriter: w, status: 200}
			next.ServeHTTP(sr, r)
			if sr.status >= 500 {
				go RecordError(context.Background(), db, ErrorEvent{
					Component: "api",
					Kind:      "http_5xx",
					Message:   strings.TrimSpace(sr.body.String()),
					RequestID: r.Header.Get("X-Request-Id"),
					Path:      r.URL.Path,
					Status:    sr.status,
					IP:        clientIP(r),
				})
			}
		})
	}
}

type captureWriter struct {
	http.ResponseWriter
	status int
	body   strings.Builder
}

func (c *captureWriter) WriteHeader(code int) {
	c.status = code
	c.ResponseWriter.WriteHeader(code)
}

func (c *captureWriter) Write(b []byte) (int, error) {
	// Cap captured body at 512 bytes — we only want a hint for the error log.
	if c.body.Len() < 512 {
		remain := 512 - c.body.Len()
		if len(b) < remain {
			remain = len(b)
		}
		c.body.Write(b[:remain])
	}
	return c.ResponseWriter.Write(b)
}

func clientIP(r *http.Request) string {
	if v := r.Header.Get("X-Forwarded-For"); v != "" {
		if i := strings.IndexByte(v, ','); i > 0 {
			return strings.TrimSpace(v[:i])
		}
		return strings.TrimSpace(v)
	}
	if v := r.Header.Get("X-Real-IP"); v != "" {
		return v
	}
	return r.RemoteAddr
}
