// Package tracing wires up OpenTelemetry tracing for the API and
// worker processes.
//
// What this package owns
// ----------------------
// One narrow job: stand up an OpenTelemetry TracerProvider that
// exports spans to an OTLP endpoint (Tempo in dev, anything OTLP-
// compatible in prod), and tear it down cleanly on shutdown.
//
// Why we have it
// --------------
// The metrics package has been recording OpenMetrics exemplars
// against the HTTP histogram for a while — every observation
// carries a trace_id parsed from the W3C `traceparent` header. But
// without an actual tracer running in the process, no upstream
// produces that header — so the exemplars were always empty.
// Wiring up tracing here closes the loop: chi gets an `otelchi`
// middleware that starts a server-side span (and emits the
// `traceparent` response header), which the metrics middleware
// then reads when it records the exemplar. Same trace_id in both
// places means an operator clicking an exemplar in Grafana is
// taken to the precise request that produced the slow bucket.
//
// What does and doesn't propagate
// -------------------------------
// We use the W3C TraceContext propagator (the OTel default). All
// outbound HTTP (Prometheus client, AI calls, webhook delivery) is
// _not_ wrapped today — adding `otelhttp` to the relevant clients
// is a follow-up. Server-side spans alone already make the
// exemplar pipeline work end-to-end.
//
// Configuration
// -------------
// Read at Init time:
//
//   - OTEL_EXPORTER_OTLP_ENDPOINT — base URL for the collector
//     (default `http://localhost:4318`). HTTP/protobuf path —
//     gRPC would need a different exporter and isn't worth the
//     extra dep weight in dev.
//   - OTEL_SERVICE_NAME           — `service.name` resource
//     attribute. Defaults to "formly-api" or "formly-worker"
//     depending on the caller.
//   - OTEL_TRACES_SAMPLER_ARG     — head sampling ratio (0..1).
//     Default 1.0 in dev (capture every trace), drop to 0.05–0.1
//     in prod once you're sure the volume needs it.
//   - OTEL_DISABLED               — when "1" / "true", Init returns
//     a no-op shutdown and skips wiring entirely. Same fail-safe
//     pattern as AI / OCR — a fresh dev checkout without Tempo
//     running stays bootable.
//
// On any exporter init error the package logs and falls back to a
// no-op provider rather than blocking startup. Tracing is
// observability; observability outages must not be a production
// outage.
package tracing

import (
	"context"
	"fmt"
	"log/slog"
	"os"
	"strconv"
	"strings"
	"time"

	"go.opentelemetry.io/otel"
	"go.opentelemetry.io/otel/exporters/otlp/otlptrace/otlptracehttp"
	"go.opentelemetry.io/otel/propagation"
	"go.opentelemetry.io/otel/sdk/resource"
	sdktrace "go.opentelemetry.io/otel/sdk/trace"
	semconv "go.opentelemetry.io/otel/semconv/v1.26.0"
)

// ShutdownFunc flushes pending spans and tears down the
// TracerProvider. Always non-nil; the no-op variant is returned
// when tracing is disabled or fails to initialize. Safe to call
// from a signal handler — bounded by the supplied context.
type ShutdownFunc func(ctx context.Context) error

