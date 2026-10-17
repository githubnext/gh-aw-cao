//go:build !windows

package runtimecli

import (
	"bytes"
	"context"
	"os"
	"os/exec"
	"testing"
	"time"

	"github.com/cli/go-gh/v2/pkg/term"
)

func TestNonInteractiveProcessGroup(t *testing.T) {
	cmd := exec.CommandContext(context.Background(), "unused")
	cmd.Stdin = bytes.NewBufferString("input")
	configureProcess(cmd)
	if cmd.SysProcAttr == nil || !cmd.SysProcAttr.Setpgid {
		t.Fatal("non-interactive descendants must be isolated for cancellation")
	}
}

func TestForegroundTerminal(t *testing.T) {
	if !term.IsTerminal(os.Stdin) {
		if os.Getenv("CAO_REQUIRE_TTY_TEST") == "1" {
			t.Fatal("terminal inheritance check requires a real PTY")
		}
		t.Skip("run under a PTY with terminal-input on stdin to verify secure-prompt terminal inheritance")
	}
	t.Setenv("CAO_TEST_HELPER", "1")
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	var stdout, stderr bytes.Buffer
	err := run(ctx, os.Args[0], []string{"-test.run=^TestRuntimeHelper$", "--", "terminal"}, os.Stdin, &stdout, &stderr)
	if err != nil {
		t.Fatalf("foreground terminal reader failed: %v: %s", err, &stderr)
	}
	if stdout.String() != "terminal input: terminal-input\n" {
		t.Fatalf("terminal input was not inherited: %q", &stdout)
	}
}
