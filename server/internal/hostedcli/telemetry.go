package hostedcli

import (
	"context"
	"sync"
	"time"

	"go.opentelemetry.io/otel"
	"go.opentelemetry.io/otel/attribute"
	"go.opentelemetry.io/otel/codes"
	"go.opentelemetry.io/otel/metric"
	"go.opentelemetry.io/otel/trace"
)

// instrumentationName is the scope shared with the rest of the CAO server.
const instrumentationName = "github.com/githubnext/gh-aw-cao/server"

// Span and metric names are stable. Metric attributes are low-cardinality
// fixed values; repositories and command IDs appear only on spans. Actors
// never appear; correlate them through the audit trail by command ID.
// Tokens never appear; spans carry GitHub's hashed_token digest only.
const (
	spanCommand     = "cao_hostedcli.command.execute"
	spanTokenMint   = "cao_hostedcli.token.mint"   //nolint:gosec // telemetry name, not a credential
	spanTokenRevoke = "cao_hostedcli.token.revoke" //nolint:gosec // telemetry name, not a credential

	metricCommandCount  = "cao_hostedcli.command.count"
	metricCommandTime   = "cao_hostedcli.command.duration"
	metricTokenCount    = "cao_hostedcli.token.operation.count"     //nolint:gosec // telemetry name, not a credential
	metricTokenPooled   = "cao_hostedcli.token.pooled"              //nolint:gosec // telemetry name, not a credential
	metricTokenPending  = "cao_hostedcli.token.pending_revocations" //nolint:gosec // telemetry name, not a credential
	metricLeaseHeld     = "cao_hostedcli.lease.held"
	attributeStatus     = "cao_hostedcli.status"
	attributeOperation  = "cao_hostedcli.token.operation"
	attributeOutcome    = "cao_hostedcli.outcome"
	attributeCommandID  = "cao_hostedcli.command.id"
	attributeRepository = "cao_hostedcli.repository"
	attributeExitCode   = "cao_hostedcli.exit_code"
	attributeInstall    = "cao_hostedcli.installation.id"
	attributeHashed     = "cao_hostedcli.token.hashed"
)

// Token operations counted by metricTokenCount.
const (
	tokenMint    = "mint"
	tokenReuse   = "reuse"
	tokenRevoke  = "revoke"
	tokenDiscard = "discard"
)

type instruments struct {
	commands  metric.Int64Counter
	duration  metric.Float64Histogram
	tokens    metric.Int64Counter
	leaseHeld metric.Int64UpDownCounter
}

var (
	instrumentsOnce sync.Once
	sharedMetrics   instruments
)

// metrics returns process-wide instruments. The global OpenTelemetry API
// delegates to whichever provider telemetry.Setup installs, so instruments
// created before setup still export.
func metrics() instruments {
	instrumentsOnce.Do(func() {
		meter := otel.Meter(instrumentationName)
		sharedMetrics.commands, _ = meter.Int64Counter(metricCommandCount,
			metric.WithDescription("Hosted CLI commands settled, by terminal status."), metric.WithUnit("{command}"))
		sharedMetrics.duration, _ = meter.Float64Histogram(metricCommandTime,
			metric.WithDescription("Hosted CLI command execution time, by terminal status."), metric.WithUnit("s"),
			metric.WithExplicitBucketBoundaries(0.5, 1, 5, 15, 30, 60, 120, 300, 600, 1200))
		sharedMetrics.tokens, _ = meter.Int64Counter(metricTokenCount,
			metric.WithDescription("Single-use installation token operations, by operation and outcome."), metric.WithUnit("{token}"))
		sharedMetrics.leaseHeld, _ = meter.Int64UpDownCounter(metricLeaseHeld,
			metric.WithDescription("Executors in this process holding the hosted CLI queue lease."), metric.WithUnit("{lease}"))
	})
	return sharedMetrics
}

func tracer() trace.Tracer { return otel.Tracer(instrumentationName) }

func countToken(ctx context.Context, operation string, err error) {
	outcome := "success"
	if err != nil {
		outcome = "error"
	}
	if counter := metrics().tokens; counter != nil {
		counter.Add(ctx, 1, metric.WithAttributes(
			attribute.String(attributeOperation, operation), attribute.String(attributeOutcome, outcome)))
	}
}

func recordCommand(ctx context.Context, status string, started time.Time) {
	attrs := metric.WithAttributes(attribute.String(attributeStatus, status))
	m := metrics()
	if m.commands != nil {
		m.commands.Add(ctx, 1, attrs)
	}
	if m.duration != nil {
		m.duration.Record(ctx, time.Since(started).Seconds(), attrs)
	}
}

func leaseHeld(ctx context.Context, delta int64) {
	if counter := metrics().leaseHeld; counter != nil {
		counter.Add(context.WithoutCancel(ctx), delta)
	}
}

// observeBroker exports the pool size and the revocations still pending so an
// operator can alert when a credential outlives its command.
func observeBroker(broker *Broker) func() {
	meter := otel.Meter(instrumentationName)
	pooled, err := meter.Int64ObservableGauge(metricTokenPooled,
		metric.WithDescription("Unused pre-minted installation tokens held by the broker."), metric.WithUnit("{token}"))
	if err != nil {
		return func() {}
	}
	pending, err := meter.Int64ObservableGauge(metricTokenPending,
		metric.WithDescription("Installation tokens whose revocation failed and is being retried."), metric.WithUnit("{token}"))
	if err != nil {
		return func() {}
	}
	registration, err := meter.RegisterCallback(func(_ context.Context, observer metric.Observer) error {
		stats := broker.Stats()
		observer.ObserveInt64(pooled, int64(stats.Pooled))
		observer.ObserveInt64(pending, int64(stats.PendingRevocations))
		return nil
	}, pooled, pending)
	if err != nil {
		return func() {}
	}
	return func() { _ = registration.Unregister() }
}

func endSpan(span trace.Span, err error) {
	if err != nil {
		span.SetStatus(codes.Error, "failed")
	}
	span.End()
}

// traceEnvironment propagates the command span to OpenTelemetry-aware
// subprocesses through the TRACEPARENT environment carrier. Baggage and
// tracestate are not forwarded.
func traceEnvironment(ctx context.Context) []string {
	spanContext := trace.SpanContextFromContext(ctx)
	if !spanContext.IsValid() {
		return nil
	}
	return []string{"TRACEPARENT=00-" + spanContext.TraceID().String() + "-" + spanContext.SpanID().String() + "-" + spanContext.TraceFlags().String()}
}
