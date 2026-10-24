package postgresx

import (
	"context"
	"crypto/sha256"
	"encoding/json"
	"fmt"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/githubnext/gh-cao/server/internal/model"
	"github.com/githubnext/gh-cao/server/internal/query"
)

func dailyPublish(t *testing.T, store *Store, rows ...model.Row) {
	t.Helper()
	w, err := store.BeginIngestion(t.Context())
	if err != nil {
		t.Fatal(err)
	}
	defer w.Abort(t.Context())
	for _, entry := range []struct {
		source string
		row    model.Row
	}{
		{"$repositories", model.Row{"id": "repo", "owner": "octo", "name": "api"}},
		{"$workflows", model.Row{"id": "workflow", "repositoryId": "repo", "path": ".github/workflows/test.md"}},
		{"$workflows", model.Row{"id": "workflow2", "repositoryId": "repo", "path": ".github/workflows/second.md"}},
	} {
		if err := w.Append(t.Context(), entry.source, entry.row); err != nil {
			t.Fatal(err)
		}
	}
	for _, row := range rows {
		if err := w.Append(t.Context(), "$runs", row); err != nil {
			t.Fatal(err)
		}
	}
	if _, err := w.Publish(t.Context(), fmt.Sprintf("daily-%d", time.Now().UnixNano())); err != nil {
		t.Fatal(err)
	}
}

func dailyRun(id, conclusion, status string) model.Row {
	return model.Row{"id": id, "repositoryId": "repo", "workflowId": "workflow", "owner": "octo", "repository": "api",
		"workflowPath": ".github/workflows/test.md", "startedAt": time.Now().UTC().Format(time.RFC3339), "attempt": int64(2), "conclusion": conclusion, "status": status}
}

func dailyTotals(t *testing.T, store *Store) map[string]int64 {
	t.Helper()
	var total, successful, failed, approval, pending, other int64
	err := store.db.QueryRowContext(t.Context(), `SELECT coalesce(sum(total),0),coalesce(sum(successful),0),coalesce(sum(failed),0),
		coalesce(sum(approval),0),coalesce(sum(pending),0),coalesce(sum(other),0) FROM daily_run_counts WHERE namespace=$1`, store.namespace).
		Scan(&total, &successful, &failed, &approval, &pending, &other)
	if err != nil {
		t.Fatal(err)
	}
	return map[string]int64{"total": total, "successful": successful, "failed": failed, "approval": approval, "pending": pending, "other": other}
}

func TestDailyCountsClassifyReplayCorrectionAndPreserve(t *testing.T) {
	store, _ := nativeTestStore(t)
	cases := []struct{ conclusion, status, category string }{
		{"success", "queued", "successful"}, {"failure", "completed", "failed"},
		{"startup-failure", "completed", "failed"}, {"stale", "completed", "failed"}, {"timed-out", "completed", "failed"},
		{"action-required", "completed", "approval"}, {"cancelled", "queued", "pending"}, {"", "in_progress", "pending"},
		{"cancelled", "completed", "other"}, {"skipped", "", "other"}, {"", "completed", "other"},
	}
	rows := make([]model.Row, len(cases), len(cases)+1)
	for index, test := range cases {
		rows[index] = dailyRun(fmt.Sprint(index), test.conclusion, test.status)
	}
	undated := dailyRun("undated", "success", "completed")
	delete(undated, "startedAt")
	rows = append(rows, undated)
	dailyPublish(t, store, rows...)
	dailyPublish(t, store, rows...)
	totals := dailyTotals(t, store)
	for field, want := range map[string]int64{"total": 11, "successful": 1, "failed": 4, "approval": 1, "pending": 2, "other": 3} {
		if totals[field] != want {
			t.Fatalf("%s=%d want=%d", field, totals[field], want)
		}
	}
	// Date, identity, and outcome correction subtract the old bucket atomically.
	correction := dailyRun("0", "failure", "completed")
	correction["workflowId"], correction["workflowPath"] = "workflow2", ".github/workflows/second.md"
	correction["startedAt"] = time.Now().UTC().Add(-24 * time.Hour).Format(time.RFC3339)
	correction["updatedAt"] = time.Now().UTC().Format(time.RFC3339Nano)
	dailyPublish(t, store, correction)
	totals = dailyTotals(t, store)
	if totals["total"] != 11 || totals["successful"] != 0 || totals["failed"] != 5 {
		t.Fatalf("correction counted a second run: %v", totals)
	}
	// Replacement of all detail neither removes receipts nor reverts a winner.
	stale := dailyRun("0", "success", "completed")
	stale["attempt"] = int64(1)
	dailyPublish(t, store, stale)
	dailyPublish(t, store)
	totals = dailyTotals(t, store)
	if totals["total"] != 11 || totals["failed"] != 5 {
		t.Fatalf("detail deletion/lower-attempt replay changed history: %v", totals)
	}
	var receipts int
	if err := store.db.QueryRowContext(t.Context(), `SELECT count(*) FROM run_count_contributions WHERE namespace=$1`, store.namespace).Scan(&receipts); err != nil || receipts != 12 {
		t.Fatalf("receipts were deleted: %d %v", receipts, err)
	}
	content, err := os.ReadFile("../../../dashboard/site/src/data/queries/database.json")
	if err != nil {
		t.Fatal(err)
	}
	definitions := make([]query.Definition, 0, 1)
	if err := json.Unmarshal(content, &definitions); err != nil {
		t.Fatal(err)
	}
	definitions = append(definitions, query.Definition{Name: "daily", From: dailySource})
	sources, _, err := store.ExecuteSQLPlan(t.Context(), definitions, []string{"daily"})
	if err != nil {
		t.Fatal(err)
	}
	if len(sources["daily"].Rows) != 2 || sources["daily"].Metadata["undated-run-count"] != int64(1) {
		t.Fatalf("SQL source or undated diagnostics missing: %+v", sources["daily"])
	}
}

