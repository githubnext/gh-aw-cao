package main

import (
	"path/filepath"
	"testing"
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
