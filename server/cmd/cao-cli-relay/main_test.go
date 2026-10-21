package main

import (
	"errors"
	"os/exec"
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

func TestWorkloadExitCode(t *testing.T) {
	if got := workloadExitCode(nil); got != 0 {
		t.Fatalf("success exit code = %d, want 0", got)
	}
	shell, err := exec.LookPath("sh")
	if err != nil {
		t.Skip("sh is unavailable")
	}
	exitErr := exec.Command(shell, "-c", "exit 7").Run()
	if got := workloadExitCode(exitErr); got != 7 {
		t.Fatalf("workload exit code = %d, want 7", got)
	}
}

func TestWorkloadExitCodeStartFailure(t *testing.T) {
	startErr := exec.Command("/nonexistent/cao-relay-workload").Run()
	if startErr == nil {
		t.Fatal("expected a start failure")
	}
	if got := workloadExitCode(startErr); got != 125 {
		t.Fatalf("start failure exit code = %d, want 125", got)
	}
	if got := workloadExitCode(errors.New("other")); got != 125 {
		t.Fatalf("generic failure exit code = %d, want 125", got)
	}
}
