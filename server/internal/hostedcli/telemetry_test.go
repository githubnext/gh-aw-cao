package hostedcli

import (
	"context"
	"regexp"
	"strings"
	"testing"

	"go.opentelemetry.io/otel"
	sdkmetric "go.opentelemetry.io/otel/sdk/metric"
	"go.opentelemetry.io/otel/sdk/metric/metricdata"
	sdktrace "go.opentelemetry.io/otel/sdk/trace"
	"go.opentelemetry.io/otel/sdk/trace/tracetest"

	"github.com/githubnext/gh-aw-cao/server/internal/operational"
)

func TestExecutorTelemetryTracesCommandWithoutSecretsOrActors(t *testing.T) {
	previousTrace, previousMeter := otel.GetTracerProvider(), otel.GetMeterProvider()
	exporter := tracetest.NewInMemoryExporter()
	traceProvider := sdktrace.NewTracerProvider(sdktrace.WithSyncer(exporter))
	reader := sdkmetric.NewManualReader()
	meterProvider := sdkmetric.NewMeterProvider(sdkmetric.WithReader(reader))
	otel.SetTracerProvider(traceProvider)
	otel.SetMeterProvider(meterProvider)
	t.Cleanup(func() {
		_ = traceProvider.Shutdown(context.Background())
		_ = meterProvider.Shutdown(context.Background())
		otel.SetTracerProvider(previousTrace)
		otel.SetMeterProvider(previousMeter)
	})

	queue, minter := newFakeQueue(), newFakeMinter()
	runner := &fakeRunner{minter: minter}
	var traceparent string
	runner.run = func(_ context.Context, process Process, _ OutputFunc) (int, error) {
		traceparent = envValue(process, "TRACEPARENT")
		return 0, nil
	}
	startExecutor(t, queue, minter, fakeGitHub{permission: "write"}, runner)
	id := enqueue(t, queue, "gh aw upgrade --repo octo/app --create-pull-request", "octo/app", "mona")
	if command := queue.waitSettled(t, id); command.Status != operational.CLICommandCompleted {
		t.Fatalf("unexpected result %+v", command)
	}
	if !regexp.MustCompile(`^00-[0-9a-f]{32}-[0-9a-f]{16}-0[01]$`).MatchString(traceparent) {
		t.Fatalf("subprocess TRACEPARENT = %q", traceparent)
	}

	names := map[string]bool{}
	for _, span := range exporter.GetSpans() {
		names[span.Name] = true
		for _, attr := range span.Attributes {
			value := attr.Value.String()
			if strings.Contains(value, "ghs_fake") || value == "mona" {
				t.Fatalf("span %s leaked %s=%s", span.Name, attr.Key, value)
			}
		}
	}
	for _, want := range []string{"cao_hostedcli.command.execute", "cao_hostedcli.token.mint", "cao_hostedcli.token.revoke"} {
		if !names[want] {
			t.Fatalf("missing span %s in %v", want, names)
		}
	}

	var metrics metricdata.ResourceMetrics
	if err := reader.Collect(t.Context(), &metrics); err != nil {
		t.Fatal(err)
	}
	found := map[string]bool{}
	for _, scope := range metrics.ScopeMetrics {
		for _, metric := range scope.Metrics {
			found[metric.Name] = true
		}
	}
	for _, want := range []string{"cao_hostedcli.command.count", "cao_hostedcli.command.duration", "cao_hostedcli.token.operation.count"} {
		if !found[want] {
			t.Fatalf("missing metric %s in %v", want, found)
		}
	}
}
