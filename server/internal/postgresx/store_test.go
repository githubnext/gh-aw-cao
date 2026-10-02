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
	if err := store.db.QueryRowContext(ctx, `SELECT count(*) FROM cao_values
		WHERE namespace = $1 AND source_name = '$runs'`, "default").Scan(&canonicalRows); err != nil || canonicalRows != 0 {
		t.Fatalf("canonical metadata or fields duplicated in EAV: count=%d err=%v", canonicalRows, err)
	}
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
	var exactNumber, textFallback bool
	if err := store.db.QueryRowContext(ctx, `SELECT EXISTS (SELECT 1 FROM cao_values
		WHERE namespace = $1)`, "default").Scan(&exactNumber); err != nil || exactNumber {
		t.Fatalf("new sources retained EAV nodes: %v, %v", exactNumber, err)
	}
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
	// Simulate a committed pre-document EAV-only source and migrate it on
	// reopening; the legacy reader remains usable until migration succeeds.
	tx, err := store.db.BeginTx(ctx, nil)
	if err != nil {
		t.Fatal(err)
	}
	if _, err = tx.ExecContext(ctx, `INSERT INTO cao_sources (namespace, source_name)
		VALUES ('default', '$jobs')`); err != nil {
		t.Fatal(err)
	}
	if _, err = tx.ExecContext(ctx, `INSERT INTO cao_counts (namespace, source_name, count)
		VALUES ('default', '$jobs', 1)`); err != nil {
		t.Fatal(err)
	}
	if _, err = tx.ExecContext(ctx, `INSERT INTO cao_source_rows (namespace, source_name, ordinal)
		VALUES ('default', '$jobs', 0)`); err != nil {
		t.Fatal(err)
	}
	legacyBatch := valueBatch{ctx: ctx, tx: tx}
	if err = legacyBatch.addTree("default", "$jobs", -1, map[string]any{"source-id": "$jobs"}); err != nil {
		t.Fatal(err)
	}
	if err = legacyBatch.addTree("default", "$jobs", 0, map[string]any{
		"id": "old", "createdAt": "2026-01-02T03:04:05Z",
	}); err != nil {
		t.Fatal(err)
	}
	if err = legacyBatch.flush(); err != nil {
		t.Fatal(err)
	}
	if err = tx.Commit(); err != nil {
		t.Fatal(err)
	}
	legacy, _, err := store.LoadSource(ctx, "$jobs", nil)
	if err != nil || !reflect.DeepEqual(legacy.Rows, []model.Row{{"id": "old", "createdAt": "2026-01-02T03:04:05Z"}}) {
		t.Fatalf("pre-document EAV reader lost data: %+v err=%v", legacy, err)
	}
	if err := initialize(ctx, store.db); err != nil {
		t.Fatal(err)
	}
	fallbacks, err := store.StorageFallbacks(ctx)
	if err != nil || len(fallbacks) != 0 {
		t.Fatalf("backfilled source retained fallback warning: %+v err=%v", fallbacks, err)
	}
	converted, _, err := store.LoadSource(ctx, "$jobs", nil)
	if err != nil || !reflect.DeepEqual(converted.Rows, []model.Row{{"id": "old", "createdAt": "2026-01-02T03:04:05Z"}}) {
		t.Fatalf("backfilled canonical row: %+v err=%v", converted, err)
	}
	if err := store.db.QueryRowContext(ctx, `SELECT count(*) FROM cao_source_rows
		WHERE namespace = $1 AND source_name = '$jobs'`, "default").Scan(&documents); err != nil || documents != 0 {
		t.Fatalf("backfill retained EAV rows: count=%d err=%v", documents, err)
	}
	var exceptionalRaw sql.NullString
	if err := store.db.QueryRowContext(ctx, `SELECT created_at_raw FROM cao_canonical_rows
		WHERE namespace = $1 AND source_name = '$jobs'`, "default").Scan(&exceptionalRaw); err != nil || exceptionalRaw.Valid {
		t.Fatalf("ordinary timestamp unnecessarily duplicated: raw=%v err=%v", exceptionalRaw, err)
	}
	if err := store.db.QueryRowContext(ctx, `SELECT count(*) FROM cao_values
		WHERE namespace = $1 AND source_name = '$jobs'`, "default").Scan(&documents); err != nil || documents != 0 {
		t.Fatalf("backfill retained metadata EAV: count=%d err=%v", documents, err)
	}
	if err := initialize(ctx, store.db); err != nil {
		t.Fatalf("backfill is not idempotent: %v", err)
	}
	// Malformed historical EAV records must remain readable, not be partly
	// promoted and deleted when their known shape cannot be represented.
	tx, err = store.db.BeginTx(ctx, nil)
	if err != nil {
		t.Fatal(err)
	}
	if _, err = tx.ExecContext(ctx, `INSERT INTO cao_sources (namespace, source_name)
		VALUES ('default', '$sessions')`); err != nil {
		t.Fatal(err)
	}
	if _, err = tx.ExecContext(ctx, `INSERT INTO cao_counts (namespace, source_name, count)
		VALUES ('default', '$sessions', 1)`); err != nil {
		t.Fatal(err)
	}
	if _, err = tx.ExecContext(ctx, `INSERT INTO cao_source_rows (namespace, source_name, ordinal)
		VALUES ('default', '$sessions', 0)`); err != nil {
		t.Fatal(err)
	}
	invalidBatch := valueBatch{ctx: ctx, tx: tx}
	if err = invalidBatch.addTree("default", "$sessions", -1, map[string]any{}); err != nil {
		t.Fatal(err)
	}
	if err = invalidBatch.addTree("default", "$sessions", 0,
		map[string]any{"id": "old-bad", "createdAt": "not-a-timestamp"}); err != nil {
		t.Fatal(err)
	}
	if err = invalidBatch.flush(); err != nil {
		t.Fatal(err)
	}
	if err = tx.Commit(); err != nil {
		t.Fatal(err)
	}
	if err := initialize(ctx, store.db); err != nil {
		t.Fatal(err)
	}
	fallbacks, err = store.StorageFallbacks(ctx)
	if err != nil || fallbacks["$sessions"] != "known timestamp createdAt has invalid format" {
		t.Fatalf("historical unsupported shape lacked fallback diagnostic: %+v err=%v", fallbacks, err)
	}
	if malformed, _, err := store.LoadSource(ctx, "$sessions", nil); err != nil ||
		!reflect.DeepEqual(malformed.Rows, []model.Row{{"id": "old-bad", "createdAt": "not-a-timestamp"}}) {
		t.Fatalf("historical EAV source lost after failed promotion: %+v err=%v", malformed, err)
	}
	if err := store.db.QueryRowContext(ctx, `SELECT count(*) FROM cao_canonical_rows
		WHERE namespace = 'default' AND source_name = '$sessions'`).Scan(&documents); err != nil || documents != 0 {
		t.Fatalf("failed historical promotion left partial native rows: count=%d err=%v", documents, err)
	}
	if _, err := store.db.ExecContext(ctx, `UPDATE cao_counts SET count = count + 1
		WHERE namespace = $1 AND source_name = '$jobs'`, "default"); err != nil {
		t.Fatal(err)
	}
	if _, _, err := store.LoadSource(ctx, "$jobs", nil); err == nil {
		t.Fatal("incomplete typed source was silently returned")
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

func TestLegacyEAVBatchMigrationIntegration(t *testing.T) {
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
	schema := fmt.Sprintf("cao_postgresx_eav_batch_%d", time.Now().UnixNano())
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
	tx, err := store.db.BeginTx(ctx, nil)
	if err != nil {
		t.Fatal(err)
	}
	for _, statement := range []string{
		`INSERT INTO cao_state (namespace, revision, data_revision, evaluated_at)
			VALUES ('default', 1, 'legacy', now())`,
		`INSERT INTO cao_sources (namespace, source_name) VALUES ('default', '$runs')`,
		`INSERT INTO cao_counts (namespace, source_name, count) VALUES ('default', '$runs', 260)`,
	} {
		if _, err = tx.ExecContext(ctx, statement); err != nil {
			t.Fatal(err)
		}
	}
	values := valueBatch{ctx: ctx, tx: tx}
	positions := rowBatch{ctx: ctx, tx: tx, namespace: "default", name: "$runs"}
	if err = values.addTree("default", "$runs", -1, map[string]any{"source-id": "$runs"}); err != nil {
		t.Fatal(err)
	}
	for i := int64(0); i < 260; i++ {
		if err = positions.add(i); err != nil {
			t.Fatal(err)
		}
		if err = values.addTree("default", "$runs", i, map[string]any{
			"id": fmt.Sprintf("run:%d", i), "attempt": json.Number(strconv.FormatInt(i, 10)),
		}); err != nil {
			t.Fatal(err)
		}
	}
	if err = positions.flush(); err != nil {
		t.Fatal(err)
	}
	if err = values.flush(); err != nil {
		t.Fatal(err)
	}
	if err = tx.Commit(); err != nil {
		t.Fatal(err)
	}
	if err := initialize(ctx, store.db); err != nil {
		t.Fatal(err)
	}
	loaded, _, err := store.LoadSource(ctx, "$runs", nil)
	if err != nil || len(loaded.Rows) != 260 ||
		loaded.Rows[0]["attempt"] != json.Number("0") ||
		loaded.Rows[259]["attempt"] != json.Number("259") {
		t.Fatalf("EAV migration lost batch boundary: rows=%d err=%v", len(loaded.Rows), err)
	}
	for _, table := range []string{"cao_values", "cao_source_rows"} {
		var count int
		if err := store.db.QueryRowContext(ctx, `SELECT count(*) FROM `+table+
			` WHERE namespace = 'default' AND source_name = '$runs'`).Scan(&count); err != nil || count != 0 {
			t.Fatalf("legacy %s persisted after successful migration: count=%d err=%v", table, count, err)
		}
	}
}

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
				"relation": "run", "label": "Run 2"},
			"attributableRunIds": []any{}, "included": nil, "value": json.Number("0.000100")},
	}
	sources := map[string]model.Source{
		"$graderObservations": {
			Source: "$graderObservations", Rows: input, Metadata: model.Metadata{"source-id": "$graderObservations"},
		},
		"$campaigns": {
			Source: "$campaigns", Rows: []model.Row{{
				"id": "campaign:1", "maxRepositories": json.Number("12"),
				"inventoryWarnings": json.Number("0"), "experimental": false,
				"workers": []any{map[string]any{"name": "worker", "index": json.Number("1")}},
				"targets": []any{map[string]any{"repository": "org/repo"}},
				"campaignLink": map[string]any{"href": "https://github.com/org/repo",
					"relation": "campaign", "label": "Campaign"},
			}},
		},
		"$marketplacePackages": {
			Source: "$marketplacePackages", Rows: []model.Row{{
				"id": "marketplace:1", "registryId": "primary", "registryPrecedence": json.Number("0"),
				"contents": []any{map[string]any{"path": "worker.md"}}, "stars": json.Number("42"),
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
		AND extension IS NULL AND (run_href IS NOT NULL OR run_href_json IS NOT NULL) AND grader_id IS NOT NULL
		AND attributable_run_ids IS NOT NULL`).Scan(&stored); err != nil || stored != 2 {
		t.Fatalf("producer fields not native: count=%d err=%v", stored, err)
	}
	if err := store.db.QueryRowContext(ctx, `SELECT count(*) FROM cao_canonical_rows
		WHERE namespace = 'default' AND source_name = '$campaigns'
		AND id = 'campaign:dashboard' AND extension IS NULL`).Scan(&stored); err != nil || stored != 1 {
		t.Fatalf("fully known deployed fixture retained JSON extension: count=%d err=%v", stored, err)
	}
	for _, table := range []string{"cao_values", "cao_source_rows"} {
		if err := store.db.QueryRowContext(ctx, `SELECT count(*) FROM `+table+` WHERE namespace = 'default'`).
			Scan(&stored); err != nil || stored != 0 {
			t.Fatalf("canonical EAV duplication in %s: count=%d err=%v", table, stored, err)
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
	for _, name := range []string{"$campaigns", "$marketplacePackages", "$audits"} {
		loaded, _, err := store.LoadSource(ctx, name, nil)
		if err != nil || !reflect.DeepEqual(loaded.Rows, sources[name].Rows) {
			t.Errorf("%s native structured roundtrip: %+v err=%v", name, loaded, err)
		}
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
		('cao_sources', 'cao_source_rows', 'cao_state', 'cao_values', 'cao_counts',
		 'cao_diagnostic_counts', 'cao_relationship_errors', 'cao_duplicate_ids')
		AND ((data_type IN ('json', 'jsonb') AND column_name <> 'metadata_extension')
			OR column_name IN ('metadata', 'payload', 'diagnostics'))`).Scan(&count)
	if err != nil || count != 0 {
		t.Fatalf("legacy JSON columns remain: count=%d err=%v", count, err)
	}
	var nativeNumeric bool
	err = db.QueryRowContext(ctx, `SELECT EXISTS (SELECT 1 FROM information_schema.columns
		WHERE table_schema = current_schema() AND table_name = 'cao_values'
		AND column_name = 'numeric_value' AND data_type = 'numeric')`).Scan(&nativeNumeric)
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
}

func TestLegacyMigrationFailureRollsBack(t *testing.T) {
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
	schema := fmt.Sprintf("cao_postgresx_rollback_%d", time.Now().UnixNano())
	if _, err := admin.ExecContext(ctx, "CREATE SCHEMA "+schema); err != nil {
		t.Fatal(err)
	}
	defer func() { _, _ = admin.ExecContext(context.Background(), "DROP SCHEMA "+schema+" CASCADE") }()
	config.RuntimeParams["search_path"] = schema
	legacy := stdlib.OpenDB(*config.Copy())
	defer func() { _ = legacy.Close() }()
	for _, statement := range []string{
		`CREATE TABLE cao_sources (namespace TEXT NOT NULL, source_name TEXT NOT NULL,
				metadata JSONB NOT NULL, PRIMARY KEY (namespace, source_name))`,
		`CREATE TABLE cao_source_rows (namespace TEXT NOT NULL, source_name TEXT NOT NULL,
				ordinal BIGINT NOT NULL, payload JSONB NOT NULL,
				PRIMARY KEY (namespace, source_name, ordinal),
				FOREIGN KEY (namespace, source_name) REFERENCES cao_sources(namespace, source_name) ON DELETE CASCADE)`,
		`CREATE TABLE cao_state (namespace TEXT PRIMARY KEY, revision BIGINT NOT NULL,
				data_revision TEXT NOT NULL, evaluated_at TIMESTAMPTZ NOT NULL,
				counts JSONB NOT NULL, diagnostics JSONB NOT NULL)`,
		`INSERT INTO cao_sources VALUES ('tenant', 'raw', '{"keep":true}'::jsonb)`,
		`INSERT INTO cao_state VALUES ('tenant', 1, 'old', now(), '{"raw":0}'::jsonb,
				'{"schemaVersion":"invalid"}'::jsonb)`,
	} {
		if _, err := legacy.ExecContext(ctx, statement); err != nil {
			t.Fatal(err)
		}
	}
	if store, err := NewConfig(ctx, config, "tenant"); err == nil {
		_ = store.Close()
		t.Fatal("invalid legacy diagnostics must abort migration")
	}
	var preserved bool
	if err := legacy.QueryRowContext(ctx, `SELECT metadata->>'keep' = 'true' FROM cao_sources
			WHERE namespace = 'tenant' AND source_name = 'raw'`).Scan(&preserved); err != nil || !preserved {
		t.Fatalf("failed migration changed legacy data: %v, %v", preserved, err)
	}
	if _, err := legacy.ExecContext(ctx, `UPDATE cao_state SET diagnostics = '{"schemaVersion":14}'::jsonb`); err != nil {
		t.Fatal(err)
	}
	store, err := NewConfig(ctx, config, "tenant")
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = store.Close() }()
	assertNativeSchema(t, ctx, store.db)
	source, _, err := store.LoadSource(ctx, "raw", nil)
	if err != nil || source.Metadata["keep"] != true {
		t.Fatalf("retry lost legacy metadata: %+v, %v", source, err)
	}
}

func TestRemoveNativeGenerationColumn(t *testing.T) {
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
	schema := fmt.Sprintf("cao_generation_removal_%d", time.Now().UnixNano())
	if _, err := admin.ExecContext(ctx, "CREATE SCHEMA "+schema); err != nil {
		t.Fatal(err)
	}
	defer func() { _, _ = admin.ExecContext(context.Background(), "DROP SCHEMA "+schema+" CASCADE") }()
	config.RuntimeParams["search_path"] = schema
	store, err := NewConfig(ctx, config)
	if err != nil {
		t.Fatal(err)
	}
	input := []model.Row{
		{"id": "one", "open": map[string]any{"wide": json.Number("1e1000000")}},
		{"id": "two"},
		{"id": "three"},
		{"id": "four"},
	}
	if _, err := store.Replace(ctx, map[string]model.Source{
		"$runs": {Source: "$runs", Rows: input},
	}, model.Diagnostics{}, "old", time.Now()); err != nil {
		t.Fatal(err)
	}
	if _, err := store.db.ExecContext(ctx, `ALTER TABLE cao_canonical_rows ADD COLUMN generation TEXT`); err != nil {
		t.Fatal(err)
	}
	if _, err := store.db.ExecContext(ctx, `UPDATE cao_canonical_rows SET
			generation = CASE ordinal WHEN 0 THEN 'snapshot-1' WHEN 2 THEN '' END,
			present = CASE WHEN ordinal = 1 THEN present ELSE array_append(present, 'generation') END
			WHERE source_name = '$runs'`); err != nil {
		t.Fatal(err)
	}
	if _, err := store.db.ExecContext(ctx, `UPDATE cao_sources SET
			metadata_extension = '{"source-kind":"derived","wide":1e1000000}'::json
			WHERE source_name = '$runs'`); err != nil {
		t.Fatal(err)
	}
	_ = store.Close()
	legacy := stdlib.OpenDB(*config.Copy())
	defer func() { _ = legacy.Close() }()
	if _, err := legacy.ExecContext(ctx, `UPDATE cao_sources
			SET metadata_extension = '{"source-kind":42}'::json WHERE source_name = '$runs'`); err != nil {
		t.Fatal(err)
	}
	if broken, err := NewConfig(ctx, config); err == nil {
		_ = broken.Close()
		t.Fatal("invalid source-kind must abort the entire upgrade")
	}
	var retained bool
	if err := legacy.QueryRowContext(ctx, `SELECT EXISTS (SELECT 1 FROM information_schema.columns
			WHERE table_schema = current_schema() AND table_name = 'cao_canonical_rows'
			AND column_name = 'generation')`).Scan(&retained); err != nil || !retained {
		t.Fatalf("failed upgrade removed native generation before commit: %t, %v", retained, err)
	}
	if _, err := legacy.ExecContext(ctx, `UPDATE cao_sources
			SET metadata_extension = '{"source-kind":"derived","wide":1e1000000}'::json
			WHERE source_name = '$runs'`); err != nil {
		t.Fatal(err)
	}
	upgraded, err := NewConfig(ctx, config)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = upgraded.Close() }()
	input[0]["generation"] = "snapshot-1"
	input[2]["generation"] = ""
	input[3]["generation"] = nil
	got, _, err := upgraded.LoadSource(ctx, "$runs", nil)
	if err != nil || !reflect.DeepEqual(got.Rows, input) {
		t.Fatalf("generation column removal changed rows: %#v, %v", got.Rows, err)
	}
	if !reflect.DeepEqual(got.Metadata, model.Metadata{
		"source-kind": "derived", "wide": json.Number("1e1000000"),
	}) {
		t.Fatalf("known metadata field was not migrated losslessly: %#v", got.Metadata)
	}
	var metadataKind string
	if err := upgraded.db.QueryRowContext(ctx, `SELECT metadata_source_kind
		FROM cao_sources WHERE source_name = '$runs'`).Scan(&metadataKind); err != nil || metadataKind != "derived" {
		t.Fatalf("metadata source kind not native: %q, %v", metadataKind, err)
	}
	var exists bool
	if err := upgraded.db.QueryRowContext(ctx, `SELECT EXISTS (
			SELECT 1 FROM information_schema.columns WHERE table_schema = current_schema()
			AND table_name = 'cao_canonical_rows' AND column_name = 'generation')`).Scan(&exists); err != nil || exists {
		t.Fatalf("native generation column retained: %t, %v", exists, err)
	}
}

