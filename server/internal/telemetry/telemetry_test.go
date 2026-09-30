package telemetry

import (
	"context"
	"net/http/httptest"
	"testing"

	"go.opentelemetry.io/otel"
	"go.opentelemetry.io/otel/baggage"
	"go.opentelemetry.io/otel/propagation"
	"go.opentelemetry.io/otel/trace"
)

const testSpanName = "test-span"

func TestResolveExporterDecision(t *testing.T) {
	tests := []struct {
		name              string
		sdkDisabledEnv    string
		tracesEndpointEnv string
		endpointEnv       string
		wantEndpoint      string
		wantDecision      exporterDecision
	}{
		{
			name:           "sdk disabled overrides a configured endpoint",
			sdkDisabledEnv: "true",
			endpointEnv:    "http://127.0.0.1:4318",
			wantEndpoint:   "",
			wantDecision:   exporterDecisionDisabled,
		},
		{
			name:           "sdk disabled comparison is case-insensitive and trims whitespace",
			sdkDisabledEnv: " True ",
			endpointEnv:    "http://127.0.0.1:4318",
			wantEndpoint:   "",
			wantDecision:   exporterDecisionDisabled,
		},
		{
			name:         "no endpoint configured stays noop",
			wantEndpoint: "",
			wantDecision: exporterDecisionNoEndpoint,
		},
		{
			name:              "traces endpoint takes priority over the general endpoint",
			tracesEndpointEnv: "http://traces.example:4318",
			endpointEnv:       "http://general.example:4318",
			wantEndpoint:      "http://traces.example:4318",
			wantDecision:      exporterDecisionConfigured,
		},
		{
			name:         "general endpoint is used when no traces endpoint is set",
			endpointEnv:  "http://general.example:4318",
			wantEndpoint: "http://general.example:4318",
			wantDecision: exporterDecisionConfigured,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			gotEndpoint, gotDecision := resolveExporterDecision(tt.sdkDisabledEnv, tt.tracesEndpointEnv, tt.endpointEnv)
			if gotEndpoint != tt.wantEndpoint {
				t.Errorf("endpoint = %q, want %q", gotEndpoint, tt.wantEndpoint)
			}
			if gotDecision != tt.wantDecision {
				t.Errorf("decision = %q, want %q", gotDecision, tt.wantDecision)
			}
		})
	}
}

func TestSetupWithoutEndpointStaysNoop(t *testing.T) {
	t.Setenv("OTEL_EXPORTER_OTLP_ENDPOINT", "")
	t.Setenv("OTEL_EXPORTER_OTLP_TRACES_ENDPOINT", "")
	t.Setenv("OTEL_SDK_DISABLED", "")
	shutdown, err := Setup(context.Background(), "test")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if shutdown == nil {
		t.Fatal("Setup must always return a non-nil shutdown function")
	}
	if err := shutdown(context.Background()); err != nil {
		t.Fatalf("no-op shutdown must not fail: %v", err)
	}
	_, span := Tracer().Start(context.Background(), testSpanName)
	defer span.End()
	if span.SpanContext().IsValid() {
		t.Fatal("the default no-op tracer provider must not produce an exported span context")
	}
}

func TestSetupDisabledSkipsExporter(t *testing.T) {
	t.Setenv("OTEL_SDK_DISABLED", "true")
	t.Setenv("OTEL_EXPORTER_OTLP_ENDPOINT", "http://127.0.0.1:4318")
	shutdown, err := Setup(context.Background(), "test")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if err := shutdown(context.Background()); err != nil {
		t.Fatalf("no-op shutdown must not fail: %v", err)
	}
}

func TestSetupWithHTTPEndpointConfiguresProvider(t *testing.T) {
	previousProvider := otel.GetTracerProvider()
	t.Cleanup(func() { otel.SetTracerProvider(previousProvider) })
	t.Setenv("OTEL_SDK_DISABLED", "")
	t.Setenv("OTEL_EXPORTER_OTLP_ENDPOINT", "http://127.0.0.1:4318")
	t.Setenv("OTEL_RESOURCE_ATTRIBUTES", "")
	shutdown, err := Setup(context.Background(), "test")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	defer func() {
		// The exporter never dials during Setup, so shutdown must not
		// hang or fail even though nothing is listening on the endpoint.
		ctx, cancel := context.WithTimeout(context.Background(), 0)
		defer cancel()
		_ = shutdown(ctx)
	}()
	provider := otel.GetTracerProvider()
	if provider == nil {
		t.Fatal("expected a global tracer provider to be installed")
	}
	carrier := propagation.MapCarrier{
		"traceparent": "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01",
		"baggage":     "account=private-identifier",
	}
	extracted := otel.GetTextMapPropagator().Extract(context.Background(), carrier)
	if !trace.SpanContextFromContext(extracted).IsValid() {
		t.Fatal("traceparent must still be propagated")
	}
	if baggage.FromContext(extracted).Len() != 0 {
		t.Fatal("untrusted baggage must not be propagated")
	}
}

func TestSetupWithMetricsEndpointConfiguresMeterProviderOnly(t *testing.T) {
	previousMeterProvider := otel.GetMeterProvider()
	previousTracerProvider := otel.GetTracerProvider()
	t.Cleanup(func() {
		otel.SetMeterProvider(previousMeterProvider)
		otel.SetTracerProvider(previousTracerProvider)
	})
	t.Setenv("OTEL_SDK_DISABLED", "")
	t.Setenv("OTEL_EXPORTER_OTLP_ENDPOINT", "")
	t.Setenv("OTEL_EXPORTER_OTLP_TRACES_ENDPOINT", "")
	t.Setenv("OTEL_EXPORTER_OTLP_METRICS_ENDPOINT", "http://127.0.0.1:4318")

	shutdown, err := Setup(context.Background(), "test")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	defer func() {
		ctx, cancel := context.WithTimeout(context.Background(), 0)
		defer cancel()
		_ = shutdown(ctx)
	}()
	if otel.GetMeterProvider() == previousMeterProvider {
		t.Fatal("expected a global meter provider to be installed")
	}
	if otel.GetTracerProvider() != previousTracerProvider {
		t.Fatal("metrics-only configuration must not replace the tracer provider")
	}
}

func TestSetResponseTraceHeadersOnlyWritesValidSpanContext(t *testing.T) {
	recorder := httptest.NewRecorder()
	SetResponseTraceHeaders(recorder, trace.SpanContext{})
	if recorder.Header().Get(TraceIDHeader) != "" {
		t.Fatal("an invalid span context must not set trace headers")
	}

	traceID, _ := trace.TraceIDFromHex("4bf92f3577b34da6a3ce929d0e0e4736")
	spanID, _ := trace.SpanIDFromHex("00f067aa0ba902b7")
	spanContext := trace.NewSpanContext(trace.SpanContextConfig{
		TraceID:    traceID,
		SpanID:     spanID,
		TraceFlags: trace.FlagsSampled,
	})
	SetResponseTraceHeaders(recorder, spanContext)
	if got := recorder.Header().Get(TraceIDHeader); got != traceID.String() {
		t.Fatalf("trace id header = %q, want %q", got, traceID.String())
	}
	if got := recorder.Header().Get(SpanIDHeader); got != spanID.String() {
		t.Fatalf("span id header = %q, want %q", got, spanID.String())
	}
}
