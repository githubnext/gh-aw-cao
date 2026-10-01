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
	"github.com/githubnext/gh-aw-cao/server/internal/model"
	"github.com/githubnext/gh-aw-cao/server/internal/postgresx"
	"github.com/githubnext/gh-aw-cao/server/internal/query"
	"github.com/githubnext/gh-aw-cao/server/internal/server"
)

type benchmarkLoader struct {
	ctx   context.Context
	store *postgresx.Store
}

func (loader benchmarkLoader) LoadSource(name string, definition *query.Definition) (model.Source, model.Metrics, error) {
	source, metrics, err := loader.store.LoadSource(loader.ctx, name, definition)
	if errors.Is(err, postgresx.ErrSourceUnavailable) {
		// Match the server loader: optional logical sources are unavailable,
		// not a fatal Postgres read error.
		return model.Source{Source: name, Rows: []model.Row{}, Metadata: model.Metadata{
			"source-id": name, "availability": "unavailable",
			"completeness": "unknown", "freshness": "unknown",
		}}, metrics, nil
	}
	return source, metrics, err
}

type benchmarkMeasurement struct {
	Query      string        `json:"query"`
	DurationMS float64       `json:"duration-ms"`
	Metrics    model.Metrics `json:"metrics"`
	Rows       int           `json:"rows"`
}

type benchmarkReport struct {
	Engine       string                 `json:"engine"`
	SourceCounts map[string]int         `json:"source-counts"`
	Records      int                    `json:"records"`
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

func benchmarkPostgresConfig(endpoint string) (*pgx.ConnConfig, error) {
	config, err := pgx.ParseConfig(endpoint)
	if err != nil {
		return nil, errors.New("invalid benchmark Postgres configuration")
	}
	local := func(host string) bool {
		if filepath.IsAbs(host) {
			return true // pgx treats an absolute host path as a Unix socket directory.
		}
		addr, err := netip.ParseAddr(host)
		return err == nil && addr.IsLoopback()
	}
	if !local(config.Host) {
		return nil, errors.New("benchmark Postgres endpoint must be loopback or a Unix socket")
	}
	for _, fallback := range config.Fallbacks {
		if fallback == nil || !local(fallback.Host) {
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

func benchmarkQueries(ctx context.Context, store *postgresx.Store, source, databasePath, dashboardPath string, candidates []string) (benchmarkReport, error) {
	report := benchmarkReport{Engine: "postgres-go", Measurements: []benchmarkMeasurement{}}
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
	definitions := append([]query.Definition{}, database...)
	definitions = append(definitions, dashboard...)
	server.ResolveQueryContext(definitions, result.EvaluatedAt)
	defined := make(map[string]bool, len(dashboard))
	for _, definition := range dashboard {
		defined[definition.Name] = true
	}
	for _, name := range candidates {
		if !defined[name] {
			return report, fmt.Errorf("query %q is not declared in the dashboard", name)
		}
		started := time.Now()
		sources, metrics, err := query.New(benchmarkLoader{ctx: ctx, store: store}).Execute(definitions, []string{name})
		if err != nil {
			return report, fmt.Errorf("query %q failed: %w", name, err)
		}
		source, ok := sources[name]
		if !ok || source.Metadata["availability"] == "unavailable" {
			return report, fmt.Errorf("query %q unavailable", name)
		}
		report.Measurements = append(report.Measurements, benchmarkMeasurement{
			Query: name, DurationMS: float64(time.Since(started).Microseconds()) / 1000,
			Metrics: metrics, Rows: len(source.Rows),
		})
	}
	return report, nil
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
		if *source == "" || *candidatesPath == "" {
			return errors.New("--source and --candidates are required")
		}
		content, err := os.ReadFile(*candidatesPath)
		if err != nil {
			return fmt.Errorf("read candidates: %w", err)
		}
		var candidates []string
		if err := json.Unmarshal(content, &candidates); err != nil {
			return fmt.Errorf("parse candidates: %w", err)
		}
		if len(candidates) == 0 {
			return errors.New("no query candidates selected")
		}
		endpoint, err := resolvePostgresEndpoint(*postgresURL, os.Getenv("CAO_POSTGRES_URL"))
		if err != nil {
			return err
		}
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
