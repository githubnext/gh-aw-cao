package sqlitex

import (
	"bytes"
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"reflect"
	"slices"
	"strings"
	"testing"
	"time"

	"github.com/githubnext/gh-aw-cao/dashboard"

	"github.com/githubnext/gh-aw-cao/server/internal/model"
	"github.com/githubnext/gh-aw-cao/server/internal/postgresx"
	"github.com/githubnext/gh-aw-cao/server/internal/query"
)

func testDirectory(t *testing.T) string {
	t.Helper()
	directory, err := os.MkdirTemp(".", ".sqlite-test-")
	if err != nil {
		t.Fatal(err)
	}
	directory, err = filepath.Abs(directory)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.RemoveAll(directory) })
	return directory
}

func seedStore(t *testing.T) (*Store, string) {
	t.Helper()
	path := filepath.Join(testDirectory(t), "dashboard.sqlite")
	db, err := sql.Open("sqlite", path)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = db.Close() }()
	for _, statement := range []string{
		`PRAGMA journal_mode=WAL`,
		`CREATE TABLE __idb_databases (name TEXT PRIMARY KEY,version INTEGER)`,
		`CREATE TABLE __idb_stores (database_name TEXT,name TEXT,PRIMARY KEY(database_name,name))`,
		`CREATE TABLE __idb_records (database_name TEXT,store_name TEXT,record_key TEXT,value TEXT,PRIMARY KEY(database_name,store_name,record_key))`,
		`CREATE TABLE preview_sources(name TEXT PRIMARY KEY,value TEXT NOT NULL)`,
	} {
		if _, err := db.ExecContext(t.Context(), statement); err != nil {
			t.Fatal(err)
		}
	}
	if _, err := db.ExecContext(t.Context(), `INSERT INTO __idb_databases VALUES (?,41)`, databaseName); err != nil {
		t.Fatal(err)
	}
	for _, name := range append(slices.Clone(collections), "transactions", "storageShards", "quality") {
		if _, err := db.ExecContext(t.Context(), `INSERT INTO __idb_stores VALUES (?,?)`, databaseName, name); err != nil {
			t.Fatal(err)
		}
	}
	store, err := New(t.Context(), path)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = store.Close() })
	return store, path
}

func putRecord(t *testing.T, ctx context.Context, store *Store, collection, key string, value any) {
	t.Helper()
	content, err := json.Marshal(value)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := store.db.ExecContext(ctx, `INSERT OR REPLACE INTO __idb_records VALUES (?,?,?,?)`, store.database, collection, mustJSON(key), string(content)); err != nil {
		t.Fatal(err)
	}
}

func putPreview(t *testing.T, store *Store, name string, value model.Source) {
	t.Helper()
	content, err := json.Marshal(value)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := store.db.ExecContext(t.Context(), `INSERT OR REPLACE INTO preview_sources VALUES (?,?)`, name, string(content)); err != nil {
		t.Fatal(err)
	}
}

func definitions(t *testing.T, content string) []query.Definition {
	t.Helper()
	var result []query.Definition
	decoder := json.NewDecoder(strings.NewReader(content))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&result); err != nil {
		t.Fatal(err)
	}
	return result
}

func canonicalDefinitions(t *testing.T) []query.Definition {
	t.Helper()
	content, err := dashboard.Catalog.ReadFile("site/src/data/queries/database.json")
	if err != nil {
		t.Fatal(err)
	}
	result := definitions(t, string(content))
	if len(result) < 34 {
		t.Fatal("canonical query corpus unexpectedly small")
	}
	return result
}

func equalJSON(t *testing.T, actual, expected any) {
	t.Helper()
	a, err := json.Marshal(actual)
	if err != nil {
		t.Fatal(err)
	}
	e, err := json.Marshal(expected)
	if err != nil {
		t.Fatal(err)
	}
	var normalizedA, normalizedE any
	_ = json.Unmarshal(a, &normalizedA)
	_ = json.Unmarshal(e, &normalizedE)
	if !reflect.DeepEqual(normalizedA, normalizedE) {
		t.Fatalf("actual: %s\nexpected: %s", a, e)
	}
}

