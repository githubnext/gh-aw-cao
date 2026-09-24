// Package telemetry configures standardized OpenTelemetry tracing for the
// dashboard server. It intentionally follows upstream OpenTelemetry
// conventions rather than a vendor-specific SDK: the exporter, protocol, and
// resource attributes are all controlled through the standard OTEL_*
// environment variables (https://opentelemetry.io/docs/specs/otel/configuration/sdk-environment-variables/),
// span identifiers are W3C Trace Context trace/span ids, and HTTP server
// spans use the semantic conventions implemented by
// go.opentelemetry.io/contrib/instrumentation/net/http/otelhttp. Deployments
// that need Azure Monitor / Application Insights ingestion point
// OTEL_EXPORTER_OTLP_ENDPOINT at an OpenTelemetry Collector configured with
// the azuremonitorexporter; the server never links an Azure-specific SDK.
package telemetry

import (
	"context"
	"fmt"
	"os"
	"strings"

	"go.opentelemetry.io/otel"
	"go.opentelemetry.io/otel/exporters/otlp/otlptrace/otlptracehttp"
	"go.opentelemetry.io/otel/propagation"
	"go.opentelemetry.io/otel/sdk/resource"
	sdktrace "go.opentelemetry.io/otel/sdk/trace"
	semconv "go.opentelemetry.io/otel/semconv/v1.26.0"
)

// ServiceName is the standardized service.name resource attribute reported by
// every dashboard server process, regardless of hosting mode.
const ServiceName = "cao-dashboard"

// Shutdown flushes and stops any exporter started by Setup. It is always
// non-nil and safe to call even when Setup did not configure an exporter.
type Shutdown func(context.Context) error

// Setup installs a global TracerProvider and W3C Trace Context propagator
// for the dashboard server. When OTEL_SDK_DISABLED is "true" or no OTLP
// endpoint is configured, the global propagator is still installed but no
// exporter is started, so handlers can unconditionally start spans without
// checking whether telemetry is enabled: unexported spans are cheap no-ops.
func Setup(ctx context.Context, version string) (Shutdown, error) {
	noop := func(context.Context) error { return nil }
	otel.SetTextMapPropagator(propagation.NewCompositeTextMapPropagator(
		propagation.TraceContext{},
		propagation.Baggage{},
	))
	if strings.EqualFold(strings.TrimSpace(os.Getenv("OTEL_SDK_DISABLED")), "true") {
		return noop, nil
	}
	endpoint := firstNonEmpty(
		os.Getenv("OTEL_EXPORTER_OTLP_TRACES_ENDPOINT"),
		os.Getenv("OTEL_EXPORTER_OTLP_ENDPOINT"),
	)
	if endpoint == "" {
		// No exporter destination is configured; keep the default no-op
		// tracer provider so instrumentation stays inert instead of
		// spending resources on unexported spans.
		return noop, nil
	}
	var exporterOptions []otlptracehttp.Option
	if strings.HasPrefix(endpoint, "http://") {
		exporterOptions = append(exporterOptions, otlptracehttp.WithInsecure())
	}
	exporter, err := otlptracehttp.New(ctx, exporterOptions...)
	if err != nil {
		return noop, fmt.Errorf("create OTLP trace exporter: %w", err)
	}
	serviceName := firstNonEmpty(os.Getenv("OTEL_SERVICE_NAME"), ServiceName)
	res, err := resource.New(ctx,
		resource.WithAttributes(
			semconv.ServiceNameKey.String(serviceName),
			semconv.ServiceVersionKey.String(version),
		),
		resource.WithFromEnv(),
		resource.WithHost(),
		resource.WithTelemetrySDK(),
	)
	if err != nil {
		return noop, fmt.Errorf("build OpenTelemetry resource: %w", err)
	}
	provider := sdktrace.NewTracerProvider(
		sdktrace.WithBatcher(exporter),
		sdktrace.WithResource(res),
	)
	otel.SetTracerProvider(provider)
	return provider.Shutdown, nil
}

func firstNonEmpty(values ...string) string {
	for _, value := range values {
		if trimmed := strings.TrimSpace(value); trimmed != "" {
			return trimmed
		}
	}
	return ""
}
