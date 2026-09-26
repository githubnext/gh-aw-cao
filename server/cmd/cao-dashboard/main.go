package main

import (
	"context"
	"encoding/json"
	"errors"
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
	"github.com/spf13/cobra"
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

// consumerNameSource identifies which input determined the resolved
// collection worker consumer name. It is useful for diagnosing
// misconfiguration without logging the name itself.
type consumerNameSource string

const (
	consumerNameSourceFlag     consumerNameSource = "flag"
	consumerNameSourceHostname consumerNameSource = "hostname"
)

// resolveConsumerName applies the standard priority for a collection worker's
// consumer name: an explicit flag value, then the machine hostname obtained
// from hostnameFunc. It returns the resolved name and which input supplied
// it, so callers can log the source without exposing the name. An error is
// returned only when the flag is empty and hostnameFunc fails.
func resolveConsumerName(flagValue string, hostnameFunc func() (string, error)) (string, consumerNameSource, error) {
	if name := strings.TrimSpace(flagValue); name != "" {
		return name, consumerNameSourceFlag, nil
	}
	hostname, err := hostnameFunc()
	if err != nil {
		return "", "", fmt.Errorf("resolve consumer name: %w", err)
	}
	return hostname, consumerNameSourceHostname, nil
}

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

// namespaceDefaultSource identifies which input determined the default value
// offered to the doctor command's --redis-namespace flag before any explicit
// flag override. It is useful for diagnosing misconfiguration without
// logging the namespace itself.
type namespaceDefaultSource string

const (
	namespaceDefaultSourceEnv      namespaceDefaultSource = "env"
	namespaceDefaultSourceCheckout namespaceDefaultSource = "checkout"
)

// resolveNamespaceDefault applies the standard priority for the doctor
// command's default Redis namespace: an explicit CAO_REDIS_NAMESPACE
// environment override, then checkoutDefault, which is normally derived from
// the working directory by redisx.DefaultNamespace. It returns the resolved
// default and which input supplied it, so callers can log the source without
// exposing the namespace value.
func resolveNamespaceDefault(envValue, checkoutDefault string) (string, namespaceDefaultSource) {
	if namespace := strings.TrimSpace(envValue); namespace != "" {
		return namespace, namespaceDefaultSourceEnv
	}
	return checkoutDefault, namespaceDefaultSourceCheckout
}

// ingestSourceOrigin identifies which input determined the ingest command's
// deployed dashboard directory. It is useful for diagnosing misconfiguration
// without logging the directory path itself.
type ingestSourceOrigin string

const (
	ingestSourceOriginFlag          ingestSourceOrigin = "flag"
	ingestSourceOriginPositionalArg ingestSourceOrigin = "positional-arg"
)

// resolveIngestSource applies the standard priority for the ingest command's
// deployed dashboard directory: an explicit --source flag value, then a
// single positional argument. It returns the resolved source and which input
// supplied it, so callers can log the source without exposing the directory
// path. An error is returned when neither input supplies a non-blank value.
func resolveIngestSource(flagValue string, positionalArgs []string) (string, ingestSourceOrigin, error) {
	if source := strings.TrimSpace(flagValue); source != "" {
		return source, ingestSourceOriginFlag, nil
	}
	if len(positionalArgs) == 1 {
		if source := strings.TrimSpace(positionalArgs[0]); source != "" {
			return source, ingestSourceOriginPositionalArg, nil
		}
	}
	return "", "", errors.New("ingest requires --source DIRECTORY")
}

// registerRedisNamespaceFlag registers a --redis-namespace flag whose default
// is the current checkout's namespace, optionally overridden by
// CAO_REDIS_NAMESPACE when applyEnvOverride is true. A namespace-detection
// failure is returned rather than applied immediately, so every other flag on
// cmd is still registered; callers must check the returned error inside RunE,
// so a user-supplied flag value never masks the original error behind an
// "unknown flag" one.
func registerRedisNamespaceFlag(cmd *cobra.Command, usage string, applyEnvOverride bool) (namespace *string, source namespaceDefaultSource, namespaceErr error) {
	checkoutNamespace, err := redisx.DefaultNamespace(".")
	defaultNamespace, defaultSource := checkoutNamespace, namespaceDefaultSourceCheckout
	if applyEnvOverride {
		defaultNamespace, defaultSource = resolveNamespaceDefault(os.Getenv("CAO_REDIS_NAMESPACE"), checkoutNamespace)
	}
	namespace = cmd.Flags().String("redis-namespace", defaultNamespace, usage)
	return namespace, defaultSource, err
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

// newRootCommand builds the cao-dashboard subcommand tree using cobra. It is
// a pure constructor (no global state, no side effects until Execute is
// called) so tests can build and execute a fresh tree per case.
func newRootCommand() *cobra.Command {
	root := &cobra.Command{
		Use:           "cao-dashboard",
		Short:         "cao-dashboard serves, ingests, and collects dashboard data",
		SilenceUsage:  true,
		SilenceErrors: true,
	}
	// The shell-completion subcommand isn't part of cao-dashboard's
	// documented interface, so keep the command surface as-is.
	root.CompletionOptions.DisableDefaultCmd = true
	root.AddCommand(
		newServeCommand(),
		newServeHostedCommand(),
		newIngestCommand(),
		newCollectCommand(),
		newBackfillCommand(),
		newDoctorCommand(),
	)
	return root
}

func run(arguments []string) error {
	root := newRootCommand()
	root.SetArgs(arguments)
	if target, _, err := root.Find(arguments); err == nil && target != root {
		commandLog.Printf("running subcommand=%s", target.Name())
	}
	return root.Execute()
}

// newDoctorCommand builds the read-only diagnostic check-up subcommand.
//
// It reports rather than repairs, and it exits non-zero when it found a
// breaking condition so it is usable as a deployment gate as well as by a
// person or an agent reading the report.
func newDoctorCommand() *cobra.Command {
	cmd := &cobra.Command{
		Use:   "doctor",
		Short: "run a read-only check-up of Redis, canonical data, queries, and collection",
	}
	redisURL := cmd.Flags().String("redis-url", "", "server-side Redis URL; defaults to CAO_REDIS_URL then "+defaultRedisURL)
	redisNamespace, namespaceDefaultSource, namespaceErr := registerRedisNamespaceFlag(cmd, "Redis key namespace", true)
	databaseQueries := cmd.Flags().String("database-queries",
		"../dashboard/site/src/data/queries/database.json", "canonical database projection queries")
	format := cmd.Flags().String("format", "text", "report format: text or json")
	deep := cmd.Flags().Bool("deep", false, "additionally read every source to confirm stored rows decode")
	strict := cmd.Flags().Bool("strict", false, "exit non-zero on warnings as well as failures")
	timeout := cmd.Flags().Duration("timeout", 10*time.Second, "per-check timeout")
	cmd.RunE = func(*cobra.Command, []string) error {
		if namespaceErr != nil {
			return namespaceErr
		}
		commandLog.Printf("doctor resolved namespace default source=%s", namespaceDefaultSource)
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
		// A client that cannot be constructed is itself a finding, so the
		// report is still produced; the Redis checks report why they could
		// not run.
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
			// main recognizes this sentinel and exits without adding a
			// redundant error line, so the report remains the whole output.
			return errDoctorFoundProblems
		}
		return nil
	}
	return cmd
}

func newServeHostedCommand() *cobra.Command {
	cmd := &cobra.Command{
		Use:   "serve-hosted",
		Short: "serve the dashboard and admit webhook deliveries",
	}
	listen := cmd.Flags().String("listen", "127.0.0.1:8080", "listen address; non-loopback listeners require TLS")
	cert := cmd.Flags().String("cert", "", "TLS certificate PEM file required for a non-loopback listener")
	key := cmd.Flags().String("key", "", "TLS private key PEM file required for a non-loopback listener")
	siteDirectory := cmd.Flags().String("site", "../dashboard/site/dist", "built dashboard site directory")
	databaseQueries := cmd.Flags().String("database-queries", "../dashboard/site/src/data/queries/database.json", "canonical database projection queries")
	dashboardQueries := cmd.Flags().String("dashboard-queries", "../dashboard/site/dashboard.json", "default dashboard query document")
	cmd.RunE = func(*cobra.Command, []string) error {
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
	return cmd
}

func newServeCommand() *cobra.Command {
	cmd := &cobra.Command{
		Use:   "serve",
		Short: "serve the dashboard from Redis",
	}
	redisURL := cmd.Flags().String("redis-url", defaultRedisURL, "server-side Redis URL")
	redisNamespace, _, namespaceErr := registerRedisNamespaceFlag(cmd, "Redis key and index namespace", false)
	siteDirectory := cmd.Flags().String("site", "../dashboard/site/dist", "built dashboard site directory")
	listen := cmd.Flags().String("listen", "127.0.0.1:8443", "HTTPS listen address")
	cert := cmd.Flags().String("cert", "", "optional TLS certificate PEM file")
	key := cmd.Flags().String("key", "", "optional TLS private key PEM file")
	accessToken := cmd.Flags().String("access-token", "", "dashboard access token (generated when omitted)")
	source := cmd.Flags().String("source", "", "deployed dashboard directory to ingest before serving")
	databaseQueries := cmd.Flags().String("database-queries", "../dashboard/site/src/data/queries/database.json", "canonical database projection queries")
	dashboardQueries := cmd.Flags().String("dashboard-queries", "../dashboard/site/dashboard.json", "default dashboard query document")
	cmd.RunE = func(*cobra.Command, []string) error {
		if namespaceErr != nil {
			return namespaceErr
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
	return cmd
}

func newIngestCommand() *cobra.Command {
	cmd := &cobra.Command{
		Use:   "ingest [source]",
		Short: "ingest a deployed dashboard directory into Redis",
	}
	redisURL := cmd.Flags().String("redis-url", defaultRedisURL, "server-side Redis URL")
	redisNamespace, _, namespaceErr := registerRedisNamespaceFlag(cmd, "Redis key and index namespace", false)
	source := cmd.Flags().String("source", "", "deployed dashboard directory")
	databaseQueries := cmd.Flags().String("database-queries", "../dashboard/site/src/data/queries/database.json", "canonical database projection queries")
	cmd.RunE = func(_ *cobra.Command, args []string) error {
		if namespaceErr != nil {
			return namespaceErr
		}
		resolvedSource, sourceOrigin, err := resolveIngestSource(*source, args)
		if err != nil {
			return err
		}
		commandLog.Printf("ingest flags parsed source_origin=%s", sourceOrigin)
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
		result, err := ingest.Run(ctx, store, resolvedSource, ingest.Options{DatabaseQueriesPath: *databaseQueries})
		if err != nil {
			return err
		}
		return json.NewEncoder(os.Stdout).Encode(result)
	}
	return cmd
}

// newCollectCommand builds the collection worker role subcommand. It is the
// same binary as the server, started with a different role, so collection
// scales independently without a second deployment artifact.
func newCollectCommand() *cobra.Command {
	cmd := &cobra.Command{
		Use:   "collect",
		Short: "lease tasks, collect repositories, and project",
	}
	databaseQueries := cmd.Flags().String("database-queries",
		"../dashboard/site/src/data/queries/database.json", "canonical database projection queries")
	consumer := cmd.Flags().String("consumer", "", "consumer name; defaults to the hostname")
	project := cmd.Flags().Bool("project", true, "participate in coalesced projection")
	cmd.RunE = func(*cobra.Command, []string) error {
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
		name, nameSource, err := resolveConsumerName(*consumer, os.Hostname)
		if err != nil {
			return err
		}
		worker := collector.Worker(name)
		worker.Project = *project
		commandLog.Printf("collect resolved consumer name source=%s", nameSource)
		log.Printf("collection worker %s started", name)
		if err := worker.Run(ctx); err != nil && ctx.Err() == nil {
			return err
		}
		return nil
	}
	return cmd
}

// newBackfillCommand builds the cold-start subcommand. It performs cold
// start and exits. It is safe to re-run: a populated evidence lake is
// replayed without GitHub requests, and enrollment and queue writes are
// idempotent.
func newBackfillCommand() *cobra.Command {
	cmd := &cobra.Command{
		Use:   "backfill",
		Short: "cold start: replay the lake, enumerate installations, seed tasks",
	}
	databaseQueries := cmd.Flags().String("database-queries",
		"../dashboard/site/src/data/queries/database.json", "canonical database projection queries")
	replayOnly := cmd.Flags().Bool("replay-only", false,
		"reproject the evidence lake without contacting GitHub")
	cmd.RunE = func(*cobra.Command, []string) error {
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
	return cmd
}