func TestCanonicalQueryCorpusAndGoWorkItemFixture(t *testing.T) {
	store, _ := seedStore(t)
	content, err := os.ReadFile("../../../dashboard/site/test/fixtures/canonical-work-items.json")
	if err != nil {
		t.Fatal(err)
	}
	var fixture map[string][]model.Row
	if err := json.Unmarshal(content, &fixture); err != nil {
		t.Fatal(err)
	}
	fixture["runs"][1]["startedAt"] = nil
	for _, issue := range fixture["issues"] {
		issue["type"] = "safe_output.result"
	}
	for collection, records := range fixture {
		for _, record := range records {
			putRecord(t, t.Context(), store, collection, record["id"].(string), record)
		}
	}
	defs := canonicalDefinitions(t)
	names := make([]string, 0, len(defs))
	for _, def := range defs {
		names = append(names, def.Name)
	}
	result, metrics, err := store.ExecuteSQLPlan(t.Context(), defs, names)
	if err != nil {
		t.Fatal(err)
	}
	if len(result) != len(names) || metrics.QueryCount < len(defs) || metrics.Operations == 0 {
		t.Fatalf("canonical corpus did not execute: %#v", metrics)
	}
	if len(result["outcomes"].Rows) != 2 || len(result["work-items"].Rows) != 2 {
		t.Fatalf("work-item attempt correlation changed: %#v", result["work-items"])
	}
	for _, row := range result["work-items"].Rows {
		if row["workflow"] == ".github/workflows/worker.md" &&
			(row["name"] != "Worker · Current attempt" || row["lifecycle-state"] != "review" || row["started-at"] != fixture["runs"][1]["createdAt"]) {
			t.Fatalf("latest-attempt parity: %#v", row)
		}
	}
}

func TestJSCanonicalStorageAndQueryParity(t *testing.T) {
	if os.Getenv("CAO_QUERYENGINE_JS_PARITY") != "1" {
		t.Skip("optional JS parity oracle; set CAO_QUERYENGINE_JS_PARITY=1")
	}
	node, err := exec.LookPath("node")
	if err != nil {
		t.Skip("Node is needed for the canonical ingestion parity oracle")
	}
	path := filepath.Join(testDirectory(t), "dashboard.sqlite")
	script := `
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { installSqliteIndexedDB } from './dashboard/site/src/data/storage/sqlite-indexeddb.js';
import { ENTITY_STORES, DATABASE_VERSION, readCollections, upsertCanonicalBatch } from './dashboard/site/src/data/storage/indexeddb.js';
import { ingestDashboardSources } from './dashboard/site/src/data/ingest/coordinator.js';
import { queryDatabaseSources } from './dashboard/site/src/data/queries/database.js';
import { relationshipErrors } from './dashboard/site/src/data/model/schema.js';
const path = process.argv[1];
const indexedDB = installSqliteIndexedDB(path);
const db = new DatabaseSync(path);
db.exec('CREATE TABLE preview_sources(name TEXT PRIMARY KEY,value TEXT NOT NULL)');
const metadata = {'as-of':new Date().toISOString(),'retrieved-at':new Date().toISOString(),completeness:'complete',freshness:'fresh'};
const sourcesInput = {
  repositories:{metadata,rows:[{organization:'acme',repository:'control'}]},
  workflows:{metadata,rows:[{organization:'acme',repository:'control',workflow:'demo.md','workflow-name':'Demo'}]}
};
await ingestDashboardSources(indexedDB,sourcesInput);
for (const [name,value] of Object.entries(sourcesInput)) db.prepare('INSERT INTO preview_sources VALUES (?,?)').run(name,JSON.stringify(value));
const fixture = JSON.parse(readFileSync('./dashboard/site/test/fixtures/canonical-work-items.json','utf8'));
for (const issue of fixture.issues) issue.type = 'safe_output.result';
const batch = Object.fromEntries(ENTITY_STORES.map(name => [name,fixture[name] ?? []]));
await upsertCanonicalBatch(indexedDB,batch);
const queries = JSON.parse(readFileSync('./dashboard/site/src/data/queries/database.json','utf8'));
const names = queries.map(query=>query.name);
const sources = await queryDatabaseSources(indexedDB,sourcesInput,names);
const records = await readCollections(indexedDB,ENTITY_STORES);
const diagnostics = {schemaVersion:DATABASE_VERSION,counts:Object.fromEntries(ENTITY_STORES.map(name=>[name,records[name].length])),
  relationshipErrors:relationshipErrors(records), duplicateRecordIds:Object.fromEntries(ENTITY_STORES.map(name=>[name,[]]))};
db.close();
process.stdout.write(JSON.stringify({sources,diagnostics}));
`
	command := exec.CommandContext(t.Context(), node, "--input-type=module", "-e", script, path) //nolint:gosec // G204: opt-in oracle uses the PATH-resolved Node executable with a fixed script and test-owned fixture path, without a shell.
	command.Dir = "../../../"
	var stderr bytes.Buffer
	command.Stderr = &stderr
	output, err := command.Output()
	if err != nil {
		t.Fatalf("canonical JS oracle: %v: %s", err, stderr.String())
	}
	var expected struct {
		Sources     map[string]model.Source `json:"sources"`
		Diagnostics model.Diagnostics       `json:"diagnostics"`
	}
	if err := json.Unmarshal(output, &expected); err != nil {
		t.Fatal(err)
	}
	store, err := New(t.Context(), path)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = store.Close() }()
	defs := canonicalDefinitions(t)
	names := make([]string, 0, len(defs))
	for _, def := range defs {
		names = append(names, def.Name)
	}
	actual, _, err := store.ExecuteSQLPlan(t.Context(), defs, names)
	if err != nil {
		t.Fatal(err)
	}
	for _, name := range names {
		t.Run(name, func(t *testing.T) {
			equalJSON(t, actual[name].Rows, expected.Sources[name].Rows)
			for _, field := range []string{"availability", "completeness", "freshness"} {
				equalJSON(t, actual[name].Metadata[field], expected.Sources[name].Metadata[field])
			}
		})
	}
	diagnostics, err := store.Diagnostics(t.Context())
	if err != nil {
		t.Fatal(err)
	}
	equalJSON(t, diagnostics, expected.Diagnostics)
}

