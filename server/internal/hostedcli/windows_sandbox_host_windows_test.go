//go:build windows

package hostedcli

import (
	"context"
	"os"
	"os/exec"
	"testing"
	"time"
)

// These tests need no VM or tools bundle. They exercise the production global
// mutex across actual Windows processes when run on a Windows test host.
func TestWindowsSandboxNativeMutexAcrossProcesses(t *testing.T) {
	ctx, cancel := context.WithTimeout(t.Context(), 5*time.Second)
	defer cancel()
	unlock, err := windowsSandboxGlobalLock(ctx)
	if err != nil {
		t.Fatal(err)
	}
	locked := true
	defer func() {
		if locked {
			unlock()
		}
	}()
	runWindowsSandboxMutexChild(t, ctx, "blocked")
	unlock()
	locked = false
	runWindowsSandboxMutexChild(t, ctx, "available")
}

func runWindowsSandboxMutexChild(t *testing.T, ctx context.Context, expectation string) {
	t.Helper()
	binary, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	// #nosec G204 -- The child is this exact test binary, never a user-supplied program.
	command := exec.CommandContext(ctx, binary, "-test.run=^TestWindowsSandboxNativeMutexChild$")
	command.Env = []string{"CAO_WINDOWS_SANDBOX_MUTEX_TEST=" + expectation, "SystemRoot=" + os.Getenv("SystemRoot")}
	if output, err := command.CombinedOutput(); err != nil {
		t.Fatalf("cross-process mutex check failed: %v: %s", err, output)
	}
}

func TestWindowsSandboxNativeMutexChild(t *testing.T) {
	expectation := os.Getenv("CAO_WINDOWS_SANDBOX_MUTEX_TEST")
	if expectation == "" {
		t.Skip("only run by the cross-process mutex test")
	}
	ctx, cancel := context.WithTimeout(t.Context(), 100*time.Millisecond)
	defer cancel()
	unlock, err := windowsSandboxGlobalLock(ctx)
	if err == nil {
		defer unlock()
	}
	switch expectation {
	case "blocked":
		if err == nil {
			t.Fatal("another process bypassed the machine-global mutex")
		}
	case "available":
		if err != nil {
			t.Fatal("released global mutex was not available:", err)
		}
	default:
		t.Fatal("invalid mutex test expectation")
	}
}
