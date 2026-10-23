package postgresx

import (
	"encoding/json"
	"os"
	"testing"
	"time"

	"github.com/githubnext/gh-cao/server/internal/model"
	"github.com/githubnext/gh-cao/server/internal/query"
)

func TestStatisticalNativeSQLBoundary(t *testing.T) {
	store, _ := nativeTestStore(t)
	content, err := os.ReadFile("../../../dashboard/site/test/fixtures/statistical-sampling.json")
	if err != nil {
		t.Fatal(err)
	}
	var fixture struct {
		Rows      []model.Row
		Watermark string
	}
	if err := json.Unmarshal(content, &fixture); err != nil {
		t.Fatal(err)
	}
	asOf := time.Date(2026, time.October, 8, 12, 0, 0, 0, time.UTC)
	if err := store.RunPartitionMaintenance(t.Context(), asOf, 30, store.linkedRetentionDays); err != nil {
		t.Fatal(err)
	}
	w, err := store.BeginIngestion(t.Context())
	if err != nil {
		t.Fatal(err)
	}
	defer w.Abort(t.Context())
	w.ingestedAt = asOf
	for _, input := range []struct {
		source string
		row    model.Row
	}{
		{"$repositories", model.Row{"id": "repo", "owner": "o", "name": "r"}},
		{"$workflows", model.Row{"id": "workflow", "repositoryId": "repo", "path": "worker.md"}},
	} {
		if err := w.Append(t.Context(), input.source, input.row); err != nil {
			t.Fatal(err)
		}
	}
	for _, row := range fixture.Rows {
		row["repositoryId"], row["workflowId"] = "repo", "workflow"
		if err := w.Append(t.Context(), "$runs", row); err != nil {
			t.Fatal(err)
		}
	}
	for _, source := range []string{"$tools", "$domains", "$skills", "$audits"} {
		for _, row := range []model.Row{
			{"id": "a", "runId": fixture.Rows[0]["id"]}, {"id": "b", "runId": fixture.Rows[0]["id"]},
			{"id": "expired", "runId": fixture.Rows[7]["id"]},
		} {
			if err := w.Append(t.Context(), source, row); err != nil {
				t.Fatal(err)
			}
		}
	}
	if err := w.Quality(t.Context(), "$runs", model.Metadata{
		"as-of": fixture.Watermark, "completeness": "complete", "availability": "available",
	}); err != nil {
		t.Fatal(err)
	}
	if _, err := w.Publish(t.Context(), "statistical-boundary"); err != nil {
		t.Fatal(err)
	}
	corpus, err := os.ReadFile("../../../dashboard/site/src/data/queries/database.json")
	if err != nil {
		t.Fatal(err)
	}
	var definitions []query.Definition
	if err := json.Unmarshal(append(corpus[:len(corpus)-2], []byte(`,
		{"name":"sample-success","from":"statistical-runs","filter":{"predicates":[{"field":"run-conclusion","equals":"success"}]}},
		{"name":"sample-empty","from":"statistical-runs","filter":{"predicates":[{"field":"run","equals":"not-present"}]}}
	]`)...), &definitions); err != nil {
		t.Fatal(err)
	}
	result, metrics, err := store.ExecuteSQLPlan(t.Context(), definitions, []string{
		"sample-success", "sample-empty", "runs", "statistical-tools", "statistical-domains", "statistical-skills", "statistical-audits",
	})
	if err != nil {
		t.Fatal(err)
	}
	if len(result["sample-success"].Rows) != 5 || len(result["sample-empty"].Rows) != 0 || len(result["runs"].Rows) != 9 {
		t.Fatalf("statistical selection changed exact evidence: %+v", result)
	}
	for _, name := range []string{"sample-success", "sample-empty"} {
		frame, ok := result[name].Metadata["statistical-frame"].(map[string]any)
		if !ok || frame["population-count"] != 6 || frame["selected-count"] != 6 || frame["capacity"] != 64000 {
			t.Fatalf("consumer predicates changed frozen frame: %v", result[name].Metadata)
		}
	}
	if len(metrics.FallbackOperations) != 0 {
		t.Fatalf("statistical consumer bypassed native SQL: %+v", metrics)
	}
	for _, row := range result["sample-success"].Rows {
		if row["sample-weight"] != row["statistical-weight"] || row["sample-stratum"] != row["statistical-stratum"] ||
			row["sample-probability"] != row["statistical-probability"] {
			t.Fatalf("public sample fields do not preserve frozen weights: %v", row)
		}
	}
	for _, source := range []string{"statistical-tools", "statistical-domains", "statistical-skills", "statistical-audits"} {
		if len(result[source].Rows) != 2 {
			t.Fatalf("owned observations were independently sampled or expired children retained: %s %+v", source, result[source])
		}
	}
}
