package webhookgateway

import (
	"context"
	"fmt"
	"strings"
	"testing"
	"time"

	"go.opentelemetry.io/otel"
	sdkmetric "go.opentelemetry.io/otel/sdk/metric"
	"go.opentelemetry.io/otel/sdk/metric/metricdata"
)

func TestGatewayTelemetryBoundedEventFamily(t *testing.T) {
	for _, event := range []string{"private-org/private-repo", "secret", "", "projects_v2_untrusted"} {
		if got := eventFamily(event); got != "other" {
			t.Fatalf("untrusted label %q classified as %q", event, got)
		}
	}
	ctx, end := gatewayStage(context.Background(), "admission", "projects_v2_item")
	observeQueueAge(ctx, time.Now())
	end("filtered")
}

func TestGatewayTelemetryPrivateEventNeverMetricLabel(t *testing.T) {
	reader := sdkmetric.NewManualReader()
	provider := sdkmetric.NewMeterProvider(sdkmetric.WithReader(reader))
	old := otel.GetMeterProvider()
	otel.SetMeterProvider(provider)
	t.Cleanup(func() {
		otel.SetMeterProvider(old)
		_ = provider.Shutdown(context.Background())
	})
	ctx, end := gatewayStage(context.Background(), "admission", "sensitive-customer-event")
	end("filtered")
	observeGatewayQueue(ctx, 3)
	observeGatewayRetry(ctx)
	var data metricdata.ResourceMetrics
	if err := reader.Collect(ctx, &data); err != nil {
		t.Fatal(err)
	}
	if strings.Contains(fmt.Sprint(data), "sensitive-customer-event") {
		t.Fatal("untrusted event leaked into exported metrics")
	}
	if len(data.ScopeMetrics) == 0 {
		t.Fatal("metrics were not exported")
	}
}
