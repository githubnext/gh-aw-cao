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

	"github.com/spf13/cobra"

	"github.com/githubnext/gh-aw-cao/server/internal/doctor"
	"github.com/githubnext/gh-aw-cao/server/internal/ingest"
	debuglogger "github.com/githubnext/gh-aw-cao/server/internal/logger"
	"github.com/githubnext/gh-aw-cao/server/internal/postgresx"
	"github.com/githubnext/gh-aw-cao/server/internal/redisx"
	"github.com/githubnext/gh-aw-cao/server/internal/server"
	"github.com/githubnext/gh-aw-cao/server/internal/telemetry"
)

// version is the standardized service.version resource attribute reported by
// this build's OpenTelemetry spans. Override it at build time with
// -ldflags "-X main.version=...", or at runtime with CAO_BUILD_VERSION.
var version = "dev"
var revision = "unknown"

const defaultRedisURL = "redis://127.0.0.1:6379/0"

var commandLog = debuglogger.New("cao:cli")

var errDoctorFoundProblems = errors.New("doctor found problems")
var errTelemetrySmokeFailed = errors.New("OpenTelemetry smoke test failed")

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

// postgresEndpointSource identifies which input determined a resolved
// Postgres endpoint. It is useful for diagnosing misconfiguration without
// logging the endpoint URL itself, which can contain credentials.
type postgresEndpointSource string

const (
	postgresEndpointSourceFlag postgresEndpointSource = "flag"
	postgresEndpointSourceEnv  postgresEndpointSource = "env"
)

// resolvePostgresEndpoint requires an explicit flag or environment value; never
// include the endpoint in errors or logs because it can contain credentials.
// It returns which input supplied the endpoint, so callers can log the
// source without exposing the value.
func resolvePostgresEndpoint(flagValue, envValue string) (string, postgresEndpointSource, error) {
	if endpoint := strings.TrimSpace(flagValue); endpoint != "" {
		return endpoint, postgresEndpointSourceFlag, nil
	}
	if endpoint := strings.TrimSpace(envValue); endpoint != "" {
		return endpoint, postgresEndpointSourceEnv, nil
	}
	return "", "", errors.New("--postgres-url or CAO_POSTGRES_URL is required")
}

