package postgresx

import (
	"testing"

	"github.com/githubnext/gh-cao/server/internal/model"
	"github.com/githubnext/gh-cao/server/internal/query"
)

func TestMissingStatisticalClockPreservesExactQueries(t *testing.T) {
	store, _ := nativeTestStore(t)
	writer, err := store.BeginIngestion(t.Context())
	if err != nil {
		t.Fatal(err)
	}
	defer writer.Abort(t.Context())
	if err := writer.Append(t.Context(), "$repositories", model.Row{"id": "repository", "owner": "example", "name": "control"}); err != nil {
		t.Fatal(err)
	}
	if _, err := writer.Publish(t.Context(), "missing-statistical-clock"); err != nil {
		t.Fatal(err)
	}
	results, _, err := store.ExecuteSQLPlan(t.Context(), []query.Definition{
		{Name: "sample", From: "$statisticalMembership"},
		{Name: "exact", From: "$repositories"},
	}, []string{"sample", "exact"})
	if err != nil {
		t.Fatal(err)
	}
	if results["sample"].Metadata["availability"] != "unavailable" || len(results["sample"].Rows) != 0 {
		t.Fatalf("missing sampling clock was presented as a usable sample: %+v", results["sample"])
	}
	if len(results["exact"].Rows) != 1 || results["exact"].Rows[0]["id"] != "repository" {
		t.Fatalf("sampling unavailability changed exact evidence: %+v", results["exact"])
	}
}
