package postgresx

import (
	"encoding/json"
	"os"
	"testing"

	"github.com/githubnext/gh-cao/server/internal/model"
	"github.com/githubnext/gh-cao/server/internal/query"
)

func TestRepositoryRunInventoryDailyAvailability(t *testing.T) {
	store, _ := nativeTestStore(t)
	dailyPublish(t, store, dailyRun("observed", "success", "completed"))
	var definitions []query.Definition
	for _, path := range []string{
		"../../../dashboard/site/src/data/queries/database.json",
		"../../../dashboard/site/src/agent/queries.generated.json",
	} {
		content, err := os.ReadFile(path)
		if err != nil {
			t.Fatal(err)
		}
		var batch []query.Definition
		if err := json.Unmarshal(content, &batch); err != nil {
			t.Fatal(err)
		}
		definitions = append(definitions, batch...)
	}
	// An unbounded request resolves both time bounds to null before SQL lowering.
	for i := range definitions {
		for j := range definitions[i].Compute {
			for k := range definitions[i].Compute[j].Args {
				arg := &definitions[i].Compute[j].Args[k]
				if arg.Context != "" {
					arg.Context = ""
					arg.Value = nil
				}
			}
		}
	}
	for _, status := range []string{"ready", "empty", "unavailable", "absent"} {
		store.dailyCounts = status != "unavailable"
		if status == "empty" {
			if _, err := store.db.ExecContext(t.Context(), `DELETE FROM daily_run_counts WHERE namespace=$1`, store.namespace); err != nil {
				t.Fatal(err)
			}
		}
		if status == "absent" {
			if _, err := store.db.ExecContext(t.Context(), `DELETE FROM daily_run_count_state WHERE namespace=$1`, store.namespace); err != nil {
				t.Fatal(err)
			}
		}
		sources, _, err := store.ExecuteSQLPlan(t.Context(), definitions, []string{"repository-run-inventory"})
		if err != nil {
			t.Fatal(err)
		}
		source := sources["repository-run-inventory"]
		if source.Metadata["aggregate-version"] != 1 {
			t.Fatalf("lost daily identity: %+v", source)
		}
		if status == "unavailable" || status == "absent" {
			if len(source.Rows) != 0 || source.Metadata["availability"] != "unavailable" {
				t.Fatalf("unavailable daily evidence fabricated inventory zeros: %+v", source)
			}
		} else {
			want := json.Number("1")
			if status == "empty" {
				want = json.Number("0")
			}
			if len(source.Rows) != 1 || source.Rows[0]["runs"] != want ||
				source.Metadata["completeness"] != "partial" || source.Metadata["aggregate-retention-start"] == nil {
				t.Fatalf("lost daily counts or partial provenance: %+v", source)
			}
		}
	}
}

func TestDailyAggregateLeftJoinMetadata(t *testing.T) {
	definitions := []query.Definition{
		{Name: "counts", From: "daily-run-counts"},
		{Name: "inventory", From: "$repositories", Joins: []query.Join{{Source: "counts", Type: "left"}}},
		{Name: "nested", From: "$repositories", Joins: []query.Join{{Source: "inventory", Type: "left"}}},
	}
	for _, availability := range []string{"available", "empty", "unavailable"} {
		t.Run(availability, func(t *testing.T) {
			roots := map[string]model.Metadata{
				"$repositories": {"availability": "available", "completeness": "unknown"},
				"daily-run-counts": {"availability": availability, "completeness": "partial",
					"aggregate-version": 1, "aggregate-time-grain": "utc-run-start-day", "aggregate-retention-start": "2026-10-05"},
			}
			for _, name := range []string{"inventory", "nested"} {
				got := ComposeMetadata(definitions, roots, name)
				if got["aggregate-version"] != 1 || got["aggregate-retention-start"] != "2026-10-05" || got["completeness"] != "partial" {
					t.Fatalf("%s lost aggregate provenance: %+v", name, got)
				}
				if (got["availability"] == "unavailable") != (availability == "unavailable") {
					t.Fatalf("%s availability: %+v", name, got)
				}
			}
			delete(roots["daily-run-counts"], "aggregate-version")
			if got := ComposeMetadata(definitions, roots, "inventory"); got["availability"] == "unavailable" {
				t.Fatalf("ordinary left join became required: %+v", got)
			}
		})
	}
}

func TestRuntimeSourceClassificationUsesServerRegistry(t *testing.T) {
	for name, table := range entityTables {
		if got := IsRuntimeSource(name); got != table.runtime {
			t.Fatalf("source %q: runtime=%t, want %t", name, got, table.runtime)
		}
	}
	for _, name := range []string{"unknown", "$notRegistered", "$transactions", ""} {
		if IsRuntimeSource(name) {
			t.Fatalf("unregistered runtime source %q was admitted", name)
		}
	}
}
