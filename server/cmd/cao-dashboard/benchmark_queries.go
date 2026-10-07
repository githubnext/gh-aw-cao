package main

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"net/netip"
	"os"
	"path/filepath"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/spf13/cobra"

	"github.com/githubnext/gh-aw-cao/server/internal/ingest"
	debuglogger "github.com/githubnext/gh-aw-cao/server/internal/logger"
	"github.com/githubnext/gh-aw-cao/server/internal/model"
	"github.com/githubnext/gh-aw-cao/server/internal/postgresx"
	"github.com/githubnext/gh-aw-cao/server/internal/query"
	"github.com/githubnext/gh-aw-cao/server/internal/server"
)

var benchmarkLog = debuglogger.New("cao:dashboard:benchmark")

const benchmarkPageLimit = 500

type benchmarkMeasurement struct {
	Query      string        `json:"query"`
	DurationMS float64       `json:"duration-ms"`
	Metrics    model.Metrics `json:"metrics"`
	Rows       int           `json:"rows"`
	TotalRows  int           `json:"total-rows"`
}

type benchmarkReport struct {
	Engine       string                 `json:"engine"`
	SourceCounts map[string]int         `json:"source-counts"`
	Records      int                    `json:"records"`
	PageLimit    int                    `json:"page-limit"`
	Measurements []benchmarkMeasurement `json:"measurements"`
}

func validateBenchmarkEvidence(counts map[string]int) (int, error) {
	records := 0
	for _, count := range counts {
		records += count
	}
	if records == 0 || counts["$runs"] == 0 {
		return records, errors.New("deployed Postgres projection is empty")
	}
	return records, nil
}

// benchmarkPostgresRejectionStage identifies which stage of
// benchmarkPostgresConfig's local-only validation failed, so a
// misconfigured --postgres-url or CAO_POSTGRES_URL is diagnosable without
// logging the endpoint itself, which can contain credentials.
type benchmarkPostgresRejectionStage string

const (
	benchmarkPostgresRejectionStageParse    benchmarkPostgresRejectionStage = "parse"
	benchmarkPostgresRejectionStagePrimary  benchmarkPostgresRejectionStage = "primary-host"
	benchmarkPostgresRejectionStageFallback benchmarkPostgresRejectionStage = "fallback-host"
)

// isLocalPostgresHost reports whether host is safe for the benchmark
// command to connect to: a Unix socket directory (an absolute path) or a
// loopback IP address. It is a pure function extracted from
// benchmarkPostgresConfig's inline closure so the loopback-versus-remote
// decision is independently testable against host strings, without
// constructing a pgx.ConnConfig.
func isLocalPostgresHost(host string) bool {
	if filepath.IsAbs(host) {
		return true // pgx treats an absolute host path as a Unix socket directory.
	}
	addr, err := netip.ParseAddr(host)
	return err == nil && addr.IsLoopback()
}

func benchmarkPostgresConfig(endpoint string) (*pgx.ConnConfig, error) {
	config, err := pgx.ParseConfig(endpoint)
	if err != nil {
		benchmarkLog.Printf("benchmark postgres config rejected stage=%s", benchmarkPostgresRejectionStageParse)
		return nil, errors.New("invalid benchmark Postgres configuration")
	}
	if !isLocalPostgresHost(config.Host) {
		benchmarkLog.Printf("benchmark postgres config rejected stage=%s", benchmarkPostgresRejectionStagePrimary)
		return nil, errors.New("benchmark Postgres endpoint must be loopback or a Unix socket")
	}
	for _, fallback := range config.Fallbacks {
		if fallback == nil || !isLocalPostgresHost(fallback.Host) {
			benchmarkLog.Printf("benchmark postgres config rejected stage=%s", benchmarkPostgresRejectionStageFallback)
			return nil, errors.New("benchmark Postgres fallback must be loopback or a Unix socket")
		}
	}
	return config, nil
}

func newBenchmarkNamespace() (string, error) {
	var id [16]byte
	if _, err := rand.Read(id[:]); err != nil {
		return "", errors.New("cannot create benchmark namespace")
	}
	return "query_cost_benchmark_" + hex.EncodeToString(id[:]), nil
}

