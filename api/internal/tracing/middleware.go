package tracing

import (
	"net/http"

	"github.com/go-chi/chi/v5"
	"go.opentelemetry.io/otel"
	"go.opentelemetry.io/otel/attribute"
	"go.opentelemetry.io/otel/codes"
	"go.opentelemetry.io/otel/propagation"
	semconv "go.opentelemetry.io/otel/semconv/v1.26.0"
	"go.opentelemetry.io/otel/trace"
)

// Middleware returns a chi-compatible handler that starts a
// server-side span for every incoming request.
//
// Why this and not otelchi
// ------------------------
// `github.com/riandyrn/otelchi` does roughly the same thing but
// pulls in another module just to wire 30 lines of glue. Keeping
// the middleware in-tree means we can:
//
//   1. Use chi's `RouteContext` to capture the templated route
//      pattern (`/v1/folders/{id}`) instead of the raw path —
//      same approach the metrics middleware already uses for
//      cardinality. This keeps the trace's `http.route` attribute
//      stable across tenants.
//   2. Add the chi RequestID as a span attribute so trace search
//      by request ID works in Grafana / Tempo without a separate
//      log correlation step.
//   3. Skip /healthz and /metrics so the trace store doesn't fill
//      with k8s liveness probes.
//
// Mount this middleware AFTER chi's RequestID and BEFORE the
// metrics middleware. The metrics middleware reads the W3C
// `traceparent` from the *incoming* request to populate
// exemplars; our span has to be started first so that header
// (which we inject into the incoming context-carried propagation)
// matches what's on the histogram.
func Middleware() func(http.Handler) http.Handler {
	tracer := otel.Tracer("github.com/docforge/api/internal/tracing")
	prop := otel.GetTextMapPropagator()

	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			// Skip the noisy infra paths. Liveness probes and
			// scrape requests don't carry interesting context and
			// would dominate any sampled subset.
			if r.URL.Path == "/healthz" || r.URL.Path == "/metrics" {
				next.ServeHTTP(w, r)
				return
			}

			// Extract any inbound trace context — a load balancer
			// or upstream caller may already have started the
			// trace. ParentBased sampler honours their decision.
			ctx := prop.Extract(r.Context(), propagation.HeaderCarrier(r.Header))

			spanName := r.Method + " " + r.URL.Path
			ctx, span := tracer.Start(ctx, spanName,
				trace.WithSpanKind(trace.SpanKindServer),
				trace.WithAttributes(
					semconv.HTTPRequestMethodKey.String(r.Method),
					semconv.URLPath(r.URL.Path),
					semconv.URLScheme(scheme(r)),
					semconv.UserAgentOriginal(r.UserAgent()),
					semconv.ServerAddress(r.Host),
				),
			)
			defer span.End()

			// Wrap the writer so we can capture the status code
			// after the handler returns. http.ResponseWriter
			// itself doesn't expose the status, and we want
			// `http.response.status_code` on the span for trace
			// filtering.
			ww := &statusWriter{ResponseWriter: w, status: http.StatusOK}

			// Inject the *outgoing* trace context onto the
			// response so a polite client sees it, and (more
			// importantly) onto the request's downstream context
			// so the metrics middleware reads the same trace_id
			// when it records its exemplar. We re-extract from
			// the headers we just wrote — that's the cheapest way
			// to keep both sides reading from the same source.
			prop.Inject(ctx, propagation.HeaderCarrier(ww.Header()))
			// Also stamp it on the *request* headers — the
			// metrics middleware reads `traceparent` off
			// r.Header, not the response, so without this the
			// exemplar can't see our span. The propagator's
			// HeaderCarrier handles set semantics correctly.
			prop.Inject(ctx, propagation.HeaderCarrier(r.Header))

			next.ServeHTTP(ww, r.WithContext(ctx))

			// Patch up the span with the route pattern + status
			// code now that chi has resolved them.
			if rctx := chi.RouteContext(ctx); rctx != nil {
				if pattern := rctx.RoutePattern(); pattern != "" {
					span.SetAttributes(semconv.HTTPRoute(pattern))
					span.SetName(r.Method + " " + pattern)
				}
			}
			span.SetAttributes(
				semconv.HTTPResponseStatusCode(ww.status),
			)
			if reqID := r.Header.Get("X-Request-Id"); reqID != "" {
				span.SetAttributes(attribute.String("formly.request_id", reqID))
			}
			// Mark 5xx as error so Grafana's "errors only" filter
			// works. 4xx is intentionally not an error — a 401 on
			// a wrong password is normal traffic.
			if ww.status >= 500 {
				span.SetStatus(codes.Error, http.StatusText(ww.status))
			}
		})
	}
}

// statusWriter is a tiny wrapper so we can read back the
// response status after the handler returns. Identical pattern to
// the metrics middleware, kept independent so the two can be
// reordered without one depending on the other.
type statusWriter struct {
	http.ResponseWriter
	status      int
	wroteHeader bool
}

func (s *statusWriter) WriteHeader(code int) {
	if !s.wroteHeader {
		s.status = code
		s.wroteHeader = true
	}
	s.ResponseWriter.WriteHeader(code)
}

func (s *statusWriter) Write(b []byte) (int, error) {
	if !s.wroteHeader {
		s.status = http.StatusOK
		s.wroteHeader = true
	}
	return s.ResponseWriter.Write(b)
}

// Hijack/Flush passthroughs so middlewares above us (e.g.
// SSE/streaming) keep working. chi's middleware.WrapResponseWriter
// does the same; we replicate just the two we actually need.
func (s *statusWriter) Flush() {
	if f, ok := s.ResponseWriter.(http.Flusher); ok {
		f.Flush()
	}
}

func scheme(r *http.Request) string {
	if r.TLS != nil {
		return "https"
	}
	if v := r.Header.Get("X-Forwarded-Proto"); v != "" {
		return v
	}
	return "http"
}
