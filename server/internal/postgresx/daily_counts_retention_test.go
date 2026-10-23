package postgresx

import (
	"context"
	"crypto/sha256"
	"fmt"
	"strings"
	"testing"
	"time"

	"github.com/githubnext/gh-cao/server/internal/model"
	"github.com/githubnext/gh-cao/server/internal/query"
)

func TestDailyCountsCalendarCutoff(t *testing.T) {
	for _, test := range []struct{ now, want string }{
		{"2026-10-19T00:00:00Z", "2026-10-05"},
		{"2026-10-25T23:59:59Z", "2026-10-05"},
		{"2026-10-26T00:00:00Z", "2026-10-12"},
		{"2026-10-19T00:30:00+02:00", "2026-09-28"},
		{"2027-01-01T12:00:00Z", "2026-12-14"},
	} {
		now, err := time.Parse(time.RFC3339, test.now)
		if err != nil {
			t.Fatal(err)
		}
		if got := dailyCutoff(now).Format("2006-01-02"); got != test.want {
			t.Fatalf("cutoff(%s)=%s want %s", test.now, got, test.want)
		}
	}
}

func dailyMaintain(t *testing.T, store *Store, now time.Time, commit bool) {
	t.Helper()
	tx, err := store.beginInvocation(t.Context())
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = tx.Rollback() }()
	if err := maintainDailyCounts(t.Context(), store.namespace, now, func(ctx context.Context, statement string, args ...any) error {
		_, err := tx.ExecContext(ctx, statement, args...)
		return err
	}); err != nil {
		t.Fatal(err)
	}
	if commit {
		if err := tx.Commit(); err != nil {
			t.Fatal(err)
		}
	}
}

func dailyReceiptCount(t *testing.T, store *Store) int {
	t.Helper()
	var count int
	if err := store.db.QueryRowContext(t.Context(), `SELECT count(*) FROM run_count_contributions WHERE namespace=$1`, store.namespace).Scan(&count); err != nil {
		t.Fatal(err)
	}
	return count
}

func TestDailyCountsRetentionRolloverRollbackReplayAndClockRegression(t *testing.T) {
	store, _ := nativeTestStore(t)
	now := time.Now().UTC()
	cutoff := dailyCutoff(now)
	old := dailyRun("expires", "success", "completed")
	old["startedAt"] = cutoff.Format(time.RFC3339)
	boundary := dailyRun("boundary", "failure", "completed")
	boundary["startedAt"] = cutoff.AddDate(0, 0, 7).Format(time.RFC3339)
	undated := dailyRun("undated-retention", "success", "completed")
	delete(undated, "startedAt")
	dailyPublish(t, store, old, boundary, undated)
	if totals := dailyTotals(t, store); totals["total"] != 2 || dailyReceiptCount(t, store) != 3 {
		t.Fatalf("initial contributions missing: %v", totals)
	}

	later := now.AddDate(0, 0, 7)
	dailyMaintain(t, store, later, false)
	if totals := dailyTotals(t, store); totals["total"] != 2 || dailyReceiptCount(t, store) != 3 {
		t.Fatalf("rolled-back eviction escaped its transaction: %v", totals)
	}
	dailyMaintain(t, store, later, true)
	if totals := dailyTotals(t, store); totals["total"] != 1 || totals["failed"] != 1 || dailyReceiptCount(t, store) != 2 {
		t.Fatalf("rollover did not keep exactly the cutoff boundary: %v", totals)
	}
	dailyMaintain(t, store, now.AddDate(0, 0, -7), true)
	// Existing detail still includes the expired Run. Replacing it with a
	// replay cannot undo the persisted cutoff, even with a regressed clock.
	dailyPublish(t, store, old, boundary, undated)
	if totals := dailyTotals(t, store); totals["total"] != 1 || dailyReceiptCount(t, store) != 2 {
		t.Fatalf("expired replay resurrected history: %v", totals)
	}
	var persisted time.Time
	if err := store.db.QueryRowContext(t.Context(), `SELECT watermark_at FROM daily_run_count_state WHERE namespace=$1`, store.namespace).Scan(&persisted); err != nil || persisted.Sub(later).Abs() > time.Microsecond {
		t.Fatalf("watermark regressed: %s %v", persisted, err)
	}

	// Undated receipts use their first admission time, never the time of
	// each replay. Maintenance alone expires them without inventing a day.
	dailyMaintain(t, store, now.AddDate(0, 0, 28), true)
	if dailyReceiptCount(t, store) != 0 || dailyTotals(t, store)["total"] != 0 {
		t.Fatal("dated or undated receipts were retained without bounds")
	}
	// Starting and publishing an empty replacement must not re-admit the
	// surviving pre-replacement detail during its preservation phase.
	dailyPublish(t, store)
	if dailyReceiptCount(t, store) != 0 || dailyTotals(t, store)["total"] != 0 {
		t.Fatal("surviving detail resurrected expired projection state")
	}
}

