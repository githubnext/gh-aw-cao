package postgresx

import (
	"context"
	"errors"
	"strings"
	"testing"

	"github.com/jackc/pgx/v5"
	"go.opentelemetry.io/otel"
	"go.opentelemetry.io/otel/attribute"
	"go.opentelemetry.io/otel/codes"
	sdkmetric "go.opentelemetry.io/otel/sdk/metric"
	"go.opentelemetry.io/otel/sdk/metric/metricdata"
	sdktrace "go.opentelemetry.io/otel/sdk/trace"
	"go.opentelemetry.io/otel/sdk/trace/tracetest"
	"go.opentelemetry.io/otel/trace"

	"github.com/githubnext/gh-aw-cao/server/internal/telemetry"
)

type existingQueryTracer struct{ starts, ends int }

func (t *existingQueryTracer) TraceQueryStart(ctx context.Context, _ *pgx.Conn, _ pgx.TraceQueryStartData) context.Context {
	t.starts++
	return ctx
}
func (t *existingQueryTracer) TraceQueryEnd(context.Context, *pgx.Conn, pgx.TraceQueryEndData) {
	t.ends++
}

func TestPostgresTelemetryPreservesTracerAndOmitsSQL(t *testing.T) {
	previousTracer, previousMeter := otel.GetTracerProvider(), otel.GetMeterProvider()
	exporter := tracetest.NewInMemoryExporter()
	traceProvider := sdktrace.NewTracerProvider(sdktrace.WithSyncer(exporter))
	reader := sdkmetric.NewManualReader()
	meterProvider := sdkmetric.NewMeterProvider(sdkmetric.WithReader(reader))
	otel.SetTracerProvider(traceProvider)
	otel.SetMeterProvider(meterProvider)
	t.Cleanup(func() {
		_ = meterProvider.Shutdown(t.Context())
		_ = traceProvider.Shutdown(t.Context())
		otel.SetTracerProvider(previousTracer)
		otel.SetMeterProvider(previousMeter)
	})

	existing := &existingQueryTracer{}
	config, err := pgx.ParseConfig("postgres://localhost/test?sslmode=disable")
	if err != nil {
		t.Fatal(err)
	}
	config.Tracer = existing
	instrumented, err := instrumentConfig(config)
	if err != nil {
		t.Fatal(err)
	}
	if config.Tracer != existing {
		t.Fatal("caller configuration was mutated")
	}
	const privateSQL = "SELECT secret FROM sensitive_table WHERE token = $1"
	const privateArg = "private-credential"
	for _, test := range []struct {
		statement string
		err       error
	}{
		{privateSQL, nil},
		{"INSERT INTO sensitive_table VALUES ($1)", errors.New(privateArg)},
	} {
		ctx := instrumented.Tracer.TraceQueryStart(t.Context(), nil,
			pgx.TraceQueryStartData{SQL: test.statement, Args: []any{privateArg}})
		instrumented.Tracer.TraceQueryEnd(ctx, nil, pgx.TraceQueryEndData{Err: test.err})
	}
	if existing.starts != 2 || existing.ends != 2 {
		t.Fatalf("prior tracer lost events: starts=%d ends=%d", existing.starts, existing.ends)
	}
	spans := exporter.GetSpans()
	if len(spans) != 2 {
		t.Fatalf("spans = %d, want 2", len(spans))
	}
	for i, span := range spans {
		if span.Name != telemetry.SpanPostgresQuery || span.SpanKind != trace.SpanKindClient {
			t.Fatalf("unexpected span: %+v", span)
		}
		if i == 1 && (span.Status.Code != codes.Error || span.Status.Description != "postgres query failed") {
			t.Fatalf("unsanitized or missing failure status: %+v", span.Status)
		}
		for _, value := range span.Attributes {
			if strings.Contains(value.Value.String(), privateSQL) ||
				strings.Contains(value.Value.String(), privateArg) ||
				strings.Contains(value.Value.String(), "sensitive_table") {
				t.Fatalf("SQL or argument leaked in span attribute %s", value.Key)
			}
		}
	}
	var measured metricdata.ResourceMetrics
	if err := reader.Collect(t.Context(), &measured); err != nil {
		t.Fatal(err)
	}
	counts := map[string]int64{}
	durations := map[string]float64{}
	for _, scope := range measured.ScopeMetrics {
		for _, recorded := range scope.Metrics {
			switch data := recorded.Data.(type) {
			case metricdata.Sum[int64]:
				if recorded.Name != postgresQueryCount {
					continue
				}
				for _, point := range data.DataPoints {
					op, _ := point.Attributes.Value(attribute.Key("db.operation.name"))
					outcome, _ := point.Attributes.Value(attribute.Key("cao_dashboard.postgres.outcome"))
					counts[op.AsString()+"/"+outcome.AsString()] += point.Value
				}
			case metricdata.Histogram[float64]:
				if recorded.Name != postgresQueryDuration {
					continue
				}
				for _, point := range data.DataPoints {
					op, _ := point.Attributes.Value(attribute.Key("db.operation.name"))
					outcome, _ := point.Attributes.Value(attribute.Key("cao_dashboard.postgres.outcome"))
					if point.Count != 1 || point.Sum < 0 {
						t.Fatalf("invalid duration point: %+v", point)
					}
					durations[op.AsString()+"/"+outcome.AsString()] = point.Sum
				}
			}
		}
	}
	if counts["select/success"] != 1 || counts["insert/error"] != 1 ||
		len(counts) != 2 || len(durations) != 2 {
		t.Fatalf("missing postgres metrics: counts=%v durations=%v", counts, durations)
	}
}

func TestPostgresOperationIsBounded(t *testing.T) {
	for statement, expected := range map[string]string{
		" SELECT secret FROM table": "select",
		"UPDATE hidden SET x = 1":   "update",
		"WITH private AS (...)":     "other",
		"DROP TABLE private":        "other",
		"private_input":             "other",
		"":                          "other",
	} {
		if got := postgresOperation(statement); got != expected {
			t.Errorf("postgresOperation(%q) = %q, want %q", statement, got, expected)
		}
	}
}
