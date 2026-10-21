package collect

import (
	"errors"
	"strings"
	"testing"
	"time"

	"go.opentelemetry.io/otel"
	"go.opentelemetry.io/otel/baggage"
	"go.opentelemetry.io/otel/codes"
	sdkmetric "go.opentelemetry.io/otel/sdk/metric"
	"go.opentelemetry.io/otel/sdk/metric/metricdata"
	sdktrace "go.opentelemetry.io/otel/sdk/trace"
	"go.opentelemetry.io/otel/sdk/trace/tracetest"

	"github.com/githubnext/gh-cao/server/internal/telemetry"
)

func TestRefreshTelemetryCorrelatesQueuedWorkWithoutPayloadMetadata(t *testing.T) {
	previousTrace, previousMeter := otel.GetTracerProvider(), otel.GetMeterProvider()
	exporter := tracetest.NewInMemoryExporter()
	tracer := sdktrace.NewTracerProvider(sdktrace.WithSyncer(exporter))
	reader := sdkmetric.NewManualReader()
	meter := sdkmetric.NewMeterProvider(sdkmetric.WithReader(reader))
	otel.SetTracerProvider(tracer)
	otel.SetMeterProvider(meter)
	t.Cleanup(func() {
		_ = tracer.Shutdown(t.Context())
		_ = meter.Shutdown(t.Context())
		otel.SetTracerProvider(previousTrace)
		otel.SetMeterProvider(previousMeter)
	})
	w := refreshWorker(t)
	ctx := t.Context()
	secret, err := baggage.NewMember("private", "sensitive-private-value")
	if err != nil {
		t.Fatal(err)
	}
	bag, err := baggage.New(secret)
	if err != nil {
		t.Fatal(err)
	}
	ctx = baggage.ContextWithBaggage(ctx, bag)
	if err := w.Enrollment.AddRepositories(ctx, 7, []string{"octo/api"}); err != nil {
		t.Fatal(err)
	}
	admitter := Admitter{Queue: w.Queue, Enrollment: w.Enrollment}
	payload := []byte(`{"ref":"refs/heads/main","installation":{"id":7},"repository":{"full_name":"octo/api","default_branch":"main"},"commits":[{"modified":[".github/workflows/build.lock.yml"]}]}`)
	for _, delivery := range []string{"first", "second", "first"} {
		if _, err := admitter.AdmitDelivery(ctx, "push", payload, delivery, time.Hour); err != nil {
			t.Fatal(err)
		}
	}
	lease := refreshLease(t, w.Queue)
	if !strings.HasPrefix(lease.Task.Traceparent, "00-") || strings.Contains(lease.Task.Traceparent, "sensitive") {
		t.Fatal("task did not persist isolated traceparent correlation")
	}
	w.process(ctx, lease)
	_, fail := startRefreshTelemetry(ctx, "worker", "workflows")
	fail("failed", errors.New("sensitive-private-value"))
	spans := exporter.GetSpans()
	if len(spans) != 5 || spans[3].Name != telemetry.SpanCollectionRefresh ||
		spans[3].Parent.SpanID() != spans[0].SpanContext.SpanID() ||
		spans[3].SpanContext.TraceID() != spans[0].SpanContext.TraceID() ||
		spans[4].Status.Code != codes.Error {
		t.Fatalf("refresh trace correlation or failure status missing: %+v", spans)
	}
	for _, span := range spans {
		for _, attr := range span.Attributes {
			if strings.Contains(attr.Value.String(), "sensitive") || strings.Contains(attr.Value.String(), "octo/api") {
				t.Fatal("refresh spans contained private or per-repository metadata")
			}
		}
		if len(span.Events) != 0 || strings.Contains(span.Status.Description, "sensitive") {
			t.Fatal("refresh span exported raw failure details")
		}
	}
	var metrics metricdata.ResourceMetrics
	if err := reader.Collect(ctx, &metrics); err != nil {
		t.Fatal(err)
	}
	found := map[string]bool{}
	for _, scope := range metrics.ScopeMetrics {
		for _, measurement := range scope.Metrics {
			found[measurement.Name] = true
		}
	}
	for _, name := range []string{"cao_dashboard.collection.refresh.count", "cao_dashboard.collection.refresh.duration", "cao_dashboard.collection.refresh.queue_age"} {
		if !found[name] {
			t.Fatalf("missing metric %s", name)
		}
	}
}
