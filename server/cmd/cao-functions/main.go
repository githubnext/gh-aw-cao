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

	"github.com/githubnext/gh-aw-cao/server/internal/server"
)

func main() {
	if err := run(); err != nil {
		log.Printf("error: %v", err)
		os.Exit(1)
	}
}

func run() error {
	port := strings.TrimSpace(os.Getenv("FUNCTIONS_CUSTOMHANDLER_PORT"))
	if port == "" {
		return errors.New("FUNCTIONS_CUSTOMHANDLER_PORT is required")
	}
	siteDirectory := envOrDefault("CAO_AZURE_SITE_DIRECTORY", "site")
	queriesPath := envOrDefault("CAO_AZURE_DASHBOARD_QUERIES", filepath.Join(siteDirectory, "dashboard.json"))

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	handler, err := server.NewAzureFunctionsHandlerFromEnv(ctx, siteDirectory, queriesPath, log.Default())
	if err != nil {
		return err
	}
	listener, err := net.Listen("tcp", net.JoinHostPort("127.0.0.1", port))
	if err != nil {
		return err
	}
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

func envOrDefault(name, fallback string) string {
	if value := strings.TrimSpace(os.Getenv(name)); value != "" {
		return value
	}
	return fallback
}
