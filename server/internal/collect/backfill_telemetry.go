package collect

import (
	"context"
	"log/slog"
	"time"

	"go.opentelemetry.io/otel"
	"go.opentelemetry.io/otel/attribute"
	"go.opentelemetry.io/otel/codes"
	"go.opentelemetry.io/otel/metric"

	"github.com/githubnext/gh-aw-cao/server/internal/logger"
	"github.com/githubnext/gh-aw-cao/server/internal/telemetry"
)

var backfillSummary = logger.NewSlogLoggerWithHandler(logger.New("cao:collect:backfill:summary"))

func startBackfillTelemetry(ctx context.Context, window int) (context.Context, func(BackfillState, error)) {
	started := time.Now()
	ctx, span := telemetry.Tracer().Start(ctx, telemetry.SpanBackfillRun)
	span.SetAttributes(attribute.Int("cao_dashboard.backfill.window_days", window))
	backfillSummary.InfoContext(ctx, "backfill started", slog.Int("window_days", window))
	return ctx, func(state BackfillState, err error) {
		outcome := state.Phase
		span.SetAttributes(
			attribute.String("cao_dashboard.backfill.phase", outcome),
			attribute.Int("cao_dashboard.backfill.repositories", state.Repositories),
			attribute.Int("cao_dashboard.backfill.queued_runs", state.QueuedRunTasks),
			attribute.Int("cao_dashboard.backfill.failures", state.EnumerationFailures),
			attribute.Bool("cao_dashboard.backfill.lake_replayed", state.LakeReplayed),
		)
		if err != nil || outcome == "partial" {
			span.SetStatus(codes.Error, "backfill incomplete")
		} else {
			span.SetStatus(codes.Ok, "")
		}
		meter := otel.Meter(backfillMeterName)
		attrs := metric.WithAttributes(attribute.String("cao_dashboard.backfill.phase", outcome))
		if count, meterErr := meter.Int64Counter("cao_dashboard.collection.backfill.run.count"); meterErr == nil {
			count.Add(ctx, 1, attrs)
		} else {
			backfillLog.Printf("backfill run metric creation failed")
		}
		if duration, meterErr := meter.Float64Histogram("cao_dashboard.collection.backfill.duration", metric.WithUnit("s")); meterErr == nil {
			duration.Record(ctx, time.Since(started).Seconds(), attrs)
		} else {
			backfillLog.Printf("backfill duration metric creation failed")
		}
		backfillSummary.InfoContext(ctx, "backfill finished",
			slog.String("phase", outcome), slog.Int("repositories", state.Repositories),
			slog.Int("queued_runs", state.QueuedRunTasks), slog.Int("failures", state.EnumerationFailures),
			slog.Int64("duration_ms", time.Since(started).Milliseconds()))
		span.End()
	}
}
