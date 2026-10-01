package postgresx

import (
	"context"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/multitracer"
	"go.opentelemetry.io/otel"
	"go.opentelemetry.io/otel/attribute"
	"go.opentelemetry.io/otel/codes"
	"go.opentelemetry.io/otel/metric"
	"go.opentelemetry.io/otel/trace"

	"github.com/githubnext/gh-aw-cao/server/internal/telemetry"
)

const (
	postgresQueryCount    = "cao_dashboard.postgres.query.count"
	postgresQueryDuration = "cao_dashboard.postgres.query.duration"
)

type queryTracer struct {
	count    metric.Int64Counter
	duration metric.Float64Histogram
}

type queryTraceKey struct{}

type queryTrace struct {
	started   time.Time
	operation string
	span      trace.Span
}

func instrumentConfig(config *pgx.ConnConfig) (*pgx.ConnConfig, error) {
	config = config.Copy()
	tracer, err := newQueryTracer()
	if err != nil {
		return nil, err
	}
	if config.Tracer == nil {
		config.Tracer = tracer
	} else {
		config.Tracer = multitracer.New(config.Tracer, tracer)
	}
	return config, nil
}

func newQueryTracer() (*queryTracer, error) {
	meter := otel.Meter("github.com/githubnext/gh-aw-cao/server")
	count, err := meter.Int64Counter(postgresQueryCount,
		metric.WithUnit("{query}"),
		metric.WithDescription("Postgres statements by fixed operation and outcome"))
	if err != nil {
		return nil, err
	}
	duration, err := meter.Float64Histogram(postgresQueryDuration,
		metric.WithUnit("s"),
		metric.WithDescription("Postgres statement latency, excluding connection-pool wait"))
	if err != nil {
		return nil, err
	}
	return &queryTracer{count: count, duration: duration}, nil
}

func postgresOperation(statement string) string {
	statement = strings.TrimLeft(statement, " \t\r\n")
	end := 0
	for end < len(statement) && end < 7 && statement[end] >= 'A' && statement[end] <= 'Z' {
		end++
	}
	switch statement[:end] {
	case "SELECT":
		return "select"
	case "INSERT":
		return "insert"
	case "UPDATE":
		return "update"
	case "DELETE":
		return "delete"
	case "COPY":
		return "copy"
	default:
		return "other"
	}
}

func (t *queryTracer) TraceQueryStart(ctx context.Context, _ *pgx.Conn, data pgx.TraceQueryStartData) context.Context {
	operation := postgresOperation(data.SQL)
	ctx, span := telemetry.Tracer().Start(ctx, telemetry.SpanPostgresQuery,
		trace.WithSpanKind(trace.SpanKindClient),
		trace.WithAttributes(
			attribute.String("db.system.name", "postgresql"),
			attribute.String("db.operation.name", operation),
		))
	return context.WithValue(ctx, queryTraceKey{}, queryTrace{started: time.Now(), operation: operation, span: span})
}

func (t *queryTracer) TraceQueryEnd(ctx context.Context, _ *pgx.Conn, data pgx.TraceQueryEndData) {
	state, ok := ctx.Value(queryTraceKey{}).(queryTrace)
	if !ok {
		return
	}
	outcome := "success"
	if data.Err != nil {
		outcome = "error"
		state.span.SetStatus(codes.Error, "postgres query failed")
	} else {
		state.span.SetStatus(codes.Ok, "")
	}
	state.span.SetAttributes(attribute.String("cao_dashboard.postgres.outcome", outcome))
	state.span.End()
	attrs := metric.WithAttributes(
		attribute.String("db.system.name", "postgresql"),
		attribute.String("db.operation.name", state.operation),
		attribute.String("cao_dashboard.postgres.outcome", outcome),
	)
	t.count.Add(ctx, 1, attrs)
	t.duration.Record(ctx, time.Since(state.started).Seconds(), attrs)
}

var _ pgx.QueryTracer = (*queryTracer)(nil)
