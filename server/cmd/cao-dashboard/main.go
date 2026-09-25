package main

import (
	"context"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"log"
	"os"
	"os/signal"
	"strings"
	"syscall"
	"time"

	"github.com/githubnext/gh-aw-cao/server/internal/doctor"
	"github.com/githubnext/gh-aw-cao/server/internal/ingest"
	debuglogger "github.com/githubnext/gh-aw-cao/server/internal/logger"
	"github.com/githubnext/gh-aw-cao/server/internal/redisx"
	"github.com/githubnext/gh-aw-cao/server/internal/server"
	"github.com/githubnext/gh-aw-cao/server/internal/telemetry"
)

// version is the standardized service.version resource attribute reported by
// this build's OpenTelemetry spans. Override it at build time with
// -ldflags "-X main.version=...", or at runtime with CAO_BUILD_VERSION.
var version = "dev"

const defaultRedisURL = "redis://127.0.0.1:6379/0"

var commandLog = debuglogger.New("cao:cli")

var errDoctorFoundProblems = errors.New("doctor found problems")

// redisEndpointSource identifies which input determined a resolved Redis
// endpoint. It is useful for diagnosing misconfiguration without logging the
// endpoint URL itself.
type redisEndpointSource string

const (
	redisEndpointSourceFlag    redisEndpointSource = "flag"
	redisEndpointSourceEnv     redisEndpointSource = "env"
	redisEndpointSourceDefault redisEndpointSource = "default"
)

// resolveRedisEndpoint applies the standard priority for a server-side Redis
// URL: an explicit flag value, then an environment override, then
// defaultValue. It returns both the resolved endpoint and which input
// supplied it, so callers can log the source without exposing the URL.
func resolveRedisEndpoint(flagValue, envValue, defaultValue string) (string, redisEndpointSource) {
	if endpoint := strings.TrimSpace(flagValue); endpoint != "" {
		return endpoint, redisEndpointSourceFlag
	}
	if endpoint := strings.TrimSpace(envValue); endpoint != "" {
		return endpoint, redisEndpointSourceEnv
	}
	return defaultValue, redisEndpointSourceDefault
}

func main() {
	if override := strings.TrimSpace(os.Getenv("CAO_BUILD_VERSION")); override != "" {
		version = override
	}
	if err := run(os.Args[1:]); err != nil {
		if errors.Is(err, errDoctorFoundProblems) {
			os.Exit(1)
		}
		log.Printf("error: %v", err)
		os.Exit(1)
	}
}

func run(arguments []string) error {
	if len(arguments) == 0 {
		return errors.New(
			"usage: cao-dashboard <serve|serve-hosted|ingest|collect|backfill|doctor> [flags]")
	}
	switch arguments[0] {
	case "serve":
		commandLog.Printf("running serve command")
		return serve(arguments[1:])
	case "ingest":
		commandLog.Printf("running ingest command")
		return ingestCommand(arguments[1:])
	case "serve-hosted":
		commandLog.Printf("running hosted serve command")
		return serveHosted(arguments[1:])
	case "collect":
		commandLog.Printf("running collect command")
		return collectCommand(arguments[1:])
	case "backfill":
		commandLog.Printf("running backfill command")
		return backfillCommand(arguments[1:])
	case "doctor":
		commandLog.Printf("running doctor command")
		return doctorCommand(arguments[1:])
	default:
		return fmt.Errorf(
			"unknown subcommand %q; expected serve, serve-hosted, ingest, collect, backfill, or doctor",
			arguments[0])
	}
}

// doctorCommand runs the read-only diagnostic check-up.
//
// It reports rather than repairs, and it exits non-zero when it found a
// breaking condition so it is usable as a deployment gate as well as by a
// person or an agent reading the report.
func doctorCommand(arguments []string) error {
	flags := flag.NewFlagSet("doctor", flag.ContinueOnError)
	redisURL := flags.String("redis-url", "", "server-side Redis URL; defaults to CAO_REDIS_URL then "+defaultRedisURL)
	defaultNamespace, err := redisx.DefaultNamespace(".")
	if err != nil {
		return err
	}
	if configured := strings.TrimSpace(os.Getenv("CAO_REDIS_NAMESPACE")); configured != "" {
		defaultNamespace = configured
	}
	redisNamespace := flags.String("redis-namespace", defaultNamespace, "Redis key namespace")
	databaseQueries := flags.String("database-queries",
		"../dashboard/site/src/data/queries/database.json", "canonical database projection queries")
	format := flags.String("format", "text", "report format: text or json")
	deep := flags.Bool("deep", false, "additionally read every source to confirm stored rows decode")
	strict := flags.Bool("strict", false, "exit non-zero on warnings as well as failures")
	timeout := flags.Duration("timeout", 10*time.Second, "per-check timeout")
	if err := flags.Parse(arguments); err != nil {
		return err
	}
	endpoint, endpointSource := resolveRedisEndpoint(*redisURL, os.Getenv("CAO_REDIS_URL"), defaultRedisURL)
	commandLog.Printf("doctor resolved redis endpoint source=%s", endpointSource)
	namespace, err := redisx.NormalizeNamespace(*redisNamespace)
	if err != nil {
		return err
	}
	check := doctor.Doctor{
		RedisURL:            endpoint,
		Namespace:           namespace,
		DatabaseQueriesPath: *databaseQueries,
		Version:             version,
		Deep:                *deep,
		Timeout:             *timeout,
	}
	// A client that cannot be constructed is itself a finding, so the report
	// is still produced; the Redis checks report why they could not run.
	if client, err := redisx.New(endpoint); err == nil {
		check.Store = redisx.NewStore(client, namespace)
	} else {
		commandLog.Printf("doctor could not construct a Redis client")
	}
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	report := check.Run(ctx)
	if err := doctor.Render(os.Stdout, report, *format); err != nil {
		return err
	}
	if report.Failed(*strict) {
		// main recognizes this sentinel and exits without adding a redundant
		// error line, so the report remains the whole output.
		return errDoctorFoundProblems
	}
	return nil
}

