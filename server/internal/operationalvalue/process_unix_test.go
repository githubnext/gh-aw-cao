//go:build !windows

package operationalvalue

import (
	"context"
	"errors"
	"os"
	"os/exec"
	"syscall"
	"testing"
)

func TestClassifyProcessGroupKillErrorTranslatesESRCHToProcessDone(t *testing.T) {
	if got := classifyProcessGroupKillError(syscall.ESRCH); !errors.Is(got, os.ErrProcessDone) {
		t.Fatalf("classifyProcessGroupKillError(ESRCH) = %v, want os.ErrProcessDone", got)
	}
}

func TestClassifyProcessGroupKillErrorPassesThroughOtherErrors(t *testing.T) {
	if got := classifyProcessGroupKillError(syscall.EPERM); !errors.Is(got, syscall.EPERM) {
		t.Fatalf("classifyProcessGroupKillError(EPERM) = %v, want syscall.EPERM", got)
	}
}

func TestClassifyProcessGroupKillErrorPassesThroughNil(t *testing.T) {
	if got := classifyProcessGroupKillError(nil); got != nil {
		t.Fatalf("classifyProcessGroupKillError(nil) = %v, want nil", got)
	}
}

func TestTerminateProcessTreeHandlesNilProcess(t *testing.T) {
	if err := terminateProcessTree(nil); err != nil {
		t.Fatalf("terminateProcessTree(nil) = %v, want nil", err)
	}
}

// TestTerminateProcessTreeKillsRealProcessGroup exercises terminateProcessTree
// against a real, separately grouped child process, then confirms a second
// call against the now-exited process reports os.ErrProcessDone instead of a
// raw ESRCH, matching classifyProcessGroupKillError's translation.
func TestTerminateProcessTreeKillsRealProcessGroup(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	command := exec.CommandContext(ctx, "sleep", "5")
	configureProcessTree(command)
	if err := command.Start(); err != nil {
		t.Fatalf("start sleep: %v", err)
	}

	if err := terminateProcessTree(command.Process); err != nil {
		t.Fatalf("terminateProcessTree(running) = %v, want nil", err)
	}
	_ = command.Wait()

	if err := terminateProcessTree(command.Process); !errors.Is(err, os.ErrProcessDone) {
		t.Fatalf("terminateProcessTree(exited) = %v, want os.ErrProcessDone", err)
	}
}
