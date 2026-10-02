package main

import (
	"context"
	"os"
	"regexp"
	"strings"
	"testing"
	"time"

	"github.com/githubnext/gh-aw-cao/server/internal/model"
	"github.com/githubnext/gh-aw-cao/server/internal/postgresx"
	"github.com/githubnext/gh-aw-cao/server/internal/query"
)

func TestMergeBenchmarkDefinitionsDeclaresDashboardNames(t *testing.T) {
	database := []query.Definition{{Name: "runs-base", From: "$runs"}}
	dashboard := []query.Definition{{Name: "overview", From: "runs-base"}, {Name: "cso-summary", From: "runs-base"}}

	definitions, defined := mergeBenchmarkDefinitions(database, dashboard)

	if len(definitions) != len(database)+len(dashboard) {
		t.Fatalf("expected %d merged definitions, got %d", len(database)+len(dashboard), len(definitions))
	}
	if defined["runs-base"] {
		t.Fatal("database-only queries must not be in the declared candidate set")
	}
	if !defined["overview"] || !defined["cso-summary"] {
		t.Fatalf("expected dashboard queries to be declared, got %+v", defined)
	}
}

func TestValidateBenchmarkCandidatesRejectsUndeclared(t *testing.T) {
	defined := map[string]bool{"overview": true}

	if err := validateBenchmarkCandidates([]string{"overview"}, defined); err != nil {
		t.Fatalf("expected declared candidate to pass, got %v", err)
	}
	err := validateBenchmarkCandidates([]string{"overview", "not-a-dashboard-query"}, defined)
	if err == nil || !strings.Contains(err.Error(), "not-a-dashboard-query") {
		t.Fatalf("expected an undeclared-candidate error naming the query, got %v", err)
	}
}

func TestBenchmarkPostgresConfigLocalOnly(t *testing.T) {
	for _, tc := range []struct {
		name, endpoint string
		allowed        bool
	}{
		{"ipv4", "postgres://user@127.0.0.1:5432/cao?sslmode=disable", true},
		{"ipv6", "postgres://user@[::1]:5432/cao?sslmode=disable", true},
		{"unix socket", "host=/var/run/postgresql dbname=cao", true},
		{"remote TLS", "host=db.example.com user=secret sslmode=require", false},
		{"remote IP", "host=192.0.2.1 sslmode=require", false},
		{"localhost DNS", "host=localhost", false},
		{"remote fallback", "host=127.0.0.1,db.example.com sslmode=require", false},
		{"remote fallback IP", "host=127.0.0.1,192.0.2.1 sslmode=require", false},
		{"invalid", "postgres://bad host/cao", false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			_, err := benchmarkPostgresConfig(tc.endpoint)
			if (err == nil) != tc.allowed {
				t.Fatalf("allowed=%t, error=%v", tc.allowed, err)
			}
			if err != nil && strings.Contains(err.Error(), "secret") {
				t.Fatal("error leaked credentials")
			}
		})
	}
}

func TestBenchmarkPostgresConfigRejectsRemoteEnvironmentFallback(t *testing.T) {
	t.Setenv("PGHOST", "db.example.com")
	if _, err := benchmarkPostgresConfig("dbname=cao"); err == nil {
		t.Fatal("environment-provided remote host must be rejected")
	}
}

func TestBenchmarkNamespaceUnique(t *testing.T) {
	first, err := newBenchmarkNamespace()
	if err != nil {
		t.Fatal(err)
	}
	second, err := newBenchmarkNamespace()
	if err != nil {
		t.Fatal(err)
	}
	if first == second || !regexp.MustCompile(`^query_cost_benchmark_[0-9a-f]{32}$`).MatchString(first) {
		t.Fatalf("expected distinct random benchmark namespaces, got %q and %q", first, second)
	}
}

func TestBenchmarkQueriesRequiresCandidates(t *testing.T) {
	_, err := benchmarkQueries(t.Context(), nil, "", "", "", nil)
	if err == nil || !strings.Contains(err.Error(), "no query candidates") {
		t.Fatalf("expected an empty candidate error, got %v", err)
	}
}

