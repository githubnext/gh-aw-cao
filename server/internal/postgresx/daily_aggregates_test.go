package postgresx

import (
	"context"
	"fmt"
	"testing"
	"time"

	"github.com/githubnext/gh-cao/server/internal/model"
	"github.com/githubnext/gh-cao/server/internal/query"
)

func TestAggregateUTCMondayWindow(t *testing.T) {
	for _, input := range []string{"2026-10-19T00:00:00Z", "2026-10-25T23:59:59Z", "2026-10-26T01:00:00+02:00"} {
		at, _ := time.Parse(time.RFC3339, input)
		if got := aggregateCutoff(at).Format("2006-01-02"); got != "2026-10-05" {
			t.Fatalf("cutoff(%s) = %s", input, got)
		}
	}
	at, _ := time.Parse(time.RFC3339, "2026-10-26T00:00:00Z")
	if got := aggregateCutoff(at).Format("2006-01-02"); got != "2026-10-12" {
		t.Fatalf("Monday rotation = %s", got)
	}
}

func TestDailyWorkflowAggregateCorrectionsReplayAndRotation(t *testing.T) {
	store, _ := nativeTestStore(t)
	ctx := t.Context()
	now := time.Now().UTC()
	old := aggregateCutoff(now).AddDate(0, 0, 1).Add(time.Hour)
	other := aggregateWeekStart(now).Add(time.Hour)
	evidenceVersion := 0
	publish := func(at time.Time, runs []model.Row, events bool) {
		t.Helper()
		w, err := store.BeginIngestion(ctx)
		if err != nil {
			t.Fatal(err)
		}
		defer w.Abort(ctx)
		w.ingestedAt = at
		if len(runs) > 0 {
			for _, input := range []struct {
				source string
				row    model.Row
			}{
				{"$campaigns", model.Row{"id": "campaign", "name": "Campaign"}},
				{"$repositories", model.Row{"id": "repository", "owner": "octo", "name": "api"}},
				{"$workflows", model.Row{"id": "workflow", "repositoryId": "repository", "campaignId": "campaign"}},
			} {
				if err := w.Append(ctx, input.source, input.row); err != nil {
					t.Fatal(err)
				}
			}
		}
		for _, run := range runs {
			run["repositoryId"], run["workflowId"] = "repository", "workflow"
			if err := w.Append(ctx, "$runs", run); err != nil {
				t.Fatal(err)
			}
		}
		if events {
			for _, input := range []struct {
				source string
				row    model.Row
			}{
				{"$tools", model.Row{"id": fmt.Sprint("tool:", evidenceVersion), "runId": "old", "mcpServer": "github", "invocationCount": 3 + evidenceVersion*2, "responseBytes": 24}},
				{"$domains", model.Row{"id": fmt.Sprint("domain:", evidenceVersion), "runId": "old", "decision": "blocked", "requestCount": 2 + evidenceVersion}},
			} {
				if err := w.Append(ctx, input.source, input.row); err != nil {
					t.Fatal(err)
				}
			}
		}
		if _, err := w.Publish(ctx, fmt.Sprint(at.UnixNano(), len(runs))); err != nil {
			t.Fatal(err)
		}
	}
	run := func(id string, at time.Time) model.Row {
		return model.Row{"id": id, "startedAt": at.Format(time.RFC3339), "createdAt": at.Format(time.RFC3339)}
	}
	a, b := run("old", old), run("new", other)
	a["conclusion"], a["aicTotal"], a["inputTokens"] = "failure", 4.5, 0
	a["status"], a["completedAt"] = "completed", old.Add(30*time.Second).Format(time.RFC3339)
	b["status"] = "completed"
	publish(now, []model.Row{a, b}, true)
	read := func(day time.Time) (int64, float64, int64, int64, int64) {
		t.Helper()
		var count, observations, successes, failures int64
		var aic float64
		if err := store.db.QueryRowContext(ctx, `SELECT run_count,coalesce(aic_total_sum,0),aic_total_observed_count,success_count,failure_count
			FROM daily_workflow_aggregates WHERE namespace=$1 AND day=$2`, store.namespace, day.Format("2006-01-02")).
			Scan(&count, &aic, &observations, &successes, &failures); err != nil {
			t.Fatal(err)
		}
		return count, aic, observations, successes, failures
	}
	if count, aic, observations, _, failures := read(old); count != 1 || aic != 4.5 || observations != 1 || failures != 1 {
		t.Fatalf("initial aggregate: %d %v %d %d", count, aic, observations, failures)
	}
	var duration float64
	var durationObserved, tokensObserved int
	if err := store.db.QueryRowContext(ctx, `SELECT agentic_duration_seconds_sum,agentic_duration_seconds_observed_count,input_tokens_observed_count
		FROM daily_workflow_aggregates WHERE day=$1`, old.Format("2006-01-02")).Scan(&duration, &durationObserved, &tokensObserved); err != nil || duration != 30 || durationObserved != 1 || tokensObserved != 1 {
		t.Fatalf("duration/observed zero: %v %d %d %v", duration, durationObserved, tokensObserved, err)
	}
	var missing bool
	if err := store.db.QueryRowContext(ctx, `SELECT agentic_duration_seconds_sum IS NULL AND agentic_duration_seconds_observed_count=0
		AND input_tokens_sum IS NULL AND input_tokens_observed_count=0 FROM daily_workflow_aggregates WHERE day=$1`, other.Format("2006-01-02")).Scan(&missing); err != nil || !missing {
		t.Fatalf("missing measurements became measured zero: %v %v", missing, err)
	}
	var rich, ledger, tools int
	if err := store.db.QueryRowContext(ctx, `SELECT (SELECT count(*) FROM runs WHERE id='old'),
		(SELECT count(*) FROM cao_run_contributions WHERE run_id='old'),(SELECT count(*) FROM tools WHERE run_id='old')`).Scan(&rich, &ledger, &tools); err != nil {
		t.Fatal(err)
	}
	if rich != 1 || ledger != 1 || tools != 0 {
		t.Fatalf("old detail retained or contribution missing: %d %d %d", rich, ledger, tools)
	}
	var toolCalls, blocked int
	if err := store.db.QueryRowContext(ctx, `SELECT mcp_tool_calls_sum,firewall_blocked_calls_sum FROM daily_workflow_aggregates WHERE day=$1`, old.Format("2006-01-02")).Scan(&toolCalls, &blocked); err != nil || toolCalls != 3 || blocked != 2 {
		t.Fatalf("late tool/domain evidence: %d %d %v", toolCalls, blocked, err)
	}
	publish(now, []model.Row{a, b}, true)
	evidenceVersion = 1
	publish(now, []model.Row{a}, true)
	publish(now, []model.Row{a}, true)
	if err := store.db.QueryRowContext(ctx, `SELECT tool_calls_sum,domain_calls_sum FROM daily_workflow_aggregates WHERE day=$1`, old.Format("2006-01-02")).Scan(&toolCalls, &blocked); err != nil || toolCalls != 8 || blocked != 5 {
		t.Fatalf("partial late evidence replay: %d %d %v", toolCalls, blocked, err)
	}
	partial := run("old", old)
	partial["conclusion"] = "success"
	publish(now, []model.Row{partial}, false)
	if count, aic, observations, successes, failures := read(old); count != 1 || aic != 4.5 || observations != 1 || successes != 1 || failures != 0 {
		t.Fatalf("partial/replay correction: %d %v %d %d %d", count, aic, observations, successes, failures)
	}
	partial["aicTotal"] = 7.25
	publish(now, []model.Row{partial}, false)
	if count, aic, observations, _, _ := read(old); count != 1 || aic != 7.25 || observations != 1 {
		t.Fatalf("enriched correction: %d %v %d", count, aic, observations)
	}
	publish(now, nil, false)
	if count, _, _, _, _ := read(other); count != 1 {
		t.Fatal("partial snapshot removed unseen run")
	}
	// Native SQL exposes the same logical UTC date and nullable averages.
	definition := query.Definition{Name: "aggregate", From: dailyAggregateSource}
	result, _, err := store.ExecuteSQLPlan(ctx, []query.Definition{definition}, []string{"aggregate"})
	if err != nil || len(result["aggregate"].Rows) != 2 {
		t.Fatalf("native aggregate query: %+v %v", result, err)
	}
	next := aggregateWeekStart(now).AddDate(0, 0, 7)
	if err := store.RunPartitionMaintenance(ctx, next, defaultRunRetentionDays, 7); err != nil {
		t.Fatal(err)
	}
	var aggregates int
	if err := store.db.QueryRowContext(ctx, `SELECT (SELECT count(*) FROM daily_workflow_aggregates),(SELECT count(*) FROM cao_run_contributions)`).Scan(&aggregates, &ledger); err != nil {
		t.Fatal(err)
	}
	if aggregates != 1 || ledger != 1 {
		t.Fatalf("whole-week rotation retained expired facts: %d %d", aggregates, ledger)
	}
	publish(next, []model.Row{a}, true)
	if err := store.db.QueryRowContext(ctx, `SELECT count(*) FROM daily_workflow_aggregates`).Scan(&aggregates); err != nil || aggregates != 1 {
		t.Fatalf("expired replay resurrected aggregate: %d %v", aggregates, err)
	}
}

func TestDailyAggregateDayCorrection(t *testing.T) {
	store, _ := nativeTestStore(t)
	ctx := context.Background()
	now := time.Now().UTC()
	for _, offset := range []int{0, -1, -1} {
		w, err := store.BeginIngestion(ctx)
		if err != nil {
			t.Fatal(err)
		}
		nativeParents(ctx, t, w)
		// The ordinary fixture has no explicit date. Correct it in the staging
		// table before publication, as a richer replacement snapshot would.
		if err := w.Flush(ctx); err != nil {
			t.Fatal(err)
		}
		if _, err := w.tx.Exec(ctx, `UPDATE runs_stage SET started_at=$1,created_at=$1,run_at=$1`, now.AddDate(0, 0, offset)); err != nil {
			t.Fatal(err)
		}
		if _, err := w.Publish(ctx, fmt.Sprint(offset)); err != nil {
			w.Abort(ctx)
			t.Fatal(err)
		}
	}
	var count, total int
	if err := store.db.QueryRowContext(ctx, `SELECT count(*),sum(run_count) FROM daily_workflow_aggregates`).Scan(&count, &total); err != nil || count != 1 || total != 1 {
		t.Fatalf("date correction double-counted: %d %d %v", count, total, err)
	}
}
