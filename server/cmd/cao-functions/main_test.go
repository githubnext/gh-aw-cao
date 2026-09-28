package main

import (
	"context"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"testing"
	"time"
)

func TestResolveFunctionsConfig_RequiresPort(t *testing.T) {
	env := map[string]string{}
	getenv := func(name string) string { return env[name] }

	_, err := resolveFunctionsConfig(getenv)
	if err == nil {
		t.Fatal("expected an error when FUNCTIONS_CUSTOMHANDLER_PORT is unset")
	}
}

func TestResolveFunctionsConfig_TrimsAndRequiresNonBlankPort(t *testing.T) {
	env := map[string]string{"FUNCTIONS_CUSTOMHANDLER_PORT": "   "}
	getenv := func(name string) string { return env[name] }

	_, err := resolveFunctionsConfig(getenv)
	if err == nil {
		t.Fatal("expected an error when FUNCTIONS_CUSTOMHANDLER_PORT is blank")
	}
}

func TestResolveFunctionsConfig_Defaults(t *testing.T) {
	env := map[string]string{"FUNCTIONS_CUSTOMHANDLER_PORT": "8080"}
	getenv := func(name string) string { return env[name] }

	config, err := resolveFunctionsConfig(getenv)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if config.port != "8080" {
		t.Errorf("port = %q, want %q", config.port, "8080")
	}
	if config.siteDirectory != "site" {
		t.Errorf("siteDirectory = %q, want %q", config.siteDirectory, "site")
	}
	wantQueries := filepath.Join("site", "dashboard.json")
	if config.queriesPath != wantQueries {
		t.Errorf("queriesPath = %q, want %q", config.queriesPath, wantQueries)
	}
}

func TestResolveFunctionsConfig_OverridesAndDerivedQueriesPath(t *testing.T) {
	env := map[string]string{
		"FUNCTIONS_CUSTOMHANDLER_PORT": " 9090 ",
		"CAO_AZURE_SITE_DIRECTORY":     "/srv/dashboard",
	}
	getenv := func(name string) string { return env[name] }

	config, err := resolveFunctionsConfig(getenv)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if config.port != "9090" {
		t.Errorf("port = %q, want %q", config.port, "9090")
	}
	if config.siteDirectory != "/srv/dashboard" {
		t.Errorf("siteDirectory = %q, want %q", config.siteDirectory, "/srv/dashboard")
	}
	wantQueries := filepath.Join("/srv/dashboard", "dashboard.json")
	if config.queriesPath != wantQueries {
		t.Errorf("queriesPath = %q, want %q", config.queriesPath, wantQueries)
	}
}

func TestResolveFunctionsConfig_ExplicitQueriesPathOverridesDerivedDefault(t *testing.T) {
	env := map[string]string{
		"FUNCTIONS_CUSTOMHANDLER_PORT": "8080",
		"CAO_AZURE_SITE_DIRECTORY":     "/srv/dashboard",
		"CAO_AZURE_DASHBOARD_QUERIES":  "/etc/cao/dashboard.json",
	}
	getenv := func(name string) string { return env[name] }

	config, err := resolveFunctionsConfig(getenv)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if config.queriesPath != "/etc/cao/dashboard.json" {
		t.Errorf("queriesPath = %q, want %q", config.queriesPath, "/etc/cao/dashboard.json")
	}
}

func TestEnvOrDefault(t *testing.T) {
	env := map[string]string{"SET_VALUE": "  configured  ", "BLANK_VALUE": "   "}
	getenv := func(name string) string { return env[name] }

	if got := envOrDefault(getenv, "SET_VALUE", "fallback"); got != "configured" {
		t.Errorf("envOrDefault(SET_VALUE) = %q, want %q", got, "configured")
	}
	if got := envOrDefault(getenv, "BLANK_VALUE", "fallback"); got != "fallback" {
		t.Errorf("envOrDefault(BLANK_VALUE) = %q, want %q", got, "fallback")
	}
	if got := envOrDefault(getenv, "MISSING_VALUE", "fallback"); got != "fallback" {
		t.Errorf("envOrDefault(MISSING_VALUE) = %q, want %q", got, "fallback")
	}
}

// TestShutdownOnDone_GracefulShutdownOnCancel verifies that cancelling ctx
// triggers a real *http.Server shutdown that stops it from serving further
// requests, using an actual listener rather than a mock.
func TestShutdownOnDone_GracefulShutdownOnCancel(t *testing.T) {
	server := httptest.NewUnstartedServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
	}))
	server.Start()
	defer server.Close()

	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})
	go func() {
		shutdownOnDone(ctx, server.Config, time.Second)
		close(done)
	}()

	cancel()

	select {
	case <-done:
	case <-time.After(2 * time.Second):
		t.Fatal("shutdownOnDone did not return after context cancellation")
	}

	if _, err := http.Get(server.URL); err == nil {
		t.Fatal("expected requests to fail after shutdown, but request succeeded")
	}
}

// TestShutdownOnDone_WaitsForContext confirms shutdownOnDone blocks until
// ctx is done, rather than shutting down immediately.
func TestShutdownOnDone_WaitsForContext(t *testing.T) {
	server := httptest.NewUnstartedServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
	}))
	server.Start()
	defer server.Close()

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	done := make(chan struct{})
	go func() {
		shutdownOnDone(ctx, server.Config, time.Second)
		close(done)
	}()

	select {
	case <-done:
		t.Fatal("shutdownOnDone returned before context was cancelled")
	case <-time.After(100 * time.Millisecond):
	}

	resp, err := http.Get(server.URL)
	if err != nil {
		t.Fatalf("expected server to still accept requests, got error: %v", err)
	}
	resp.Body.Close()
}
