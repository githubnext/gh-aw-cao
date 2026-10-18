package cli

import (
	"bytes"
	"context"
	"errors"
	"path/filepath"
	"strings"
	"testing"
)

func TestNativeNamedQueriesFailClosed(t *testing.T) {
	catalog, err := loadNativeCatalog("")
	if err != nil {
		t.Fatal(err)
	}
	db, err := openNativeSnapshot(filepath.Join(t.TempDir(), "explicit.sqlite"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if err := db.Close(); err != nil {
			t.Error(err)
		}
	})
	for _, tt := range []struct {
		id         string
		parameters map[string]any
		limit      int
		message    string
	}{
		{id: "not-a-query", limit: 5, message: "Unknown dashboard query"},
		{id: "campaign-runs", parameters: map[string]any{"unknown": "value"}, limit: 5, message: "Unknown parameter"},
		{id: "campaign-runs", parameters: map[string]any{"campaign": []any{"value"}}, limit: 5, message: "must be a string"},
		{id: "campaign-runs", parameters: map[string]any{"campaign": strings.Repeat("x", 257)}, limit: 5, message: "exceeds 256 characters"},
		{id: "campaign-runs", parameters: map[string]any{"campaign": strings.Repeat("\U0001f600", 129)}, limit: 5, message: "exceeds 256 characters"},
		{id: "campaign-runs", limit: 0, message: "positive integer"},
		{id: "simulator-database-inputs", limit: 5, message: "requires parameter"},
	} {
		t.Run(tt.id+"/"+tt.message, func(t *testing.T) {
			if _, err := catalog.runQuery(context.Background(), db, tt.id, tt.parameters, tt.limit); err == nil || !strings.Contains(err.Error(), tt.message) {
				t.Fatalf("error=%v, want %q", err, tt.message)
			}
		})
	}
	catalog.index["cycle-a"] = map[string]any{"name": "cycle-a", "from": "cycle-b"}
	catalog.index["cycle-b"] = map[string]any{"name": "cycle-b", "from": "cycle-a"}
	catalog.index["absent"] = map[string]any{"name": "absent", "from": "not-a-source"}
	for _, id := range []string{"cycle-a", "absent"} {
		result, err := catalog.runQuery(context.Background(), db, id, nil, 5)
		if err != nil {
			t.Fatal(err)
		}
		metadata := nativeObject(result["metadata"])
		if metadata["availability"] != "unavailable" || nativeText(metadata["query-diagnostic"]) == "" {
			t.Fatalf("%s did not report unavailable evidence: %v", id, result)
		}
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if _, err := catalog.runQuery(ctx, db, "campaign-runs", nil, 5); !errors.Is(err, context.Canceled) {
		t.Fatalf("cancellation=%v, want context.Canceled", err)
	}
}

func TestNativeDefaultQueriesRequireDownloadedSnapshot(t *testing.T) {
	t.Chdir(t.TempDir())
	for _, args := range [][]string{
		{"query", "--collection", "runs"},
		{"query", "campaign-runs"},
		{"mcp"},
	} {
		root := NewRootCommand("test")
		var output bytes.Buffer
		root.SetOut(&output)
		root.SetErr(&output)
		root.SetArgs(args)
		if err := root.Execute(); err == nil || !strings.Contains(err.Error(), "No downloaded CAO snapshot") {
			t.Fatalf("command %v error=%v, output=%s", args, err, &output)
		}
	}
}

func TestNativeNamedQueryLimitIsExplicitlyPartial(t *testing.T) {
	file := nativeTestSnapshot(t, map[string][]map[string]any{"runs": {
		{"id": "run:a", "githubRunId": 1, "owner": "org", "repository": "repo"},
		{"id": "run:b", "githubRunId": 2, "owner": "org", "repository": "repo"},
	}})
	db, err := openNativeSnapshot(file)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if err := db.Close(); err != nil {
			t.Error(err)
		}
	})
	catalog, err := loadNativeCatalog("")
	if err != nil {
		t.Fatal(err)
	}
	result, err := catalog.runQuery(context.Background(), db, "run-import-status", nil, 1)
	if err != nil {
		t.Fatal(err)
	}
	metadata := nativeObject(result["metadata"])
	if metadata["completeness"] != "partial" || metadata["returned-rows"] != 1 || metadata["limit"] != 1 {
		t.Fatalf("bounded query did not report partial evidence: %v", result)
	}
}
