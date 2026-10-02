package postgresx

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"reflect"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/stdlib"

	"github.com/githubnext/gh-aw-cao/server/internal/model"
	"github.com/githubnext/gh-aw-cao/server/internal/query"
)

func TestDecodeJSONPreservesNumbers(t *testing.T) {
	var row model.Row
	if err := decodeJSON([]byte(`{"large":9007199254740993,"fraction":1.25,"nested":[2]}`), &row); err != nil {
		t.Fatal(err)
	}
	if row["large"] != json.Number("9007199254740993") || row["fraction"] != json.Number("1.25") {
		t.Fatalf("numbers were rounded or changed: %#v", row)
	}
	if nested := row["nested"].([]any); nested[0] != json.Number("2") {
		t.Fatalf("nested number was changed: %#v", nested)
	}
}

func TestNamespaceRequired(t *testing.T) {
	if _, err := NewWithNamespace(t.Context(), "", ""); err == nil {
		t.Fatal("empty namespace must fail before attempting a connection")
	}
	if _, err := New(t.Context(), "", ""); err == nil {
		t.Fatal("empty explicit namespace must fail before attempting a connection")
	}
	if _, err := New(t.Context(), "", "one", "two"); err == nil {
		t.Fatal("multiple namespaces must fail before attempting a connection")
	}
}

func TestConnectionTransport(t *testing.T) {
	for _, tc := range []struct {
		name, dsn string
		allowed   bool
	}{
		{"remote default prefer", "postgres://db.example.com/data", false},
		{"remote prefer fallback", "postgres://db.example.com/data?sslmode=prefer", false},
		{"remote allow fallback", "postgres://db.example.com/data?sslmode=allow", false},
		{"remote disable", "postgres://db.example.com/data?sslmode=disable", false},
		{"remote require", "postgres://db.example.com/data?sslmode=require", true},
		{"remote verify full", "postgres://db.example.com/data?sslmode=verify-full", true},
		{"keyword remote disable", "host=db.example.com user=user sslmode=disable", false},
		{"keyword remote require", "host=db.example.com user=user sslmode=require", true},
		{"loopback ipv4", "postgres://127.0.0.1:5432/data?sslmode=disable", true},
		{"loopback ipv6", "postgres://[::1]:5432/data?sslmode=disable", true},
		{"localhost", "postgres://localhost:5432/data?sslmode=disable", true},
		{"remote fallback from loopback", "host=127.0.0.1,db.example.com sslmode=disable", false},
		{"unix socket", "host=/run/postgresql sslmode=disable", true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			config, err := pgx.ParseConfig(tc.dsn)
			if err != nil {
				t.Fatal(err)
			}
			if err := validateTransport(config); (err == nil) != tc.allowed {
				t.Fatalf("allowed=%t, transport validation error: %v", tc.allowed, err)
			}
		})
	}
}

func TestRejectsInsecureDSNWithoutLeakingCredentials(t *testing.T) {
	secret := "visible-in-error"
	dsn := "postgres://user:" + secret + "@db.example.com/data?sslmode=prefer"
	_, err := New(t.Context(), dsn)
	if err == nil || strings.Contains(err.Error(), secret) || strings.Contains(err.Error(), dsn) {
		t.Fatalf("insecure DSN not safely rejected: %v", err)
	}
	_, err = New(t.Context(), "postgres://user:"+secret+"@[invalid")
	if err == nil || strings.Contains(err.Error(), secret) {
		t.Fatalf("malformed DSN not safely rejected: %v", err)
	}
}

