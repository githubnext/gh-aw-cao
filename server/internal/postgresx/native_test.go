package postgresx

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"reflect"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/stdlib"

	"github.com/githubnext/gh-aw-cao/server/internal/model"
	"github.com/githubnext/gh-aw-cao/server/internal/query"
)

func nativeTestStore(t *testing.T) (*Store, *pgx.ConnConfig) {
	t.Helper()
	endpoint := os.Getenv("POSTGRES_URL")
	if endpoint == "" {
		t.Skip("POSTGRES_URL is unset")
	}
	config, err := pgx.ParseConfig(endpoint)
	if err != nil {
		t.Fatal(err)
	}
	admin := stdlib.OpenDB(*config.Copy())
	schema := fmt.Sprintf("cao_native_%d", time.Now().UnixNano())
	if _, err := admin.ExecContext(t.Context(), "CREATE SCHEMA "+schema); err != nil {
		_ = admin.Close()
		t.Fatal(err)
	}
	t.Cleanup(func() {
		ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		_, _ = admin.ExecContext(ctx, "DROP SCHEMA "+schema+" CASCADE")
		_ = admin.Close()
	})
	config.RuntimeParams["search_path"] = schema
	store, err := NewConfig(t.Context(), config)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = store.Close() })
	return store, config
}

func nativeParents(ctx context.Context, t *testing.T, w *Writer) {
	t.Helper()
	for _, record := range []struct {
		source string
		row    model.Row
	}{
		{"$repositories", model.Row{"id": "repository", "owner": "octo", "name": "api"}},
		{"$workflows", model.Row{"id": "workflow", "repositoryId": "repository", "path": ".github/workflows/test.md"}},
		{"$runs", model.Row{"id": "run", "workflowId": "workflow", "repositoryId": "repository", "owner": "octo", "repository": "api", "githubRunId": "9007199254740993"}},
	} {
		if err := w.Append(ctx, record.source, record.row); err != nil {
			t.Fatal(err)
		}
	}
}

func nativeSeed(ctx context.Context, t *testing.T, store *Store, sources map[string][]model.Row) {
	t.Helper()
	w, err := store.BeginIngestion(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer w.Abort(ctx)
	nativeParents(ctx, t, w)
	for name, rows := range sources {
		for _, row := range rows {
			if err := w.Append(ctx, name, row); err != nil {
				t.Fatal(err)
			}
		}
	}
	if _, err := w.Publish(ctx, "typed"); err != nil {
		t.Fatal(err)
	}
}

func TestFreshSchemaReopen(t *testing.T) {
	store, config := nativeTestStore(t)
	nativeSeed(t.Context(), t, store, nil)
	before, err := store.State(t.Context())
	if err != nil {
		t.Fatal(err)
	}
	reopened, err := NewConfig(t.Context(), config)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = reopened.Close() }()
	after, err := reopened.State(t.Context())
	if err != nil || !reflect.DeepEqual(before, after) {
		t.Fatalf("fresh reopen changed state: %+v %v", after, err)
	}
	if _, err := store.db.ExecContext(t.Context(), "UPDATE cao_contract SET digest='changed'"); err != nil {
		t.Fatal(err)
	}
	if changed, err := NewConfig(t.Context(), config); err == nil {
		_ = changed.Close()
		t.Fatal("different physical contract was accepted")
	}
}

func TestNativeStorageAndSQLPresence(t *testing.T) {
	store, _ := nativeTestStore(t)
	nativeSeed(t.Context(), t, store, map[string][]model.Row{"$domains": {
		{"id": "null", "runId": "run", "domain": nil, "requestCount": json.Number("9007199254740993")},
		{"id": "absent", "runId": "run", "unused": make(chan int)},
	}})
	result, metrics, err := store.ExecuteSQLPlan(t.Context(), []query.Definition{{Name: "native", From: "$domains", Select: []query.SelectedField{{Field: "id"}, {Field: "domain"}, {Field: "requestCount"}}}}, []string{"native"})
	if err != nil {
		t.Fatal(err)
	}
	rows := result["native"].Rows
	if len(rows) != 2 || rows[0]["domain"] != nil || rows[0]["requestCount"] != json.Number("9007199254740993") {
		t.Fatalf("typed rows lost precision/null: %#v", rows)
	}
	if _, present := rows[0]["domain"]; !present {
		t.Fatal("explicit null became absent")
	}
	if _, present := rows[1]["domain"]; present {
		t.Fatal("absent became explicit null")
	}
	if len(metrics.PushedDown) == 0 {
		t.Fatalf("not a complete SQL execution: %+v", metrics)
	}
	var forbidden int
	if err := store.db.QueryRowContext(t.Context(), `SELECT count(*) FROM information_schema.columns
		WHERE table_schema=current_schema() AND (data_type IN ('json','jsonb') OR table_name IN ('cao_sources','cao_source_rows','cao_values') OR (table_name LIKE '%\_values' AND table_name <> 'operational_values'))`).Scan(&forbidden); err != nil {
		t.Fatal(err)
	}
	if forbidden != 0 {
		t.Fatal("forbidden generic or persisted JSON storage exists")
	}
}