// Init configures the global TracerProvider for the calling
// process. The `service` argument distinguishes API spans from
// worker spans inside Tempo (you'll see two separate service
// nodes in Grafana's service graph).
//
// Returns a shutdown function the caller should defer at process
// scope — flushing on exit avoids losing the last few spans of a
// graceful shutdown, and is the single most common reason a
// "looks fine in dev, missing spans in prod" bug walks in.
func Init(ctx context.Context, service string) ShutdownFunc {
	noop := func(context.Context) error { return nil }

	if isDisabled() {
		slog.Info("tracing.disabled",
			"reason", "OTEL_DISABLED",
			"service", service)
		return noop
	}

	endpoint := strings.TrimSpace(os.Getenv("OTEL_EXPORTER_OTLP_ENDPOINT"))
	if endpoint == "" {
		endpoint = "http://localhost:4318"
	}
	// otlptracehttp wants the host:port (and optional path), not
	// the scheme. Strip http:// / https:// and remember whether
	// to use TLS — Tempo in dev is plain HTTP, but production
	// Tempo / OTel collectors are usually TLS-fronted.
	insecure := true
	host := endpoint
	switch {
	case strings.HasPrefix(host, "https://"):
		host = strings.TrimPrefix(host, "https://")
		insecure = false
	case strings.HasPrefix(host, "http://"):
		host = strings.TrimPrefix(host, "http://")
		insecure = true
	}
	host = strings.TrimSuffix(host, "/")

	opts := []otlptracehttp.Option{
		otlptracehttp.WithEndpoint(host),
		// 5s ceiling — exporter flush shouldn't block our shutdown
		// budget. The default is 10s which is too long for a
		// kubernetes graceful-stop window.
		otlptracehttp.WithTimeout(5 * time.Second),
	}
	if insecure {
		opts = append(opts, otlptracehttp.WithInsecure())
	}

	exp, err := otlptracehttp.New(ctx, opts...)
	if err != nil {
		// Fall back to a no-op provider rather than crashing.
		// `tracing.Init` is observability; if Tempo is down the
		// API still serves traffic — we just don't capture spans
		// until Tempo comes back.
		slog.Warn("tracing.init_failed",
			"endpoint", endpoint,
			"service", service,
			"err", err)
		return noop
	}

	res, err := resource.New(ctx,
		resource.WithFromEnv(),
		resource.WithProcess(),
		resource.WithTelemetrySDK(),
		resource.WithAttributes(
			semconv.ServiceName(serviceName(service)),
			semconv.ServiceVersion(buildVersion()),
			semconv.DeploymentEnvironment(envName()),
		),
	)
	if err != nil {
		slog.Warn("tracing.resource_failed", "err", err)
		// resource.New failure is recoverable — a default resource
		// is still better than no tracing.
		res = resource.Default()
	}

	tp := sdktrace.NewTracerProvider(
		sdktrace.WithBatcher(exp,
			// Tighter batch sizes than the SDK default (5s flush)
			// so a low-traffic dev environment doesn't sit on
			// spans for ages before they show up in Tempo.
			sdktrace.WithBatchTimeout(2*time.Second),
			sdktrace.WithMaxExportBatchSize(512),
		),
		sdktrace.WithResource(res),
		sdktrace.WithSampler(headSampler()),
	)

	// Set as the global provider so every call to
	// otel.Tracer("...") in any package picks it up.
	otel.SetTracerProvider(tp)

	// W3C TraceContext + Baggage. Two propagators because Baggage
	// is how you'd plumb tenant_id / org_id through a span chain
	// without it polluting the metric label vocabulary.
	otel.SetTextMapPropagator(propagation.NewCompositeTextMapPropagator(
		propagation.TraceContext{},
		propagation.Baggage{},
	))

	slog.Info("tracing.init",
		"endpoint", endpoint,
		"service", serviceName(service),
		"sampler", samplerName())

	return func(ctx context.Context) error {
		// Force one final flush before tearing down — the batcher
		// might have queued spans we'd otherwise lose.
		if err := tp.ForceFlush(ctx); err != nil {
			slog.Warn("tracing.flush_failed", "err", err)
		}
		if err := tp.Shutdown(ctx); err != nil {
			return fmt.Errorf("tracing shutdown: %w", err)
		}
		return nil
	}
}

func isDisabled() bool {
	v := strings.TrimSpace(strings.ToLower(os.Getenv("OTEL_DISABLED")))
	return v == "1" || v == "true" || v == "yes"
}

// serviceName resolves OTEL_SERVICE_NAME → fallback. The fallback
// is whatever the caller passed (`formly-api` or `formly-worker`)
// — we don't want a sloppy environment to cause both processes to
// share a `service.name` and merge their service-graph nodes in
// Grafana.
func serviceName(fallback string) string {
	if v := strings.TrimSpace(os.Getenv("OTEL_SERVICE_NAME")); v != "" {
		return v
	}
	return fallback
}

func buildVersion() string {
	if v := strings.TrimSpace(os.Getenv("FORMLY_VERSION")); v != "" {
		return v
	}
	return "dev"
}

func envName() string {
	if v := strings.TrimSpace(os.Getenv("FORMLY_ENV")); v != "" {
		return v
	}
	return "dev"
}

// headSampler resolves OTEL_TRACES_SAMPLER_ARG. We use head
// sampling (decision at trace start, propagated downstream) so a
// trace either lives end-to-end or doesn't — sampling per-span
// produces orphan branches that are useless for debugging.
func headSampler() sdktrace.Sampler {
	raw := strings.TrimSpace(os.Getenv("OTEL_TRACES_SAMPLER_ARG"))
	if raw == "" {
		return sdktrace.AlwaysSample()
	}
	ratio, err := strconv.ParseFloat(raw, 64)
	if err != nil || ratio <= 0 {
		return sdktrace.NeverSample()
	}
	if ratio >= 1 {
		return sdktrace.AlwaysSample()
	}
	// ParentBased so a sampled upstream forces sampling here, and
	// vice versa — the trace's sampled flag is sticky.
	return sdktrace.ParentBased(sdktrace.TraceIDRatioBased(ratio))
}

func samplerName() string {
	raw := strings.TrimSpace(os.Getenv("OTEL_TRACES_SAMPLER_ARG"))
	if raw == "" {
		return "always"
	}
	return "ratio=" + raw
}
