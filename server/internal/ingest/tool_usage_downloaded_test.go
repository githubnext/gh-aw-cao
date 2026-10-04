package ingest

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/stdlib"

	"github.com/githubnext/gh-aw-cao/server/internal/postgresx"
	"github.com/githubnext/gh-aw-cao/server/internal/query"
)

func downloadedToolTestStore(t *testing.T) (context.Context, *postgresx.Store, *pgx.ConnConfig) {
	t.Helper()
	endpoint := os.Getenv("POSTGRES_URL")
	if endpoint == "" {
		t.Skip("POSTGRES_URL is unset")
	}
	ctx, cancel := context.WithTimeout(t.Context(), 5*time.Minute)
	t.Cleanup(cancel)
	config, err := pgx.ParseConfig(endpoint)
	if err != nil {
		t.Fatal(err)
	}
	admin := stdlib.OpenDB(*config.Copy())
	t.Cleanup(func() { _ = admin.Close() })
	schema := fmt.Sprintf("cao_downloaded_tools_%d", time.Now().UnixNano())
	if _, err := admin.ExecContext(ctx, "CREATE SCHEMA "+schema); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
		defer cancel()
		if _, err := admin.ExecContext(ctx, "DROP SCHEMA "+schema+" CASCADE"); err != nil {
			t.Errorf("remove downloaded Tool test schema: %v", err)
		}
	})
	config.RuntimeParams["search_path"] = schema
	store, err := postgresx.NewConfig(ctx, config)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = store.Close() })
	return ctx, store, config
}

type downloadedToolFootprint struct {
	Collection string `json:"collection"`
	Relations  int    `json:"relations"`
	Populated  int    `json:"populatedRelations"`
	HeapBytes  int64  `json:"heapBytes"`
	TableBytes int64  `json:"tableBytes"`
	IndexBytes int64  `json:"indexBytes"`
	TotalBytes int64  `json:"totalBytes"`
}

func TestDownloadedToolAggregatePrecisionAndFootprint(t *testing.T) {
	directory := os.Getenv("CAO_TEST_TOOL_DATA_DIRECTORY")
	if directory == "" {
		t.Skip("CAO_TEST_TOOL_DATA_DIRECTORY is unset")
	}
	ctx, store, config := downloadedToolTestStore(t)
	started := time.Now()
	result, err := Run(ctx, store, directory, Options{DatabaseQueriesPath: "../../../dashboard/site/src/data/queries/database.json"})
	if err != nil {
		t.Fatal(err)
	}
	ingestionDuration := time.Since(started)
	definitions, err := loadDefinitions("../../../dashboard/site/src/data/queries/database.json")
	if err != nil {
		t.Fatal(err)
	}
	definitions = append(definitions, query.Definition{
		Name: "tool-totals", From: "tools", Aggregate: &query.Aggregate{Values: []query.AggregateValue{
			{Field: "event-count", As: "events", Reducer: "sum"},
			{Field: "call-count", As: "calls", Reducer: "sum"},
			{Field: "request-bytes", As: "requests", Reducer: "sum"},
			{Field: "failed-count", As: "failures", Reducer: "sum"},
			{Field: "latency-count", As: "known-latencies", Reducer: "sum"},
		}},
	})
	started = time.Now()
	sources, metrics, err := store.ExecuteSQLPlan(ctx, definitions, []string{"tool-totals"})
	if err != nil {
		t.Fatal(err)
	}
	queryDuration := time.Since(started)
	if queryDuration > 15*time.Second {
		t.Fatalf("deployed Tool aggregate exceeded its bounded query budget: %s", queryDuration)
	}
	encoded, err := json.Marshal(sources["tool-totals"].Rows)
	if err != nil {
		t.Fatal(err)
	}
	var totals []map[string]int64
	if err := json.Unmarshal(encoded, &totals); err != nil {
		t.Fatal(err)
	}
	if len(totals) != 1 || totals[0]["events"] != 222626 || totals[0]["calls"] != 111313 ||
		totals[0]["requests"] != 74135945 || totals[0]["failures"] != 0 || totals[0]["known-latencies"] != 0 {
		t.Fatalf("deployed Tool precision changed: %s", encoded)
	}
	footprintSources, _, err := store.ExecuteSQLPlan(ctx, []query.Definition{
		{Name: "tools", From: "$tools", Aggregate: &query.Aggregate{Values: []query.AggregateValue{{Field: "id", As: "facts", Reducer: "count"}}}},
	}, []string{"tools"})
	if err != nil {
		t.Fatal(err)
	}
	diagnostics, err := store.Diagnostics(ctx)
	if err != nil {
		t.Fatal(err)
	}
	for name, expected := range map[string]int{"tools": 23740, "toolIdentities": 114, "toolCounters": 47480} {
		if diagnostics.Counts[name] != expected {
			t.Fatalf("deployed %s grain changed: got %d, want %d", name, diagnostics.Counts[name], expected)
		}
	}
	db := stdlib.OpenDB(*config.Copy())
	defer func() { _ = db.Close() }()
	rows, err := db.QueryContext(ctx, `
		WITH roots AS (
			SELECT c.oid,c.relname,c.relkind FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
			WHERE n.nspname=current_schema() AND c.relname IN ('tools','tool_identities','tool_counters','tool_evidence')
		), relations AS (
			SELECT relname,oid AS relid FROM roots WHERE relkind <> 'p'
			UNION ALL
			SELECT r.relname,p.relid FROM roots r CROSS JOIN LATERAL pg_partition_tree(r.oid) p
			WHERE r.relkind='p' AND p.isleaf
		)
		SELECT relname,count(*),count(*) FILTER (WHERE pg_relation_size(relid)>0),
			sum(pg_relation_size(relid)),sum(pg_table_size(relid)),
			sum(pg_indexes_size(relid)),sum(pg_total_relation_size(relid))
		FROM relations GROUP BY relname ORDER BY relname`)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = rows.Close() }()
	var footprint []downloadedToolFootprint
	var totalBytes int64
	for rows.Next() {
		var item downloadedToolFootprint
		if err := rows.Scan(&item.Collection, &item.Relations, &item.Populated, &item.HeapBytes,
			&item.TableBytes, &item.IndexBytes, &item.TotalBytes); err != nil {
			t.Fatal(err)
		}
		if item.Populated == 0 || item.HeapBytes <= 0 || item.IndexBytes <= 0 ||
			item.TotalBytes != item.TableBytes+item.IndexBytes {
			t.Fatalf("invalid physical Tool footprint: %+v", item)
		}
		totalBytes += item.TotalBytes
		footprint = append(footprint, item)
	}
	if err := rows.Err(); err != nil {
		t.Fatal(err)
	}
	if len(footprint) != 4 {
		t.Fatalf("physical Tool footprint omitted a supporting table: %+v", footprint)
	}
	receipt := map[string]any{"ingestion": result, "totals": totals, "metrics": metrics,
		"factCounts": footprintSources, "diagnostics": diagnostics, "footprint": footprint,
		"toolStorageBytes": totalBytes, "ingestionDurationMs": ingestionDuration.Milliseconds(),
		"queryDurationMs": queryDuration.Milliseconds()}
	data, err := json.MarshalIndent(receipt, "", "  ")
	if err != nil {
		t.Fatal(err)
	}
	if output := os.Getenv("CAO_TEST_TOOL_RECEIPT"); output != "" {
		if err := os.WriteFile(filepath.Clean(output), append(data, '\n'), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	t.Logf("verified deployed counters: %s; ingestion=%s query=%s physical Tool storage=%d bytes",
		encoded, ingestionDuration, queryDuration, totalBytes)
}