func TestNativeAtomicFailureAndBoundedCopy(t *testing.T) {
	store, _ := nativeTestStore(t)
	nativeSeed(t.Context(), t, store, nil)
	before, _ := store.State(t.Context())
	for _, failure := range []string{"duplicate", "orphan", "type"} {
		w, err := store.BeginIngestion(t.Context())
		if err != nil {
			t.Fatal(err)
		}
		nativeParents(t.Context(), t, w)
		row := model.Row{"id": "bad", "runId": "run"}
		if failure == "orphan" {
			row["runId"] = "missing"
		}
		if failure == "type" {
			row["requestCount"] = "invalid"
		}
		err = w.Append(t.Context(), "$domains", row)
		if failure == "duplicate" && err == nil {
			err = w.Append(t.Context(), "$domains", row)
		}
		if err == nil {
			_, err = w.Publish(t.Context(), "bad")
		}
		w.Abort(t.Context())
		if err == nil {
			t.Fatalf("%s published", failure)
		}
		after, err := store.State(t.Context())
		if err != nil || !reflect.DeepEqual(before, after) {
			t.Fatalf("failure changed publication: %+v %v", after, err)
		}
	}
	w, err := store.BeginIngestion(t.Context())
	if err != nil {
		t.Fatal(err)
	}
	defer w.Abort(t.Context())
	nativeParents(t.Context(), t, w)
	for index := range BatchRows*3 + 1 {
		if err := w.Append(t.Context(), "$domains", model.Row{"id": fmt.Sprint(index), "runId": "run", "domain": strings.Repeat("x", 50)}); err != nil {
			t.Fatal(err)
		}
		if w.rows >= BatchRows || w.bytes >= BatchBytes {
			t.Fatal("batch memory was not bounded")
		}
	}
	state, err := w.Publish(t.Context(), "many")
	if err != nil {
		t.Fatal(err)
	}
	if state.Counts["$domains"] != BatchRows*3+1 {
		t.Fatalf("CopyFrom lost rows: %+v", state.Counts)
	}
}

