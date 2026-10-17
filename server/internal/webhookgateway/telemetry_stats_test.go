package webhookgateway

import (
	"context"
	"math"
	"testing"

	"go.opentelemetry.io/otel"
	sdkmetric "go.opentelemetry.io/otel/sdk/metric"
	"go.opentelemetry.io/otel/sdk/metric/metricdata"
)

func TestGatewayTelemetryStatsAndMaintenance(t *testing.T) {
	ctx := context.Background()
	reader := sdkmetric.NewManualReader()
	provider := sdkmetric.NewMeterProvider(sdkmetric.WithReader(reader))
	old := otel.GetMeterProvider()
	otel.SetMeterProvider(provider)
	t.Cleanup(func() {
		otel.SetMeterProvider(old)
		_ = provider.Shutdown(ctx)
	})
	observeGatewayStats(ctx, QueueStats{
		Depth: 4, RetainedRows: 10, RetainedBytes: 5000, OldestAgeSeconds: 30,
		ActiveWorkers: 2, WorkerUtilization: 0.5,
		TenantUtilization: []float64{0.5, 0.25, math.NaN(), math.Inf(1), -1},
	})
	observeGatewayMaintenance(ctx, MaintenanceResult{Recovered: 2, Ambiguous: 1, Expired: 3, Deleted: 4})
	var data metricdata.ResourceMetrics
	if err := reader.Collect(ctx, &data); err != nil {
		t.Fatal(err)
	}
	expectedIntegers := map[string]int64{
		"cao_webhookgateway.queue.depth":            4,
		"cao_webhookgateway.queue.retained.rows":    10,
		"cao_webhookgateway.queue.retained.bytes":   5000,
		"cao_webhookgateway.workers.active":         2,
		"cao_webhookgateway.lease.expiration.count": 3,
		"cao_webhookgateway.queue.recovered.count":  2,
		"cao_webhookgateway.queue.expired.count":    3,
		"cao_webhookgateway.queue.ambiguous.count":  1,
		"cao_webhookgateway.queue.deleted.count":    4,
	}
	expectedFloats := map[string]float64{
		"cao_webhookgateway.queue.oldest_age":    30,
		"cao_webhookgateway.workers.utilization": 0.5,
	}
	histogramSeen := false
	for _, scope := range data.ScopeMetrics {
		for _, instrument := range scope.Metrics {
			switch observation := instrument.Data.(type) {
			case metricdata.Gauge[int64]:
				for _, point := range observation.DataPoints {
					if expected, ok := expectedIntegers[instrument.Name]; !ok || point.Value != expected || point.Attributes.Len() != 0 {
						t.Fatalf("unexpected integer observation %s %+v", instrument.Name, point)
					}
					delete(expectedIntegers, instrument.Name)
				}
			case metricdata.Sum[int64]:
				for _, point := range observation.DataPoints {
					if expected, ok := expectedIntegers[instrument.Name]; !ok || point.Value != expected || point.Attributes.Len() != 0 {
						t.Fatalf("unexpected counter observation %s %+v", instrument.Name, point)
					}
					delete(expectedIntegers, instrument.Name)
				}
			case metricdata.Gauge[float64]:
				for _, point := range observation.DataPoints {
					if expected, ok := expectedFloats[instrument.Name]; !ok || point.Value != expected || point.Attributes.Len() != 0 {
						t.Fatalf("unexpected float observation %s %+v", instrument.Name, point)
					}
					delete(expectedFloats, instrument.Name)
				}
			case metricdata.Histogram[float64]:
				if instrument.Name != "cao_webhookgateway.tenant.utilization" || len(observation.DataPoints) != 1 {
					t.Fatal("unexpected histogram")
				}
				point := observation.DataPoints[0]
				if point.Count != 2 || point.Sum != 0.75 || point.Attributes.Len() != 0 {
					t.Fatalf("unbounded or labeled utilization %+v", point)
				}
				histogramSeen = true
			}
		}
	}
	if len(expectedIntegers) != 0 || len(expectedFloats) != 0 || !histogramSeen {
		t.Fatalf("missing metrics integers=%v floats=%v histogram=%v", expectedIntegers, expectedFloats, histogramSeen)
	}
}

type shellStatsQueue struct {
	*shellQueue
	statsCalls int
}

func (q *shellStatsQueue) QueueStats(context.Context) (QueueStats, error) {
	q.statsCalls++
	return QueueStats{Depth: 1, RetainedRows: 1, RetainedBytes: 100, TenantUtilization: []float64{0.1}}, nil
}

func TestWorkerObservesQueueStatsWhenIdle(t *testing.T) {
	queue := &shellQueue{}
	worker := shellWorker(queue, &shellAuthorizer{})
	statsQueue := &shellStatsQueue{shellQueue: queue}
	worker.Queue = statsQueue
	queue.job = nil
	if worked, err := worker.RunOnce(context.Background()); err != nil || worked {
		t.Fatalf("worked=%v err=%v", worked, err)
	}
	if statsQueue.statsCalls != 1 {
		t.Fatal("idle worker failed to observe durable queue aggregates")
	}
}
