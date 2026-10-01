package postgresx

import (
	"context"
	"database/sql"
	"fmt"
	"os"
	"sort"
	"strconv"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/stdlib"

	"github.com/githubnext/gh-aw-cao/server/internal/model"
	"github.com/githubnext/gh-aw-cao/server/internal/query"
)

// BenchmarkNativeFilterPlan compares one indexed drilldown against the old
// evaluator and equivalent hand-written SQL on the same committed revision.
// POSTGRES_URL must point to a disposable Postgres instance.
func BenchmarkNativeFilterPlan(b *testing.B) {
	url := os.Getenv("POSTGRES_URL")
	if url == "" {
		b.Skip("POSTGRES_URL is unset")
	}
	ctx := b.Context()
	config, err := pgx.ParseConfig(url)
	if err != nil {
		b.Fatal(err)
	}
	admin := stdlib.OpenDB(*config.Copy())
	defer func() { _ = admin.Close() }()
	schema := fmt.Sprintf("cao_plan_bench_%d", time.Now().UnixNano())
	if _, err := admin.ExecContext(ctx, "CREATE SCHEMA "+schema); err != nil {
		b.Fatal(err)
	}
	defer func() {
		_, _ = admin.ExecContext(context.Background(), "DROP SCHEMA "+schema+" CASCADE")
	}()
	config.RuntimeParams["search_path"] = schema
	store, err := NewConfig(ctx, config)
	if err != nil {
		b.Fatal(err)
	}
	defer func() { _ = store.Close() }()
	rows := make([]model.Row, 5000)
	for i := range rows {
		rows[i] = model.Row{"id": "job-" + strconv.Itoa(i), "runId": "run-" + strconv.Itoa(i/10),
			"status": "completed", "nested": map[string]any{"attempt": i}}
	}
	started := time.Now()
	if _, err := store.Replace(ctx, map[string]model.Source{"$jobs": {
		Source: "$jobs", Rows: rows,
	}}, model.Diagnostics{}, "benchmark", time.Now()); err != nil {
		b.Fatal(err)
	}
	b.Logf("ingestion: %s for %d rows (includes legacy EAV + indexed documents)", time.Since(started), len(rows))
	if _, err := store.db.ExecContext(ctx, "ANALYZE cao_source_documents"); err != nil {
		b.Fatal(err)
	}
	plan, err := store.db.QueryContext(ctx, `EXPLAIN (ANALYZE, BUFFERS) SELECT payload
		FROM cao_source_documents WHERE namespace = $1 AND source_name = $2
		AND run_id = $3 AND ordinal >= 0 ORDER BY ordinal LIMIT 11`,
		"default", "$jobs", "run-250")
	if err != nil {
		b.Fatal(err)
	}
	defer func() { _ = plan.Close() }()
	for plan.Next() {
		var line string
		if err := plan.Scan(&line); err != nil {
			b.Fatal(err)
		}
		b.Logf("EXPLAIN (ANALYZE, BUFFERS): %s", line)
	}
	if err := plan.Err(); err != nil {
		b.Fatal(err)
	}
	definitions := []query.Definition{{Name: "jobs", From: "$jobs"}, {
		Name: "picked", From: "jobs", Filter: &query.Filter{Predicates: []query.Predicate{{Field: "runId", Equals: "run-250"}}},
	}}
	order := []string{"jobs", "picked"}
	bench := func(b *testing.B, run func(SourceReader) error) {
		b.ReportAllocs()
		latencies := make([]time.Duration, 0, b.N)
		b.ResetTimer()
		for i := 0; i < b.N; i++ {
			start := time.Now()
			if err := store.WithReadTransaction(ctx, run); err != nil {
				b.Fatal(err)
			}
			latencies = append(latencies, time.Since(start))
		}
		b.StopTimer()
		sort.Slice(latencies, func(i, j int) bool { return latencies[i] < latencies[j] })
		if len(latencies) != 0 {
			b.ReportMetric(float64(latencies[len(latencies)/2].Microseconds()), "p50-us")
			b.ReportMetric(float64(latencies[(len(latencies)*95-1)/100].Microseconds()), "p95-us")
		}
	}
	b.Run("native", func(b *testing.B) {
		bench(b, func(reader SourceReader) error {
			results, _, supported, err := reader.(NativePlanExecutor).ExecuteNativePlan(ctx, definitions, []string{"picked"}, order)
			if err == nil && (!supported || len(results["picked"].Rows) != 10) {
				return fmt.Errorf("native plan did not return 10 rows")
			}
			return err
		})
	})
	b.Run("go-fallback", func(b *testing.B) {
		bench(b, func(reader SourceReader) error {
			results, _, err := query.New(readerLoader{reader: reader, ctx: ctx}).Execute(definitions, []string{"picked"})
			if err == nil && len(results["picked"].Rows) != 10 {
				return fmt.Errorf("Go evaluator did not return 10 rows")
			}
			return err
		})
	})
	b.Run("handwritten-sql", func(b *testing.B) {
		bench(b, func(reader SourceReader) error {
			r := reader.(*readTransaction)
			rows, err := r.tx.QueryContext(ctx, `SELECT payload FROM cao_source_documents
				WHERE namespace = $1 AND source_name = $2 AND run_id = $3 AND ordinal >= 0
				ORDER BY ordinal LIMIT 11`, "default", "$jobs", "run-250")
			if err != nil {
				return err
			}
			defer func() { _ = rows.Close() }()
			count := 0
			for rows.Next() {
				var payload string
				if err := rows.Scan(&payload); err != nil {
					return err
				}
				count++
			}
			if err := rows.Err(); err != nil {
				return err
			}
			if count != 10 {
				return fmt.Errorf("hand-written query returned %d rows", count)
			}
			return nil
		})
	})
	var sqlBytes, eavBytes sql.NullInt64
	if err := store.db.QueryRowContext(ctx, `SELECT sum(octet_length(payload)) FROM cao_source_documents
		WHERE namespace = $1 AND source_name = $2 AND run_id = $3`, "default", "$jobs", "run-250").Scan(&sqlBytes); err != nil {
		b.Fatal(err)
	}
	if err := store.db.QueryRowContext(ctx, `SELECT sum(octet_length(coalesce(text_value, '')))
		FROM cao_values WHERE namespace = $1 AND source_name = $2 AND ordinal >= 0`,
		"default", "$jobs").Scan(&eavBytes); err != nil {
		b.Fatal(err)
	}
	b.Logf("filtered SQL JSON payload bytes=%d; unfiltered EAV text bytes=%d (excludes row protocol overhead)", sqlBytes.Int64, eavBytes.Int64)
}