// mergeBenchmarkDefinitions combines the canonical database queries with the
// dashboard's declared queries and reports which names the dashboard
// declares. Candidates outside that declared set must fail closed before any
// Postgres work runs.
func mergeBenchmarkDefinitions(database, dashboard []query.Definition) ([]query.Definition, map[string]bool) {
	definitions := append([]query.Definition{}, database...)
	definitions = append(definitions, dashboard...)
	defined := make(map[string]bool, len(dashboard))
	for _, definition := range dashboard {
		defined[definition.Name] = true
	}
	return definitions, defined
}

// validateBenchmarkCandidates reports the first candidate not declared by the
// dashboard, so callers can fail before issuing any Postgres query.
func validateBenchmarkCandidates(candidates []string, defined map[string]bool) error {
	for _, name := range candidates {
		if !defined[name] {
			return fmt.Errorf("query %q is not declared in the dashboard", name)
		}
	}
	return nil
}

func benchmarkQueries(ctx context.Context, store *postgresx.Store, source, databasePath, dashboardPath string, candidates []string) (benchmarkReport, error) {
	report := benchmarkReport{Engine: "postgres-native-sql", PageLimit: benchmarkPageLimit, Measurements: []benchmarkMeasurement{}}
	if len(candidates) == 0 {
		return report, errors.New("no query candidates selected")
	}
	result, err := ingest.Run(ctx, store, source, ingest.Options{DatabaseQueriesPath: databasePath})
	if err != nil {
		return report, fmt.Errorf("ingest deployed artifacts: %w", err)
	}
	report.SourceCounts = result.Counts
	report.Records, err = validateBenchmarkEvidence(result.Counts)
	if err != nil {
		return report, err
	}
	database, err := server.ParseDashboardQueries(databasePath)
	if err != nil {
		return report, fmt.Errorf("parse database queries: %w", err)
	}
	dashboard, err := server.ParseDashboardQueries(dashboardPath)
	if err != nil {
		return report, fmt.Errorf("parse dashboard queries: %w", err)
	}
	definitions, defined := mergeBenchmarkDefinitions(database, dashboard)
	server.ResolveQueryContext(definitions, result.EvaluatedAt)
	if err := validateBenchmarkCandidates(candidates, defined); err != nil {
		return report, err
	}
	benchmarkLog.Printf("benchmark starting candidates=%d records=%d", len(candidates), report.Records)
	for _, name := range candidates {
		started := time.Now()
		var sources map[string]model.Source
		var metrics model.Metrics
		err := store.WithReadTransaction(ctx, func(ctx context.Context, reader postgresx.NativeReader) error {
			var err error
			sources, metrics, err = reader.ExecuteSQLPlanWithOptions(ctx, definitions, []string{name}, postgresx.SQLExecutionOptions{
				Pages: map[string]postgresx.SQLPage{name: {Limit: benchmarkPageLimit}},
				ResourceLimits: &postgresx.SQLResourceLimits{
					MaxInputRows:    query.MaxWorkingRows,
					MaxOperations:   10 * query.MaxOperations,
					MaxWorkingBytes: 4 * query.MaxWorkingBytes,
				},
			})
			return err
		})
		if err != nil {
			return report, fmt.Errorf("query %q failed: %w", name, err)
		}
		source, ok := sources[name]
		if !ok || source.Metadata["availability"] == "unavailable" {
			return report, fmt.Errorf("query %q unavailable", name)
		}
		totalRows, ok := source.Metadata["total-row-count"].(int)
		if !ok || totalRows < len(source.Rows) {
			return report, fmt.Errorf("query %q has invalid page cardinality", name)
		}
		report.Measurements = append(report.Measurements, benchmarkMeasurement{
			Query: name, DurationMS: float64(time.Since(started).Microseconds()) / 1000,
			Metrics: metrics, Rows: len(source.Rows), TotalRows: totalRows,
		})
	}
	benchmarkLog.Printf("benchmark completed measurements=%d", len(report.Measurements))
	return report, nil
}

// benchmarkFlagFailure identifies which required benchmark-queries flag was
// left blank, so a misconfigured invocation is diagnosable without logging
// the operator-supplied flag values themselves (the source directory and
// candidates path).
type benchmarkFlagFailure string

const (
	benchmarkFlagFailureNone       benchmarkFlagFailure = "none"
	benchmarkFlagFailureSource     benchmarkFlagFailure = "source"
	benchmarkFlagFailureCandidates benchmarkFlagFailure = "candidates"
)

