package githubquota

import (
	"context"
	"errors"
	"strconv"
	"time"

	"go.opentelemetry.io/otel"
	"go.opentelemetry.io/otel/attribute"
	"go.opentelemetry.io/otel/codes"
	"go.opentelemetry.io/otel/metric"
	"go.opentelemetry.io/otel/trace"
)

// instrumentationName is the OpenTelemetry scope shared with the rest of the
// CAO server so quota telemetry exports alongside server spans and metrics.
const instrumentationName = "github.com/githubnext/gh-aw-cao/server"

// Span and metric names are stable and low-cardinality. Attributes carry only
// non-secret bucket identity (App name, installation ID, resource), fixed
// operation names, and fixed outcomes; tokens, reservation IDs, and free-form
// parking reasons are never recorded.
const (
	spanPrefix           = "cao_githubquota."
	metricOperationCount = "cao_githubquota.operation.count"
	metricOperationTime  = "cao_githubquota.operation.duration"
	metricRemaining      = "cao_githubquota.bucket.remaining"
	metricReserved       = "cao_githubquota.bucket.reserved"
	metricAvailable      = "cao_githubquota.bucket.available"
	metricParked         = "cao_githubquota.bucket.parked"

	attributeOperation    = "cao_githubquota.operation"
	attributeOutcome      = "cao_githubquota.outcome"
	attributeApp          = "cao_githubquota.app"
	attributeInstallation = "cao_githubquota.installation"
	attributeResource     = "cao_githubquota.resource"
	attributeStatus       = "cao_githubquota.status"
	attributeCandidates   = "cao_githubquota.candidates"
	attributeCost         = "cao_githubquota.cost"
	attributeFloor        = "cao_githubquota.floor"
)

// Fixed operation outcomes.
const (
	outcomeSuccess    = "success"
	outcomeError      = "error"
	outcomeInvalid    = "invalid"
	outcomeAdmitted   = "admitted"
	outcomeStale      = "stale"
	outcomeReplaced   = "replaced"
	outcomeReconciled = "reconciled"
	outcomeExpired    = "expired"
	outcomeExtended   = "extended"
	outcomeUnchanged  = "unchanged"
	outcomeSelected   = "selected"
	outcomeNoBucket   = "no_candidates"
)

// operation is one instrumented service call: a span plus an operation
// counter and duration histogram recorded when it finishes.
type operation struct {
	name    string
	started time.Time
	span    trace.Span
	attrs   []attribute.KeyValue
	outcome string
}

func startOperation(ctx context.Context, name string, bucket BucketID) (context.Context, *operation) {
	op := &operation{name: name, started: time.Now(), outcome: outcomeSuccess}
	op.attrs = []attribute.KeyValue{attribute.String(attributeOperation, name)}
	if bucket.App != "" {
		op.attrs = append(op.attrs,
			attribute.String(attributeApp, bucket.App),
			attribute.String(attributeResource, bucket.Resource))
	}
	ctx, op.span = otel.Tracer(instrumentationName).Start(ctx, spanPrefix+name,
		trace.WithSpanKind(trace.SpanKindInternal),
		trace.WithAttributes(op.attrs...))
	if bucket.Installation > 0 {
		op.span.SetAttributes(attribute.Int64(attributeInstallation, bucket.Installation))
	}
	return ctx, op
}

// setBucket attaches the normalized bucket identity once validation succeeds.
func (op *operation) setBucket(bucket BucketID) {
	if op.span == nil {
		return
	}
	if len(op.attrs) == 1 {
		op.attrs = append(op.attrs,
			attribute.String(attributeApp, bucket.App),
			attribute.String(attributeResource, bucket.Resource))
	}
	op.span.SetAttributes(
		attribute.String(attributeApp, bucket.App),
		attribute.String(attributeResource, bucket.Resource),
		attribute.Int64(attributeInstallation, bucket.Installation))
}

// finish ends the span and records the operation metrics. Unavailable
// buckets are expected admission outcomes, not errors.
func (op *operation) finish(ctx context.Context, err error) {
	outcome := op.outcome
	var unavailable *UnavailableError
	switch {
	case errors.As(err, &unavailable):
		outcome = string(unavailable.Status)
		op.span.SetAttributes(attribute.String(attributeStatus, outcome))
		op.span.SetStatus(codes.Ok, "")
	case errors.Is(err, ErrNoCandidates):
		outcome = outcomeNoBucket
		op.span.SetStatus(codes.Ok, "")
	case err != nil && outcome == outcomeInvalid:
		op.span.SetStatus(codes.Error, "invalid github quota request")
	case err != nil:
		outcome = outcomeError
		op.span.RecordError(err)
		op.span.SetStatus(codes.Error, "github quota operation failed")
	default:
		op.span.SetStatus(codes.Ok, "")
	}
	op.span.SetAttributes(attribute.String(attributeOutcome, outcome))
	op.span.End()

	attrs := metric.WithAttributes(append(op.attrs, attribute.String(attributeOutcome, outcome))...)
	meter := otel.Meter(instrumentationName)
	if counter, counterErr := meter.Int64Counter(metricOperationCount,
		metric.WithUnit("{operation}"),
		metric.WithDescription("GitHub quota service operations by operation, bucket app and resource, and fixed outcome"),
	); counterErr == nil {
		counter.Add(ctx, 1, attrs)
	}
	if histogram, histogramErr := meter.Float64Histogram(metricOperationTime,
		metric.WithUnit("s"),
		metric.WithDescription("GitHub quota service operation latency including the atomic Redis script"),
	); histogramErr == nil {
		histogram.Record(ctx, time.Since(op.started).Seconds(), attrs)
	}
}

// recordBucketState publishes the latest known bucket state as gauges so
// operators can see headroom, reservations, and parking per bucket.
func recordBucketState(ctx context.Context, state BucketState) {
	meter := otel.Meter(instrumentationName)
	attrs := metric.WithAttributes(
		attribute.String(attributeApp, state.Bucket.App),
		attribute.String(attributeInstallation, strconv.FormatInt(state.Bucket.Installation, 10)),
		attribute.String(attributeResource, state.Bucket.Resource),
	)
	parked := int64(0)
	if state.Status == StatusParked {
		parked = 1
	}
	gauges := []struct {
		name        string
		unit        string
		description string
		value       int64
	}{
		{metricRemaining, "{request}", "Last authoritative GitHub remaining quota for the bucket", int64(state.Remaining)},
		{metricReserved, "{request}", "Quota reserved by unreconciled work in the bucket", int64(state.Reserved)},
		{metricAvailable, "{request}", "Remaining minus reserved quota for the bucket", int64(state.Available)},
		{metricParked, "1", "Whether the bucket is parked (1) or not (0)", parked},
	}
	for _, gauge := range gauges {
		instrument, err := meter.Int64Gauge(gauge.name, metric.WithUnit(gauge.unit), metric.WithDescription(gauge.description))
		if err == nil {
			instrument.Record(ctx, gauge.value, attrs)
		}
	}
}
