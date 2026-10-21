package webhookgateway

import (
	"context"
	"fmt"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"go.opentelemetry.io/otel"
	"go.opentelemetry.io/otel/attribute"
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
	observeQueueAge(ctx, time.Now(), time.Now())
	end("filtered")
}

func TestGatewayQueueAgeUsesServiceTime(t *testing.T) {
	reader := sdkmetric.NewManualReader()
	provider := sdkmetric.NewMeterProvider(sdkmetric.WithReader(reader))
	old := otel.GetMeterProvider()
	otel.SetMeterProvider(provider)
	t.Cleanup(func() {
		otel.SetMeterProvider(old)
		_ = provider.Shutdown(t.Context())
	})
	now := time.Date(2026, 1, 1, 0, 2, 0, 0, time.UTC)
	observeQueueAge(t.Context(), now, now.Add(-2*time.Minute))
	var data metricdata.ResourceMetrics
	if err := reader.Collect(t.Context(), &data); err != nil {
		t.Fatal(err)
	}
	for _, scope := range data.ScopeMetrics {
		for _, metric := range scope.Metrics {
			if metric.Name == "cao_webhookgateway.queue.age" {
				histogram, ok := metric.Data.(metricdata.Histogram[float64])
				if !ok || len(histogram.DataPoints) != 1 || histogram.DataPoints[0].Sum != 120 {
					t.Fatal("queue age did not use controlled service time")
				}
				return
			}
		}
	}
	t.Fatal("queue age metric missing")
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

func TestIngressRecordsMatchingStageOncePerDelivery(t *testing.T) {
	for _, action := range []string{"edited", "deleted"} {
		t.Run(action, func(t *testing.T) {
			reader := sdkmetric.NewManualReader()
			provider := sdkmetric.NewMeterProvider(sdkmetric.WithReader(reader))
			old := otel.GetMeterProvider()
			otel.SetMeterProvider(provider)
			t.Cleanup(func() {
				otel.SetMeterProvider(old)
				_ = provider.Shutdown(context.Background())
			})
			sub, snapshot := shellFixture()
			sub.ID = "second"
			snapshot.Subscriptions = append(snapshot.Subscriptions, sub)
			snapshot.Revisions[sub.ID] = snapshot.Revisions["project-sync"]
			handler := Ingress{SourceID: "projects", Secrets: shellSecrets{}, Policies: shellPolicy{snapshot: snapshot},
				Queue: &shellQueue{}, Authorizer: &shellAuthorizer{}}
			body := fmt.Sprintf(`{"action":%q,"installation":{"id":10},"organization":{"id":20},"projects_v2_item":{"id":9}}`, action)
			handler.ServeHTTP(httptest.NewRecorder(), shellRequest(body))
			var data metricdata.ResourceMetrics
			if err := reader.Collect(t.Context(), &data); err != nil {
				t.Fatal(err)
			}
			var count int64
			for _, scope := range data.ScopeMetrics {
				for _, instrument := range scope.Metrics {
					if instrument.Name != "cao_webhookgateway.operation.count" {
						continue
					}
					for _, point := range instrument.Data.(metricdata.Sum[int64]).DataPoints {
						if stage, _ := point.Attributes.Value(attribute.Key("cao_webhookgateway.stage")); stage.AsString() == "matching" {
							count += point.Value
						}
					}
				}
			}
			if count != 1 {
				t.Fatalf("matching stage counted %d times for one delivery", count)
			}
		})
	}
}
