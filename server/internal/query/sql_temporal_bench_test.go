package query

import (
	"encoding/json"
	"strconv"
	"strings"
	"testing"
)

func BenchmarkTemporalPostgres(b *testing.B) {
	connection := temporalTestConnection(b)
	input := SQLRelation{
		SQL: "generate_series(1,20000) AS ordinal", Order: "ordinal",
		Columns: map[string]SQLColumn{
			"at":        {Expression: "'2026-01-01'::timestamptz + (20000-ordinal) * interval '1 hour'", Presence: "TRUE", Kind: SQLTimestamp},
			"repo":      {Expression: "'repo-' || (ordinal % 8)::text", Presence: "TRUE", Kind: SQLText},
			"value":     {Expression: "ordinal::numeric", Presence: "TRUE", Kind: SQLNumber},
			"direction": {Expression: "'increase'::text", Presence: "TRUE", Kind: SQLText},
		},
	}
	for _, name := range []string{"groups", "panels", "many-measures"} {
		b.Run(name, func(b *testing.B) {
			shape, count := name, 2
			source := input
			if name == "many-measures" {
				shape, count = "groups", 16
				source.SQL = "generate_series(1,5000) AS ordinal"
			}
			def := TemporalSeries{
				Time: "at", Series: "repo", Shape: shape, Carry: []string{"direction"},
			}
			for i := range count {
				def.Measures = append(def.Measures, TemporalMeasure{Field: "value", Kind: "measure-" + strconv.Itoa(i)})
			}
			if shape == "groups" {
				def.Trend = &TemporalTrend{Direction: "direction"}
			}
			plan := temporalTestPlan(b, source, def)
			relation := plan.Outputs["observations"]
			projection := make([]string, 0, len(relation.Columns))
			for _, field := range sortedSQLFields(relation.Columns) {
				projection = append(projection, relation.Columns[field].Expression)
			}
			statement := "EXPLAIN (ANALYZE, FORMAT JSON, TIMING OFF) " + plan.CTEs +
				" SELECT " + strings.Join(projection, ",") + " FROM " + relation.SQL + " ORDER BY " + relation.Order
			var totalMS float64
			for b.Loop() {
				var data []byte
				if err := connection.QueryRow(b.Context(), statement, plan.Args...).Scan(&data); err != nil {
					b.Fatal(err)
				}
				var report []struct {
					ExecutionMS float64 `json:"Execution Time"`
				}
				if err := json.Unmarshal(data, &report); err != nil || len(report) != 1 {
					b.Fatalf("invalid EXPLAIN result: %s: %v", data, err)
				}
				totalMS += report[0].ExecutionMS
			}
			b.ReportMetric(totalMS/float64(b.N), "postgres-ms/op")
		})
	}
}
