package collect

import (
	"context"
	"errors"
	"strings"
	"testing"

	"go.opentelemetry.io/otel"
	"go.opentelemetry.io/otel/codes"
	sdkmetric "go.opentelemetry.io/otel/sdk/metric"
	"go.opentelemetry.io/otel/sdk/metric/metricdata"
	sdktrace "go.opentelemetry.io/otel/sdk/trace"
	"go.opentelemetry.io/otel/sdk/trace/tracetest"

	"github.com/githubnext/gh-aw-cao/server/internal/redisx"
	"github.com/githubnext/gh-aw-cao/server/internal/telemetry"
)

func TestBackfillLifecycleTelemetryIsBoundedAndMarksIncompleteWork(t *testing.T) {
	previousTrace, previousMeter := otel.GetTracerProvider(), otel.GetMeterProvider()
	exporter := tracetest.NewInMemoryExporter()
	traceProvider := sdktrace.NewTracerProvider(sdktrace.WithSyncer(exporter))
	reader := sdkmetric.NewManualReader()
	meterProvider := sdkmetric.NewMeterProvider(sdkmetric.WithReader(reader))
	otel.SetTracerProvider(traceProvider)
	otel.SetMeterProvider(meterProvider)
	t.Cleanup(func() {
		_ = traceProvider.Shutdown(t.Context())
		_ = meterProvider.Shutdown(t.Context())
		otel.SetTracerProvider(previousTrace)
		otel.SetMeterProvider(previousMeter)
	})
	_, finish := startBackfillTelemetry(t.Context(), 7)
	finish(BackfillState{Phase: "partial", Repositories: 50_000, QueuedRunTasks: 349_993, EnumerationFailures: 1},
		errors.New("sensitive internal detail"))
	spans := exporter.GetSpans()
	if len(spans) != 1 || spans[0].Name != telemetry.SpanBackfillRun || spans[0].Status.Code != codes.Error {
		t.Fatalf("incomplete backfill lifecycle span = %+v", spans)
	}
	for _, attr := range spans[0].Attributes {
		if strings.Contains(attr.Value.String(), "sensitive") || strings.Contains(string(attr.Key), "repository_id") {
			t.Fatal("backfill lifecycle telemetry included internal details or per-repository attributes")
		}
	}
	var metrics metricdata.ResourceMetrics
	if err := reader.Collect(t.Context(), &metrics); err != nil {
		t.Fatal(err)
	}
	foundCount, foundDuration := false, false
	for _, scope := range metrics.ScopeMetrics {
		for _, metric := range scope.Metrics {
			foundCount = foundCount || metric.Name == "cao_dashboard.collection.backfill.run.count"
			foundDuration = foundDuration || metric.Name == "cao_dashboard.collection.backfill.duration"
		}
	}
	if !foundCount || !foundDuration {
		t.Fatal("backfill lifecycle counter or duration histogram is missing")
	}
}

type checkpointFailureClient struct{}

func (checkpointFailureClient) Do(_ context.Context, _ ...string) (any, error) {
	return nil, errors.New("injected checkpoint failure")
}

func (checkpointFailureClient) DoMany(_ context.Context, _ [][]string) ([]any, error) {
	return nil, errors.New("injected checkpoint failure")
}

func TestBackfillDoesNotReportSuccessWhenCheckpointCannotBePersisted(t *testing.T) {
	store := redisx.NewStore(checkpointFailureClient{}, "checkpoint-failure")
	state, err := (Backfill{Store: store}).Run(t.Context())
	if err == nil || state.Phase != "failed" || state.CompletedAt == "" {
		t.Fatalf("checkpoint failure was hidden: %+v, %v", state, err)
	}
}
