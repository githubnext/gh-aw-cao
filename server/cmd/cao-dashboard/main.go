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

	"github.com/githubnext/gh-aw-cao/server/internal/ingest"
	"github.com/githubnext/gh-aw-cao/server/internal/redisx"
	"github.com/githubnext/gh-aw-cao/server/internal/server"
	"github.com/githubnext/gh-aw-cao/server/internal/telemetry"
)

// version is the standardized service.version resource attribute reported by
// this build's OpenTelemetry spans. Override it at build time with
// -ldflags "-X main.version=...", or at runtime with CAO_BUILD_VERSION.
var version = "dev"

const defaultRedisURL = "redis://127.0.0.1:6379/0"

func main() {
	if override := strings.TrimSpace(os.Getenv("CAO_BUILD_VERSION")); override != "" {
		version = override
	}
	if err := run(os.Args[1:]); err != nil {
		log.Printf("error: %v", err)
		os.Exit(1)
	}
}

func run(arguments []string) error {
	if len(arguments) == 0 {
		return errors.New("usage: cao-dashboard <serve|ingest> [flags]")
	}
	switch arguments[0] {
	case "serve":
		return serve(arguments[1:])
	case "ingest":
		return ingestCommand(arguments[1:])
	default:
		return fmt.Errorf("unknown subcommand %q; expected serve or ingest", arguments[0])
	}
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