func TestDailyCountsCorrectionsAcrossRetentionBoundary(t *testing.T) {
	store, _ := nativeTestStore(t)
	cutoff := dailyCutoff(time.Now())
	run := dailyRun("cross-boundary", "success", "completed")
	run["startedAt"] = cutoff.Format(time.RFC3339)
	run["updatedAt"] = time.Now().UTC().Format(time.RFC3339Nano)
	dailyPublish(t, store, run)
	retained := model.Row{}
	for key, value := range run {
		retained[key] = value
	}
	run["startedAt"] = cutoff.Add(-time.Second).Format(time.RFC3339)
	run["updatedAt"] = time.Now().UTC().Add(time.Minute).Format(time.RFC3339Nano)
	dailyPublish(t, store, run)
	if totals := dailyTotals(t, store); totals["total"] != 0 || dailyReceiptCount(t, store) != 1 {
		t.Fatalf("retained-to-expired correction created an expired bucket: %v", totals)
	}
	dailyPublish(t, store, retained)
	if dailyTotals(t, store)["total"] != 0 {
		t.Fatal("stale retained-day replay resurrected a retired contribution")
	}
	dailyPublish(t, store, run)
	if dailyTotals(t, store)["total"] != 0 {
		t.Fatal("expired correction replay recreated counts")
	}
	run["startedAt"], run["conclusion"] = cutoff.Format(time.RFC3339), "failure"
	run["updatedAt"] = time.Now().UTC().Add(2 * time.Minute).Format(time.RFC3339Nano)
	dailyPublish(t, store, run)
	if totals := dailyTotals(t, store); totals["total"] != 1 || totals["failed"] != 1 {
		t.Fatalf("expired-to-retained correction failed: %v", totals)
	}
	sources, _, err := store.ExecuteSQLPlan(t.Context(), []query.Definition{{Name: "daily", From: dailySource}}, []string{"daily"})
	if err != nil {
		t.Fatal(err)
	}
	metadata := sources["daily"].Metadata
	if metadata["completeness"] != "partial" || metadata["backfill-coverage"] != "available-evidence-only" ||
		metadata["retention"] != "three-utc-calendar-weeks" || metadata["retention-cutoff"] != cutoff.Format("2006-01-02") {
		t.Fatalf("projection overclaimed coverage: %+v", metadata)
	}
}