func TestDependencyOnlyReadsAndMissingNull(t *testing.T) {
	store, _ := seedStore(t)
	putRecord(t, t.Context(), store, "repositories", "one", model.Row{"id": "one", "present": nil, "_storage": map[string]any{"bytes": 3}})
	if _, err := store.db.ExecContext(t.Context(), `INSERT INTO __idb_records VALUES (?,?,?,?)`, databaseName, "tools", `"corrupt"`, "not json"); err != nil {
		t.Fatal(err)
	}
	defs := definitions(t, `[{"name":"selected","from":"$repositories","select":[{"field":"id"},{"field":"present"},{"field":"absent"}]}]`)
	result, _, err := store.ExecuteSQLPlan(t.Context(), defs, []string{"selected", "$campaigns"})
	if err != nil {
		t.Fatal(err)
	}
	equalJSON(t, result["selected"].Rows, []model.Row{{"id": "one", "present": nil}})
	equalJSON(t, result["$campaigns"].Rows, []model.Row{})
	for _, name := range []string{"$unknown", "unknown", "$tools"} {
		if _, _, err := store.ExecuteSQLPlan(t.Context(), nil, []string{name}); err == nil {
			t.Fatalf("source %q did not fail closed", name)
		}
	}
}

func TestUnavailableQualityOptionalJoinsAndRawSources(t *testing.T) {
	store, _ := seedStore(t)
	putRecord(t, t.Context(), store, "repositories", "one", model.Row{"id": "one"})
	putRecord(t, t.Context(), store, "tools", "tool", model.Row{"id": "tool"})
	putRecord(t, t.Context(), store, "quality", "tools", model.Row{"metadata": map[string]any{"availability": "unavailable", "error": "evidence missing"}})
	putPreview(t, store, "external", model.Source{Rows: []model.Row{{"id": "external"}}, Metadata: model.Metadata{"completeness": "complete"}})
	putPreview(t, store, "campaigns", model.Source{Metadata: model.Metadata{"availability": "unavailable"}})
	putPreview(t, store, "cli-commands", model.Source{Rows: []model.Row{{"stale": true}}})
	defs := definitions(t, `[
		{"name":"joined","from":"$repositories","joins":[{"source":"$tools","type":"left","on":[{"left":"id","right":"id"}],"fields":[{"field":"id","as":"tool"}]}]},
		{"name":"required","from":"$tools","aggregate":{"values":[{"field":"id","as":"count","reducer":"count"}]}}
	]`)
	result, _, err := store.ExecuteSQLPlan(t.Context(), defs, []string{"joined", "required", "$tools", "$campaigns", "external"})
	if err != nil {
		t.Fatal(err)
	}
	equalJSON(t, result["joined"].Rows, []model.Row{{"id": "one", "tool": nil}})
	if result["joined"].Metadata["completeness"] != "partial" {
		t.Fatalf("unavailable optional evidence was not partial: %#v", result["joined"])
	}
	for _, name := range []string{"required", "$tools", "$campaigns"} {
		if result[name].Metadata["availability"] != "unavailable" || len(result[name].Rows) != 0 {
			t.Fatalf("unavailable source %q became successful: %#v", name, result[name])
		}
	}
	equalJSON(t, result["external"].Rows, []model.Row{{"id": "external"}})
	runtimeResult, _, err := store.ExecuteSQLPlanWithOptions(t.Context(), nil, []string{"cli-commands"}, postgresx.SQLExecutionOptions{
		Runtime: func(context.Context, string) (model.Source, error) {
			return model.Source{Rows: []model.Row{{"current": true}}}, nil
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	equalJSON(t, runtimeResult["cli-commands"].Rows, []model.Row{{"current": true}})
	if _, _, err := store.ExecuteSQLPlan(t.Context(), nil, []string{"cli-commands"}); err == nil {
		t.Fatal("stale preview rows bypassed the required runtime source provider")
	}
}

func TestPaginationRuntimePredictionAndBounds(t *testing.T) {
	store, _ := seedStore(t)
	for i := 0; i < 3; i++ {
		putRecord(t, t.Context(), store, "repositories", fmt.Sprint(i), model.Row{"id": fmt.Sprint(i), "x": i, "y": 2*i + 1})
	}
	defs := definitions(t, `[{"name":"predicted","from":"$repositories","predict":[{"method":"linear","on":"x","field":"y","as":"prediction"}],"order-by":[{"field":"x"}]}]`)
	options := postgresx.SQLExecutionOptions{
		Pages: map[string]postgresx.SQLPage{"predicted": {Offset: 1, Limit: 1}},
		Runtime: func(_ context.Context, name string) (model.Source, error) {
			if name != "runtime-fixture" {
				return model.Source{}, errors.New("not authorized")
			}
			return model.Source{Rows: []model.Row{{"runtime": true}}}, nil
		},
	}
	result, _, err := store.ExecuteSQLPlanWithOptions(t.Context(), defs, []string{"predicted", "runtime-fixture"}, options)
	if err != nil {
		t.Fatal(err)
	}
	equalJSON(t, result["predicted"].Rows[0]["prediction"], 3)
	equalJSON(t, result["predicted"].Metadata["total-row-count"], 3)
	equalJSON(t, result["runtime-fixture"].Rows, []model.Row{{"runtime": true}})
	options.Pages["predicted"] = postgresx.SQLPage{Offset: 4, Limit: 1}
	if _, _, err := store.ExecuteSQLPlanWithOptions(t.Context(), defs, []string{"predicted"}, options); err == nil {
		t.Fatal("stale page offset accepted")
	}
	for _, limits := range []postgresx.SQLResourceLimits{
		{MaxInputRows: 2, MaxOperations: query.MaxOperations, MaxWorkingBytes: query.MaxWorkingBytes},
		{MaxInputRows: query.MaxInputRows, MaxOperations: 1, MaxWorkingBytes: query.MaxWorkingBytes},
		{MaxInputRows: query.MaxInputRows, MaxOperations: query.MaxOperations, MaxWorkingBytes: 1},
	} {
		if _, _, err := store.ExecuteSQLPlanWithOptions(t.Context(), defs, []string{"predicted"}, postgresx.SQLExecutionOptions{ResourceLimits: &limits}); err == nil {
			t.Fatalf("resource limit ignored: %#v", limits)
		}
	}
	for _, text := range []string{
		`[{"name":"cycle","from":"cycle"}]`,
		`[{"name":"dup","from":"$runs"},{"name":"dup","from":"$tools"}]`,
	} {
		if _, _, err := store.ExecuteSQLPlan(t.Context(), definitions(t, text), []string{"cycle"}); err == nil {
			t.Fatal("invalid graph accepted")
		}
	}
	ctx, cancel := context.WithCancel(t.Context())
	cancel()
	if _, _, err := store.ExecuteSQLPlan(ctx, nil, []string{"$repositories"}); !errors.Is(err, context.Canceled) {
		t.Fatalf("context cancellation lost: %v", err)
	}
}

func TestStateRecoveryConsistentSnapshotAndSafePaths(t *testing.T) {
	store, path := seedStore(t)
	initial, err := store.State(t.Context())
	if err != nil || initial.Revision != 1 || !initial.Ready || initial.EvaluatedAt.IsZero() {
		t.Fatalf("default state: %#v %v", initial, err)
	}

	expected := postgresx.State{Revision: 7, DataRevision: "fixture", EvaluatedAt: time.Date(2026, 10, 18, 1, 2, 3, 0, time.UTC)}
	if err := store.SetState(t.Context(), expected); err != nil {
		t.Fatal(err)
	}
	if err := store.WithReadTransaction(t.Context(), func(ctx context.Context, reader postgresx.NativeReader) error {
		state, err := reader.State(ctx)
		if err != nil {
			return err
		}
		putRecord(t, ctx, store, "repositories", "later", model.Row{"id": "later"})
		current, _, err := reader.ExecuteSQLPlan(ctx, nil, []string{"$repositories"})
		if err != nil {
			return err
		}
		if state.Revision != 7 || len(current["$repositories"].Rows) != 0 {
			t.Fatal("read transaction mixed database snapshots")
		}
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	reopened, err := New(t.Context(), path)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = reopened.Close() }()
	actual, err := reopened.State(t.Context())
	if err != nil || actual.Revision != expected.Revision || actual.DataRevision != expected.DataRevision || !actual.EvaluatedAt.Equal(expected.EvaluatedAt) {
		t.Fatalf("recovered state: %#v %v", actual, err)
	}
	symlink := filepath.Join(filepath.Dir(path), "linked.sqlite")
	if err := os.Symlink(path, symlink); err != nil {
		t.Fatal(err)
	}
	for _, unsafe := range []string{filepath.Dir(path), symlink, filepath.Join(filepath.Dir(path), "missing.sqlite"), ":memory:", "file:" + path} {
		if db, err := New(t.Context(), unsafe); err == nil {
			_ = db.Close()
			t.Fatalf("unsafe SQLite path accepted: %q", unsafe)
		}
	}
}

func TestLargeResultsAreBoundedBeforePagination(t *testing.T) {
	store, _ := seedStore(t)
	if _, err := store.db.ExecContext(t.Context(), `WITH RECURSIVE numbers(n) AS (
		VALUES(0) UNION ALL SELECT n+1 FROM numbers WHERE n < 100000
	) INSERT INTO __idb_records SELECT ?, 'repositories', json_quote(printf('%06d',n)),
		json_object('id',printf('%06d',n)) FROM numbers`, databaseName); err != nil {
		t.Fatal(err)
	}
	defs := definitions(t, `[{"name":"large","from":"$repositories","select":[{"field":"id"}]}]`)
	result, _, err := store.ExecuteSQLPlanWithOptions(t.Context(), defs, []string{"large"}, postgresx.SQLExecutionOptions{
		Pages: map[string]postgresx.SQLPage{"large": {Offset: 100000, Limit: 10}},
	})
	if err != nil {
		t.Fatal(err)
	}
	equalJSON(t, result["large"].Rows, []model.Row{{"id": "100000"}})
	equalJSON(t, result["large"].Metadata["total-row-count"], 100001)
	if _, _, err := store.ExecuteSQLPlan(t.Context(), defs, []string{"large"}); err == nil {
		t.Fatal("unpaginated oversized response accepted")
	}
}

func TestGraphDepthAndBatchLimits(t *testing.T) {
	store, _ := seedStore(t)
	var defs []query.Definition
	input := "$runs"
	for i := 0; i <= query.MaxDependencyDepth; i++ {
		name := fmt.Sprintf("depth-%d", i)
		defs = append(defs, query.Definition{Name: name, From: input})
		input = name
	}
	if _, _, err := store.ExecuteSQLPlan(t.Context(), defs, []string{input}); err == nil {
		t.Fatal("excessive query dependency depth accepted")
	}
	defs = nil
	var names []string
	for i := 0; i < 90; i++ {
		input := "$runs"
		for level := 0; level < 3; level++ {
			name := fmt.Sprintf("branch-%d-%d", i, level)
			defs = append(defs, query.Definition{Name: name, From: input})
			input = name
		}
		names = append(names, input)
	}
	if _, _, err := store.ExecuteSQLPlan(t.Context(), defs, names); err == nil {
		t.Fatal("excessive dependency plan width accepted")
	}
	if _, _, err := store.ExecuteSQLPlan(t.Context(), nil, make([]string, 101)); err == nil {
		t.Fatal("excessive requested source batch accepted")
	}
}
