package postgresx

import (
	"testing"
	"time"

	"github.com/githubnext/gh-cao/server/internal/model"
)

func TestDailyCountsExplicitNullCorrections(t *testing.T) {
	store, _ := nativeTestStore(t)
	run := dailyRun("clear", "success", "completed")
	run["updatedAt"] = time.Now().UTC().Format(time.RFC3339Nano)
	dailyPublish(t, store, run)
	correction := model.Row{
		"id": "clear", "repositoryId": "repo", "workflowId": "workflow", "owner": "octo", "repository": "api",
		"workflowPath": ".github/workflows/test.md", "attempt": int64(2), "status": "completed", "conclusion": nil,
	}
	// The receipt's timestamp must not turn an explicit clear into an absent
	// field. Missing startedAt still preserves the run's known date.
	dailyPublish(t, store, correction)
	if totals := dailyTotals(t, store); totals["total"] != 1 || totals["successful"] != 0 || totals["other"] != 1 {
		t.Fatalf("explicit conclusion clear retained a prior success: %v", totals)
	}
	correction["startedAt"] = nil
	dailyPublish(t, store, correction)
	if totals := dailyTotals(t, store); totals["total"] != 0 {
		t.Fatalf("explicit date clear retained an invented date: %v", totals)
	}
}
