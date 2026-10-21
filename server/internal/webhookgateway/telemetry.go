package webhookgateway

import (
	"context"
	"math"
	"time"

	"go.opentelemetry.io/otel"
	"go.opentelemetry.io/otel/attribute"
	"go.opentelemetry.io/otel/codes"
	"go.opentelemetry.io/otel/metric"
	"go.opentelemetry.io/otel/trace"
)

const gatewayInstrumentation = "github.com/githubnext/gh-cao/server"

// Values used as metric labels are classified here, never copied from a webhook.
func eventFamily(event string) string {
	switch event {
	case "issues", "issue_comment", "pull_request", "pull_request_review", "pull_request_review_comment":
		return "collaboration"
	case "push", "create", "delete":
		return "code"
	case "workflow_run", "workflow_job", "check_run", "check_suite":
		return "automation"
	case "projects_v2", "projects_v2_item":
		return "projects"
	case "installation", "installation_repositories", "repository", "organization":
		return "administration"
	default:
		return "other"
	}
}

func gatewayStage(ctx context.Context, stage, event string) (context.Context, func(string)) {
	start := time.Now()
	attrs := []attribute.KeyValue{
		attribute.String("cao_webhookgateway.stage", stage),
		attribute.String("cao_webhookgateway.event_family", eventFamily(event)),
	}
	ctx, span := otel.Tracer(gatewayInstrumentation).Start(ctx, "cao_webhookgateway."+stage,
		trace.WithAttributes(attrs...))
	return ctx, func(outcome string) {
		attrs = append(attrs, attribute.String("cao_webhookgateway.outcome", outcome))
		span.SetAttributes(attrs...)
		if outcome == "error" || outcome == "ambiguous" {
			span.SetStatus(codes.Error, "gateway stage incomplete")
		}
		meter := otel.Meter(gatewayInstrumentation)
		options := metric.WithAttributes(attrs...)
		if counter, err := meter.Int64Counter("cao_webhookgateway.operation.count"); err == nil {
			counter.Add(ctx, 1, options)
		}
		if duration, err := meter.Float64Histogram("cao_webhookgateway.operation.duration", metric.WithUnit("s")); err == nil {
			duration.Record(ctx, time.Since(start).Seconds(), options)
		}
		span.End()
	}
}

func observeQueueAge(ctx context.Context, created time.Time) {
	age := time.Since(created).Seconds()
	if age < 0 {
		age = 0
	}
	if instrument, err := otel.Meter(gatewayInstrumentation).Float64Histogram("cao_webhookgateway.queue.age", metric.WithUnit("s")); err == nil {
		instrument.Record(ctx, age)
	}
}

func observeGatewayRetry(ctx context.Context) {
	if instrument, err := otel.Meter(gatewayInstrumentation).Int64Counter("cao_webhookgateway.retry.count"); err == nil {
		instrument.Add(ctx, 1)
	}
}

func observeGatewayQueue(ctx context.Context, depth int64) {
	if instrument, err := otel.Meter(gatewayInstrumentation).Int64Gauge("cao_webhookgateway.queue.depth"); err == nil {
		instrument.Record(ctx, depth)
	}
}

func traceGatewayIdentity(ctx context.Context, deliveryID, jobID string) {
	span := trace.SpanFromContext(ctx)
	if deliveryID != "" {
		span.SetAttributes(attribute.String("cao_webhookgateway.delivery_id", deliveryID))
	}
	if jobID != "" {
		span.SetAttributes(attribute.String("cao_webhookgateway.job_id", jobID))
	}
}

func traceGatewayAcceptance(ctx context.Context, status int, workflowRunID int64) {
	if status == 0 {
		return
	}
	span := trace.SpanFromContext(ctx)
	span.SetAttributes(attribute.Int("cao_webhookgateway.accepted_status", status))
	if workflowRunID > 0 {
		span.SetAttributes(attribute.Int64("cao_webhookgateway.workflow_run_id", workflowRunID))
	}
}

func observeGatewayStats(ctx context.Context, stats QueueStats) {
	observeGatewayQueue(ctx, stats.Depth)
	meter := otel.Meter(gatewayInstrumentation)
	for _, observation := range []struct {
		name  string
		unit  string
		value int64
	}{
		{"cao_webhookgateway.queue.retained.rows", "{row}", stats.RetainedRows},
		{"cao_webhookgateway.queue.retained.bytes", "By", stats.RetainedBytes},
		{"cao_webhookgateway.workers.active", "{worker}", stats.ActiveWorkers},
	} {
		if gauge, err := meter.Int64Gauge(observation.name, metric.WithUnit(observation.unit)); err == nil && observation.value >= 0 {
			gauge.Record(ctx, observation.value)
		}
	}
	for _, observation := range []struct {
		name  string
		unit  string
		value float64
	}{
		{"cao_webhookgateway.queue.oldest_age", "s", stats.OldestAgeSeconds},
		{"cao_webhookgateway.workers.utilization", "1", stats.WorkerUtilization},
	} {
		if gauge, err := meter.Float64Gauge(observation.name, metric.WithUnit(observation.unit)); err == nil && validObservation(observation.value) {
			gauge.Record(ctx, observation.value)
		}
	}
	if histogram, err := meter.Float64Histogram("cao_webhookgateway.tenant.utilization", metric.WithUnit("1")); err == nil {
		for _, utilization := range stats.TenantUtilization {
			if validObservation(utilization) {
				histogram.Record(ctx, utilization)
			}
		}
	}
}

func validObservation(value float64) bool {
	return value >= 0 && !math.IsNaN(value) && !math.IsInf(value, 0)
}

func observeGatewayMaintenance(ctx context.Context, result MaintenanceResult) {
	meter := otel.Meter(gatewayInstrumentation)
	for _, observation := range []struct {
		name  string
		count int
	}{
		{"cao_webhookgateway.lease.expiration.count", result.Recovered + result.Ambiguous},
		{"cao_webhookgateway.queue.recovered.count", result.Recovered},
		{"cao_webhookgateway.queue.expired.count", result.Expired},
		{"cao_webhookgateway.queue.ambiguous.count", result.Ambiguous},
		{"cao_webhookgateway.queue.deleted.count", result.Deleted},
	} {
		if observation.count <= 0 {
			continue
		}
		if counter, err := meter.Int64Counter(observation.name); err == nil {
			counter.Add(ctx, int64(observation.count))
		}
	}
}