func TestDailyCountsLegacyExtensionOwnerUpgrade(t *testing.T) {
	store, config := nativeTestStore(t)
	if _, err := store.db.ExecContext(t.Context(), `DROP TABLE daily_run_counts,run_count_contributions,daily_run_count_state,cao_daily_contract`); err != nil {
		t.Fatal(err)
	}
	legacy := strings.NewReplacer("  observed_at TIMESTAMPTZ NOT NULL,\n", "", "  retention_at TIMESTAMPTZ,\n", "",
		"  watermark_at TIMESTAMPTZ NOT NULL,\n", "", "  cutoff_at TIMESTAMPTZ NOT NULL,\n", "").Replace(dailySchemaSQL)
	if digest := fmt.Sprintf("%x", sha256.Sum256([]byte(legacy))); digest != legacyDailyDigest {
		t.Fatalf("legacy fixture no longer matches supported upgrade: %s", digest)
	}
	for _, statement := range strings.Split(legacy, ";") {
		if strings.TrimSpace(statement) != "" {
			if _, err := store.db.ExecContext(t.Context(), statement); err != nil {
				t.Fatal(err)
			}
		}
	}
	if _, err := store.db.ExecContext(t.Context(), `INSERT INTO cao_daily_contract(digest) VALUES($1)`, legacyDailyDigest); err != nil {
		t.Fatal(err)
	}
	store.dailyCounts = false
	row := dailyRun("legacy-detail", "success", "completed")
	dailyPublish(t, store, row)
	started, err := time.Parse(time.RFC3339, row["startedAt"].(string))
	if err != nil {
		t.Fatal(err)
	}
	day := started.UTC().Format("2006-01-02")
	if _, err := store.db.ExecContext(t.Context(), `INSERT INTO daily_run_counts
		(namespace,id,day,repository_id,workflow_id,owner,repository,workflow_path,total,successful,failed,approval,pending,other)
		VALUES($1,$2,$3,'repo','workflow','octo','api','.github/workflows/test.md',1,1,0,0,0,0)`,
		store.namespace, fmt.Sprintf(`["%s","repo","workflow"]`, day), day); err != nil {
		t.Fatal(err)
	}
	if _, err := store.db.ExecContext(t.Context(), `INSERT INTO run_count_contributions
		(namespace,id,repository_id,workflow_id,owner,repository,workflow_path,started_at,attempt,status,conclusion)
		VALUES($1,'legacy-detail','repo','workflow','octo','api','.github/workflows/test.md',$2,2,'completed','success')`,
		store.namespace, started); err != nil {
		t.Fatal(err)
	}
	if _, err := store.db.ExecContext(t.Context(), `INSERT INTO daily_run_count_state(namespace,id,initialized_at)
		VALUES($1,'daily-run-counts',clock_timestamp())`, store.namespace); err != nil {
		t.Fatal(err)
	}
	reopened, err := openConfig(t.Context(), config, false, store.namespace)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = reopened.Close() }()
	if reopened.dailyCounts {
		t.Fatal("runtime accepted an unbounded legacy extension")
	}
	sources, _, err := reopened.ExecuteSQLPlan(t.Context(), []query.Definition{{Name: "daily", From: dailySource}}, []string{"daily"})
	if err != nil || sources["daily"].Metadata["availability"] != "unavailable" {
		t.Fatalf("runtime did not fail closed: %+v %v", sources, err)
	}
	if err := initializeDailyCounts(t.Context(), store.db); err != nil {
		t.Fatal(err)
	}
	if err := initializeDailyCounts(t.Context(), store.db); err != nil {
		t.Fatalf("owner upgrade is not idempotent: %v", err)
	}
	if err := store.backfillDailyOnce(t.Context()); err != nil {
		t.Fatal(err)
	}
	if dailyTotals(t, store)["total"] != 1 {
		t.Fatal("owner upgrade lost existing admitted history")
	}
	store.dailyCounts = true
	dailyPublish(t, store, row)
	if dailyTotals(t, store)["total"] != 1 {
		t.Fatal("legacy receipt replay double-counted an upgraded bucket")
	}
	var nativeDigest string
	if err := store.db.QueryRowContext(t.Context(), `SELECT digest FROM cao_contract`).Scan(&nativeDigest); err != nil ||
		nativeDigest != fmt.Sprintf("%x", sha256.Sum256([]byte(nativeSchemaSQL))) {
		t.Fatalf("extension upgrade changed native storage: %v", err)
	}
}