func TestDailyCountsRollbackBackfillAndNamespace(t *testing.T) {
	store, config := nativeTestStore(t)
	// Simulate pre-extension canonical detail, then backfill without editing it.
	store.dailyCounts = false
	row := dailyRun("backfill", "success", "completed")
	dailyPublish(t, store, row)
	if _, err := store.db.ExecContext(t.Context(), `DELETE FROM daily_run_count_state WHERE namespace=$1`, store.namespace); err != nil {
		t.Fatal(err)
	}
	var before string
	if err := store.db.QueryRowContext(t.Context(), `SELECT row_to_json(r)::text FROM runs r WHERE namespace=$1 AND id='backfill'`, store.namespace).Scan(&before); err != nil {
		t.Fatal(err)
	}
	reopened, err := openConfig(t.Context(), config, false, store.namespace)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = reopened.Close() }()
	if dailyTotals(t, reopened)["successful"] != 1 {
		t.Fatal("existing detail was not backfilled")
	}
	var after string
	if err := store.db.QueryRowContext(t.Context(), `SELECT row_to_json(r)::text FROM runs r WHERE namespace=$1 AND id='backfill'`, store.namespace).Scan(&after); err != nil || after != before {
		t.Fatalf("backfill edited detail: %v", err)
	}
	tx, err := reopened.beginInvocation(t.Context())
	if err != nil {
		t.Fatal(err)
	}
	if _, err := tx.ExecContext(t.Context(), `UPDATE runs SET conclusion='failure' WHERE namespace=$1`, store.namespace); err != nil {
		t.Fatal(err)
	}
	if err := reopened.reconcileDailyInvocation(t.Context(), tx, "backfill"); err != nil {
		t.Fatal(err)
	}
	if err := tx.Rollback(); err != nil {
		t.Fatal(err)
	}
	if dailyTotals(t, reopened)["successful"] != 1 {
		t.Fatal("rollback leaked daily correction")
	}
	other, err := openConfig(t.Context(), config, false, "other-namespace")
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = other.Close() }()
	if dailyTotals(t, other)["total"] != 0 {
		t.Fatal("daily history leaked across namespaces")
	}
}

func TestDailyCountsOptionalCapabilityAndIndependentDigest(t *testing.T) {
	store, _ := nativeTestStore(t)
	if _, err := store.db.ExecContext(t.Context(), `DROP TABLE daily_run_counts,run_count_contributions,daily_run_count_state,cao_daily_contract`); err != nil {
		t.Fatal(err)
	}

	store.dailyCounts = false
	dailyPublish(t, store, dailyRun("detail", "success", "completed"))
	sources, _, err := store.ExecuteSQLPlan(t.Context(), []query.Definition{{Name: "daily", From: dailySource}}, []string{"daily"})
	if err != nil || sources["daily"].Metadata["availability"] != "unavailable" {
		t.Fatalf("missing capability manufactured data: %+v %v", sources, err)
	}
	var digest string
	if err := store.db.QueryRowContext(t.Context(), `SELECT digest FROM cao_contract`).Scan(&digest); err != nil ||
		digest != fmt.Sprintf("%x", sha256.Sum256([]byte(nativeSchemaSQL))) {
		t.Fatalf("extension changed native digest: %v", err)
	}
	if err := initializeDailyCounts(t.Context(), store.db); err != nil {
		t.Fatal(err)
	}
	if strings.Contains(dailySchemaSQL, "REFERENCES runs") || strings.Contains(dailySchemaSQL, "ON DELETE") {
		t.Fatal("extension lifetime is coupled to detail")
	}
}

