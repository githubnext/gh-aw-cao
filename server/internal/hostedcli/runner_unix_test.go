//go:build !windows

package hostedcli

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"
)

func TestContainerBootstrapInitializesGitAndPreservesArguments(t *testing.T) {
	workspace, err := filepath.EvalSymlinks(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	// Exercise the exact bootstrap and Git-root prerequisite without invoking
	// GitHub or any target-side effects.
	p := Process{Program: "/bin/sh", Dir: workspace, Env: []string{"PATH=" + os.Getenv("PATH"), "HOME=" + workspace, "GIT_CONFIG_NOSYSTEM=1"},
		Args: []string{"-c", containerBootstrap, "cao-hosted-cli", "git", "rev-parse", "--show-toplevel"}}
	var output strings.Builder
	code, err := (ExecRunner{}).Run(t.Context(), p, func(_ string, data []byte) { output.Write(data) })
	if err != nil || code != 0 || strings.TrimSpace(output.String()) != workspace {
		t.Fatalf("Git root prerequisite failed: %d %v %q", code, err, output.String())
	}
	p.Args = []string{"-c", containerBootstrap, "cao-hosted-cli", "printf", "%s", `$(touch should-not-exist); spaced argument`}
	output.Reset()
	code, err = (ExecRunner{}).Run(t.Context(), p, func(_ string, data []byte) { output.Write(data) })
	if err != nil || code != 0 || output.String() != `$(touch should-not-exist); spaced argument` {
		t.Fatalf("arguments were reinterpreted: %d %v %q", code, err, output.String())
	}
	if _, err := os.Stat(filepath.Join(workspace, "should-not-exist")); !errors.Is(err, os.ErrNotExist) {
		t.Fatal("argument was interpreted as shell")
	}
}

func TestExecRunnerUsesOnlyGivenEnvironment(t *testing.T) {
	var mutex sync.Mutex
	var output strings.Builder
	code, err := ExecRunner{}.Run(context.Background(), Process{
		Program: "/bin/sh", Args: []string{"-c", "echo \"$ONLY\" \"${HOME:-unset}\"; exit 3"},
		Env: []string{"ONLY=value"}, Dir: t.TempDir(),
	}, func(_ string, data []byte) {
		mutex.Lock()
		output.Write(data)
		mutex.Unlock()
	})
	if err != nil || code != 3 {
		t.Fatalf("code=%d err=%v", code, err)
	}
	if strings.TrimSpace(output.String()) != "value unset" {
		t.Fatalf("unexpected output %q", output.String())
	}
}

func TestExecRunnerKillsProcessGroupOnCancel(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 200*time.Millisecond)
	defer cancel()
	started := time.Now()
	_, err := ExecRunner{WaitDelay: time.Second}.Run(ctx, Process{
		Program: "/bin/sh", Args: []string{"-c", "sleep 30 & sleep 30"}, Dir: t.TempDir(),
	}, nil)
	if !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("want deadline error, got %v", err)
	}
	if time.Since(started) > 5*time.Second {
		t.Fatal("process group was not killed promptly")
	}
}
