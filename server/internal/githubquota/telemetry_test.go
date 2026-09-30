package githubquota

import (
	"errors"
	"strings"
	"testing"
	"time"

	"go.opentelemetry.io/otel"
	"go.opentelemetry.io/otel/attribute"
	"go.opentelemetry.io/otel/codes"
	sdkmetric "go.opentelemetry.io/otel/sdk/metric"
	"go.opentelemetry.io/otel/sdk/metric/metricdata"
	sdktrace "go.opentelemetry.io/otel/sdk/trace"
	"go.opentelemetry.io/otel/sdk/trace/tracetest"
)

func installTestTelemetry(t *testing.T) (*tracetest.InMemoryExporter, *sdkmetric.ManualReader) {
	t.Helper()
	previousTracer := otel.GetTracerProvider()
	previousMeter := otel.GetMeterProvider()
	traces := tracetest.NewInMemoryExporter()
	traceProvider := sdktrace.NewTracerProvider(sdktrace.WithSyncer(traces))
	reader := sdkmetric.NewManualReader()
	meterProvider := sdkmetric.NewMeterProvider(sdkmetric.WithReader(reader))
	otel.SetTracerProvider(traceProvider)
	otel.SetMeterProvider(meterProvider)
	t.Cleanup(func() {
		_ = meterProvider.Shutdown(t.Context())
		_ = traceProvider.Shutdown(t.Context())
		otel.SetTracerProvider(previousTracer)
		otel.SetMeterProvider(previousMeter)
	})
	return traces, reader
}

func TestServiceEmitsSpansAndMetricsWithoutSecrets(t *testing.T) {
	traces, reader := installTestTelemetry(t)
	service, _ := newTestService(t, Options{})
	ctx := t.Context()
	bucket := BucketID{App: "collector", Installation: 42}
	observe(t, service, bucket, 1000, testNow.Add(time.Hour))
	reservation, err := service.Reserve(ctx, bucket, ReservationRequest{EstimatedCost: 100, MinimumRemain: 500})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := service.Reserve(ctx, bucket, ReservationRequest{EstimatedCost: 950}); !errors.Is(err, ErrExhausted) {
		t.Fatalf("exhausted reservation = %v", err)
	}
	if err := service.Release(ctx, reservation); err != nil {
		t.Fatal(err)
	}
	const privateReason = "private-operator-note"
	if err := service.Park(ctx, bucket, testNow.Add(time.Minute), privateReason); err != nil {
		t.Fatal(err)
	}
	if _, err := service.Select(ctx, []BucketID{bucket}, Requirement{EstimatedCost: 1}); !errors.Is(err, ErrParked) {
		t.Fatalf("parked selection = %v", err)
	}
	if _, err := service.Reserve(ctx, BucketID{App: "bad:app", Installation: 1}, ReservationRequest{EstimatedCost: 1}); err == nil {
		t.Fatal("invalid bucket was accepted")
	}

	outcomes := map[string][]string{}
	for _, span := range traces.GetSpans() {
		if !strings.HasPrefix(span.Name, spanPrefix) {
			t.Fatalf("unexpected span name %q", span.Name)
		}
		for _, attr := range span.Attributes {
			value := attr.Value.String()
			if strings.Contains(value, reservation.ID) || strings.Contains(value, privateReason) {
				t.Fatalf("span %s recorded sensitive attribute %s", span.Name, attr.Key)
			}
			if attr.Key == attributeOutcome {
				outcomes[span.Name] = append(outcomes[span.Name], value)
			}
		}
		if span.Name == spanPrefix+"reserve" && span.Status.Code == codes.Error {
			outcome := ""
			for _, attr := range span.Attributes {
				if attr.Key == attributeOutcome {
					outcome = attr.Value.AsString()
				}
			}
			if outcome != outcomeInvalid {
				t.Fatalf("reserve span failed with outcome %q", outcome)
			}
		}
	}
	want := map[string][]string{
		spanPrefix + "observe": {outcomeReplaced},
		spanPrefix + "reserve": {outcomeAdmitted, string(StatusExhausted), outcomeInvalid},
		spanPrefix + "release": {outcomeSuccess},
		spanPrefix + "park":    {outcomeExtended},
		spanPrefix + "select":  {string(StatusParked)},
	}
	for name, expected := range want {
		if strings.Join(outcomes[name], ",") != strings.Join(expected, ",") {
			t.Fatalf("span %s outcomes = %v, want %v", name, outcomes[name], expected)
		}
	}

	var metrics metricdata.ResourceMetrics
	if err := reader.Collect(ctx, &metrics); err != nil {
		t.Fatal(err)
	}
	counts := map[string]int64{}
	gauges := map[string]int64{}
	for _, scope := range metrics.ScopeMetrics {
		for _, recorded := range scope.Metrics {
			switch data := recorded.Data.(type) {
			case metricdata.Sum[int64]:
				for _, point := range data.DataPoints {
					operation, _ := point.Attributes.Value(attribute.Key(attributeOperation))
					outcome, _ := point.Attributes.Value(attribute.Key(attributeOutcome))
					counts[operation.AsString()+"/"+outcome.AsString()] += point.Value
				}
			case metricdata.Gauge[int64]:
				for _, point := range data.DataPoints {
					installation, _ := point.Attributes.Value(attribute.Key(attributeInstallation))
					if installation.AsString() == "42" {
						gauges[recorded.Name] = point.Value
					}
				}
			}
		}
	}
	for key, expected := range map[string]int64{
		"observe/replaced": 1, "reserve/admitted": 1, "reserve/exhausted": 1, "reserve/invalid": 1,
		"release/success": 1, "park/extended": 1, "select/parked": 1,
	} {
		if counts[key] != expected {
			t.Fatalf("operation count %s = %d, want %d (all: %v)", key, counts[key], expected, counts)
		}
	}
	if gauges[metricRemaining] != 1000 || gauges[metricReserved] != 0 || gauges[metricAvailable] != 1000 || gauges[metricParked] != 1 {
		t.Fatalf("unexpected bucket gauges %v", gauges)
	}
}