func TestDailyCountsUTCDayAndWinningAttempt(t *testing.T) {
	store, _ := nativeTestStore(t)
	row := dailyRun("utc", "success", "completed")
	row["startedAt"] = time.Now().UTC().AddDate(0, 0, -1).Format("2006-01-02") + "T23:30:00-02:00"
	row["updatedAt"] = time.Now().UTC().Format(time.RFC3339Nano)
	dailyPublish(t, store, row)
	var day, id string
	if err := store.db.QueryRowContext(t.Context(), `SELECT day,id FROM daily_run_counts WHERE namespace=$1`, store.namespace).Scan(&day, &id); err != nil {
		t.Fatal(err)
	}
	want := time.Now().UTC().Format("2006-01-02")
	if day != want || id != fmt.Sprintf(`["%s","repo","workflow"]`, want) {
		t.Fatalf("daily key is not UTC/JSON.stringify compatible: %s %s", day, id)
	}
	row["attempt"], row["status"] = int64(3), "in_progress"
	delete(row, "conclusion")
	dailyPublish(t, store, row)
	if totals := dailyTotals(t, store); totals["pending"] != 1 || totals["successful"] != 0 || totals["total"] != 1 {
		t.Fatalf("new attempt retained old outcome: %v", totals)
	}
	row["conclusion"], row["status"] = "failure", "completed"
	row["updatedAt"] = time.Now().UTC().Add(-time.Hour).Format(time.RFC3339Nano)
	dailyPublish(t, store, row)
	if totals := dailyTotals(t, store); totals["pending"] != 1 || totals["failed"] != 0 {
		t.Fatalf("older update reverted receipt: %v", totals)
	}
	row["updatedAt"], row["startedAt"] = time.Now().UTC().Add(time.Minute).Format(time.RFC3339Nano), nil
	dailyPublish(t, store, row)
	if totals := dailyTotals(t, store); totals["total"] != 0 {
		t.Fatalf("explicitly undated correction invented a date: %v", totals)
	}
}

func TestDailyCountsBoundedBackfillBatches(t *testing.T) {
	store, _ := nativeTestStore(t)
	rows := make([]model.Row, BatchRows+7)
	for index := range rows {
		rows[index] = dailyRun(fmt.Sprintf("batch-%04d", index), "success", "completed")
	}
	dailyPublish(t, store, rows...)
	dailyPublish(t, store, rows...)
	if totals := dailyTotals(t, store); totals["total"] != int64(len(rows)) || totals["successful"] != int64(len(rows)) {
		t.Fatalf("bounded receipt batches dropped or duplicated runs: %v", totals)
	}
	detailDigest := func() string {
		t.Helper()
		var digest string
		if err := store.db.QueryRowContext(t.Context(), `SELECT md5(string_agg(row_to_json(r)::text,'' ORDER BY id))
			FROM runs r WHERE namespace=$1`, store.namespace).Scan(&digest); err != nil {
			t.Fatal(err)
		}
		return digest
	}
	before := detailDigest()
	// Remove only the projection to exercise legacy backfill across the 512-row
	// cursor boundary, not just ordinary ingestion with multiple write batches.
	for _, statement := range []string{
		"DELETE FROM daily_run_counts WHERE namespace=$1",
		"DELETE FROM run_count_contributions WHERE namespace=$1",
		"DELETE FROM daily_run_count_state WHERE namespace=$1",
	} {
		if _, err := store.db.ExecContext(t.Context(), statement, store.namespace); err != nil {
			t.Fatal(err)
		}
	}
	for range 2 {
		if err := store.backfillDailyOnce(t.Context()); err != nil {
			t.Fatal(err)
		}
		if totals := dailyTotals(t, store); totals["total"] != int64(len(rows)) || totals["successful"] != int64(len(rows)) {
			t.Fatalf("bounded legacy backfill dropped or duplicated runs: %v", totals)
		}
	}
	if after := detailDigest(); after != before {
		t.Fatal("bounded legacy backfill changed retained canonical detail")
	}
}

func TestDailyCountsInitializedReopenDoesNotTakeWriterLock(t *testing.T) {
	store, config := nativeTestStore(t)
	dailyPublish(t, store, dailyRun("already-counted", "success", "completed"))
	locker, err := store.db.Conn(t.Context())
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = locker.Close() }()
	if _, err := locker.ExecContext(t.Context(), `SELECT pg_advisory_lock(hashtextextended(current_schema() || ':' || $1,0))`, store.namespace); err != nil {
		t.Fatal(err)
	}
	defer func() {
		_, _ = locker.ExecContext(context.Background(), `SELECT pg_advisory_unlock(hashtextextended(current_schema() || ':' || $1,0))`, store.namespace)
	}()
	ctx, cancel := context.WithTimeout(t.Context(), 5*time.Second)
	defer cancel()
	reopened, err := openConfig(ctx, config, false, store.namespace)
	if err != nil {
		t.Fatalf("initialized runtime reopen acquired the namespace writer lock: %v", err)
	}
	defer func() { _ = reopened.Close() }()
	if totals := dailyTotals(t, reopened); totals["total"] != 1 || totals["successful"] != 1 {
		t.Fatalf("reopen changed initialized counts: %v", totals)
	}
}