func serveHosted(arguments []string) error {
	flags := flag.NewFlagSet("serve-hosted", flag.ContinueOnError)
	listen := flags.String("listen", "127.0.0.1:8080", "listen address; non-loopback listeners require TLS")
	cert := flags.String("cert", "", "TLS certificate PEM file required for a non-loopback listener")
	key := flags.String("key", "", "TLS private key PEM file required for a non-loopback listener")
	siteDirectory := flags.String("site", "../dashboard/site/dist", "built dashboard site directory")
	databaseQueries := flags.String("database-queries", "../dashboard/site/src/data/queries/database.json", "canonical database projection queries")
	dashboardQueries := flags.String("dashboard-queries", "../dashboard/site/dashboard.json", "default dashboard query document")
	if err := flags.Parse(arguments); err != nil {
		return err
	}
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	shutdownTelemetry, err := telemetry.Setup(ctx, version)
	if err != nil {
		return fmt.Errorf("configure telemetry: %w", err)
	}
	defer func() {
		shutdownCtx, cancel := context.WithTimeout(context.WithoutCancel(ctx), 5*time.Second)
		defer cancel()
		_ = shutdownTelemetry(shutdownCtx)
	}()
	app, err := server.NewHostedAppFromEnv(
		ctx, *listen, *cert, *key, *siteDirectory, *dashboardQueries, *databaseQueries,
		log.New(os.Stderr, "cao-dashboard: ", log.LstdFlags),
	)
	if err != nil {
		return err
	}
	return app.Serve(ctx)
}

func serve(arguments []string) error {
	flags := flag.NewFlagSet("serve", flag.ContinueOnError)
	redisURL := flags.String("redis-url", defaultRedisURL, "server-side Redis URL")
	defaultNamespace, err := redisx.DefaultNamespace(".")
	if err != nil {
		return err
	}
	redisNamespace := flags.String("redis-namespace", defaultNamespace, "Redis key and index namespace")
	siteDirectory := flags.String("site", "../dashboard/site/dist", "built dashboard site directory")
	listen := flags.String("listen", "127.0.0.1:8443", "HTTPS listen address")
	cert := flags.String("cert", "", "optional TLS certificate PEM file")
	key := flags.String("key", "", "optional TLS private key PEM file")
	accessToken := flags.String("access-token", "", "dashboard access token (generated when omitted)")
	source := flags.String("source", "", "deployed dashboard directory to ingest before serving")
	databaseQueries := flags.String("database-queries", "../dashboard/site/src/data/queries/database.json", "canonical database projection queries")
	dashboardQueries := flags.String("dashboard-queries", "../dashboard/site/dashboard.json", "default dashboard query document")
	if err := flags.Parse(arguments); err != nil {
		return err
	}
	commandLog.Printf("serve flags parsed tls=%t source_ingestion=%t", *cert != "", *source != "")
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	shutdownTelemetry, err := telemetry.Setup(ctx, version)
	if err != nil {
		return fmt.Errorf("configure telemetry: %w", err)
	}
	defer func() {
		shutdownCtx, cancel := context.WithTimeout(context.WithoutCancel(ctx), 5*time.Second)
		defer cancel()
		_ = shutdownTelemetry(shutdownCtx)
	}()
	client, err := redisx.New(*redisURL)
	if err != nil {
		return err
	}
	namespace, err := redisx.NormalizeNamespace(*redisNamespace)
	if err != nil {
		return err
	}
	definitions, err := server.ParseDashboardQueries(*dashboardQueries)
	if err != nil {
		return err
	}
	app, err := server.New(redisx.NewStore(client, namespace), server.Config{
		Listen:              *listen,
		SiteDirectory:       *siteDirectory,
		CertFile:            *cert,
		KeyFile:             *key,
		AccessToken:         *accessToken,
		SourceDirectory:     *source,
		DatabaseQueriesPath: *databaseQueries,
		DashboardQueries:    definitions,
		Logger:              log.New(os.Stderr, "cao-dashboard: ", log.LstdFlags),
	})
	if err != nil {
		return err
	}
	return app.Serve(ctx)
}