func TestDailyCountsExpiredBackfillIsPartialAndDoesNotEditDetail(t *testing.T) {
	store, _ := nativeTestStore(t)
	store.dailyCounts = false
	expired := dailyRun("expired-backfill", "success", "completed")
	expired["startedAt"] = dailyCutoff(time.Now()).Add(-time.Second).Format(time.RFC3339)
	dailyPublish(t, store, expired)
	if _, err := store.db.ExecContext(t.Context(), `DELETE FROM daily_run_count_state WHERE namespace=$1`, store.namespace); err != nil {
		t.Fatal(err)
	}

	if err := store.backfillDailyOnce(t.Context()); err != nil {
		t.Fatal(err)
	}
	if dailyReceiptCount(t, store) != 0 || dailyTotals(t, store)["total"] != 0 {
		t.Fatal("backfill admitted expired evidence")
	}
	var rows int
	if err := store.db.QueryRowContext(t.Context(), `SELECT count(*) FROM runs WHERE namespace=$1`, store.namespace).Scan(&rows); err != nil || rows != 1 {
		t.Fatalf("backfill edited canonical detail: %d %v", rows, err)
	}
	store.dailyCounts = true
	dailyPublish(t, store, model.Row{"id": "retained-backfill", "repositoryId": "repo", "workflowId": "workflow",
		"owner": "octo", "repository": "api", "workflowPath": ".github/workflows/test.md",
		"startedAt": time.Now().UTC().Format(time.RFC3339)})
	if dailyTotals(t, store)["total"] != 1 {
		t.Fatal("expired backfill prevented subsequent retained admission")
	}
}

func TestDailyCountsFutureWeekAndEqualRevisionOrder(t *testing.T) {
	store, _ := nativeTestStore(t)
	future := dailyRun("future", "success", "completed")
	future["startedAt"] = dailyCutoff(time.Now()).AddDate(0, 0, 21).Format(time.RFC3339)
	dailyPublish(t, store, future)
	if dailyTotals(t, store)["total"] != 0 || dailyReceiptCount(t, store) != 0 {
		t.Fatal("a future UTC week escaped the three-week window")
	}
	queued := dailyRun("tied", "", "queued")
	queued["updatedAt"] = time.Now().UTC().Format(time.RFC3339Nano)
	complete := model.Row{}
	for key, value := range queued {
		complete[key] = value
	}
	complete["status"], complete["conclusion"] = "completed", "success"
	dailyPublish(t, store, complete)
	dailyPublish(t, store, queued)
	if totals := dailyTotals(t, store); totals["successful"] != 1 || totals["pending"] != 0 {
		t.Fatalf("equal-revision pending replay displaced terminal evidence: %v", totals)
	}
	dailyPublish(t, store, complete)
	if totals := dailyTotals(t, store); totals["successful"] != 1 || totals["total"] != 1 {
		t.Fatalf("equal-revision replay changed the population: %v", totals)
	}
	futureCorrection := model.Row{}
	for key, value := range complete {
		futureCorrection[key] = value
	}
	futureCorrection["startedAt"] = future["startedAt"]
	dailyPublish(t, store, futureCorrection)
	if dailyTotals(t, store)["total"] != 1 {
		t.Fatal("unversioned future correction crossed the retention boundary")
	}
	futureCorrection["updatedAt"] = time.Now().UTC().Add(time.Minute).Format(time.RFC3339Nano)
	dailyPublish(t, store, futureCorrection)
	dailyPublish(t, store, complete)
	if dailyTotals(t, store)["total"] != 0 || dailyReceiptCount(t, store) != 1 {
		t.Fatal("stale replay resurrected a future-corrected contribution")
	}
	complete["updatedAt"] = time.Now().UTC().Add(2 * time.Minute).Format(time.RFC3339Nano)
	dailyPublish(t, store, complete)
	if dailyTotals(t, store)["successful"] != 1 || dailyReceiptCount(t, store) != 1 {
		t.Fatal("authoritative re-entry from a future correction duplicated or lost the contribution")
	}
}