func TestNativeSnapshotAndNamespaceIsolation(t *testing.T) {
	store, config := nativeTestStore(t)
	nativeSeed(t.Context(), t, store, nil)
	other, err := NewConfig(t.Context(), config, "other")
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = other.Close() }()
	nativeSeed(t.Context(), t, other, nil)
	err = store.WithReadTransaction(t.Context(), func(ctx context.Context, reader NativeReader) error {
		before, err := reader.State(ctx)
		if err != nil {
			return err
		}
		nativeSeed(ctx, t, store, map[string][]model.Row{"$domains": {{"id": "new", "runId": "run"}}})
		after, err := reader.State(ctx)
		if err != nil {
			return err
		}
		if !reflect.DeepEqual(before, after) {
			t.Fatal("repeatable-read publication changed")
		}
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
	if err := store.DeleteNamespace(t.Context()); err != nil {
		t.Fatal(err)
	}
	state, err := other.State(t.Context())
	if err != nil || !state.Ready || state.Counts["$runs"] != 1 {
		t.Fatalf("namespace isolation failed: %+v %v", state, err)
	}
}

func TestNativeInventoryEnrichment(t *testing.T) {
	store, _ := nativeTestStore(t)
	w, err := store.BeginIngestion(t.Context())
	if err != nil {
		t.Fatal(err)
	}

	defer w.Abort(t.Context())
	nativeParents(t.Context(), t, w)
	if err := w.AppendInventory(t.Context(), "$repositories", model.Row{"id": "repository", "owner": "must-not-replace", "visibility": "private"}); err != nil {
		t.Fatal(err)
	}
	if _, err := w.Publish(t.Context(), "inventory"); err != nil {
		t.Fatal(err)
	}
	var owner, visibility string
	if err := store.db.QueryRowContext(t.Context(), "SELECT owner,visibility FROM repositories WHERE namespace=$1", store.namespace).Scan(&owner, &visibility); err != nil {
		t.Fatal(err)
	}
	if owner != "octo" || visibility != "private" {
		t.Fatalf("native observation precedence lost: %s %s", owner, visibility)
	}
}

func TestWeeklyRunPartitionsAndRetention(t *testing.T) {
	store, _ := nativeTestStore(t)
	now := time.Now().UTC()
	old := now.AddDate(0, 0, -28).Format(time.RFC3339)
	current := now.Format(time.RFC3339)
	writer, err := store.BeginIngestion(t.Context())
	if err != nil {
		t.Fatal(err)
	}
	defer writer.Abort(t.Context())
	for _, record := range []struct {
		source string
		row    model.Row
	}{
		{"$repositories", model.Row{"id": "repository"}},
		{"$workflows", model.Row{"id": "workflow", "repositoryId": "repository"}},
		{"$experiments", model.Row{"id": "experiment", "workflowId": "workflow"}},
		{"$graders", model.Row{"id": "grader", "workflowId": "workflow"}},
		{"$evals", model.Row{"id": "eval", "workflowId": "workflow"}},
		{"$runs", model.Row{"id": "old", "repositoryId": "repository", "workflowId": "workflow", "createdAt": old}},
		{"$runs", model.Row{"id": "current", "repositoryId": "repository", "workflowId": "workflow", "createdAt": current}},
		{"$sessions", model.Row{"id": "old-session", "runId": "old"}},
		{"$events", model.Row{"id": "old-event", "sessionId": "old-session"}},
		{"$sessions", model.Row{"id": "current-session", "runId": "current"}},
		{"$events", model.Row{"id": "current-event", "sessionId": "current-session"}},
	} {
		if err := writer.Append(t.Context(), record.source, record.row); err != nil {
			t.Fatal(err)
		}
	}
	for _, source := range []string{"$audits", "$domains", "$evalObservations", "$experimentAssignments", "$friction", "$graderObservations", "$issues", "$jobs", "$skills", "$tools"} {
		for _, run := range []string{"old", "current"} {
			row := model.Row{"id": source + run, "runId": run}
			switch source {
			case "$evalObservations":
				row["evalId"] = "eval"
			case "$experimentAssignments":
				row["experimentId"] = "experiment"
			case "$graderObservations":
				row["graderId"] = "grader"
			}
			if err := writer.Append(t.Context(), source, row); err != nil {
				t.Fatal(err)
			}
		}
	}
	if _, err := writer.Publish(t.Context(), "weekly"); err != nil {
		t.Fatal(err)
	}
	var partitions int
	if err := store.db.QueryRowContext(t.Context(), "SELECT count(DISTINCT tableoid) FROM runs WHERE namespace=$1", store.namespace).Scan(&partitions); err != nil || partitions != 2 {
		t.Fatalf("runs did not route to two weekly partitions: %d %v", partitions, err)
	}
	result, _, err := store.ExecuteSQLPlan(t.Context(), []query.Definition{{Name: "runs", From: "$runs", Select: []query.SelectedField{{Field: "id"}}}}, []string{"runs"})
	if err != nil || len(result["runs"].Rows) != 2 {
		t.Fatalf("parent query lost partitions: %v %v", result, err)
	}
	if err := store.RunPartitionMaintenance(t.Context(), now, 14); err != nil {
		t.Fatal(err)
	}
	for _, table := range []string{"runs", "sessions", "events", "audits", "domains", "eval_observations", "experiment_assignments", "friction", "grader_observations", "issues", "jobs", "skills", "tools"} {
		var count int
		if err := store.db.QueryRowContext(t.Context(), "SELECT count(*) FROM "+table+" WHERE namespace=$1", store.namespace).Scan(&count); err != nil || count != 1 {
			t.Fatalf("%s coordinated retention count = %d, err = %v", table, count, err)
		}
	}
}