func TestCanonicalExtensionColumnUpgrade(t *testing.T) {
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
	schema := fmt.Sprintf("cao_canonical_upgrade_%d", time.Now().UnixNano())
	if _, err := admin.ExecContext(ctx, "CREATE SCHEMA "+schema); err != nil {
		t.Fatal(err)
	}
	defer func() { _, _ = admin.ExecContext(context.Background(), "DROP SCHEMA "+schema+" CASCADE") }()
	config.RuntimeParams["search_path"] = schema
	old, err := NewConfig(ctx, config)
	if err != nil {
		t.Fatal(err)
	}
	var booleanIndexes int
	if err := old.db.QueryRowContext(ctx, `SELECT count(*) FROM pg_indexes
		WHERE schemaname = current_schema() AND tablename = 'cao_canonical_rows'
		AND indexname IN ('cao_canonical_rows_enabled', 'cao_canonical_rows_is_pull_request')
		AND (indexdef LIKE '%(namespace, source_name, enabled)%'
			OR indexdef LIKE '%(namespace, source_name, is_pull_request)%')`).
		Scan(&booleanIndexes); err != nil || booleanIndexes != 2 {
		t.Fatalf("native boolean indexes: count=%d err=%v", booleanIndexes, err)
	}
	input := make([]model.Row, 270)
	for i := range input {
		input[i] = model.Row{"id": fmt.Sprintf("run-%d", i), "status": "completed", "runId": nil}
	}
	if _, err := old.Replace(ctx, map[string]model.Source{
		"$runs": {Source: "$runs", Rows: input, Metadata: model.Metadata{"version": json.Number("1")}},
		"$jobs": {Source: "$jobs", Rows: []model.Row{{"id": "job-1"}}},
	}, model.Diagnostics{}, "old", time.Now().UTC()); err != nil {
		t.Fatal(err)
	}
	prior, _, err := old.LoadSource(ctx, "$runs", nil)
	if err != nil || !reflect.DeepEqual(prior.Metadata, model.Metadata{"version": json.Number("1")}) {
		t.Fatalf("new canonical metadata storage: %+v, %v", prior.Metadata, err)
	}
	_ = old.Close()
	legacy := stdlib.OpenDB(*config.Copy())
	defer func() { _ = legacy.Close() }()
	// Model the prior branch's table with canonical rows and extension fields
	// that were not yet represented by physical columns.
	for _, statement := range []string{
		`INSERT INTO cao_source_documents (namespace, source_name, ordinal, payload)
			VALUES ('default', '$runs', -1,
				'{"version":1,"source-id":"$runs","source-revision":"old","availability":"available","row-count":270}'::json)`,
		`INSERT INTO cao_source_documents (namespace, source_name, ordinal, payload)
			VALUES ('default', '$jobs', -1, 'null'::json)`,
		`ALTER TABLE cao_sources
			DROP COLUMN metadata_extension, DROP COLUMN metadata_present,
			DROP COLUMN metadata_source_id, DROP COLUMN metadata_source_revision,
			DROP COLUMN metadata_availability, DROP COLUMN metadata_row_count_null,
			DROP COLUMN metadata_migrated`,
		`UPDATE cao_canonical_rows SET extension = '{}'::json WHERE extension IS NULL`,
		`ALTER TABLE cao_canonical_rows ALTER COLUMN extension SET NOT NULL`,
		`ALTER TABLE cao_canonical_rows
			DROP COLUMN agent_id, DROP COLUMN failure_message,
			DROP COLUMN target_repository_id,
			DROP COLUMN evidence_window_start, DROP COLUMN evidence_window_start_raw,
			DROP COLUMN attributable_run_ids, DROP COLUMN events_truncated,
			DROP COLUMN value, DROP COLUMN value_raw, DROP COLUMN value_text,
			DROP COLUMN value_kind, DROP COLUMN answer_json, DROP COLUMN id_kind`,
		`ALTER TABLE cao_canonical_rows
			DROP COLUMN provenance_source, DROP COLUMN provenance_source_id,
			DROP COLUMN provenance_observed_at, DROP COLUMN provenance_observed_at_raw,
			DROP COLUMN provenance_source_revision, DROP COLUMN provenance_present,
			DROP COLUMN provenance_null, ADD COLUMN provenance JSON`,
		`UPDATE cao_canonical_rows SET
			provenance = json_build_object('source', 'legacy', 'sourceId', 'source-' || ordinal,
				'observedAt', '2026-09-01T10:11:12.123456789-07:00',
				'sourceRevision', 'v1'),
			present = array_append(present, 'provenance')
			WHERE source_name = '$runs'`,
		`UPDATE cao_canonical_rows SET extension = json_build_object(
			'agentId', 'agent-' || ordinal, 'failureMessage', null,
			'targetRepositoryId', 'repository:target',
			'evidenceWindowStart', '2026-09-01T10:11:12.123456789Z',
			'attributableRunIds', json_build_array('run-' || ordinal),
			'eventsTruncated', true, 'value', 'text evidence',
			'answer', json_build_object('nested', true),
			'openEvidence', json_build_object('source', 'old'))
			WHERE source_name = '$runs'`,
	} {
		if _, err := legacy.ExecContext(ctx, statement); err != nil {
			t.Fatal(err)
		}
	}
	if _, err := legacy.ExecContext(ctx, `UPDATE cao_canonical_rows SET
		extension = (extension::jsonb || '{"status":"failed"}'::jsonb)::json
		WHERE namespace = 'default' AND source_name = '$runs' AND ordinal = 269`); err != nil {
		t.Fatal(err)
	}
	if partial, err := NewConfig(ctx, config); err == nil {
		_ = partial.Close()
		t.Fatal("conflicting last batch must roll back the entire upgrade")
	}
	var retained string
	var added bool
	if err := legacy.QueryRowContext(ctx, `SELECT extension::text FROM cao_canonical_rows
		WHERE namespace = 'default' AND source_name = '$runs' AND ordinal = 0`).Scan(&retained); err != nil ||
		!strings.Contains(retained, `"agentId"`) {
		t.Fatalf("failed batch migration rewrote earlier rows: extension=%s err=%v", retained, err)
	}
	if err := legacy.QueryRowContext(ctx, `SELECT EXISTS (SELECT 1 FROM information_schema.columns
		WHERE table_schema = current_schema() AND table_name = 'cao_canonical_rows'
		AND column_name = 'agent_id')`).Scan(&added); err != nil || added {
		t.Fatalf("failed batch migration retained schema changes: added=%t err=%v", added, err)
	}
	var count int
	if err := legacy.QueryRowContext(ctx, `SELECT count(*) FROM cao_source_documents
		WHERE namespace = 'default' AND source_name = '$runs'`).Scan(&count); err != nil || count != 1 {
		t.Fatalf("failed batch migration removed old metadata document: count=%d err=%v", count, err)
	}
	if _, err := legacy.ExecContext(ctx, `UPDATE cao_canonical_rows SET
		extension = (extension::jsonb - 'status')::json
		WHERE namespace = 'default' AND source_name = '$runs' AND ordinal = 269`); err != nil {
		t.Fatal(err)
	}
	upgraded, err := NewConfig(ctx, config)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = upgraded.Close() }()
	source, _, err := upgraded.LoadSource(ctx, "$runs", nil)
	if err != nil || len(source.Rows) != len(input) {
		t.Fatalf("upgraded canonical source: %d rows, %v", len(source.Rows), err)
	}
	if !reflect.DeepEqual(source.Metadata, model.Metadata{
		"version": json.Number("1"), "source-id": "$runs", "source-revision": "old",
		"availability": "available", "row-count": json.Number("270"),
	}) {
		t.Fatalf("metadata changed on upgrade: %#v", source.Metadata)
	}
	for i, row := range source.Rows {
		if row["id"] != input[i]["id"] || row["runId"] != nil || row["status"] != "completed" ||
			row["targetRepositoryId"] != "repository:target" ||
			row["agentId"] != fmt.Sprintf("agent-%d", i) || row["failureMessage"] != nil ||
			row["evidenceWindowStart"] != "2026-09-01T10:11:12.123456789Z" ||
			row["eventsTruncated"] != true || row["value"] != "text evidence" ||
			!reflect.DeepEqual(row["provenance"], map[string]any{
				"source": "legacy", "sourceId": fmt.Sprintf("source-%d", i),
				"observedAt": "2026-09-01T10:11:12.123456789-07:00", "sourceRevision": "v1",
			}) ||
			!reflect.DeepEqual(row["attributableRunIds"], []any{fmt.Sprintf("run-%d", i)}) ||
			!reflect.DeepEqual(row["answer"], map[string]any{"nested": true}) ||
			!reflect.DeepEqual(row["openEvidence"], map[string]any{"source": "old"}) {
			t.Fatalf("upgraded row %d lost a field: %#v", i, row)
		}
	}
	var migratedTarget bool
	if err := upgraded.db.QueryRowContext(ctx, `SELECT bool_and(
		target_repository_id = 'repository:target'
		AND NOT EXISTS (SELECT 1 FROM json_object_keys(extension) AS key WHERE key = 'targetRepositoryId'))
		FROM cao_canonical_rows WHERE namespace = 'default' AND source_name = '$runs'`).
		Scan(&migratedTarget); err != nil || !migratedTarget {
		t.Fatalf("target relationship was not backfilled into native columns: %t, %v", migratedTarget, err)
	}
	var extension string
	var agent, valueText string
	if err := legacy.QueryRowContext(ctx, `SELECT extension::text, agent_id, value_text
		FROM cao_canonical_rows WHERE namespace = 'default' AND source_name = '$runs'
		AND ordinal = 269`).Scan(&extension, &agent, &valueText); err != nil ||
		extension != `{"openEvidence":{"source":"old"}}` || agent != "agent-269" || valueText != "text evidence" {
		t.Fatalf("native field relocation: extension=%s agent=%s value=%s err=%v", extension, agent, valueText, err)
	}
	if err := legacy.QueryRowContext(ctx, `SELECT count(*) FROM cao_canonical_rows
		WHERE namespace = 'default' AND source_name = '$runs'`).Scan(&count); err != nil || count != len(input) {
		t.Fatalf("upgrade changed row count: %d, %v", count, err)
	}
	if err := legacy.QueryRowContext(ctx, `SELECT count(*) FROM cao_source_documents
		WHERE namespace = 'default' AND source_name = '$runs'`).Scan(&count); err != nil || count != 0 {
		t.Fatalf("upgrade retained a canonical metadata document: %d, %v", count, err)
	}
	if err := legacy.QueryRowContext(ctx, `SELECT EXISTS (SELECT 1 FROM information_schema.columns
		WHERE table_schema = current_schema() AND table_name = 'cao_canonical_rows'
		AND column_name = 'provenance')`).Scan(&added); err != nil || added {
		t.Fatalf("upgrade retained legacy provenance JSON column: present=%t err=%v", added, err)
	}
	var hasExtension bool
	if err := legacy.QueryRowContext(ctx, `SELECT extension IS NOT NULL FROM cao_canonical_rows
		WHERE namespace = 'default' AND source_name = '$jobs' AND ordinal = 0`).Scan(&hasExtension); err != nil || hasExtension {
		t.Fatalf("upgrade did not null old empty extension: present=%t err=%v", hasExtension, err)
	}
	_ = upgraded.Close()
	reopened, err := NewConfig(ctx, config)
	if err != nil {
		t.Fatalf("second upgrade must be idempotent: %v", err)
	}
	_ = reopened.Close()
	if _, err := legacy.ExecContext(ctx, `UPDATE cao_canonical_rows
		SET extension = '{"status":"failed","openEvidence":true}'::json
		WHERE namespace = 'default' AND source_name = '$runs' AND ordinal = 0`); err != nil {
		t.Fatal(err)
	}
	if reopened, err := NewConfig(ctx, config); err == nil {
		_ = reopened.Close()
		t.Fatal("conflicting native/extension field must abort upgrade")
	}
	var status string
	if err := legacy.QueryRowContext(ctx, `SELECT status, extension::text
		FROM cao_canonical_rows WHERE namespace = 'default' AND source_name = '$runs'
		AND ordinal = 0`).Scan(&status, &extension); err != nil ||
		status != "completed" || !strings.Contains(extension, `"status":"failed"`) {
		t.Fatalf("failed upgrade changed existing record: status=%s extension=%s err=%v", status, extension, err)
	}
	if _, err := legacy.ExecContext(ctx, `UPDATE cao_sources
		SET metadata_extension = '{"source-id":"shadow"}'::json
		WHERE namespace = 'default' AND source_name = '$runs'`); err != nil {
		t.Fatal(err)
	}
	if _, _, err := upgraded.LoadSource(ctx, "$runs", nil); err == nil {
		t.Fatal("known metadata in extension must fail closed")
	}
}

