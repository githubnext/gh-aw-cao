package main

import (
	"slices"
	"strings"
	"testing"

	"github.com/githubnext/gh-cao/server/internal/cliegress"
)

func TestWorkloadEnvReplacesProxySettings(t *testing.T) {
	env := workloadEnv([]string{
		"PATH=/usr/bin",
		"http_proxy=http://evil:1",
		"Https_Proxy=http://evil:2",
		"NO_PROXY=example.com",
		"KEEP=a=b",
	})
	for _, want := range []string{"PATH=/usr/bin", "KEEP=a=b", "NO_PROXY=", "no_proxy="} {
		if !slices.Contains(env, want) {
			t.Errorf("missing %q in %v", want, env)
		}
	}
	for _, entry := range env {
		if strings.Contains(entry, "evil") || strings.Contains(entry, "example.com") {
			t.Errorf("inherited proxy setting leaked: %q", entry)
		}
	}
	for _, name := range proxyVariables {
		if !slices.Contains(env, name+"=http://"+cliegress.RelayAddress) {
			t.Errorf("%s not pointed at relay", name)
		}
	}
}

func TestWorkloadEnvEmpty(t *testing.T) {
	env := workloadEnv(nil)
	if len(env) != len(proxyVariables)+2 {
		t.Fatalf("got %d entries: %v", len(env), env)
	}
}