func TestBenchmarkQueriesRejectsEmptyEvidence(t *testing.T) {
	for _, counts := range []map[string]int{{}, {"$runs": 0, "$repositories": 20}} {
		if _, err := validateBenchmarkEvidence(counts); err == nil {
			t.Fatalf("empty run data must fail closed: %+v", counts)
		}
	}
	if records, err := validateBenchmarkEvidence(map[string]int{"$runs": 2, "$repositories": 3}); err != nil || records != 5 {
		t.Fatalf("expected nonempty projection, got records=%d err=%v", records, err)
	}
}

func TestBenchmarkQueriesWithDeployedSubset(t *testing.T) {
	url := os.Getenv("POSTGRES_URL")
	if url == "" {
		t.Skip("POSTGRES_URL is not set")
	}
	if _, err := benchmarkPostgresConfig(url); err != nil {
		t.Skip("POSTGRES_URL is not a local test instance")
	}
	ctx, cancel := context.WithTimeout(t.Context(), 90*time.Second)
	defer cancel()
	namespace, err := newBenchmarkNamespace()
	if err != nil {
		t.Fatal(err)
	}
	store, err := postgresx.NewWithNamespace(ctx, url, namespace)
	if err != nil {
		t.Fatal("cannot initialize test Postgres")
	}
	defer func() { _ = store.Close() }()
	defer func() {
		if err := store.DeleteNamespace(context.Background()); err != nil {
			t.Errorf("cleanup benchmark namespace: %v", err)
		}
	}()
	databasePath := "../../../dashboard/site/src/data/queries/database.json"
	dashboardPath := "../../../dashboard/site/src/agent/queries.generated.json"
	source := "../../testdata/deployed-subset"
	report, err := benchmarkQueries(ctx, store, source, databasePath, dashboardPath, []string{"repository-activity"})
	if err != nil {
		t.Fatal(err)
	}

	if report.Engine != "postgres-go" || report.Records == 0 || report.SourceCounts["$runs"] == 0 {
		t.Fatalf("invalid Postgres ingestion report: %+v", report)
	}

	if len(report.Measurements) != 1 || report.Measurements[0].Query != "repository-activity" ||
		report.Measurements[0].DurationMS < 0 || report.Measurements[0].Metrics.QueryCount == 0 {
		t.Fatalf("missing production Go query metrics: %+v", report.Measurements)
	}
	if _, err := benchmarkQueries(ctx, store, source, databasePath, dashboardPath, []string{"not-a-dashboard-query"}); err == nil {
		t.Fatal("unknown candidate must fail closed")
	}
}

func TestBenchmarkCleanupPreservesOtherNamespaces(t *testing.T) {
	url := os.Getenv("POSTGRES_URL")
	if url == "" {
		t.Skip("POSTGRES_URL is not set")
	}
	if _, err := benchmarkPostgresConfig(url); err != nil {
		t.Skip("POSTGRES_URL is not a local test instance")
	}
	ctx, cancel := context.WithTimeout(t.Context(), 30*time.Second)
	defer cancel()
	one, err := newBenchmarkNamespace()
	if err != nil {
		t.Fatal(err)
	}
	two, err := newBenchmarkNamespace()
	if err != nil {
		t.Fatal(err)
	}
	first, err := postgresx.NewWithNamespace(ctx, url, one)
	if err != nil {
		t.Fatal("cannot initialize test Postgres")
	}
	defer func() { _ = first.Close() }()
	defer func() { _ = first.DeleteNamespace(context.Background()) }()
	second, err := postgresx.NewWithNamespace(ctx, url, two)
	if err != nil {
		t.Fatal("cannot initialize test Postgres")
	}
	defer func() { _ = second.Close() }()
	defer func() { _ = second.DeleteNamespace(context.Background()) }()
	for _, store := range []*postgresx.Store{first, second} {
		if _, err := store.Replace(ctx, map[string]model.Source{"$runs": {
			Source: "$runs", Rows: []model.Row{{"id": "test"}},
		}}, model.Diagnostics{}, "benchmark-test", time.Now()); err != nil {
			t.Fatal(err)
		}
	}
	if err := first.DeleteNamespace(ctx); err != nil {
		t.Fatal(err)
	}
	state, err := first.State(ctx)
	if err != nil || state.Ready {
		t.Fatalf("deleted namespace still ready: %+v, %v", state, err)
	}
	state, err = second.State(ctx)
	if err != nil || !state.Ready || state.Counts["$runs"] != 1 {
		t.Fatalf("other namespace was damaged: %+v, %v", state, err)
	}
}