// validateBenchmarkFlags applies benchmark-queries' required-flag
// precondition: both --source and --candidates must be non-empty. It is a
// pure function extracted from newBenchmarkQueriesCommand's RunE closure, so
// each missing-flag case is independently testable without constructing a
// cobra command. --source is checked first, matching the combined error
// message's ordering.
func validateBenchmarkFlags(source, candidatesPath string) (benchmarkFlagFailure, error) {
	switch {
	case source == "":
		return benchmarkFlagFailureSource, errors.New("--source and --candidates are required")
	case candidatesPath == "":
		return benchmarkFlagFailureCandidates, errors.New("--source and --candidates are required")
	default:
		return benchmarkFlagFailureNone, nil
	}
}

// loadBenchmarkCandidates reads and decodes the --candidates JSON file into a
// non-empty list of query names. It is a pure, testable boundary extracted
// from newBenchmarkQueriesCommand's RunE closure, so the read, decode, and
// empty-list failure modes are each exercised directly against a real
// temporary file instead of through a constructed cobra command.
func loadBenchmarkCandidates(path string) ([]string, error) {
	content, err := os.ReadFile(path) // #nosec G304 -- the operator explicitly supplies the local candidates path.
	if err != nil {
		benchmarkLog.Printf("benchmark candidates load failed stage=read")
		return nil, fmt.Errorf("read candidates: %w", err)
	}
	var candidates []string
	if err := json.Unmarshal(content, &candidates); err != nil {
		benchmarkLog.Printf("benchmark candidates load failed stage=decode")
		return nil, fmt.Errorf("parse candidates: %w", err)
	}
	if len(candidates) == 0 {
		benchmarkLog.Printf("benchmark candidates load failed stage=empty")
		return nil, errors.New("no query candidates selected")
	}
	benchmarkLog.Printf("benchmark candidates loaded count=%d", len(candidates))
	return candidates, nil
}

func newBenchmarkQueriesCommand() *cobra.Command {
	cmd := &cobra.Command{
		Use:   "benchmark-queries",
		Short: "measure dashboard queries over deployed artifacts in Postgres",
		Args:  cobra.NoArgs,
	}
	source := cmd.Flags().String("source", "", "downloaded deployed artifact directory")
	databaseQueries := cmd.Flags().String("database-queries", "../dashboard/site/src/data/queries/database.json", "canonical database queries")
	dashboardQueries := cmd.Flags().String("dashboard-queries", "../dashboard/site/dashboard.json", "dashboard query document")
	candidatesPath := cmd.Flags().String("candidates", "", "JSON array of query names selected by the static evaluator")
	postgresURL := cmd.Flags().String("postgres-url", "", "Postgres URL; defaults to CAO_POSTGRES_URL")
	cmd.RunE = func(*cobra.Command, []string) (runErr error) {
		if failure, err := validateBenchmarkFlags(*source, *candidatesPath); err != nil {
			benchmarkLog.Printf("benchmark flag validation failed flag=%s", failure)
			return err
		}
		candidates, err := loadBenchmarkCandidates(*candidatesPath)
		if err != nil {
			return err
		}
		endpoint, endpointSource, err := resolvePostgresEndpoint(*postgresURL, os.Getenv("CAO_POSTGRES_URL"))
		if err != nil {
			return err
		}
		benchmarkLog.Printf("benchmark postgres endpoint resolved source=%s", endpointSource)
		config, err := benchmarkPostgresConfig(endpoint)
		if err != nil {
			return err
		}
		namespace, err := newBenchmarkNamespace()
		if err != nil {
			return err
		}
		ctx, cancel := context.WithTimeout(context.Background(), 20*time.Minute)
		defer cancel()
		store, err := postgresx.NewConfig(ctx, config, namespace)
		if err != nil {
			return errors.New("benchmark Postgres is unavailable")
		}
		defer func() { _ = store.Close() }()
		defer func() {
			cleanupCtx, cleanupCancel := context.WithTimeout(context.Background(), 30*time.Second)
			defer cleanupCancel()
			if err := store.DeleteNamespace(cleanupCtx); err != nil {
				runErr = errors.Join(runErr, errors.New("benchmark namespace cleanup failed"))
			}
		}()
		report, err := benchmarkQueries(ctx, store, *source, *databaseQueries, *dashboardQueries, candidates)
		if err != nil {
			return err
		}
		return json.NewEncoder(os.Stdout).Encode(report)
	}
	return cmd
}
