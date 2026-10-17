package main

import (
	"context"
	"errors"
	"os/exec"
	"slices"
	"testing"

	"github.com/githubnext/gh-aw-cao/server/internal/cliegress"
)

func TestWorkloadEnvironmentReplacesProxySettings(t *testing.T) {
	env := workloadEnvironment([]string{"PATH=/bin", "http_proxy=http://evil:1", "No_Proxy=x", "HOME=/h", "ALL_PROXY=y"})
	for _, kept := range []string{"PATH=/bin", "HOME=/h"} {
		if !slices.Contains(env, kept) {
			t.Fatalf("missing %q in %v", kept, env)
		}
	}
	for _, gone := range []string{"http_proxy=http://evil:1", "No_Proxy=x", "ALL_PROXY=y"} {
		if slices.Contains(env, gone) {
			t.Fatalf("inherited %q survived in %v", gone, env)
		}
	}
	relay := "=http://" + cliegress.RelayAddress
	for _, name := range []string{"HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "http_proxy", "https_proxy", "all_proxy"} {
		if !slices.Contains(env, name+relay) {
			t.Fatalf("missing %s relay setting in %v", name, env)
		}
	}
	if env[len(env)-2] != "NO_PROXY=" || env[len(env)-1] != "no_proxy=" {
		t.Fatalf("NO_PROXY not cleared last: %v", env)
	}
}

func TestWorkloadEnvironmentEmpty(t *testing.T) {
	if env := workloadEnvironment(nil); len(env) != 8 {
		t.Fatalf("len = %d, want 8: %v", len(env), env)
	}
}

func TestExitCode(t *testing.T) {
	if got := exitCode(nil); got != 0 {
		t.Fatalf("nil = %d", got)
	}
	sh, err := exec.LookPath("sh")
	if err != nil {
		t.Skip("sh unavailable")
	}
	if got := exitCode(exec.Command(sh, "-c", "exit 7").Run()); got != 7 {
		t.Fatalf("exit 7 = %d", got)
	}
	if got := exitCode(errors.New("start failed")); got != 125 {
		t.Fatalf("generic error = %d", got)
	}
	if got := exitCode(exec.CommandContext(context.Background(), "/nonexistent/cao-relay-test").Run()); got != 125 {
		t.Fatalf("missing binary = %d", got)
	}
}