func newPostgresStore(ctx context.Context, flagValue, namespace string) (*postgresx.Store, error) {
	endpoint, source, err := resolvePostgresEndpoint(flagValue, os.Getenv("CAO_POSTGRES_URL"))
	if err != nil {
		return nil, err
	}
	commandLog.Printf("postgres endpoint resolved source=%s", source)
	store, err := postgresx.NewWithNamespace(ctx, endpoint, namespace)
	if err != nil {
		return nil, errors.New("postgres is unavailable")
	}
	return store, nil
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

// checkoutNamespaceDefault resolves this checkout's default Redis namespace
// once, so both --redis-namespace registration paths below share the same
// lookup instead of each calling redisx.DefaultNamespace independently. A
// resolution failure is logged at this shared boundary, without exposing
// the namespace value itself, so it is diagnosed the same way regardless of
// which subcommand registered the flag.
func checkoutNamespaceDefault() (string, error) {
	namespace, err := redisx.DefaultNamespace(".")
	if err != nil {
		commandLog.Printf("checkout namespace default resolution failed")
		return "", err
	}
	return namespace, nil
}

// registerRedisNamespaceFlag registers a --redis-namespace flag whose default
// is the current checkout's namespace. A namespace-detection failure is
// returned rather than applied immediately, so every other flag on cmd is
// still registered; callers must check the returned error inside RunE, so a
// user-supplied flag value never masks the original error behind an
// "unknown flag" one.
func registerRedisNamespaceFlag(cmd *cobra.Command, usage string) (namespace *string, namespaceErr error) {
	checkoutNamespace, err := checkoutNamespaceDefault()
	namespace = cmd.Flags().String("redis-namespace", checkoutNamespace, usage)
	return namespace, err
}

// registerRedisNamespaceFlagWithEnvOverride behaves like
// registerRedisNamespaceFlag, but the default is additionally overridable by
// the CAO_REDIS_NAMESPACE environment variable. It also returns which input
// supplied that default, so callers can log the source without exposing the
// namespace value.
func registerRedisNamespaceFlagWithEnvOverride(cmd *cobra.Command, usage string) (namespace *string, source namespaceDefaultSource, namespaceErr error) {
	checkoutNamespace, err := checkoutNamespaceDefault()
	defaultNamespace, defaultSource := resolveNamespaceDefault(os.Getenv("CAO_REDIS_NAMESPACE"), checkoutNamespace)
	namespace = cmd.Flags().String("redis-namespace", defaultNamespace, usage)
	return namespace, defaultSource, err
}

// newRedisStore builds a redisx.Store from a raw Redis URL and namespace,
// consolidating the client-then-namespace-then-store construction repeated
// by every subcommand that talks to Redis directly. It logs only which
// construction stage failed, so no URL or namespace value reaches the log.
func newRedisStore(rawURL, rawNamespace string) (*redisx.Store, error) {
	client, err := redisx.New(rawURL)
	if err != nil {
		commandLog.Printf("redis store construction failed stage=client")
		return nil, err
	}
	namespace, err := redisx.NormalizeNamespace(rawNamespace)
	if err != nil {
		commandLog.Printf("redis store construction failed stage=namespace")
		return nil, err
	}
	return redisx.NewStore(client, namespace), nil
}

// doctorStore builds the namespaced Redis store the doctor command inspects,
// tolerating a client that cannot be constructed: an unreachable or
// misconfigured endpoint is itself a finding, so the check-up still runs and
// reports why the Redis checks could not run, rather than exiting before
// producing a report. namespace is assumed already normalized by the caller.
func doctorStore(endpoint, namespace string) *redisx.Store {
	client, err := redisx.New(endpoint)
	if err != nil {
		commandLog.Printf("doctor could not construct a Redis client")
		return nil
	}
	return redisx.NewStore(client, namespace)
}

// telemetrySetupFunc matches telemetry.Setup's signature so tests can
// substitute a fake without opening real OTLP exporters or network sockets.
type telemetrySetupFunc func(ctx context.Context, version string) (telemetry.Shutdown, error)

// setupTelemetry configures tracing for one subcommand invocation and
// returns a close function every subcommand defers identically.
//
// The close function bounds shutdown to 5 seconds using a context that
// survives cancellation of ctx, because ctx is normally already cancelled by
// the signal handler that triggered shutdown. A failed flush is logged
// rather than propagated: telemetry cleanup must never mask the subcommand's
// own result.
func setupTelemetry(ctx context.Context, version string, setup telemetrySetupFunc) (func(), error) {
	shutdown, err := setup(ctx, version)
	if err != nil {
		return nil, fmt.Errorf("configure telemetry: %w", err)
	}
	return func() {
		shutdownCtx, cancel := context.WithTimeout(context.WithoutCancel(ctx), 5*time.Second)
		defer cancel()
		if err := shutdown(shutdownCtx); err != nil {
			commandLog.Printf("telemetry shutdown failed")
		}
	}, nil
}

// hostedTLSMode identifies whether the serve-hosted command's --cert flag
// configured a TLS certificate. It is useful for diagnosing a misconfigured
// deployment without logging the certificate or key paths.
type hostedTLSMode string

const (
	hostedTLSModeConfigured hostedTLSMode = "configured"
	hostedTLSModeDisabled   hostedTLSMode = "disabled"
)

// resolveHostedTLSMode reports whether serve-hosted's --cert flag configures
// TLS. It is a pure function, mirroring the other resolve* helpers in this
// file, so serve-hosted's flag-parsing diagnostic is testable without
// starting a listener.
func resolveHostedTLSMode(certFile string) hostedTLSMode {
	if certFile != "" {
		return hostedTLSModeConfigured
	}
	return hostedTLSModeDisabled
}

// versionSource identifies which input determined the reported
// service.version resource attribute. It is useful for diagnosing a
// mismatched build without logging the version string itself.
type versionSource string

const (
	versionSourceEnvOverride versionSource = "env-override"
	versionSourceBuildLdflag versionSource = "build-ldflag"
)

// resolveVersion applies the standard priority for the reported
// service.version: an explicit CAO_BUILD_VERSION environment override, then
// buildVersion, which is normally set by -ldflags "-X main.version=...". It
// returns the resolved version and which input supplied it, so callers can
// log the source without exposing the version value.
func resolveVersion(buildVersion, envOverride string) (string, versionSource) {
	if override := strings.TrimSpace(envOverride); override != "" {
		return override, versionSourceEnvOverride
	}
	return buildVersion, versionSourceBuildLdflag
}

func main() {
	resolved, source := resolveVersion(version, os.Getenv("CAO_BUILD_VERSION"))
	version = resolved
	commandLog.Printf("resolved build version source=%s", source)
	if err := run(os.Args[1:]); err != nil {
		if errors.Is(err, errDoctorFoundProblems) || errors.Is(err, errTelemetrySmokeFailed) {
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
		// A bare invocation with no subcommand is a usage error, not
		// success, so cao-dashboard exits non-zero the same way it did
		// before this file used cobra.
		RunE: func(cmd *cobra.Command, args []string) error {
			names := make([]string, 0, len(cmd.Commands()))
			for _, sub := range cmd.Commands() {
				names = append(names, sub.Name())
			}
			return fmt.Errorf("usage: cao-dashboard <%s> [flags]", strings.Join(names, "|"))
		},
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
		newTelemetrySmokeCommand(),
		newCompileQueriesCommand(),
		newBenchmarkQueriesCommand(),
		newSimulateAPICommand(),
		newSimulateWebhooksCommand(),
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
		Short: "run a read-only check-up of operational state, canonical data, queries, and collection",
	}
	redisURL := cmd.Flags().String("redis-url", "", "server-side Redis URL; defaults to CAO_REDIS_URL then "+defaultRedisURL)
	redisNamespace, namespaceDefaultSource, namespaceErr := registerRedisNamespaceFlagWithEnvOverride(cmd, "Redis key namespace")
	databaseQueries := cmd.Flags().String("database-queries",
		"../dashboard/site/src/data/queries/database.json", "canonical database projection queries")
	format := cmd.Flags().String("format", "text", "report format: text or json")
	deep := cmd.Flags().Bool("deep", false, "additionally read every source to confirm stored rows decode")
	strict := cmd.Flags().Bool("strict", false, "exit non-zero on warnings as well as failures")
	timeout := cmd.Flags().Duration("timeout", 10*time.Second, "per-check timeout")
	postgresURL := cmd.Flags().String("postgres-url", "", "Postgres dashboard entity store URL; defaults to CAO_POSTGRES_URL")
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
		ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
		defer stop()
		check := doctor.Doctor{
			RedisURL:            endpoint,
			Namespace:           namespace,
			DatabaseQueriesPath: *databaseQueries,
			Version:             version,
			Deep:                *deep,
			Timeout:             *timeout,
			Backend:             "redis",
		}
		databaseNamespace := namespace
		selected, selectionErr := server.OperationalPolicySelectedFromEnv()
		if selectionErr != nil {
			return selectionErr
		}
		hasPolicy := selected ||
			strings.TrimSpace(os.Getenv("CAO_POLICY_PATH")) != "" ||
			strings.TrimSpace(os.Getenv("CAO_MARKETPLACE_POLICY_PATH")) != ""
		if hasPolicy {
			settings, provider, selectionErr := server.NewOperationalDiagnosticsFromEnv(ctx)
			if selectionErr != nil && settings.Backend == "" {
				return selectionErr
			}
			check.Backend = settings.Backend
			check.Namespace = settings.Namespace
			check.RedisURL = settings.RedisURL
			databaseNamespace = settings.DatabaseNamespace
			if check.Backend == "memory" && (cmd.Flags().Changed("redis-url") || cmd.Flags().Changed("redis-namespace")) {
				return errors.New("memory operational-store cannot use Redis flags; diagnose live memory state in its owning process")
			}
			if provider != nil {
				check.Store, check.RedisStore = provider, server.NewRedisProviderDiagnostics(provider)
			}
		} else {
			maxRedisBytes, err := server.RedisMaxBytesFromEnv(0)
			if err != nil {
				return err
			}
			provider := doctorStore(endpoint, namespace)
			if provider != nil {
				if err := provider.SetMaxMemoryBytes(maxRedisBytes); err != nil {
					return err
				}
				check.Store, check.RedisStore = provider, server.NewRedisProviderDiagnostics(provider)
			}
		}
		if check.Store != nil {
			defer func() { _ = check.Store.Close() }()
		}
		if strings.TrimSpace(*postgresURL) != "" || strings.TrimSpace(os.Getenv("CAO_POSTGRES_URL")) != "" {
			database, dbErr := newPostgresStore(ctx, *postgresURL, databaseNamespace)
			if dbErr == nil {
				check.Postgres = database
				defer func() { _ = database.Close() }()
			}
		}
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

func newTelemetrySmokeCommand() *cobra.Command {
	cmd := &cobra.Command{
		Use:   "otel-smoke",
		Short: "verify that a live CAO request is indexed by OpenObserve",
	}
	readinessURL := cmd.Flags().String(
		"cao-readiness-url",
		"http://127.0.0.1:8080/api/readiness",
		"live CAO readiness URL",
	)
	traceStream := cmd.Flags().String("trace-stream", "default", "OpenObserve trace stream")
	requireMetrics := cmd.Flags().Bool(
		"require-metrics",
		false,
		"require readable go.memory.allocated and go.goroutine.count metric streams",
	)
	timeout := cmd.Flags().Duration("timeout", 30*time.Second, "whole smoke-test timeout")
	pollInterval := cmd.Flags().Duration("poll-interval", time.Second, "OpenObserve trace lookup interval")
	cmd.RunE = func(cmd *cobra.Command, _ []string) error {
		ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
		defer stop()
		report, err := telemetry.RunSmoke(ctx, telemetry.SmokeConfig{
			CAOReadinessURL:    *readinessURL,
			OTELSDKDisabled:    os.Getenv("OTEL_SDK_DISABLED"),
			OTLPEndpoint:       os.Getenv("OTEL_EXPORTER_OTLP_ENDPOINT"),
			OTLPHeaders:        os.Getenv("OTEL_EXPORTER_OTLP_HEADERS"),
			OTLPTraceEndpoint:  os.Getenv("OTEL_EXPORTER_OTLP_TRACES_ENDPOINT"),
			OTLPTraceHeaders:   os.Getenv("OTEL_EXPORTER_OTLP_TRACES_HEADERS"),
			OTLPMetricEndpoint: os.Getenv("OTEL_EXPORTER_OTLP_METRICS_ENDPOINT"),
			OTLPMetricHeaders:  os.Getenv("OTEL_EXPORTER_OTLP_METRICS_HEADERS"),
			TraceStream:        *traceStream,
			RequireMetrics:     *requireMetrics,
			Timeout:            *timeout,
			PollInterval:       *pollInterval,
		})
		if err != nil {
			return err
		}
		encoder := json.NewEncoder(cmd.OutOrStdout())
		encoder.SetIndent("", "  ")
		if err := encoder.Encode(report); err != nil {
			return err
		}
		if !report.Passed {
			return errTelemetrySmokeFailed
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
	dashboardQueries := cmd.Flags().String("dashboard-queries", "../dashboard/site/src/agent/queries.generated.json", "materialized dashboard query definitions")
	agentCatalog := cmd.Flags().String("agent-catalog", "../dashboard/site/src/agent/catalog.generated.json", "materialized read-only agent catalog")
	mcpContract := cmd.Flags().String("mcp-contract", "../dashboard/site/src/agent/mcp-contract.json", "shared MCP tool contract")
	mcpEnabled := cmd.Flags().Bool("mcp-enabled", false, "serve the read-only MCP endpoint at /mcp")
	cmd.RunE = func(*cobra.Command, []string) error {
		commandLog.Printf("serve-hosted flags parsed tls=%s", resolveHostedTLSMode(*cert))
		ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
		defer stop()
		closeTelemetry, err := setupTelemetry(ctx, version, telemetry.Setup)
		if err != nil {
			return err
		}
		defer closeTelemetry()
		app, err := server.NewHostedAppFromEnv(
			ctx, *listen, *cert, *key, *siteDirectory, *dashboardQueries, *databaseQueries,
			*mcpEnabled, *agentCatalog, *mcpContract,
			log.New(os.Stderr, "cao-dashboard: ", log.LstdFlags),
		)
		if err != nil {
			return err
		}
		return app.Serve(ctx)
	}
	return cmd
}

// actionsEnvironment holds the GitHub Actions environment variables the
// serve command forwards into server.Config. It is built by
// resolveActionsEnvironment rather than read inline, so the presence of each
// variable is independently testable without exposing the values themselves
// in a log line.
type actionsEnvironment struct {
	Token      string
	Actor      string
	Repository string
	APIURL     string
}

// resolveActionsEnvironment reads the GitHub Actions environment variables
// serve forwards into server.Config. It is a pure function over getenv, so
// the resolution is testable with a fake environment rather than mutating
// the real process environment.
func resolveActionsEnvironment(getenv func(string) string) actionsEnvironment {
	return actionsEnvironment{
		Token:      getenv("GITHUB_TOKEN"),
		Actor:      getenv("GITHUB_ACTOR"),
		Repository: getenv("GITHUB_REPOSITORY"),
		APIURL:     getenv("GITHUB_API_URL"),
	}
}

// present reports which of the resolved GitHub Actions environment variables
// are non-empty, formatted for a log line. It never includes the variables'
// values, only whether each was set.
func (e actionsEnvironment) present() string {
	return fmt.Sprintf("token=%t actor=%t repository=%t api_url=%t",
		e.Token != "", e.Actor != "", e.Repository != "", e.APIURL != "")
}

func newServeCommand() *cobra.Command {
	cmd := &cobra.Command{
		Use:   "serve",
		Short: "serve dashboard data from Postgres with Redis operational state",
	}
	redisURL := cmd.Flags().String("redis-url", defaultRedisURL, "server-side Redis URL")
	postgresURL := cmd.Flags().String("postgres-url", "", "Postgres dashboard entity store URL; defaults to CAO_POSTGRES_URL")
	redisNamespace, namespaceErr := registerRedisNamespaceFlag(cmd, "Redis key and index namespace")
	siteDirectory := cmd.Flags().String("site", "../dashboard/site/dist", "built dashboard site directory")
	listen := cmd.Flags().String("listen", "127.0.0.1:8443", "HTTPS listen address")
	cert := cmd.Flags().String("cert", "", "optional TLS certificate PEM file")
	key := cmd.Flags().String("key", "", "optional TLS private key PEM file")
	accessToken := cmd.Flags().String("access-token", "", "dashboard access token (generated when omitted)")
	source := cmd.Flags().String("source", "", "deployed dashboard directory to ingest before serving")
	databaseQueries := cmd.Flags().String("database-queries", "../dashboard/site/src/data/queries/database.json", "canonical database projection queries")
	dashboardQueries := cmd.Flags().String("dashboard-queries", "../dashboard/site/src/agent/queries.generated.json", "materialized dashboard query definitions")
	agentCatalog := cmd.Flags().String("agent-catalog", "../dashboard/site/src/agent/catalog.generated.json", "materialized read-only agent catalog")
	mcpContract := cmd.Flags().String("mcp-contract", "../dashboard/site/src/agent/mcp-contract.json", "shared MCP tool contract")
	mcpEnabled := cmd.Flags().Bool("mcp-enabled", false, "serve the read-only MCP endpoint at /mcp")
	cmd.RunE = func(*cobra.Command, []string) error {
		if namespaceErr != nil {
			return namespaceErr
		}
		selected, selectionErr := server.OperationalPolicySelectedFromEnv()
		if selectionErr != nil {
			return selectionErr
		}
		if selected {
			return errors.New("reviewed operational-store selection requires serve-hosted or an external OAuth host; local bearer serve cannot override it")
		}
		if _, _, err := resolvePostgresEndpoint(*postgresURL, os.Getenv("CAO_POSTGRES_URL")); err != nil {
			return err
		}
		commandLog.Printf("serve flags parsed tls=%t source_ingestion=%t", *cert != "", *source != "")
		ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
		defer stop()
		closeTelemetry, err := setupTelemetry(ctx, version, telemetry.Setup)
		if err != nil {
			return err
		}
		defer closeTelemetry()
		store, err := newRedisStore(*redisURL, *redisNamespace)
		if err != nil {
			return err
		}
		defer func() { _ = store.Close() }()
		database, err := newPostgresStore(ctx, *postgresURL, *redisNamespace)
		if err != nil {
			return err
		}
		defer func() { _ = database.Close() }()
		definitions, err := server.ParseDashboardQueries(*dashboardQueries)
		if err != nil {
			return err
		}
		actionsEnv := resolveActionsEnvironment(os.Getenv)
		commandLog.Printf("serve resolved actions environment %s", actionsEnv.present())
		app, err := server.New(ctx, store, server.Config{
			Database:             database,
			Listen:               *listen,
			SiteDirectory:        *siteDirectory,
			CertFile:             *cert,
			KeyFile:              *key,
			AccessToken:          *accessToken,
			SourceDirectory:      *source,
			DatabaseQueriesPath:  *databaseQueries,
			DashboardQueries:     definitions,
			DashboardQueriesPath: *dashboardQueries,
			AgentCatalogPath:     *agentCatalog,
			MCPContractPath:      *mcpContract,
			MCPEnabled:           *mcpEnabled,
			BuildRevision:        revision,
			GitHubActionsToken:   actionsEnv.Token,
			GitHubActionsActor:   actionsEnv.Actor,
			ActionsRepository:    actionsEnv.Repository,
			GitHubAPIURL:         actionsEnv.APIURL,
			Logger:               log.New(os.Stderr, "cao-dashboard: ", log.LstdFlags),
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
		Short: "ingest a deployed dashboard directory into Postgres",
	}
	cmd.Flags().String("redis-url", defaultRedisURL, "legacy Redis URL (not used for canonical Postgres ingestion)")
	postgresURL := cmd.Flags().String("postgres-url", "", "Postgres dashboard entity store URL; defaults to CAO_POSTGRES_URL")
	redisNamespace, namespaceErr := registerRedisNamespaceFlag(cmd, "canonical Postgres dataset namespace (legacy flag name)")
	source := cmd.Flags().String("source", "", "deployed dashboard directory")
	databaseQueries := cmd.Flags().String("database-queries", "../dashboard/site/src/data/queries/database.json", "canonical database projection queries")
	cmd.RunE = func(_ *cobra.Command, args []string) error {
		if namespaceErr != nil {
			return namespaceErr
		}
		if _, _, err := resolvePostgresEndpoint(*postgresURL, os.Getenv("CAO_POSTGRES_URL")); err != nil {
			return err
		}
		resolvedSource, sourceOrigin, err := resolveIngestSource(*source, args)
		if err != nil {
			return err
		}
		commandLog.Printf("ingest flags parsed source_origin=%s", sourceOrigin)
		ctx := context.Background()
		closeTelemetry, err := setupTelemetry(ctx, version, telemetry.Setup)
		if err != nil {
			return err
		}
		defer closeTelemetry()
		database, err := newPostgresStore(ctx, *postgresURL, *redisNamespace)
		if err != nil {
			return err
		}
		defer func() { _ = database.Close() }()
		result, err := ingest.Run(ctx, database, resolvedSource, ingest.Options{DatabaseQueriesPath: *databaseQueries})
		if err != nil {
			return err
		}
		return json.NewEncoder(os.Stdout).Encode(result)
	}
	return cmd
}

// workerStopReason classifies why the collection worker's Run loop returned,
// so callers can log the outcome without duplicating this decision.
type workerStopReason string

const (
	workerStopReasonClean    workerStopReason = "clean"
	workerStopReasonShutdown workerStopReason = "shutdown"
	workerStopReasonError    workerStopReason = "error"
)

// classifyWorkerStop applies the standard priority for interpreting
// worker.Run's returned error: a nil error is a clean exit, an error
// alongside a cancelled context means the process is shutting down and the
// error is expected, and any other error is a real failure the caller must
// propagate. It returns the resolved reason and whether the caller should
// propagate runErr, so this decision is testable without starting a worker.
func classifyWorkerStop(runErr, ctxErr error) (workerStopReason, bool) {
	if runErr == nil {
		return workerStopReasonClean, false
	}
	if ctxErr != nil {
		return workerStopReasonShutdown, false
	}
	return workerStopReasonError, true
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
		closeTelemetry, err := setupTelemetry(ctx, version, telemetry.Setup)
		if err != nil {
			return err
		}
		defer closeTelemetry()
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
		runErr := worker.Run(ctx)
		reason, propagate := classifyWorkerStop(runErr, ctx.Err())
		commandLog.Printf("collect worker stopped reason=%s", reason)
		if propagate {
			return runErr
		}
		return nil
	}
	return cmd
}

// backfillMode identifies which action newBackfillCommand's RunE performs.
// It is useful for diagnosing backfill runs without duplicating the
// replay-only flag value in log output.
type backfillMode string

const (
	backfillModeReplayOnly backfillMode = "replay-only"
	backfillModeFull       backfillMode = "full"
)

// resolveBackfillMode applies the standard priority for backfill's action:
// when replayOnly is true, only the evidence lake is replayed without
// contacting GitHub; otherwise a full cold start enumerates installations
// and seeds tasks. It returns the resolved mode so callers can log it.
func resolveBackfillMode(replayOnly bool) backfillMode {
	if replayOnly {
		return backfillModeReplayOnly
	}
	return backfillModeFull
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
	cmd.RunE = func(cmd *cobra.Command, _ []string) error {
		ctx, stop := signal.NotifyContext(cmd.Context(), os.Interrupt, syscall.SIGTERM)
		defer stop()
		closeTelemetry, err := setupTelemetry(ctx, version, telemetry.Setup)
		if err != nil {
			return err
		}
		defer closeTelemetry()
		collector, err := server.NewCollectorFromEnv(ctx, *databaseQueries)
		if err != nil {
			return err
		}
		backfill := collector.Backfill()
		mode := resolveBackfillMode(*replayOnly)
		commandLog.Printf("backfill resolved mode=%s", mode)
		if mode == backfillModeReplayOnly {
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
