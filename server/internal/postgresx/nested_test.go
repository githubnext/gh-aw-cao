package postgresx

import (
	"context"
	"encoding/json"
	"errors"
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

func TestNativeNestedShapes(t *testing.T) {
	for key, values := range map[string][]any{
		"workers":                 {map[string]any{}, []any{map[string]any{"unexpected": true}}, []any{map[string]any{"enabled": "false"}}},
		"targets":                 {map[string]any{}, []any{map[string]any{"repository": json.Number("1")}}},
		"intelligenceDeclaration": {[]any{}, map[string]any{"fields": map[string]any{"unexpected": true}}},
		"tokenUsage":              {[]any{}, map[string]any{"total_aic": "1"}, map[string]any{"by_model": []any{}}},
		"sourceProvenance":        {[]any{}, map[string]any{"observedAt": "invalid"}, map[string]any{"evidenceLinks": []any{false}}},
	} {
		for _, value := range values {
			if _, _, _, ok, _ := canonicalRow(model.Row{key: value}); ok {
				t.Fatalf("invalid %s shape accepted: %v", key, value)
			}
			if reason := canonicalFallbackReason(model.Row{key: value}); reason == "" ||
				strings.Contains(reason, "known field has unsupported representation") {
				t.Fatalf("invalid %s shape lacks actionable diagnostic", key)
			}
		}
	}
}

func TestNativeNestedIntegration(t *testing.T) {
	dsn := os.Getenv("POSTGRES_URL")
	if dsn == "" {
		t.Skip("POSTGRES_URL is unset")
	}
	ctx, cancel := context.WithTimeout(t.Context(), 30*time.Second)
	defer cancel()
	config, err := pgx.ParseConfig(dsn)
	if err != nil {
		t.Fatal(err)
	}
	admin := stdlib.OpenDB(*config.Copy())
	defer func() { _ = admin.Close() }()
	schema := fmt.Sprintf("cao_nested_%d", time.Now().UnixNano())
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
		{"id": "full",
			"sourceProvenance": map[string]any{
				"kind": "workflow-dispatch-claim", "sourceId": "claim:1",
				"sourceSchemaRevision": json.Number("1"), "runAttempt": json.Number("2"),
				"observedAt":    "2026-10-01T12:00:00.123456789-07:00",
				"evidenceLinks": []any{"https://github.com/org/repo/issues/1"},
				"future":        map[string]any{"unknown": json.Number("1e1000000")}},
			"workers": []any{map[string]any{"id": "worker", "workflow": "worker.md", "enabled": false, "max-mode": nil},
				map[string]any{}, nil},
			"targets": []any{map[string]any{"repository": "org/repo", "mode": "review"},
				map[string]any{"repository": ""}},
			"intelligenceDeclaration": map[string]any{
				"contractVersion": "1.0.0", "campaign": "dashboard",
				"fields": map[string]any{"intendedOutcome": map[string]any{"arbitrary": []any{
					json.Number("1e1000000"), false, nil}}, "backoff": nil}},
			"tokenUsage": map[string]any{
				"total_input_tokens": json.Number("9007199254740993"),
				"total_aic":          json.Number("1.250"),
				"total_requests":     json.Number("1e3"),
				"cache_efficiency":   nil,
				"by_model": map[string]any{
					"model'\"": map[string]any{"reasoning_tokens": json.Number("-0"),
						"input_tokens": json.Number("1e1000000"),
						"provider":     map[string]any{"future": json.Number("1e1000000")}},
					"empty": map[string]any{}, "null": nil},
				"provider_extension": []any{"anything", json.Number("1e1000000")},
			}},
		{"id": "empty", "workers": []any{}, "targets": []any{}, "intelligenceDeclaration": map[string]any{},
			"tokenUsage":       map[string]any{"by_model": map[string]any{}},
			"sourceProvenance": map[string]any{"observedAt": "2026-10-01T12:00:00Z", "evidenceLinks": []any{}}},
		{"id": "null", "workers": nil, "targets": nil, "intelligenceDeclaration": nil, "tokenUsage": nil,
			"sourceProvenance": nil},
		{"id": "missing"},
	}
	source := model.Source{Source: "$campaigns", Rows: rows}
	sources := map[string]model.Source{"$campaigns": source}
	if _, err := store.Replace(ctx, sources, model.Diagnostics{}, "nested", time.Now().UTC()); err != nil {
		t.Fatal(err)
	}
	loaded, _, err := store.LoadSource(ctx, "$campaigns", nil)
	if err != nil || !reflect.DeepEqual(rows, loaded.Rows) {
		t.Fatalf("native nested roundtrip: got=%#v err=%v", loaded.Rows, err)
	}
	var native bool
	if err := store.db.QueryRowContext(ctx, `SELECT
		(workers[1]).id = 'worker' AND (workers[1]).enabled = FALSE
		AND (targets[1]).repository = 'org/repo'
		AND (intelligence_declaration).campaign = 'dashboard'
		AND ((intelligence_declaration).fields).present @> ARRAY['intendedOutcome','backoff']::text[]
		AND (token_usage).total_input_tokens = 9007199254740993
		AND (token_usage).total_aic = 1.250 AND (token_usage).total_aic_raw IS NULL
		AND (token_usage).total_requests = 1000 AND (token_usage).total_requests_raw = '1e3'
		AND (source_provenance).source_id = 'claim:1'
		AND (source_provenance).run_attempt = 2
		AND (source_provenance).observed_at IS NOT NULL
		AND (source_provenance).observed_at_raw = '2026-10-01T12:00:00.123456789-07:00'
		AND (source_provenance).evidence_links = ARRAY['https://github.com/org/repo/issues/1']::text[]
		AND NOT EXISTS (SELECT 1 FROM json_object_keys((token_usage).extension) key
			WHERE key IN ('total_aic', 'total_input_tokens', 'by_model'))
		AND extension IS NULL FROM cao_canonical_rows WHERE id = 'full'`).Scan(&native); err != nil || !native {
		t.Fatalf("closed nested data not native-only: native=%t err=%v", native, err)
	}
	var ordinaryRaw bool
	if err := store.db.QueryRowContext(ctx, `SELECT (source_provenance).observed_at_raw IS NULL
		FROM cao_canonical_rows WHERE id = 'empty'`).Scan(&ordinaryRaw); err != nil || !ordinaryRaw {
		t.Fatalf("ordinary nested timestamp duplicated its lexeme: %t %v", ordinaryRaw, err)
	}
	for _, name := range []string{"workers", "targets", "intelligence_declaration", "token_usage", "source_provenance"} {
		var dataType string
		if err := store.db.QueryRowContext(ctx, `SELECT data_type FROM information_schema.columns
			WHERE table_schema = current_schema() AND table_name = 'cao_canonical_rows' AND column_name = $1`,
			name).Scan(&dataType); err != nil || dataType == "json" || dataType == "jsonb" {
			t.Fatalf("%s is not a native composite/array: type=%s err=%v", name, dataType, err)
		}
	}
	err = store.WithReadTransaction(ctx, func(ctx context.Context, reader SourceReader) error {
		for _, selectFields := range [][]query.SelectedField{nil, {
			{Field: "workers"}, {Field: "targets"}, {Field: "intelligenceDeclaration"}, {Field: "tokenUsage"},
			{Field: "sourceProvenance"},
		}} {
			definitions := []query.Definition{{Name: "nested", From: "$campaigns", Select: selectFields}}
			native, _, supported, err := reader.(NativePlanExecutor).ExecuteNativePlan(ctx,
				definitions, []string{"nested"}, []string{"nested"})
			if err != nil || !supported {
				t.Fatalf("native nested plan: supported=%t err=%v", supported, err)
			}
			expected, _, err := query.New(readerLoader{reader: reader, ctx: ctx}).Execute(definitions, []string{"nested"})
			if err != nil || !reflect.DeepEqual(native["nested"].Rows, expected["nested"].Rows) {
				t.Fatalf("nested projection changed semantics: native=%#v expected=%#v err=%v",
					native["nested"].Rows, expected["nested"].Rows, err)
			}
		}
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
	bad := map[string]model.Source{"$campaigns": {Source: "$campaigns", Rows: []model.Row{
		{"id": "bad", "workers": []any{map[string]any{"enabled": "false"}}},
	}}}
	if _, err := store.Replace(ctx, bad, model.Diagnostics{}, "bad", time.Now().UTC()); err == nil {
		t.Fatal("malformed closed nested data must abort replacement")
	}
	loaded, _, err = store.LoadSource(ctx, "$campaigns", nil)
	if err != nil || !reflect.DeepEqual(rows, loaded.Rows) {
		t.Fatalf("failed replacement changed committed data: %v", err)
	}
	// A restart is idempotent for the native schema; tenant data survives.
	reopened, err := NewConfig(ctx, config)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = reopened.Close() }()
	loaded, _, err = reopened.LoadSource(ctx, "$campaigns", nil)
	if err != nil || !reflect.DeepEqual(rows, loaded.Rows) {
		t.Fatalf("native restart changed data: %v", err)
	}
	// Old populated JSON schemas require a fresh database, not an implicit wipe.
	if _, err := store.db.ExecContext(ctx, `ALTER TABLE cao_canonical_rows DROP COLUMN workers;
		ALTER TABLE cao_canonical_rows ADD COLUMN workers JSON`); err != nil {
		t.Fatal(err)
	}
	if unexpected, err := NewConfig(ctx, config); err == nil {
		_ = unexpected.Close()
		t.Fatal("populated old schema must not be accepted")
	} else if !errors.Is(err, ErrFreshDatabaseRequired) {
		t.Fatalf("old schema lacks actionable fresh-database error: %v", err)
	}
	var retained int
	if err := store.db.QueryRowContext(ctx, `SELECT count(*) FROM cao_canonical_rows`).Scan(&retained); err != nil || retained != len(rows) {
		t.Fatalf("old schema rejection discarded data: count=%d err=%v", retained, err)
	}
}