func ingestCommand(arguments []string) error {
	flags := flag.NewFlagSet("ingest", flag.ContinueOnError)
	redisURL := flags.String("redis-url", defaultRedisURL, "server-side Redis URL")
	defaultNamespace, err := redisx.DefaultNamespace(".")
	if err != nil {
		return err
	}
	redisNamespace := flags.String("redis-namespace", defaultNamespace, "Redis key and index namespace")
	source := flags.String("source", "", "deployed dashboard directory")
	databaseQueries := flags.String("database-queries", "../dashboard/site/src/data/queries/database.json", "canonical database projection queries")
	if err := flags.Parse(arguments); err != nil {
		return err
	}
	if *source == "" && flags.NArg() == 1 {
		*source = flags.Arg(0)
	}
	if *source == "" {
		return errors.New("ingest requires --source DIRECTORY")
	}
	commandLog.Printf("ingest flags parsed")
	client, err := redisx.New(*redisURL)
	if err != nil {
		return err
	}
	namespace, err := redisx.NormalizeNamespace(*redisNamespace)
	if err != nil {
		return err
	}
	store := redisx.NewStore(client, namespace)
	ctx := context.Background()
	shutdownTelemetry, err := telemetry.Setup(ctx, version)
	if err != nil {
		return fmt.Errorf("configure telemetry: %w", err)
	}
	defer func() {
		shutdownCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		_ = shutdownTelemetry(shutdownCtx)
	}()
	if err := store.Ping(ctx); err != nil {
		return errors.New("redis is unavailable")
	}
	result, err := ingest.Run(ctx, store, *source, ingest.Options{DatabaseQueriesPath: *databaseQueries})
	if err != nil {
		return err
	}
	return json.NewEncoder(os.Stdout).Encode(result)
}

// collectCommand runs the collection worker role. It is the same binary as the
// server, started with a different role, so collection scales independently
// without a second deployment artifact.
func collectCommand(arguments []string) error {
	flags := flag.NewFlagSet("collect", flag.ContinueOnError)
	databaseQueries := flags.String("database-queries",
		"../dashboard/site/src/data/queries/database.json", "canonical database projection queries")
	consumer := flags.String("consumer", "", "consumer name; defaults to the hostname")
	project := flags.Bool("project", true, "participate in coalesced projection")
	if err := flags.Parse(arguments); err != nil {
		return err
	}
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	shutdownTelemetry, err := telemetry.Setup(ctx, version)
	if err != nil {
		return fmt.Errorf("configure telemetry: %w", err)
	}
	defer func() {
		shutdownCtx, cancel := context.WithTimeout(context.WithoutCancel(ctx), 5*time.Second)
		defer cancel()
		_ = shutdownTelemetry(shutdownCtx)
	}()
	collector, err := server.NewCollectorFromEnv(ctx, *databaseQueries)
	if err != nil {
		return err
	}
	name := strings.TrimSpace(*consumer)
	if name == "" {
		hostname, err := os.Hostname()
		if err != nil {
			return fmt.Errorf("resolve consumer name: %w", err)
		}
		name = hostname
	}
	worker := collector.Worker(name)
	worker.Project = *project
	log.Printf("collection worker %s started", name)
	if err := worker.Run(ctx); err != nil && ctx.Err() == nil {
		return err
	}
	return nil
}

// backfillCommand performs cold start and exits. It is safe to re-run: a
// populated evidence lake is replayed without GitHub requests, and enrollment
// and queue writes are idempotent.
func backfillCommand(arguments []string) error {
	flags := flag.NewFlagSet("backfill", flag.ContinueOnError)
	databaseQueries := flags.String("database-queries",
		"../dashboard/site/src/data/queries/database.json", "canonical database projection queries")
	replayOnly := flags.Bool("replay-only", false,
		"reproject the evidence lake without contacting GitHub")
	if err := flags.Parse(arguments); err != nil {
		return err
	}
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	collector, err := server.NewCollectorFromEnv(ctx, *databaseQueries)
	if err != nil {
		return err
	}
	backfill := collector.Backfill()
	if *replayOnly {
		result, err := backfill.Replay(ctx)
		if err != nil {
			return err
		}
		log.Printf("replayed evidence lake revision=%d", result.Revision)
		return nil
	}
	state, err := backfill.Run(ctx)
	if err != nil {
		return err
	}
	report, err := json.MarshalIndent(state, "", "  ")
	if err != nil {
		return err
	}
	fmt.Println(string(report))
	return nil
}
