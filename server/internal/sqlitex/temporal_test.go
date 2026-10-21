package sqlitex

import (
	"context"
	"reflect"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/githubnext/gh-cao/server/internal/dashboardstore"
	"github.com/githubnext/gh-cao/server/internal/model"
	"github.com/githubnext/gh-cao/server/internal/query"
	"github.com/githubnext/gh-cao/server/internal/testutil"
)

func TestSnapshotTemporalProjection(t *testing.T) {
	path := testutil.SQLiteSnapshot(t, map[string][]model.Row{"runs": {
		{"id": "1", "at": "2026-01-03", "repo": "z", "value": 7, "metrics": model.Row{"quality": 3},
			"labels": []model.Row{{"id": "quality", "name": "Quality"}}, "optional": nil, "link": "https://example.test/1", "unused": strings.Repeat("x", 8192)},
		{"id": "2", "at": "2026-01-01", "repo": "a", "value": 0, "metrics": model.Row{"quality": 1},
			"labels": []model.Row{{"id": "quality", "name": "Renamed"}}, "unused": strings.Repeat("x", 8192)},
	}})
	store, err := Open(t.Context(), path)
	if err != nil {
		t.Fatal(err)
	}

	t.Cleanup(func() { _ = store.Close() })
	for _, shape := range []string{"tidy", "groups", "panels"} {
		t.Run(shape, func(t *testing.T) {
			series := &query.TemporalSeries{
				Time: "at", Series: "repo", Shape: shape,
				Measures: []query.TemporalMeasure{{Field: "value", Kind: "primary"}},
				Maps:     []query.TemporalMap{{Field: "metrics", Definitions: "labels", Kind: "diagnostic"}},
			}
			if shape == "panels" {
				series.PointCarry, series.Link = []string{"optional"}, "link"
			}
			definitions := []query.Definition{{Name: "base", From: "$runs"}, {Name: "history", From: "base", TemporalSeries: series}}
			order, err := query.Dependencies(definitions, []string{"history"})
			if err != nil {
				t.Fatal(err)
			}
			_, fields := projectSnapshotPlan(definitions, []string{"history"}, order)
			if fields["$runs"].all || fields["$runs"].fields["unused"] || !fields["$runs"].fields["labels"] {
				t.Fatalf("temporal source projection lost declared fields or retained unrelated data: %+v", fields["$runs"])
			}
			err = store.WithReadTransaction(t.Context(), func(ctx context.Context, r dashboardstore.Reader) error {
				projected, metrics, err := r.ExecuteSQLPlan(ctx, definitions, []string{"history"})
				if err != nil {
					return err
				}
				full, fullMetrics, err := r.ExecuteSQLPlan(ctx, definitions, []string{"history", "$runs"})
				if err != nil {
					return err
				}
				if !reflect.DeepEqual(projected["history"], full["history"]) {
					t.Fatal("temporal projection changed results compared with a full-document read")
				}
				if metrics.PeakWorkingBytes >= fullMetrics.PeakWorkingBytes {
					t.Fatal("temporal query retained unrelated large source fields")
				}
				if full["$runs"].Rows[0]["unused"] == nil {
					t.Fatal("requesting raw sources must preserve full documents")
				}
				found := false
				for _, row := range projected["history"].Rows {
					if row["metric-name"] == "Quality" {
						found = true
					}
				}
				if !found {
					t.Fatal("metric definitions were pruned from temporal evidence")
				}
				return nil
			})
			if err != nil {
				t.Fatal(err)
			}
		})
	}
}

func TestSnapshotTemporalTrendThenAggregate(t *testing.T) {
	store, _ := localSnapshot(t)
	definitions := []query.Definition{{
		Name: "change", From: "$runs",
		TemporalSeries: &query.TemporalSeries{
			Time: "startedAt", Series: "workflowId", Shape: "groups", Carry: []string{"direction"},
			Measures: []query.TemporalMeasure{{Field: "duration", Kind: "primary"}},
			Trend:    &query.TemporalTrend{Direction: "direction"},
		},
		Aggregate: &query.Aggregate{Values: []query.AggregateValue{{Field: "trend-delta", As: "delta", Reducer: "sum"}}},
	}}
	err := store.WithReadTransaction(t.Context(), func(ctx context.Context, r dashboardstore.Reader) error {
		result, _, err := r.ExecuteSQLPlan(ctx, definitions, []string{"change"})
		if err == nil && !reflect.DeepEqual(result["change"].Rows, []model.Row{{"delta": float64(4)}}) {
			t.Fatalf("temporal statistics must precede aggregation: %+v", result)
		}
		return err
	})
	if err != nil {
		t.Fatal(err)
	}
}

func BenchmarkSnapshotTemporal(b *testing.B) {
	rows := make([]model.Row, 2000)
	for i := range rows {
		rows[i] = model.Row{
			"id": strconv.Itoa(i), "at": time.Unix(int64(2000-i)*3600, 0).UTC().Format(time.RFC3339),
			"repo": "repo-" + strconv.Itoa(i%8), "value": i, "direction": "increase",
			"metrics": model.Row{"quality": i % 100}, "unused": strings.Repeat("x", 4096),
		}
	}
	path := testutil.SQLiteSnapshot(b, map[string][]model.Row{"runs": rows})
	store, err := Open(b.Context(), path)
	if err != nil {
		b.Fatal(err)
	}
	b.Cleanup(func() { _ = store.Close() })
	for _, shape := range []string{"groups", "panels"} {
		b.Run(shape, func(b *testing.B) {
			series := &query.TemporalSeries{
				Time: "at", Series: "repo", Shape: shape, Carry: []string{"direction"},
				Measures: []query.TemporalMeasure{{Field: "value", Kind: "primary"}},
				Maps:     []query.TemporalMap{{Field: "metrics", Kind: "diagnostic"}},
			}
			if shape == "groups" {
				series.Trend = &query.TemporalTrend{Direction: "direction"}
			}
			definitions := []query.Definition{{Name: "base", From: "$runs"}, {Name: "history", From: "base", TemporalSeries: series}}
			b.ReportAllocs()
			for b.Loop() {
				err := store.WithReadTransaction(b.Context(), func(ctx context.Context, r dashboardstore.Reader) error {
					result, metrics, err := r.ExecuteSQLPlan(ctx, definitions, []string{"history"})
					if err != nil {
						return err
					}
					if len(result["history"].Rows) != 2 {
						b.Fatal("temporal benchmark lost metric groups")
					}
					b.ReportMetric(float64(metrics.PeakWorkingBytes), "working-bytes")
					return nil
				})
				if err != nil {
					b.Fatal(err)
				}
			}
		})
	}
}
