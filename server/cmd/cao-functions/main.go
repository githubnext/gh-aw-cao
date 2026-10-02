package main

import (
	"context"
	"errors"
	"log"
	"net"
	"net/http"
	"os"
	"os/signal"
	"path/filepath"
	"strings"
	"syscall"
	"time"

	"github.com/githubnext/gh-aw-cao/server/internal/logger"
	"github.com/githubnext/gh-aw-cao/server/internal/server"
)

var startupLog = logger.New("cao:functions:startup")

func main() {
	if err := run(); err != nil {
		log.Printf("error: %v", err)
		os.Exit(1)
	}
}

// functionsConfig holds the resolved configuration used to start the Azure
// Functions custom handler.
type functionsConfig struct {
	port          string
	siteDirectory string
	queriesPath   string
}

// resolveFunctionsConfig derives the listen port, site directory, and
// dashboard queries path from the process environment. It is a pure function
// so the resolution and defaulting logic can be exercised without starting a
// listener or an HTTP server.
func resolveFunctionsConfig(getenv func(string) string) (functionsConfig, error) {
	port := strings.TrimSpace(getenv("FUNCTIONS_CUSTOMHANDLER_PORT"))
	if port == "" {
		return functionsConfig{}, errors.New("FUNCTIONS_CUSTOMHANDLER_PORT is required")
	}
	siteDirectory := envOrDefault(getenv, "CAO_AZURE_SITE_DIRECTORY", "site")
	queriesPath := envOrDefault(getenv, "CAO_AZURE_DASHBOARD_QUERIES", filepath.Join(siteDirectory, "dashboard.json"))
	return functionsConfig{
		port:          port,
		siteDirectory: siteDirectory,
		queriesPath:   queriesPath,
	}, nil
}

func run() error {
	config, err := resolveFunctionsConfig(os.Getenv)
	if err != nil {
		return err
	}
	startupLog.Printf("resolved config site_directory=%q queries_path=%q", config.siteDirectory, config.queriesPath)

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	defer func() {
		flushCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		if err := server.ShutdownAzureFunctionsTelemetry(flushCtx); err != nil {
			startupLog.Printf("telemetry shutdown failed")
		}
	}()
	handler, err := server.NewAzureFunctionsHandlerFromEnv(ctx, config.siteDirectory, config.queriesPath, log.Default())
	if err != nil {
		return err
	}
	var listenConfig net.ListenConfig
	listener, err := listenConfig.Listen(ctx, "tcp", net.JoinHostPort("127.0.0.1", config.port))
	if err != nil {
		return err
	}
	startupLog.Printf("listening addr=%q", listener.Addr().String())
	httpServer := &http.Server{
		Handler:           handler,
		ReadHeaderTimeout: 10 * time.Second,
		ReadTimeout:       65 * time.Second,
		WriteTimeout:      65 * time.Second,
		IdleTimeout:       90 * time.Second,
	}
	shutdownDone := make(chan struct{})
	go func() {
		defer close(shutdownDone)
		shutdownOnDone(ctx, httpServer, 5*time.Second)
	}()
	err = httpServer.Serve(listener)
	stop()
	<-shutdownDone
	if errors.Is(err, http.ErrServerClosed) {
		return nil
	}
	return err
}

// shutdownOnDone waits for ctx to be cancelled, then gracefully shuts down
// httpServer within timeout. It is extracted from run's inline goroutine so
// the shutdown boundary is independently testable with a real
// *http.Server, without starting a listener or a full process.
//
// The shutdown context survives cancellation of ctx, because ctx is
// normally already cancelled by the signal handler that triggered this
// shutdown. A failed or timed-out shutdown is logged rather than
// propagated: this goroutine has no return path, and Serve's own returned
// error remains the caller's signal for a failed shutdown.
func shutdownOnDone(ctx context.Context, httpServer *http.Server, timeout time.Duration) {
	<-ctx.Done()
	if drainer, ok := httpServer.Handler.(interface{ Drain() }); ok {
		drainer.Drain()
	}
	shutdownCtx, cancel := context.WithTimeout(context.WithoutCancel(ctx), timeout)
	defer cancel()
	if err := httpServer.Shutdown(shutdownCtx); err != nil {
		startupLog.Printf("graceful shutdown failed")
	}
}

func envOrDefault(getenv func(string) string, name, fallback string) string {
	if value := strings.TrimSpace(getenv(name)); value != "" {
		return value
	}
	return fallback
}
