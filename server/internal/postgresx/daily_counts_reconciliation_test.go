package postgresx

import (
	"database/sql"
	"testing"
	"time"

	"github.com/githubnext/gh-cao/server/internal/model"
	"github.com/githubnext/gh-cao/server/internal/query"
)

func TestDailyCountsReconciliationGolden(t *testing.T) {
	store, _ := nativeTestStore(t)
	revision := time.Now().UTC().Format(time.RFC3339Nano)
	for _, test := range []struct {
		id          string
		before      any
		omitBefore  bool
		oldRevision bool
		want        string
	}{
		{"unversioned-null", "success", false, false, ""},
		{"authoritative-null", nil, false, true, ""},
		{"absent-enrichment", nil, true, true, "success"},
	} {
		t.Run(test.id, func(t *testing.T) {
			before := dailyRun(test.id, "", "completed")
			before["conclusion"] = test.before
			if test.omitBefore {
				delete(before, "conclusion")
			}
			if test.oldRevision {
				before["updatedAt"] = revision
			}
			dailyPublish(t, store, before)
			incoming := model.Row{"id": test.id, "repositoryId": "repo", "workflowId": "workflow", "attempt": int64(2)}
			if test.id == "unversioned-null" {
				incoming["conclusion"] = nil
			} else {
				incoming["conclusion"] = "success"
			}
			dailyPublish(t, store, incoming)
			var conclusion sql.NullString
			if err := store.db.QueryRowContext(t.Context(), `SELECT conclusion FROM run_count_contributions
				WHERE namespace=$1 AND id=$2`, store.namespace, test.id).Scan(&conclusion); err != nil {
				t.Fatal(err)
			}
			if conclusion.String != test.want || (test.want == "" && conclusion.Valid) {
				t.Fatalf("receipt conclusion=%+v want=%q", conclusion, test.want)
			}
		})
	}
}

func TestDailyCountsEqualRevisionGoldenAndConflictDiagnostics(t *testing.T) {
	store, _ := nativeTestStore(t)
	revision := time.Now().UTC().Format(time.RFC3339Nano)
	for _, order := range []struct{ id, first, second string }{
		{"success-first", "success", "failure"}, {"failure-first", "failure", "success"},
	} {
		run := dailyRun(order.id, order.first, "completed")
		run["updatedAt"] = revision
		dailyPublish(t, store, run)
		run["conclusion"] = order.second
		dailyPublish(t, store, run)
		var conclusion string
		var conflict bool
		if err := store.db.QueryRowContext(t.Context(), `SELECT conclusion,conflict FROM run_count_contributions
			WHERE namespace=$1 AND id=$2`, store.namespace, order.id).Scan(&conclusion, &conflict); err != nil {
			t.Fatal(err)
		}

		if conclusion != "success" || !conflict {
			t.Fatalf("equal-revision golden %s: conclusion=%s conflict=%v", order.id, conclusion, conflict)
		}
	}
	sources, _, err := store.ExecuteSQLPlan(t.Context(), []query.Definition{{Name: "daily", From: dailySource}}, []string{"daily"})
	if err != nil || sources["daily"].Metadata["conflicted-runs"] != int64(2) {
		t.Fatalf("conflicts were not diagnosed: %+v %v", sources, err)
	}
	correction := dailyRun("success-first", "failure", "completed")
	correction["updatedAt"] = time.Now().UTC().Add(time.Minute).Format(time.RFC3339Nano)
	dailyPublish(t, store, correction)
	var conflict bool
	if err := store.db.QueryRowContext(t.Context(), `SELECT conflict FROM run_count_contributions
		WHERE namespace=$1 AND id='success-first'`, store.namespace).Scan(&conflict); err != nil || conflict {
		t.Fatalf("new authoritative revision retained an obsolete conflict: %v %v", conflict, err)
	}
}

func TestDailyCountsUndatedRevisionReplayFence(t *testing.T) {
	store, _ := nativeTestStore(t)
	expired := dailyRun("expired-undated", "success", "completed")
	delete(expired, "startedAt")
	expired["updatedAt"] = dailyCutoff(time.Now()).Add(-time.Second).Format(time.RFC3339)
	dailyPublish(t, store, expired)
	dailyPublish(t, store, expired)
	if dailyReceiptCount(t, store) != 0 {
		t.Fatal("expired undated evidence acquired a new admission lifetime")
	}
	delete(expired, "updatedAt")
	dailyPublish(t, store, expired)
	if dailyReceiptCount(t, store) != 1 || dailyTotals(t, store)["total"] != 0 {
		t.Fatal("timeless undated evidence was rejected or assigned an execution day")
	}
	sources, _, err := store.ExecuteSQLPlan(t.Context(), []query.Definition{{Name: "daily", From: dailySource}}, []string{"daily"})
	if err != nil {
		t.Fatal(err)
	}
	metadata := sources["daily"].Metadata
	if metadata["aggregate-retention-start"] != metadata["retention-cutoff"] ||
		metadata["aggregate-retention-watermark"] != metadata["watermark"] {
		t.Fatalf("aggregate provenance aliases differ: %+v", metadata)
	}
	expired["id"] = "dated-revision-undated-execution"
	expired["updatedAt"] = dailyCutoff(time.Now()).Add(time.Hour).Format(time.RFC3339)
	dailyPublish(t, store, expired)
	if dailyReceiptCount(t, store) != 2 {
		t.Fatal("retained undated revision was not admitted")
	}
	dailyMaintain(t, store, time.Now().AddDate(0, 0, 7), true)
	if dailyReceiptCount(t, store) != 1 {
		t.Fatal("undated receipt used import time instead of its source revision clock")
	}
}
