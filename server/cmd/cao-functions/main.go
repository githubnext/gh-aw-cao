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
	go func() {
		<-ctx.Done()
		shutdown, cancel := context.WithTimeout(context.WithoutCancel(ctx), 5*time.Second)
		defer cancel()
		_ = httpServer.Shutdown(shutdown)
	}()
	err = httpServer.Serve(listener)
	if errors.Is(err, http.ErrServerClosed) {
		return nil
	}
	return err
}

func envOrDefault(getenv func(string) string, name, fallback string) string {
	if value := strings.TrimSpace(getenv(name)); value != "" {
		return value
	}
	return fallback
}
