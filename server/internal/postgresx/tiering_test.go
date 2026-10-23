package postgresx

import (
	"context"
	"database/sql"
	"errors"
	"reflect"
	"strings"
	"testing"
	"time"

	"github.com/githubnext/gh-cao/server/internal/model"
	"github.com/githubnext/gh-cao/server/internal/storagetiers"
)

func tierPointer[T any](value T) *T { return &value }

func seedTierRuns(t *testing.T, store *Store, runs []model.Row) {
	t.Helper()
	writer, err := store.BeginIngestion(t.Context())
	if err != nil {
		t.Fatal(err)
	}
	defer writer.Abort(t.Context())
	if err := writer.Append(t.Context(), "$repositories", model.Row{"id": "repository"}); err != nil {
		t.Fatal(err)
	}
	if err := writer.Append(t.Context(), "$workflows", model.Row{"id": "workflow", "repositoryId": "repository"}); err != nil {
		t.Fatal(err)
	}
	for _, run := range runs {
		record := model.Row{"workflowId": "workflow", "repositoryId": "repository"}
		for key, value := range run {
			record[key] = value
		}
		if err := writer.Append(t.Context(), "$runs", record); err != nil {
			t.Fatal(err)
		}
	}
	if _, err := writer.Publish(t.Context(), "tier-test"); err != nil {
		t.Fatal(err)
	}
}

func TestCanonicalTierPlansPostgresSnapshot(t *testing.T) {
	store, config := nativeTestStore(t)
	watermark := time.Now().UTC().Truncate(time.Millisecond)
	rows := []model.Row{
		{"id": "failure", "startedAt": watermark.Add(-time.Hour), "conclusion": "failure"},
		{"id": "success", "startedAt": watermark.Add(-time.Hour), "conclusion": "success"},
		{"id": "old", "startedAt": watermark.Add(-8 * 24 * time.Hour), "conclusion": "failure"},
		{"id": "future", "startedAt": watermark.Add(time.Millisecond), "conclusion": "failure"},
		{"id": "boundary", "startedAt": watermark.Add(-7 * 24 * time.Hour), "conclusion": "cancelled"},
		{"id": "fallback", "completedAt": watermark.Add(-2 * time.Hour), "conclusion": "timed_out"},
		{"id": "😀", "startedAt": watermark.Add(-time.Hour)},
		{"id": "\uE000", "startedAt": watermark.Add(-time.Hour)},
	}
	seedTierRuns(t, store, rows)
	other, err := NewConfig(t.Context(), config, "other-namespace")
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = other.Close() }()
	seedTierRuns(t, other, []model.Row{{"id": "unrelated", "startedAt": watermark}})
	options := storagetiers.Options{
		Seed: "fixture", Watermark: tierPointer(watermark.UnixMilli()),
		Hot: tierPointer(3), Statistical: tierPointer(4),
	}
	before, err := store.State(t.Context())
	if err != nil {
		t.Fatal(err)
	}
	actual, err := store.PlanStorageTiers(t.Context(), options)
	if err != nil {
		t.Fatal(err)
	}
	planner, err := storagetiers.New(store.namespace, options)
	if err != nil {
		t.Fatal(err)
	}
	for _, record := range rows {
		run := storagetiers.Run{ID: record["id"].(string)}
		run.Conclusion, _ = record["conclusion"].(string)
		if value, ok := record["startedAt"].(time.Time); ok {
			run.StartedAt = tierPointer(value.UnixMilli())
		}
		if value, ok := record["completedAt"].(time.Time); ok {
			run.CompletedAt = tierPointer(value.UnixMilli())
		}
		if err := planner.Add(run); err != nil {
			t.Fatal(err)
		}
	}
	expected, err := planner.Finish()
	if err != nil || !reflect.DeepEqual(actual, expected) {
		t.Fatalf("PostgreSQL tier plan %+v != %+v: %v", actual, expected, err)
	}
	after, err := store.State(t.Context())
	if err != nil || !reflect.DeepEqual(after, before) {
		t.Fatalf("tier planning mutated state: %+v != %+v: %v", after, before, err)
	}
	cancelled, cancel := context.WithCancel(t.Context())
	cancel()
	plan, err := store.PlanStorageTiers(cancelled, options)
	if !errors.Is(err, context.Canceled) || plan.PolicyVersion != 0 {
		t.Fatalf("cancelled scan returned plan %+v: %v", plan, err)
	}
}

func TestCanonicalTierPlansPostgresRejectsIncompleteCanonicalIdentity(t *testing.T) {
	store, _ := nativeTestStore(t)
	now := time.Now().UTC().Truncate(time.Millisecond)
	options := storagetiers.Options{Seed: "fixture", Watermark: tierPointer(now.UnixMilli())}
	for _, fixture := range []struct {
		name string
		rows []model.Row
		want string
	}{
		{"duplicate", []model.Row{
			{"id": "duplicate", "startedAt": now.Add(-time.Hour)},
		}, "distinct reconciled"},
		{"missing-event-time", []model.Row{{"id": "missing"}}, "startedAt or completedAt"},
	} {
		t.Run(fixture.name, func(t *testing.T) {
			seedTierRuns(t, store, fixture.rows)
			if fixture.name == "duplicate" {
				// Normal ingestion rejects this. Simulate a damaged physical snapshot.
				if _, err := store.db.ExecContext(t.Context(), `INSERT INTO runs
					SELECT (jsonb_populate_record(NULL::runs, to_jsonb(r) ||
						jsonb_build_object('run_at',$2::timestamptz,'started_at',$2::timestamptz))).*
					FROM runs r WHERE namespace=$1`, store.namespace, now.Add(-25*time.Hour)); err != nil {
					t.Fatal(err)
				}
			}

			plan, err := store.PlanStorageTiers(t.Context(), options)
			if err == nil || !strings.Contains(err.Error(), fixture.want) || plan.PolicyVersion != 0 {
				t.Fatalf("invalid snapshot returned %+v: %v", plan, err)
			}
		})
	}
}

func TestTierTimestampBoundaries(t *testing.T) {
	for _, milliseconds := range []int64{-8_640_000_000_000_000, -1, 0, 1, 8_640_000_000_000_000} {
		actual, err := tierTimestamp(sql.NullTime{Time: time.UnixMilli(milliseconds), Valid: true})
		if err != nil || !actual.Valid || actual.Int64 != milliseconds {
			t.Fatalf("timestamp %d returned %+v: %v", milliseconds, actual, err)
		}
	}
	missing, err := tierTimestamp(sql.NullTime{})
	if err != nil || missing.Valid {
		t.Fatalf("missing timestamp became measured time: %+v: %v", missing, err)
	}
	for _, milliseconds := range []int64{-8_640_000_000_000_001, 8_640_000_000_000_001} {
		if _, err := tierTimestamp(sql.NullTime{Time: time.UnixMilli(milliseconds), Valid: true}); err == nil {
			t.Fatalf("accepted timestamp outside JavaScript Date range: %d", milliseconds)
		}
	}
}