func TestLegacyJSONBMigrationAllTenants(t *testing.T) {
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
	schema := fmt.Sprintf("cao_postgresx_migration_%d", time.Now().UnixNano())
	if _, err := admin.ExecContext(ctx, "CREATE SCHEMA "+schema); err != nil {
		t.Fatal(err)
	}
	defer func() { _, _ = admin.ExecContext(context.Background(), "DROP SCHEMA "+schema+" CASCADE") }()
	config.RuntimeParams["search_path"] = schema
	legacy := stdlib.OpenDB(*config.Copy())
	defer func() { _ = legacy.Close() }()
	for _, statement := range []string{
		`CREATE TABLE cao_sources (namespace TEXT NOT NULL, source_name TEXT NOT NULL,
			metadata JSONB NOT NULL, PRIMARY KEY (namespace, source_name))`,
		`CREATE TABLE cao_source_rows (namespace TEXT NOT NULL, source_name TEXT NOT NULL,
			ordinal BIGINT NOT NULL, payload JSONB NOT NULL,
			PRIMARY KEY (namespace, source_name, ordinal),
			FOREIGN KEY (namespace, source_name) REFERENCES cao_sources(namespace, source_name) ON DELETE CASCADE)`,
		`CREATE TABLE cao_state (namespace TEXT PRIMARY KEY, revision BIGINT NOT NULL,
			data_revision TEXT NOT NULL, evaluated_at TIMESTAMPTZ NOT NULL,
			counts JSONB NOT NULL, diagnostics JSONB NOT NULL)`,
	} {
		if _, err := legacy.ExecContext(ctx, statement); err != nil {
			t.Fatal(err)
		}
	}
	for _, tenant := range []string{"first", "second"} {
		if _, err := legacy.ExecContext(ctx, `INSERT INTO cao_sources VALUES ($1, 'raw', $2::jsonb)`,
			tenant, `{"origin":{"nested":[9007199254740993,null,{"a":true}]}}`); err != nil {
			t.Fatal(err)
		}
		if _, err := legacy.ExecContext(ctx, `INSERT INTO cao_sources VALUES
			($1, 'empty-meta', '{}'::jsonb), ($1, 'null-meta', 'null'::jsonb)`, tenant); err != nil {
			t.Fatal(err)
		}
		if _, err := legacy.ExecContext(ctx, `INSERT INTO cao_source_rows VALUES ($1, 'raw', 0, $2::jsonb)`,
			tenant, `{"owner":"`+tenant+`","values":[{"number":1.234567890123456789},[],null]}`); err != nil {
			t.Fatal(err)
		}
		if _, err := legacy.ExecContext(ctx, `INSERT INTO cao_source_rows VALUES ($1, 'raw', 1, '{}'::jsonb)`, tenant); err != nil {
			t.Fatal(err)
		}
		if _, err := legacy.ExecContext(ctx, `INSERT INTO cao_source_rows
			SELECT $1, 'raw', ordinal, '{}'::jsonb FROM generate_series(2, 269) AS ordinal`, tenant); err != nil {
			t.Fatal(err)
		}
		if _, err := legacy.ExecContext(ctx, `INSERT INTO cao_state VALUES
			($1, 7, 'legacy', '2025-01-01'::timestamptz, $2::jsonb, $3::jsonb)`,
			tenant, `{"raw":270,"empty-meta":0,"null-meta":0}`, `{"schemaVersion":14,"counts":{"raw":1},"relationshipErrors":["warning"],"duplicateRecordIds":{"raw":["a"],"empty":[]}}`); err != nil {
			t.Fatal(err)
		}
	}
	type opened struct {
		name  string
		store *Store
		err   error
	}
	start := make(chan struct{})
	results := make(chan opened, 2)
	for _, tenant := range []string{"first", "second"} {
		go func(tenant string) {
			<-start
			store, err := NewConfig(ctx, config, tenant)
			results <- opened{tenant, store, err}
		}(tenant)
	}
	close(start)
	openedStores := map[string]*Store{}
	for i := 0; i < 2; i++ {
		result := <-results
		if result.store != nil {
			defer func() { _ = result.store.Close() }()
		}
		if result.err != nil {
			t.Fatalf("concurrent %s startup: %v", result.name, result.err)
		}
		openedStores[result.name] = result.store
	}
	first, second := openedStores["first"], openedStores["second"]
	assertNativeSchema(t, ctx, first.db)
	for _, tc := range []struct {
		name  string
		store *Store
	}{{"first", first}, {"second", second}} {
		state, err := tc.store.State(ctx)
		if err != nil || !state.Ready || state.Revision != 7 || state.Counts["raw"] != 270 || state.DataRevision != "legacy" {
			t.Fatalf("%s migrated state: %+v, %v", tc.name, state, err)
		}
		source, _, err := tc.store.LoadSource(ctx, "raw", nil)
		if err != nil {
			t.Fatal(err)
		}
		if source.Rows[0]["owner"] != tc.name ||
			source.Rows[0]["values"].([]any)[0].(map[string]any)["number"] != json.Number("1.234567890123456789") ||
			source.Metadata["origin"].(map[string]any)["nested"].([]any)[0] != json.Number("9007199254740993") ||
			len(source.Rows) != 270 || len(source.Rows[1]) != 0 || len(source.Rows[269]) != 0 {
			t.Fatalf("%s migrated source: %+v", tc.name, source)
		}
		for _, shape := range []struct {
			name     string
			metadata model.Metadata
		}{{"empty-meta", model.Metadata{}}, {"null-meta", nil}} {
			loaded, _, err := tc.store.LoadSource(ctx, shape.name, nil)
			if err != nil || !reflect.DeepEqual(loaded.Metadata, shape.metadata) || len(loaded.Rows) != 0 {
				t.Fatalf("%s metadata shape %s: %+v, %v", tc.name, shape.name, loaded, err)
			}
		}
		diag, err := tc.store.Diagnostics(ctx)
		if err != nil || !reflect.DeepEqual(diag, model.Diagnostics{
			SchemaVersion: 14, Counts: map[string]int{"raw": 1},
			RelationshipErrors: []string{"warning"},
			DuplicateRecordIDs: map[string][]string{"raw": {"a"}, "empty": {}},
		}) {
			t.Fatalf("%s migrated diagnostics: %+v, %v", tc.name, diag, err)
		}
	}
	if _, err := first.Replace(ctx, map[string]model.Source{"raw": {
		Rows: []model.Row{{"owner": "updated"}}, Metadata: model.Metadata{},
	}}, model.Diagnostics{}, "updated", time.Now()); err != nil {
		t.Fatal(err)
	}
	source, _, err := second.LoadSource(ctx, "raw", nil)
	if err != nil || source.Rows[0]["owner"] != "second" {
		t.Fatalf("migration mixed tenants: %+v, %v", source, err)
	}
}
