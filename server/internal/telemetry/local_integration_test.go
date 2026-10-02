package telemetry

import (
	"context"
	"os"
	"testing"
	"time"

	"go.opentelemetry.io/otel"
	sdkmetric "go.opentelemetry.io/otel/sdk/metric"
	sdktrace "go.opentelemetry.io/otel/sdk/trace"
)

func TestLocalOpenObserveExport(t *testing.T) {
	if os.Getenv("CAO_LOCAL_OTEL_INTEGRATION") != "1" {
		t.Skip("set CAO_LOCAL_OTEL_INTEGRATION=1 to test against local OpenObserve")
	}
	if os.Getenv("OTEL_EXPORTER_OTLP_TRACES_ENDPOINT") == "" ||
		os.Getenv("OTEL_EXPORTER_OTLP_METRICS_ENDPOINT") == "" ||
		os.Getenv("OTEL_EXPORTER_OTLP_HEADERS") == "" {
		t.Fatal("configure local OTLP trace and metric endpoints and authorization headers")
	}

	previousTracer := otel.GetTracerProvider()
	previousMeter := otel.GetMeterProvider()
	t.Cleanup(func() {
		otel.SetTracerProvider(previousTracer)
		otel.SetMeterProvider(previousMeter)
	})
	t.Setenv("OTEL_SDK_DISABLED", "false")
	ctx, cancel := context.WithTimeout(t.Context(), 20*time.Second)
	defer cancel()
	shutdown, err := Setup(ctx, "local-integration-test")
	if err != nil {
		t.Fatal("could not initialize local OTLP exporters")
	}
	defer func() {
		stopCtx, stopCancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer stopCancel()
		if err := shutdown(stopCtx); err != nil {
			t.Error("local OTLP exporter shutdown failed")
		}
	}()

	_, span := Tracer().Start(ctx, "cao-dashboard.local-integration-test")
	span.End()
	tracer, ok := otel.GetTracerProvider().(*sdktrace.TracerProvider)
	if !ok {
		t.Fatal("trace exporter is not configured")
	}
	if err := tracer.ForceFlush(ctx); err != nil {
		t.Fatal("local OpenObserve trace export failed")
	}

	counter, err := otel.GetMeterProvider().Meter("cao-dashboard.local-integration-test").Int64Counter("cao_dashboard.local_integration_test.count")
	if err != nil {
		t.Fatal("could not create local test metric")
	}
	counter.Add(ctx, 1)
	meter, ok := otel.GetMeterProvider().(*sdkmetric.MeterProvider)
	if !ok {
		t.Fatal("metric exporter is not configured")
	}
	if err := meter.ForceFlush(ctx); err != nil {
		t.Fatal("local OpenObserve metric export failed")
	}
}
