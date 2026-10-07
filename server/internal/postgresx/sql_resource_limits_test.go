package postgresx

import (
	"context"
	"strings"
	"testing"

	"github.com/githubnext/gh-aw-cao/server/internal/model"
	"github.com/githubnext/gh-aw-cao/server/internal/query"
)

func TestSQLResourceLimits(t *testing.T) {
	defaults, err := sqlResourceLimits(nil)
	if err != nil || defaults.MaxInputRows != query.MaxInputRows ||
		defaults.MaxOperations != query.MaxOperations ||
		defaults.MaxWorkingBytes != query.MaxWorkingBytes {
		t.Fatalf("production SQL limits changed: %+v %v", defaults, err)
	}
	benchmark := SQLResourceLimits{
		MaxInputRows:  query.MaxWorkingRows,
		MaxOperations: 10 * query.MaxOperations, MaxWorkingBytes: 4 * query.MaxWorkingBytes,
	}
	got, err := sqlResourceLimits(&benchmark)
	if err != nil || got != benchmark {
		t.Fatalf("bounded benchmark SQL limits rejected: %+v %v", got, err)
	}
	for _, limits := range []SQLResourceLimits{
		{},
		{MaxInputRows: -1, MaxOperations: 1, MaxWorkingBytes: 1},
		{MaxInputRows: 1, MaxOperations: -1, MaxWorkingBytes: 1},
		{MaxInputRows: query.MaxWorkingRows + 1, MaxOperations: 1, MaxWorkingBytes: 1},
		{MaxInputRows: 1, MaxOperations: 10*query.MaxOperations + 1, MaxWorkingBytes: 1},
		{MaxInputRows: 1, MaxOperations: 1, MaxWorkingBytes: -1},
		{MaxInputRows: 1, MaxOperations: 1, MaxWorkingBytes: 4*query.MaxWorkingBytes + 1},
	} {
		if _, err := sqlResourceLimits(&limits); err == nil {
			t.Fatalf("invalid SQL limits admitted: %+v", limits)
		}
	}
}

func TestSQLResourceLimitsApplyOnlyToRequestedExecution(t *testing.T) {
	store, _ := nativeTestStore(t)
	nativeSeed(t.Context(), t, store, map[string][]model.Row{
		"$domains": {
			{"id": "one", "runId": "run", "domain": "example.com"},
			{"id": "two", "runId": "run", "domain": "other.example"},
		},
	})
	definitions := []query.Definition{{Name: "picked", From: "$domains"}}
	for _, tc := range []struct {
		name   string
		limits *SQLResourceLimits
		error  string
	}{
		{"input", &SQLResourceLimits{MaxInputRows: 1, MaxOperations: query.MaxOperations, MaxWorkingBytes: query.MaxWorkingBytes}, "max input rows"},
		{"operations", &SQLResourceLimits{MaxInputRows: query.MaxInputRows, MaxOperations: 1, MaxWorkingBytes: query.MaxWorkingBytes}, "max operations"},
		{"memory", &SQLResourceLimits{MaxInputRows: query.MaxInputRows, MaxOperations: query.MaxOperations, MaxWorkingBytes: 1}, "max working bytes"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			err := store.WithReadTransaction(t.Context(), func(ctx context.Context, reader NativeReader) error {
				_, _, err := reader.ExecuteSQLPlanWithOptions(ctx, definitions, []string{"picked"}, SQLExecutionOptions{ResourceLimits: tc.limits})
				return err
			})
			if err == nil || !strings.Contains(err.Error(), tc.error) {
				t.Fatalf("resource budget was not enforced: %v", err)
			}
			sources, _, err := store.ExecuteSQLPlan(t.Context(), definitions, []string{"picked"})
			if err != nil || len(sources["picked"].Rows) != 2 {
				t.Fatalf("override leaked into default SQL execution: %v", err)
			}
		})
	}
	err := store.WithReadTransaction(t.Context(), func(ctx context.Context, reader NativeReader) error {
		sources, metrics, err := reader.ExecuteSQLPlanWithOptions(ctx, definitions, []string{"picked"}, SQLExecutionOptions{
			Pages: map[string]SQLPage{"picked": {Limit: 1}},
			ResourceLimits: &SQLResourceLimits{
				MaxInputRows: query.MaxWorkingRows, MaxOperations: 10 * query.MaxOperations, MaxWorkingBytes: 4 * query.MaxWorkingBytes,
			},
		})
		if err == nil && (len(sources["picked"].Rows) != 1 || sources["picked"].Metadata["total-row-count"] != 2 ||
			metrics.OutputRows != 1 || metrics.PeakWorkingRows != 2) {
			t.Errorf("benchmark page lost full-plan cardinality: %+v %+v", sources, metrics)
		}
		return err
	})
	if err != nil {
		t.Fatal(err)
	}
}
