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
	dailyPublish(t, store, correction)
	if totals := dailyTotals(t, store); totals["successful"] != 1 {
		t.Fatalf("unversioned clear overrode authoritative evidence: %v", totals)
	}
	correction["updatedAt"] = time.Now().UTC().Add(time.Minute).Format(time.RFC3339Nano)
	// The receipt's timestamp must not turn an explicit clear into an absent
	// field. Missing startedAt still preserves the run's known date.
	dailyPublish(t, store, correction)
	if totals := dailyTotals(t, store); totals["total"] != 1 || totals["successful"] != 0 || totals["other"] != 1 {
		t.Fatalf("explicit conclusion clear retained a prior success: %v", totals)
	}
	// A correction to an undated observation must keep the old retained-day
	// replay fence even when first admission predates the retention window.
	if _, err := store.db.ExecContext(t.Context(), `UPDATE run_count_contributions SET observed_at=$2
		WHERE namespace=$1`, store.namespace, dailyCutoff(time.Now()).Add(-time.Hour)); err != nil {
		t.Fatal(err)
	}
	correction["startedAt"] = nil
	correction["updatedAt"] = time.Now().UTC().Add(2 * time.Minute).Format(time.RFC3339Nano)
	dailyPublish(t, store, correction)
	if totals := dailyTotals(t, store); totals["total"] != 0 {
		t.Fatalf("explicit date clear retained an invented date: %v", totals)
	}
	dailyPublish(t, store, run)
	if totals := dailyTotals(t, store); totals["total"] != 0 || dailyReceiptCount(t, store) != 1 {
		t.Fatalf("stale replay resurrected an explicitly cleared date: %v", totals)
	}
}
