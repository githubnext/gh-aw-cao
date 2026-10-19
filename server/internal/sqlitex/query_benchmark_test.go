package sqlitex

import (
	"context"
	"crypto/sha256"
	"encoding/json"
	"math"
	"os"
	"reflect"
	"testing"

	"github.com/githubnext/gh-cao/server/internal/dashboardstore"
	"github.com/githubnext/gh-cao/server/internal/model"
	"github.com/githubnext/gh-cao/server/internal/query"
)

func snapshotRepositoryDefinitions(tb testing.TB, corpus string) []query.Definition {
	tb.Helper()
	batches := make([][]query.Definition, 2)
	for index, name := range []string{"../../../dashboard/site/src/data/queries/database.json", corpus} {
		content, err := os.ReadFile(name) // #nosec G304,G703 -- explicit operator benchmark corpus or fixed build output.
		if err != nil {
			tb.Fatal(err)
		}
		if err := json.Unmarshal(content, &batches[index]); err != nil {
			tb.Fatal(err)
		}
	}
	definitions := batches[0]
	definitions = append(definitions, batches[1]...)
	order, err := query.Dependencies(definitions, []string{"repository-activity"})
	if err != nil {
		tb.Fatal(err)
	}
	reachable := map[string]bool{}
	for _, name := range order {
		reachable[name] = true
	}
	selected := make([]query.Definition, 0, len(order))
	for _, definition := range definitions {
		if reachable[definition.Name] {
			selected = append(selected, definition)
		}
	}
	return selected
}

func TestSnapshotRepositoryActivityParity(t *testing.T) {
	path, baseline := os.Getenv("CAO_SQLITE_SNAPSHOT"), os.Getenv("CAO_SQLITE_BASELINE_QUERIES")
	if path == "" || baseline == "" {
		t.Skip("CAO_SQLITE_SNAPSHOT and CAO_SQLITE_BASELINE_QUERIES are not set")
	}
	store, err := Open(t.Context(), path)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = store.Close() }()
	results := make([]model.Source, 0, 2)
	for _, corpus := range []string{baseline, "../../../dashboard/site/dist/src/agent/queries.generated.json"} {
		definitions := snapshotRepositoryDefinitions(t, corpus)
		err := store.WithReadTransaction(t.Context(), func(ctx context.Context, reader dashboardstore.Reader) error {
			sources, _, err := reader.ExecuteSQLPlan(ctx, definitions, []string{"repository-activity"})
			if err == nil {
				results = append(results, sources["repository-activity"])
			}
			return err
		})
		if err != nil {
			t.Fatal(err)
		}
	}
	if len(results[0].Rows) != len(results[1].Rows) || !reflect.DeepEqual(results[0].Metadata, results[1].Metadata) {
		t.Fatal("repository cardinality or evidence quality changed")
	}
	for index, row := range results[0].Rows {
		actual := results[1].Rows[index]
		left, lok := row["aic"].(float64)
		right, rok := actual["aic"].(float64)
		if !lok || !rok || math.Abs(left-right) > 1e-10*max(1, math.Abs(left)) {
			t.Fatal("repository AIC differs beyond floating-point summation precision")
		}
		actual["aic"] = row["aic"]
		if !reflect.DeepEqual(row, actual) {
			t.Fatalf("repository row %d changed beyond AIC summation precision", index)
		}
	}
}

func BenchmarkSnapshotRepositoryActivity(b *testing.B) {
	path := os.Getenv("CAO_SQLITE_SNAPSHOT")
	if path == "" {
		b.Skip("CAO_SQLITE_SNAPSHOT is not set")
	}
	store, err := Open(b.Context(), path)
	if err != nil {
		b.Fatal(err)
	}
	b.Cleanup(func() {
		if err := store.Close(); err != nil {
			b.Error(err)
		}
	})
	selected := snapshotRepositoryDefinitions(b, "../../../dashboard/site/dist/src/agent/queries.generated.json")
	requested := []string{"repository-activity"}
	b.ReportAllocs()
	b.ResetTimer()
	for b.Loop() {
		err := store.WithReadTransaction(b.Context(), func(ctx context.Context, reader dashboardstore.Reader) error {
			sources, metrics, err := reader.ExecuteSQLPlan(ctx, selected, requested)
			if err != nil {
				return err
			}
			content, err := json.Marshal(sources[requested[0]].Rows)
			if err != nil {
				return err
			}
			b.ReportMetric(float64(metrics.PeakWorkingBytes), "working-bytes")
			b.ReportMetric(float64(metrics.RetainedBytes), "retained-bytes")
			b.Logf("rows=%d sha256=%x", len(sources[requested[0]].Rows), sha256.Sum256(content))
			return nil
		})
		if err != nil {
			b.Fatal(err)
		}
	}
}