func TestStoreIntegration(t *testing.T) {
	url := os.Getenv("POSTGRES_URL")
	if url == "" {
		t.Skip("POSTGRES_URL is unset")
	}
	ctx, cancel := context.WithTimeout(t.Context(), 30*time.Second)
	defer cancel()
	config, err := pgx.ParseConfig(url)
	if err != nil {
		t.Fatal(err)
	}
	if err := validateTransport(config); err != nil {
		t.Fatal(err)
	}
	admin := stdlib.OpenDB(*config.Copy())
	defer func() { _ = admin.Close() }()
	schema := fmt.Sprintf("cao_postgresx_test_%d", time.Now().UnixNano())
	if _, err := admin.ExecContext(ctx, "CREATE SCHEMA "+schema); err != nil {
		t.Fatal(err)
	}
	defer func() { _, _ = admin.ExecContext(context.Background(), "DROP SCHEMA "+schema+" CASCADE") }()
	config.RuntimeParams["search_path"] = schema
	store, err := NewConfig(ctx, config)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = store.Close() }()

	initial, err := store.State(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if initial.Ready || initial.Revision != 0 || len(initial.Counts) != 0 {
		t.Fatalf("fresh store state: %+v", initial)
	}
	if _, _, err := store.LoadSource(ctx, "missing", nil); !errors.Is(err, ErrSourceUnavailable) {
		t.Fatalf("missing source error: %v", err)
	}
	evaluatedAt := time.Now().UTC().Truncate(time.Microsecond)
	var deep any = json.Number("12345678901234567890.12345678901234567890")
	for i := 0; i < 64; i++ {
		deep = map[string]any{"level": []any{deep}}
	}
	bulkRows := make([]model.Row, 1100)
	bulkRows[0] = model.Row{}
	for i := 1; i < len(bulkRows); i++ {
		number := json.Number(strconv.Itoa(i))
		bulkRows[i] = model.Row{"id": number, "nested": []any{map[string]any{"values": []any{number, nil}}}}
	}
	sources := map[string]model.Source{
		"$runs": {
			Source: "$runs",
			Rows: []model.Row{
				{"id": "raw-1", "runId": nil, "status": "completed", "enabled": true,
					"targetRepositoryId": "repository:target",
					"organizationLink":   map[string]any{"href": "https://github.com/githubnext"},
					"githubId":           json.Number("9007199254740993"),
					"githubRunId":        "00123", "attempt": json.Number("9007199254740993"),
					"provenance": map[string]any{
						"source": "gh-aw-logs", "sourceId": "run-1",
						"observedAt":     "2026-01-02T03:04:05.123456789-07:00",
						"sourceRevision": "v1",
					},
					"tokenUsage": map[string]any{"by_model": map[string]any{
						"gpt-test": map[string]any{"reasoning_tokens": json.Number("23")}}},
					"sequence": nil, "createdAt": "2026-01-02T03:04:05.123456789-07:00", "nested": map[string]any{
						"large":       json.Number("9007199254740993"),
						"array":       []any{map[string]any{"deep": []any{json.Number("1.2345678901234567890123456789"), nil, true}}, []any{}, map[string]any{}},
						"unusual/key": json.Number("1e1000000"),
					}},
			},
			Metadata: model.Metadata{
				"kind": "canonical", "source-id": "$runs", "source-revision": "revision-1",
				"availability": "available", "source-kind": "derived", "row-count": 1,
			},
		},
		"$jobs": {
			Source:   "$jobs",
			Metadata: model.Metadata{"source-kind": nil},
			Rows: []model.Row{
				{}, {}, {"id": json.Number("1e1000000")}, {},
				{"id": "42"}, {},
			},
		},
		"$events": {Source: "$events", Metadata: model.Metadata{"row-count": nil, "availability": nil}},
		"repositories": {
			Source: "repositories",
			Rows: []model.Row{
				{"id": "a", "count": json.Number("9007199254740993")},
				{"id": "b", "count": json.Number("2")},
			},
			Metadata: model.Metadata{"origin": "inventory", "version": json.Number("3"), "nested": []any{map[string]any{"": []any{false, nil, "value"}}}},
		},
		"empty": {Source: "empty", Rows: []model.Row{}, Metadata: model.Metadata{"origin": "inventory"}},
		"deep":  {Source: "deep", Rows: []model.Row{{"nested": deep}}, Metadata: model.Metadata{"nested": deep}},
		"bulk":  {Source: "bulk", Rows: bulkRows},
		"documents": {Source: "documents", Rows: []model.Row{
			{"id": "doc-1", "content": "document contents"},
		}},
	}
	diagnostics := model.Diagnostics{SchemaVersion: model.SchemaVersion, Counts: map[string]int{"repositories": 2}, RelationshipErrors: []string{"test diagnostic"}, DuplicateRecordIDs: map[string][]string{"present-empty": {}, "duplicates": {"a", "b"}}}
	revision, err := store.Replace(ctx, sources, diagnostics, "test-revision", evaluatedAt)
	if err != nil {
		t.Fatal(err)
	}
	err = store.WithReadTransaction(ctx, func(ctx context.Context, reader SourceReader) error {
		definitions := []query.Definition{{
			Name: "by-status", From: "$runs",
			Filter: &query.Filter{Predicates: []query.Predicate{{Field: "status", Equals: "completed"}}},
		}}
		result, _, supported, planErr := reader.(NativePlanExecutor).ExecuteNativePlan(ctx, definitions,
			[]string{"by-status"}, []string{"by-status"})
		if planErr != nil || !supported || !reflect.DeepEqual(result["by-status"].Rows, sources["$runs"].Rows) {
			t.Errorf("typed status predicate: %+v supported=%t err=%v", result, supported, planErr)
		}
		target := []query.Definition{{
			Name: "by-target", From: "$runs",
			Filter: &query.Filter{Predicates: []query.Predicate{
				{Field: "targetRepositoryId", Equals: "repository:target"},
			}},
		}}
		result, _, supported, planErr = reader.(NativePlanExecutor).ExecuteNativePlan(ctx, target,
			[]string{"by-target"}, []string{"by-target"})
		if planErr != nil || !supported || !reflect.DeepEqual(result["by-target"].Rows, sources["$runs"].Rows) {
			t.Errorf("native target relationship predicate: %+v supported=%t err=%v", result, supported, planErr)
		}
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
	if revision != initial.Revision+1 {
		t.Fatalf("revision = %d, want %d", revision, initial.Revision+1)
	}
	state, err := store.State(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if !state.Ready || state.Revision != revision || state.DataRevision != "test-revision" ||
		!state.EvaluatedAt.Equal(evaluatedAt) ||
		!reflect.DeepEqual(state.Counts, map[string]int{"$runs": 1, "$jobs": 6, "$events": 0, "repositories": 2, "empty": 0, "deep": 1, "bulk": 1100, "documents": 1}) {
		t.Fatalf("unexpected state: %+v", state)
	}
	tenant, err := NewConfig(ctx, config, "other-tenant")
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = tenant.Close() }()
	tenantState, err := tenant.State(ctx)
	if err != nil || tenantState.Ready {
		t.Fatalf("other namespace should be unready: %+v, %v", tenantState, err)
	}
	if _, _, err := tenant.LoadSource(ctx, "$runs", nil); !errors.Is(err, ErrSourceUnavailable) {
		t.Fatalf("other namespace leaked raw source: %v", err)
	}
	if _, err := tenant.LoadDocument(ctx, "documents", "doc-1"); !errors.Is(err, ErrSourceUnavailable) {
		t.Fatalf("other namespace leaked source document: %v", err)
	}
	if _, err := tenant.Replace(ctx, map[string]model.Source{"$runs": {
		Source: "$runs", Rows: []model.Row{{"id": "other"}}, Metadata: model.Metadata{},
	}}, model.Diagnostics{}, "other", evaluatedAt); err != nil {
		t.Fatal(err)
	}
	if other, _, err := tenant.LoadSource(ctx, "$runs", nil); err != nil || other.Rows[0]["id"] != "other" {
		t.Fatalf("other namespace read: %+v, %v", other, err)
	}
	nativeDefinition := []query.Definition{{Name: "raw", From: "$runs"}}
	err = tenant.WithReadTransaction(ctx, func(ctx context.Context, reader SourceReader) error {
		result, _, supported, err := reader.(NativePlanExecutor).ExecuteNativePlan(ctx, nativeDefinition, []string{"raw"}, []string{"raw"})
		if err != nil || !supported || result["raw"].Rows[0]["id"] != "other" {
			t.Errorf("native plan crossed namespaces: %+v supported=%t err=%v", result, supported, err)
		}
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
	raw, _, err := store.LoadSource(ctx, "$runs", nil)
	if err != nil || !reflect.DeepEqual(raw.Rows, sources["$runs"].Rows) {
		t.Fatalf("raw canonical source: %+v, %v", raw, err)
	}
	jobs, _, err := store.LoadSource(ctx, "$jobs", nil)
	if err != nil || !reflect.DeepEqual(jobs.Rows, sources["$jobs"].Rows) ||
		!reflect.DeepEqual(jobs.Metadata, sources["$jobs"].Metadata) {
		t.Fatalf("sparse canonical source with numeric IDs: %+v, %v", jobs, err)
	}
	events, _, err := store.LoadSource(ctx, "$events", nil)
	if err != nil || !reflect.DeepEqual(events.Metadata, sources["$events"].Metadata) {
		t.Fatalf("null canonical metadata: %+v, %v", events, err)
	}
	var numericID, idKind string
	if err := store.db.QueryRowContext(ctx, `SELECT id, id_kind FROM cao_canonical_rows
		WHERE namespace = $1 AND source_name = '$jobs' AND ordinal = 2`, "default").
		Scan(&numericID, &idKind); err != nil || numericID != "1e1000000" || idKind != "number" {
		t.Fatalf("numeric ID native storage: id=%q kind=%q err=%v", numericID, idKind, err)
	}
	err = store.WithReadTransaction(ctx, func(ctx context.Context, reader SourceReader) error {
		defs := []query.Definition{{
			Name: "selected-run", From: "$runs",
			Filter: &query.Filter{Predicates: []query.Predicate{{Field: "id", Equals: "raw-1"}}},
			Select: []query.SelectedField{
				{Field: "runId"}, {Field: "createdAt"}, {Field: "attempt"},
				{Field: "sequence"}, {Field: "enabled"}, {Field: "githubId"},
				{Field: "githubRunId"}, {Field: "organizationLink"},
				{Field: "provenance"}, {Field: "nested"}, {Field: "missingValue"},
			},
		}}
		result, _, supported, planErr := reader.(NativePlanExecutor).ExecuteNativePlan(ctx, defs,
			[]string{"selected-run"}, []string{"selected-run"})
		want := model.Row{
			"runId": nil, "createdAt": sources["$runs"].Rows[0]["createdAt"],
			"attempt": json.Number("9007199254740993"), "sequence": nil, "enabled": true,
			"githubId": json.Number("9007199254740993"), "githubRunId": "00123",
			"organizationLink": map[string]any{"href": "https://github.com/githubnext"},
			"provenance":       sources["$runs"].Rows[0]["provenance"],
			"nested":           sources["$runs"].Rows[0]["nested"],
		}
		if planErr != nil || !supported || !reflect.DeepEqual(result["selected-run"].Rows, []model.Row{want}) {
			t.Errorf("native typed selection: result=%+v supported=%t err=%v", result, supported, planErr)
		}
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
	deepSource, _, err := store.LoadSource(ctx, "deep", nil)
	if err != nil || !reflect.DeepEqual(deepSource.Rows, sources["deep"].Rows) ||
		!reflect.DeepEqual(deepSource.Metadata, sources["deep"].Metadata) {
		t.Fatalf("deeply nested source: %+v, %v", deepSource, err)
	}
	document, err := store.LoadDocument(ctx, "documents", "doc-1")
	if err != nil || document["content"] != "document contents" {
		t.Fatalf("source document: %+v, %v", document, err)
	}
	if _, err := store.LoadDocument(ctx, "documents", "missing"); !errors.Is(err, ErrSourceUnavailable) {
		t.Fatalf("missing source document error: %v", err)
	}
	bulk, bulkMetrics, err := store.LoadSource(ctx, "bulk", nil)
	if err != nil || bulkMetrics.OutputRows != len(bulkRows) || bulk.Metadata != nil ||
		!reflect.DeepEqual(bulk.Rows, bulkRows) {
		t.Fatalf("batched rows or nil metadata were not preserved: rows=%d metrics=%+v metadata=%#v err=%v",
			len(bulk.Rows), bulkMetrics, bulk.Metadata, err)
	}
	assertNativeSchema(t, ctx, store.db)
	var documents int
	if err := store.db.QueryRowContext(ctx, `SELECT count(*) FROM cao_source_documents
		WHERE namespace = $1 AND source_name = $2`, "default", "$runs").Scan(&documents); err != nil || documents != 0 {
		t.Fatalf("canonical source retained metadata or row documents: count=%d err=%v", documents, err)
	}
	var metadataExtension, sourceID, sourceRevision, availability, sourceKind string
	var metadataPresent []string
	if err := store.db.QueryRowContext(ctx, `SELECT metadata_extension::text,
		metadata_present, metadata_source_id, metadata_source_revision, metadata_availability,
		metadata_source_kind
		FROM cao_sources WHERE namespace = $1 AND source_name = '$runs'`, "default").
		Scan(&metadataExtension, &metadataPresent, &sourceID, &sourceRevision, &availability, &sourceKind); err != nil ||
		metadataExtension != `{"kind":"canonical"}` ||
		!reflect.DeepEqual(metadataPresent, []string{"availability", "row-count", "source-id", "source-kind", "source-revision"}) ||
		sourceID != "$runs" || sourceRevision != "revision-1" || availability != "available" || sourceKind != "derived" {
		t.Fatalf("native canonical metadata: extension=%s present=%v source=%s revision=%s availability=%s err=%v",
			metadataExtension, metadataPresent, sourceID, sourceRevision, availability, err)
	}
	var canonicalRows int
	if err := store.db.QueryRowContext(ctx, `SELECT count(*) FROM cao_canonical_rows
		WHERE namespace = $1 AND source_name = $2 AND id = 'raw-1' AND extension::text LIKE '%1e1000000%'`,
		"default", "$runs").Scan(&canonicalRows); err != nil || canonicalRows != 1 {
		t.Fatalf("missing native canonical row or lossless extension: count=%d err=%v", canonicalRows, err)
	}
	var targetNative bool
	if err := store.db.QueryRowContext(ctx, `SELECT target_repository_id = $1
		AND NOT EXISTS (SELECT 1 FROM json_object_keys(extension) AS key WHERE key = 'targetRepositoryId')
		FROM cao_canonical_rows WHERE namespace = $2 AND source_name = '$runs' AND ordinal = 0`,
		"repository:target", "default").Scan(&targetNative); err != nil || !targetNative {
		t.Fatalf("target repository was not stored exclusively in a native column: %t, %v", targetNative, err)
	}
	if _, err := store.db.ExecContext(ctx, `INSERT INTO cao_canonical_rows
		(namespace, source_name, ordinal, present, extension, github_id, github_id_kind)
		VALUES ($1, '$runs', 9999, ARRAY['githubId'], '{}'::json, '42', 'invalid')`, "default"); err == nil {
		t.Fatal("invalid mixed identifier kind was accepted")
	}
	var nativeIndexes int
	if err := store.db.QueryRowContext(ctx, `SELECT count(*) FROM pg_indexes
		WHERE schemaname = current_schema() AND tablename = 'cao_canonical_rows'
		AND indexname IN (
			'cao_canonical_rows_repository_id', 'cao_canonical_rows_workflow_id',
			'cao_canonical_rows_created_at', 'cao_canonical_rows_started_at',
			'cao_canonical_rows_timestamp_at', 'cao_canonical_rows_observed_at')`).Scan(&nativeIndexes); err != nil || nativeIndexes != 6 {
		t.Fatalf("missing native relationship/time indexes: count=%d err=%v", nativeIndexes, err)
	}
	assertNativeSchema(t, ctx, store.db)
	var href, extension string
	if err := store.db.QueryRowContext(ctx, `SELECT organization_href, extension::text
		FROM cao_canonical_rows WHERE namespace = $1 AND source_name = '$runs' AND ordinal = 0`,
		"default").Scan(&href, &extension); err != nil ||
		href != "https://github.com/githubnext" ||
		strings.Contains(extension, "organizationLink") || strings.Contains(extension, "tokenUsage") ||
		strings.Contains(extension, "provenance") {
		t.Fatalf("known link/token usage not native-only: href=%q extension=%q err=%v", href, extension, err)
	}
	var provenanceSource, provenanceID, provenanceRaw, provenanceRevision string
	var provenancePresent []string
	if err := store.db.QueryRowContext(ctx, `SELECT provenance_source, provenance_source_id,
		provenance_observed_at_raw, provenance_source_revision, provenance_present
		FROM cao_canonical_rows WHERE namespace = 'default' AND source_name = '$runs' AND ordinal = 0`).
		Scan(&provenanceSource, &provenanceID, &provenanceRaw, &provenanceRevision, &provenancePresent); err != nil ||
		provenanceSource != "gh-aw-logs" || provenanceID != "run-1" ||
		provenanceRaw != "2026-01-02T03:04:05.123456789-07:00" || provenanceRevision != "v1" ||
		!reflect.DeepEqual(provenancePresent, []string{"observedAt", "source", "sourceId", "sourceRevision"}) {
		t.Fatalf("native provenance: %q %q %q %q %v err=%v",
			provenanceSource, provenanceID, provenanceRaw, provenanceRevision, provenancePresent, err)
	}
	var attemptRaw, githubIDRaw sql.NullString
	var nativeAttempt, nativeGithubID string
	if err := store.db.QueryRowContext(ctx, `SELECT attempt_raw, github_id,
		attempt::text, github_id_numeric::text FROM cao_canonical_rows
		WHERE namespace = $1 AND source_name = '$runs' AND ordinal = 0`,
		"default").Scan(&attemptRaw, &githubIDRaw, &nativeAttempt, &nativeGithubID); err != nil ||
		attemptRaw.Valid || githubIDRaw.Valid ||
		nativeAttempt != "9007199254740993" || nativeGithubID != "9007199254740993" {
		t.Fatalf("ordinary numbers copied into text: attempt=%q githubId=%q raw=%v/%v err=%v",
			nativeAttempt, nativeGithubID, attemptRaw, githubIDRaw, err)
	}
	var textFallback bool
	if err := store.db.QueryRowContext(ctx, `SELECT EXISTS (SELECT 1 FROM cao_canonical_rows
		WHERE namespace = $1 AND extension::text LIKE '%1e1000000%')`,
		"default").Scan(&textFallback); err != nil || !textFallback {
		t.Fatalf("out-of-range extension number lost its lexeme: %v, %v", textFallback, err)
	}
	loaded, metrics, err := store.LoadSource(ctx, "repositories", &query.Definition{From: "repositories", Limit: intPtr(1)})
	if err != nil {
		t.Fatal(err)
	}

	if metrics.OutputRows != 2 || !reflect.DeepEqual(loaded.Rows, sources["repositories"].Rows) ||
		!reflect.DeepEqual(loaded.Metadata, sources["repositories"].Metadata) {
		t.Fatalf("unexpected source or metrics: %+v %+v", loaded, metrics)
	}
	definitions := []query.Definition{{
		Name: "selected", From: "repositories",
		Filter: &query.Filter{Predicates: []query.Predicate{{Field: "id", Equals: "b"}}},
	}}
	results, _, err := query.New(sourceLoader{store: store, ctx: ctx}).Execute(definitions, []string{"selected"})
	if err != nil || len(results["selected"].Rows) != 1 || results["selected"].Rows[0]["id"] != "b" {
		t.Fatalf("Go query result: %+v, %v", results, err)
	}
	rawResults, _, err := query.New(sourceLoader{store: store, ctx: ctx}).Execute(
		[]query.Definition{{Name: "raw", From: "$runs"}}, []string{"raw"})
	if err != nil || !reflect.DeepEqual(rawResults["raw"].Rows, raw.Rows) {
		t.Fatalf("raw query result: %+v, %v", rawResults, err)
	}
	err = store.WithReadTransaction(ctx, func(ctx context.Context, reader SourceReader) error {
		before, err := reader.State(ctx)
		if err != nil {
			return err
		}
		if _, err := store.Replace(ctx, map[string]model.Source{"$runs": {
			Source: "$runs", Rows: []model.Row{{"id": "new"}}, Metadata: model.Metadata{},
		}}, model.Diagnostics{}, "new", evaluatedAt); err != nil {
			return err
		}
		stillOld, _, err := query.New(readerLoader{reader: reader, ctx: ctx}).Execute(
			[]query.Definition{{Name: "raw", From: "$runs"}}, []string{"raw"})
		if err != nil {
			return err
		}
		again, err := reader.State(ctx)
		if err != nil {
			return err
		}
		if before.Revision != again.Revision || !reflect.DeepEqual(stillOld["raw"].Rows, raw.Rows) {
			t.Fatalf("query read mixed revisions: before=%+v after=%+v rows=%+v", before, again, stillOld)
		}
		native, _, supported, err := reader.(NativePlanExecutor).ExecuteNativePlan(ctx, nativeDefinition, []string{"raw"}, []string{"raw"})
		if err != nil || !supported || !reflect.DeepEqual(native["raw"].Rows, raw.Rows) {
			t.Fatalf("native plan read mixed revisions: %+v supported=%t err=%v", native, supported, err)
		}
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
	if latest, err := store.State(ctx); err != nil || latest.Revision != revision+1 {
		t.Fatalf("replacement did not commit independently: %+v, %v", latest, err)
	}
	// Restore the original data so the remaining rollback and replacement
	// assertions operate against their initial sources.
	revision, err = store.Replace(ctx, sources, diagnostics, "test-revision", evaluatedAt)
	if err != nil {
		t.Fatal(err)
	}
	state, err = store.State(ctx)
	if err != nil || state.Revision != revision {
		t.Fatalf("restored state: %+v, %v", state, err)
	}
	empty, _, err := store.LoadSource(ctx, "empty", nil)
	if err != nil || len(empty.Rows) != 0 {
		t.Fatalf("empty source: %+v, %v", empty, err)
	}
	gotDiagnostics, err := store.Diagnostics(ctx)
	if err != nil || !reflect.DeepEqual(gotDiagnostics, diagnostics) {
		t.Fatalf("diagnostics: %+v, %v", gotDiagnostics, err)
	}

	_, err = store.Replace(ctx, map[string]model.Source{
		"bad": {Source: "bad", Rows: []model.Row{{"invalid": make(chan int)}}},
	}, diagnostics, "bad", evaluatedAt)
	if err == nil {
		t.Fatal("expected failed replacement")
	}
	afterFailure, err := store.State(ctx)
	if err != nil || !reflect.DeepEqual(afterFailure, state) {
		t.Fatalf("failed replacement changed state: %+v, %v", afterFailure, err)
	}
	if _, _, err := store.LoadSource(ctx, "repositories", nil); err != nil {
		t.Fatalf("failed replacement lost source: %v", err)
	}
	var stillDocuments int
	if err := store.db.QueryRowContext(ctx, `SELECT count(*) FROM cao_source_documents
		WHERE namespace = $1 AND source_name = $2`, "default", "repositories").Scan(&stillDocuments); err != nil || stillDocuments != 3 {
		t.Fatalf("failed replacement changed indexed documents: count=%d err=%v", stillDocuments, err)
	}
	revision, err = store.Replace(ctx, map[string]model.Source{"empty": sources["empty"]}, diagnostics, "next", evaluatedAt)
	if err != nil || revision != state.Revision+1 {
		t.Fatalf("second replacement: %d, %v", revision, err)
	}
	if _, _, err := store.LoadSource(ctx, "repositories", nil); !errors.Is(err, ErrSourceUnavailable) {
		t.Fatalf("removed source error: %v", err)
	}
	if _, err := store.db.ExecContext(ctx, `DELETE FROM cao_source_documents WHERE namespace = $1 AND source_name = $2`,
		"default", "empty"); err != nil {
		t.Fatal(err)
	}
	err = store.WithReadTransaction(ctx, func(ctx context.Context, reader SourceReader) error {
		_, _, supported, err := reader.(NativePlanExecutor).ExecuteNativePlan(ctx,
			[]query.Definition{{Name: "empty-query", From: "empty"}}, []string{"empty-query"}, []string{"empty-query"})
		if err == nil || !supported || !strings.Contains(err.Error(), "incomplete postgres source metadata") {
			t.Errorf("missing schemaless metadata must fail closed: supported=%t err=%v", supported, err)
		}
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
	if _, _, err := store.LoadSource(ctx, "empty", nil); err == nil {
		t.Fatal("document-only source with deleted metadata must fail closed")
	}
	// Unsupported known fields fail the whole transaction without hiding
	// their source in a generic EAV/document fallback.
	beforeInvalid, err := store.State(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if _, err = store.Replace(ctx, map[string]model.Source{"$jobs": {
		Source: "$jobs", Rows: []model.Row{{"id": "bad", "createdAt": "invalid"}},
	}}, diagnostics, "invalid", evaluatedAt); err == nil {
		t.Fatal("unsupported known timestamp was silently stored")
	}
	if _, err = store.Replace(ctx, map[string]model.Source{"$runs": {
		Source: "$runs", Rows: []model.Row{{"id": "bad"}},
		Metadata: model.Metadata{"row-count": 2},
	}}, diagnostics, "invalid-metadata", evaluatedAt); err == nil {
		t.Fatal("inconsistent native row-count was silently stored")
	}
	afterInvalid, err := store.State(ctx)
	if err != nil || !reflect.DeepEqual(beforeInvalid, afterInvalid) {
		t.Fatalf("invalid replacement changed committed state: before=%+v after=%+v err=%v", beforeInvalid, afterInvalid, err)
	}
	_, err = store.Replace(ctx, map[string]model.Source{"$events": {
		Source: "$events", Rows: []model.Row{}, Metadata: model.Metadata{"source-id": "$events"},
	}}, diagnostics, "empty-canonical", evaluatedAt)
	if err != nil {
		t.Fatal(err)
	}
	emptyCanonical, _, err := store.LoadSource(ctx, "$events", nil)
	if err != nil || emptyCanonical.Rows == nil || len(emptyCanonical.Rows) != 0 {
		t.Fatalf("typed empty collection became null: %+v err=%v", emptyCanonical, err)
	}
	serialized, err := json.Marshal(emptyCanonical)
	if err != nil || !strings.Contains(string(serialized), `"rows":[]`) {
		t.Fatalf("typed empty rows JSON: %s err=%v", serialized, err)
	}
	linkOnly := model.Row{
		"id": "session-without-booleans", "githubId": json.Number("9007199254740993"),
		"organizationLink": map[string]any{"href": "https://github.com/githubnext"},
	}
	_, err = store.Replace(ctx, map[string]model.Source{"$sessions": {
		Source: "$sessions", Rows: []model.Row{linkOnly}, Metadata: model.Metadata{},
	}}, diagnostics, "identifier-link-without-boolean", evaluatedAt)
	if err != nil {
		t.Fatal(err)
	}
	decoded, _, err := store.LoadSource(ctx, "$sessions", nil)
	if err != nil || !reflect.DeepEqual(decoded.Rows, []model.Row{linkOnly}) {
		t.Fatalf("typed row lost identifier or link without booleans: %+v err=%v", decoded, err)
	}
	err = store.WithReadTransaction(ctx, func(ctx context.Context, reader SourceReader) error {
		defs := []query.Definition{{Name: "all-sessions", From: "$sessions"}}
		result, _, supported, planErr := reader.(NativePlanExecutor).ExecuteNativePlan(ctx, defs,
			[]string{"all-sessions"}, []string{"all-sessions"})
		if planErr != nil || !supported || !reflect.DeepEqual(result["all-sessions"].Rows, []model.Row{linkOnly}) {
			t.Errorf("native plan lost identifier or link without booleans: %+v supported=%t err=%v",
				result, supported, planErr)
		}
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
}

func intPtr(n int) *int { return &n }

func TestCanonicalProducerDifferentialIntegration(t *testing.T) {
	url := os.Getenv("POSTGRES_URL")
	if url == "" {
		t.Skip("POSTGRES_URL is unset")
	}
	ctx, cancel := context.WithTimeout(t.Context(), 30*time.Second)
	defer cancel()
	config, err := pgx.ParseConfig(url)
	if err != nil {
		t.Fatal(err)
	}
	admin := stdlib.OpenDB(*config.Copy())
	defer func() { _ = admin.Close() }()
	schema := fmt.Sprintf("cao_postgresx_producers_%d", time.Now().UnixNano())
	if _, err := admin.ExecContext(ctx, "CREATE SCHEMA "+schema); err != nil {
		t.Fatal(err)
	}
	defer func() { _, _ = admin.ExecContext(context.Background(), "DROP SCHEMA "+schema+" CASCADE") }()
	config.RuntimeParams["search_path"] = schema
	store, err := NewConfig(ctx, config)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = store.Close() }()
	input := []model.Row{
		{"id": "observation:1", "runId": "run:1", "graderId": "grader:1",
			"experimentId": "experiment:1", "auditId": "audit:1", "value": json.Number("1e3"),
			"threshold": nil, "included": false, "firstObservedAt": "2026-10-01T12:00:00Z",
			"runLink":            "https://github.com/org/repo/actions/runs/1",
			"metrics":            []any{map[string]any{"value": json.Number("1e3")}},
			"provenance":         map[string]any{"source": "gh-aw"},
			"attributableRunIds": []any{"run:1", "run:2"}},
		{"id": "observation:2", "runId": "run:2", "graderId": "grader:2",
			"runLink": map[string]any{"href": "https://github.com/org/repo/actions/runs/2",
				"relation": nil, "label": ""},
			"attributableRunIds": []any{}, "included": nil, "value": json.Number("0.000100")},
	}
	sources := map[string]model.Source{
		"$workflows": {
			Source: "$workflows", Rows: []model.Row{
				{"id": "workflow:1", "campaignReadmePath": "docs/campaign.md"},
				{"id": "workflow:2", "campaignReadmePath": ""},
				{"id": "workflow:3", "campaignReadmePath": nil},
				{"id": "workflow:4"},
			},
		},
		"$graderObservations": {
			Source: "$graderObservations", Rows: input, Metadata: model.Metadata{"source-id": "$graderObservations"},
		},
		"$campaigns": {
			Source: "$campaigns", Rows: []model.Row{{
				"id": "campaign:1", "maxRepositories": json.Number("12"),
				"inventoryWarnings": json.Number("0"), "experimental": false,
				"workers": []any{map[string]any{"id": "worker", "workflow": "worker.md",
					"enabled": false, "max-mode": nil}},
				"targets": []any{map[string]any{"repository": "org/repo"}},
				"campaignLink": map[string]any{"href": "https://github.com/org/repo",
					"relation": "campaign", "label": "Campaign"},
			}},
		},
		"$marketplacePackages": {
			Source: "$marketplacePackages", Rows: []model.Row{{
				"id": "marketplace:1", "registryId": "primary", "registryPrecedence": json.Number("0"),
				"contents": []any{"worker.md"}, "stars": json.Number("42"),
			}, {
				"id": "marketplace:2", "contents": []any{"workflows/main.md", "", "docs/readme.md", "workflows/main.md"},
			}, {
				"id": "marketplace:3", "contents": []any{},
			}, {
				"id": "marketplace:4", "contents": nil,
			}, {
				"id": "marketplace:5",
			}},
		},
		"$audits": {
			Source: "$audits", Rows: []model.Row{{
				"id": "audit:1", "value": "inconclusive",
				"answer":     map[string]any{"result": "UNKNOWN"},
				"evalResult": []any{"YES", "NO"},
				"costGrain":  map[string]any{"unit": "invocation", "count": json.Number("2")},
			}, {
				"id": "audit:2", "value": json.Number("2.50"),
				"answer": "YES", "evalResult": "pass", "costGrain": "run",
			}},
		},
	}
	fixture, err := os.ReadFile("../../testdata/deployed-subset/gh-aw-logs-runs/subset.jsonl")
	if err != nil {
		t.Fatal(err)
	}
	var deployed struct {
		Collection string    `json:"collection"`
		Record     model.Row `json:"record"`
	}
	if err := decodeJSON([]byte(strings.Split(string(fixture), "\n")[1]), &deployed); err != nil ||
		deployed.Collection != "campaigns" {
		t.Fatalf("deployed canonical fixture: collection=%q err=%v", deployed.Collection, err)
	}
	campaigns := sources["$campaigns"]
	campaigns.Rows = append(campaigns.Rows, deployed.Record)
	sources["$campaigns"] = campaigns
	if _, err := store.Replace(ctx, sources, model.Diagnostics{}, "producer", time.Now().UTC()); err != nil {
		t.Fatal(err)
	}
	var stored int
	if err := store.db.QueryRowContext(ctx, `SELECT count(*) FROM cao_canonical_rows
		WHERE namespace = 'default' AND source_name = '$graderObservations'
		AND extension IS NULL AND run_href IS NOT NULL AND grader_id IS NOT NULL
		AND attributable_run_ids IS NOT NULL`).Scan(&stored); err != nil || stored != 2 {
		t.Fatalf("producer fields not native: count=%d err=%v", stored, err)
	}
	var nativeLink bool
	if err := store.db.QueryRowContext(ctx, `SELECT run_href_relation IS NULL
		AND 'relation' = ANY(run_href_present) AND run_href_label = ''
		AND 'label' = ANY(run_href_present) AND run_href_kind = 'object'
		FROM cao_canonical_rows WHERE source_name = '$graderObservations' AND ordinal = 1`).
		Scan(&nativeLink); err != nil || !nativeLink {
		t.Fatalf("known link properties were not stored natively: %t, %v", nativeLink, err)
	}
	if err := store.db.QueryRowContext(ctx, `SELECT count(*) FROM cao_canonical_rows
		WHERE namespace = 'default' AND source_name = '$campaigns'
		AND id = 'campaign:dashboard' AND extension IS NULL`).Scan(&stored); err != nil || stored != 1 {
		t.Fatalf("fully known deployed fixture retained JSON extension: count=%d err=%v", stored, err)
	}
	if err := store.db.QueryRowContext(ctx, `SELECT count(*) FROM cao_canonical_rows
		WHERE namespace = 'default' AND source_name = '$workflows'
		AND extension IS NULL AND (
			(ordinal = 0 AND campaign_readme_path = 'docs/campaign.md') OR
			(ordinal = 1 AND campaign_readme_path = '') OR
			(ordinal = 2 AND campaign_readme_path IS NULL AND 'campaignReadmePath' = ANY(present)) OR
			(ordinal = 3 AND campaign_readme_path IS NULL AND NOT 'campaignReadmePath' = ANY(present)))`).
		Scan(&stored); err != nil || stored != 4 {
		t.Fatalf("workflow README path not native-only: count=%d err=%v", stored, err)
	}
	if err := store.db.QueryRowContext(ctx, `SELECT count(*) FROM cao_canonical_rows
		WHERE source_name = '$marketplacePackages' AND (
			(ordinal = 0 AND contents = ARRAY['worker.md']::text[]) OR
			(ordinal = 1 AND contents = ARRAY['workflows/main.md','','docs/readme.md','workflows/main.md']::text[]) OR
			(ordinal = 2 AND contents = ARRAY[]::text[]) OR
			(ordinal = 3 AND contents IS NULL AND 'contents' = ANY(present)) OR
			(ordinal = 4 AND contents IS NULL AND NOT 'contents' = ANY(present)))`).
		Scan(&stored); err != nil || stored != 5 {
		t.Fatalf("known package paths not native-only: count=%d err=%v", stored, err)
	}
	var jsonCompatibility bool
	if err := store.db.QueryRowContext(ctx, `SELECT EXISTS(SELECT 1 FROM information_schema.columns
		WHERE table_schema = current_schema() AND table_name = 'cao_canonical_rows'
		AND column_name = 'contents_exception')`).Scan(&jsonCompatibility); err != nil || jsonCompatibility {
		t.Fatalf("package paths retained JSON compatibility storage: present=%t err=%v", jsonCompatibility, err)
	}
	for _, statement := range []string{
		`UPDATE cao_canonical_rows SET contents = ARRAY[NULL]::text[]
			WHERE source_name = '$marketplacePackages' AND ordinal = 0`,
		`UPDATE cao_canonical_rows SET contents = ARRAY[ARRAY['nested']]::text[]
			WHERE source_name = '$marketplacePackages' AND ordinal = 0`,
		`UPDATE cao_canonical_rows SET present = array_remove(present, 'contents')
			WHERE source_name = '$marketplacePackages' AND ordinal = 0`,
	} {
		if _, err := store.db.ExecContext(ctx, statement); err == nil {
			t.Fatal("native package list must enforce non-null string items, one dimension, and presence")
		}
	}
	for _, table := range []string{"cao_values", "cao_source_rows"} {
		var exists bool
		if err := store.db.QueryRowContext(ctx, `SELECT to_regclass($1) IS NOT NULL`, table).
			Scan(&exists); err != nil || exists {
			t.Fatalf("retired table %s still exists: present=%t err=%v", table, exists, err)
		}
	}
	var documents int
	if err := store.db.QueryRowContext(ctx, `SELECT count(*) FROM cao_source_documents
		WHERE namespace = 'default' AND source_name = '$graderObservations'`).
		Scan(&documents); err != nil || documents != 0 {
		t.Fatalf("canonical source duplicated in documents: count=%d err=%v", documents, err)
	}
	loaded, _, err := store.LoadSource(ctx, "$graderObservations", nil)
	if err != nil || !reflect.DeepEqual(loaded.Rows, input) {
		t.Fatalf("native producer roundtrip: %+v err=%v", loaded, err)
	}
	for _, name := range []string{"$campaigns", "$workflows", "$marketplacePackages", "$audits"} {
		loaded, _, err := store.LoadSource(ctx, name, nil)
		if err != nil || !reflect.DeepEqual(loaded.Rows, sources[name].Rows) {
			t.Errorf("%s native structured roundtrip: %+v err=%v", name, loaded, err)
		}
	}
	readmeSelection := []query.Definition{{Name: "workflow-readme", From: "$workflows",
		Filter: &query.Filter{Predicates: []query.Predicate{{Field: "campaignReadmePath", Equals: "docs/campaign.md"}}},
		Select: []query.SelectedField{{Field: "campaignReadmePath"}}}}
	err = store.WithReadTransaction(ctx, func(ctx context.Context, reader SourceReader) error {
		result, _, supported, planErr := reader.(NativePlanExecutor).ExecuteNativePlan(ctx,
			readmeSelection, []string{"workflow-readme"}, []string{"workflow-readme"})
		if planErr != nil || !supported || !reflect.DeepEqual(result["workflow-readme"].Rows,
			[]model.Row{{"campaignReadmePath": "docs/campaign.md"}}) {
			t.Errorf("native workflow README selection: %+v supported=%t err=%v", result, supported, planErr)
		}
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
	for _, malformed := range []any{map[string]any{"path": "worker.md"}, []any{nil},
		[]any{"worker.md", map[string]any{"path": "another.md"}}} {
		bad := map[string]model.Source{"$marketplacePackages": {
			Source: "$marketplacePackages", Rows: []model.Row{{"id": "bad", "contents": malformed}},
		}}
		if _, err := store.Replace(ctx, bad, model.Diagnostics{}, "invalid-contents", time.Now().UTC()); err == nil ||
			!strings.Contains(err.Error(), "contents") {
			t.Fatalf("malformed package paths must fail with a field diagnostic: %v", err)
		}
		got, _, err := store.LoadSource(ctx, "$marketplacePackages", nil)
		if err != nil || !reflect.DeepEqual(got.Rows, sources["$marketplacePackages"].Rows) {
			t.Fatalf("invalid package paths changed prior committed revision: %#v %v", got.Rows, err)
		}
	}
	contentsSelection := []query.Definition{{Name: "package-contents", From: "$marketplacePackages",
		Filter: &query.Filter{Predicates: []query.Predicate{{Field: "id", Equals: "marketplace:2"}}},
		Select: []query.SelectedField{{Field: "contents"}}}}
	err = store.WithReadTransaction(ctx, func(ctx context.Context, reader SourceReader) error {
		result, _, supported, planErr := reader.(NativePlanExecutor).ExecuteNativePlan(ctx,
			contentsSelection, []string{"package-contents"}, []string{"package-contents"})
		if planErr != nil || !supported || !reflect.DeepEqual(result["package-contents"].Rows,
			[]model.Row{{"contents": sources["$marketplacePackages"].Rows[1]["contents"]}}) {
			t.Errorf("native package paths projection: %+v supported=%t err=%v", result, supported, planErr)
		}
		all := []query.Definition{{Name: "all-package-contents", From: "$marketplacePackages",
			Select: []query.SelectedField{{Field: "contents"}}}}
		native, _, supported, planErr := reader.(NativePlanExecutor).ExecuteNativePlan(ctx,
			all, []string{"all-package-contents"}, []string{"all-package-contents"})
		evaluated, _, evalErr := query.New(readerLoader{reader: reader, ctx: ctx}).Execute(
			all, []string{"all-package-contents"})
		if planErr != nil || evalErr != nil || !supported ||
			!reflect.DeepEqual(native["all-package-contents"].Rows, evaluated["all-package-contents"].Rows) {
			t.Errorf("package contents projection parity: native=%+v evaluated=%+v supported=%t err=%v evalErr=%v",
				native, evaluated, supported, planErr, evalErr)
		}
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
	richSelection := []query.Definition{{Name: "rich-link", From: "$graderObservations",
		Filter: &query.Filter{Predicates: []query.Predicate{{Field: "graderId", Equals: "grader:2"}}},
		Select: []query.SelectedField{{Field: "runLink"}, {Field: "attributableRunIds"}}}}
	err = store.WithReadTransaction(ctx, func(ctx context.Context, reader SourceReader) error {
		result, _, supported, planErr := reader.(NativePlanExecutor).ExecuteNativePlan(ctx,
			richSelection, []string{"rich-link"}, []string{"rich-link"})
		if planErr != nil || !supported || !reflect.DeepEqual(result["rich-link"].Rows,
			[]model.Row{{"runLink": input[1]["runLink"], "attributableRunIds": []any{}}}) {
			t.Errorf("rich link/empty array selection: %+v supported=%t err=%v", result, supported, planErr)
		}
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
	plainSelection := []query.Definition{{Name: "plain-link", From: "$graderObservations",
		Filter: &query.Filter{Predicates: []query.Predicate{{Field: "graderId", Equals: "grader:1"}}},
		Select: []query.SelectedField{{Field: "runLink"}}}}
	err = store.WithReadTransaction(ctx, func(ctx context.Context, reader SourceReader) error {
		result, _, supported, planErr := reader.(NativePlanExecutor).ExecuteNativePlan(ctx,
			plainSelection, []string{"plain-link"}, []string{"plain-link"})
		if planErr != nil || !supported || !reflect.DeepEqual(result["plain-link"].Rows,
			[]model.Row{{"runLink": input[0]["runLink"]}}) {
			t.Errorf("plain link selection: %+v supported=%t err=%v", result, supported, planErr)
		}
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
	for _, id := range []string{"audit:1", "audit:2"} {
		defs := []query.Definition{{Name: "mixed", From: "$audits",
			Filter: &query.Filter{Predicates: []query.Predicate{{Field: "id", Equals: id}}},
			Select: []query.SelectedField{{Field: "value"}, {Field: "answer"},
				{Field: "evalResult"}, {Field: "costGrain"}}}}
		err = store.WithReadTransaction(ctx, func(ctx context.Context, reader SourceReader) error {
			native, _, supported, nativeErr := reader.(NativePlanExecutor).ExecuteNativePlan(ctx,
				defs, []string{"mixed"}, []string{"mixed"})
			plain, _, plainErr := query.New(readerLoader{reader: reader, ctx: ctx}).Execute(defs, []string{"mixed"})
			if nativeErr != nil || plainErr != nil || !supported ||
				!reflect.DeepEqual(native["mixed"].Rows, plain["mixed"].Rows) {
				t.Errorf("%s mixed known evidence selection differs: native=%+v Go=%+v supported=%t errs=%v/%v",
					id, native, plain, supported, nativeErr, plainErr)
			}
			return nil
		})
		if err != nil {
			t.Fatal(err)
		}
	}
	for _, value := range []string{"inconclusive", "2.50"} {
		defs := []query.Definition{{Name: "by-value", From: "$audits",
			Filter: &query.Filter{Predicates: []query.Predicate{{Field: "value", Equals: value}}}}}
		err = store.WithReadTransaction(ctx, func(ctx context.Context, reader SourceReader) error {
			native, _, supported, nativeErr := reader.(NativePlanExecutor).ExecuteNativePlan(ctx,
				defs, []string{"by-value"}, []string{"by-value"})
			plain, _, plainErr := query.New(readerLoader{reader: reader, ctx: ctx}).Execute(defs, []string{"by-value"})
			if nativeErr != nil || plainErr != nil || !supported ||
				!reflect.DeepEqual(native["by-value"].Rows, plain["by-value"].Rows) {
				t.Errorf("%q mixed value filter differs: native=%+v Go=%+v supported=%t errs=%v/%v",
					value, native, plain, supported, nativeErr, plainErr)
			}
			return nil
		})
		if err != nil {
			t.Fatal(err)
		}
	}
	definitions := []query.Definition{{
		Name: "grader:1", From: "$graderObservations",
		Filter: &query.Filter{Predicates: []query.Predicate{{Field: "graderId", Equals: "grader:1"}}},
		Select: []query.SelectedField{{Field: "metrics"}, {Field: "value"}, {Field: "runLink"},
			{Field: "attributableRunIds"}, {Field: "included"}, {Field: "threshold"}},
	}}
	err = store.WithReadTransaction(ctx, func(ctx context.Context, reader SourceReader) error {
		plain, _, plainErr := query.New(readerLoader{reader: reader, ctx: ctx}).Execute(definitions, []string{"grader:1"})
		native, _, supported, nativeErr := reader.(NativePlanExecutor).ExecuteNativePlan(ctx,
			definitions, []string{"grader:1"}, []string{"grader:1"})
		if plainErr != nil || nativeErr != nil || !supported || !reflect.DeepEqual(plain["grader:1"].Rows, native["grader:1"].Rows) {
			t.Errorf("producer query differs: Go=%+v native=%+v supported=%t err=%v/%v",
				plain, native, supported, plainErr, nativeErr)
		}
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
}

type sourceLoader struct {
	store *Store
	ctx   context.Context
}

type readerLoader struct {
	reader SourceReader
	ctx    context.Context
}

func (l readerLoader) LoadSource(name string, definition *query.Definition) (model.Source, model.Metrics, error) {
	return l.reader.LoadSource(l.ctx, name, definition)
}

func (l sourceLoader) LoadSource(name string, definition *query.Definition) (model.Source, model.Metrics, error) {
	return l.store.LoadSource(l.ctx, name, definition)
}

func assertNativeSchema(t *testing.T, ctx context.Context, db *sql.DB) {
	t.Helper()
	var count int
	err := db.QueryRowContext(ctx, `SELECT count(*) FROM information_schema.columns
		WHERE table_schema = current_schema() AND table_name IN
		('cao_sources', 'cao_state', 'cao_counts',
		 'cao_diagnostic_counts', 'cao_relationship_errors', 'cao_duplicate_ids')
		AND ((data_type IN ('json', 'jsonb') AND column_name <> 'metadata_extension')
			OR column_name IN ('metadata', 'payload', 'diagnostics'))`).Scan(&count)
	if err != nil || count != 0 {
		t.Fatalf("legacy JSON columns remain: count=%d err=%v", count, err)
	}
	var nativeNumeric bool
	err = db.QueryRowContext(ctx, `SELECT EXISTS (SELECT 1 FROM information_schema.columns
		WHERE table_schema = current_schema() AND table_name = 'cao_canonical_rows'
		AND column_name = 'attempt' AND data_type = 'numeric')`).Scan(&nativeNumeric)
	if err != nil || !nativeNumeric {
		t.Fatalf("missing native numeric column: %v, %v", nativeNumeric, err)
	}
	var inventoryJSON bool
	err = db.QueryRowContext(ctx, `SELECT EXISTS (SELECT 1 FROM information_schema.columns
		WHERE table_schema = current_schema() AND table_name = 'cao_source_documents'
		AND column_name = 'payload' AND data_type = 'json')`).Scan(&inventoryJSON)
	if err != nil || !inventoryJSON {
		t.Fatalf("schemaless inventory lacks JSON document storage: %v, %v", inventoryJSON, err)
	}
	for _, table := range []string{"cao_values", "cao_source_rows"} {
		var exists bool
		if err := db.QueryRowContext(ctx, `SELECT to_regclass($1) IS NOT NULL`, table).Scan(&exists); err != nil || exists {
			t.Fatalf("retired EAV table %s still exists: present=%t err=%v", table, exists, err)
		}
	}
	if err := db.QueryRowContext(ctx, `SELECT count(*) FROM information_schema.columns
		WHERE table_schema = current_schema() AND table_name = 'cao_sources'
		AND column_name IN ('storage_fallback_reason', 'metadata_migrated')`).Scan(&count); err != nil || count != 0 {
		t.Fatalf("legacy source bookkeeping remains: count=%d err=%v", count, err)
	}
}

func TestCanonicalTimestampEqualityPlan(t *testing.T) {
	url := os.Getenv("POSTGRES_URL")
	if url == "" {
		t.Skip("POSTGRES_URL is unset")
	}
	ctx, cancel := context.WithTimeout(t.Context(), 45*time.Second)
	defer cancel()
	config, err := pgx.ParseConfig(url)
	if err != nil {
		t.Fatal(err)
	}
	admin := stdlib.OpenDB(*config.Copy())
	defer func() { _ = admin.Close() }()
	schema := fmt.Sprintf("cao_timestamp_plan_%d", time.Now().UnixNano())
	if _, err := admin.ExecContext(ctx, "CREATE SCHEMA "+schema); err != nil {
		t.Fatal(err)
	}
	defer func() { _, _ = admin.ExecContext(context.Background(), "DROP SCHEMA "+schema+" CASCADE") }()
	config.RuntimeParams["search_path"] = schema
	store, err := NewConfig(ctx, config)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = store.Close() }()
	rows := []model.Row{
		{"id": "offset", "createdAt": "2026-01-02T03:04:05.123456789-07:00"},
		{"id": "utc", "createdAt": "2026-01-02T10:04:05.123456789Z"},
		{"id": "micro", "createdAt": "2026-01-02T10:04:05.123456Z"},
		{"id": "null", "createdAt": nil},
		{"id": "missing"},
	}
	if _, err := store.Replace(ctx, map[string]model.Source{
		"$runs": {Source: "$runs", Rows: rows, Metadata: model.Metadata{}},
	}, model.Diagnostics{}, "timestamp-plan", time.Now()); err != nil {
		t.Fatal(err)
	}
	for _, tc := range []struct{ label, timestamp string }{
		{"offset", "2026-01-02T03:04:05.123456789-07:00"},
		{"utc", "2026-01-02T10:04:05.123456789Z"},
		{"micro", "2026-01-02T10:04:05.123456Z"},
		{"no match", "2026-01-02T10:04:05Z"},
	} {
		t.Run(tc.label, func(t *testing.T) {
			definitions := []query.Definition{{Name: "matching", From: "$runs",
				Filter: &query.Filter{Predicates: []query.Predicate{{Field: "createdAt", Equals: tc.timestamp}}},
				Select: []query.SelectedField{{Field: "id"}, {Field: "createdAt"}}}}
			err := store.WithReadTransaction(ctx, func(ctx context.Context, reader SourceReader) error {
				native, nativeMetrics, supported, planErr := reader.(NativePlanExecutor).ExecuteNativePlan(ctx,
					definitions, []string{"matching"}, []string{"matching"})
				evaluated, evaluatedMetrics, evalErr := query.New(readerLoader{reader: reader, ctx: ctx}).Execute(
					definitions, []string{"matching"})
				if planErr != nil || evalErr != nil || !supported ||
					!reflect.DeepEqual(native["matching"].Rows, evaluated["matching"].Rows) ||
					nativeMetrics.Operations != evaluatedMetrics.Operations {
					t.Errorf("native timestamp predicate parity: native=%+v evaluated=%+v supported=%t metrics=%+v/%+v errors=%v/%v",
						native, evaluated, supported, nativeMetrics, evaluatedMetrics, planErr, evalErr)
				}
				return nil
			})
			if err != nil {
				t.Fatal(err)
			}
		})
	}
}
