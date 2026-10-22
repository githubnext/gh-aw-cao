package collect

import (
	"context"
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"testing"
	"time"
)

func TestEvidenceLockAcrossProcesses(t *testing.T) {
	if directory := os.Getenv("CAO_TEST_EVIDENCE_LOCK_DIRECTORY"); directory != "" {
		ctx, cancel := context.WithTimeout(t.Context(), 100*time.Millisecond)
		defer cancel()
		release, err := (Lake{Directory: directory}).lockEvidence(ctx)
		if release != nil {
			release()
		}
		if os.Getenv("CAO_TEST_EVIDENCE_LOCK_BLOCKED") == "1" {
			if !errors.Is(err, context.DeadlineExceeded) {
				t.Fatalf("expected locked lake to time out, got %v", err)
			}
		} else if err != nil {
			t.Fatalf("released lake is not available: %v", err)
		}
		return
	}

	directory := filepath.Join(t.TempDir(), "shared lake")
	if err := os.Mkdir(directory, 0o700); err != nil {
		t.Fatal(err)
	}
	release, err := (Lake{Directory: directory}).lockEvidence(t.Context())
	if err != nil {
		t.Fatal(err)
	}
	defer release()
	executable, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	for _, blocked := range []string{"1", "0"} {
		if blocked == "0" {
			release()
		}
		ctx, cancel := context.WithTimeout(t.Context(), 10*time.Second)
		command := exec.CommandContext(ctx, executable, "-test.run=^TestEvidenceLockAcrossProcesses$", "-test.count=1") // #nosec G204 -- executes this test binary only.
		command.Env = append(os.Environ(), "CAO_TEST_EVIDENCE_LOCK_DIRECTORY="+directory,
			"CAO_TEST_EVIDENCE_LOCK_BLOCKED="+blocked)
		output, err := command.CombinedOutput()
		cancel()
		if err != nil {
			t.Fatalf("lock probe (blocked=%s): %v\n%s", blocked, err, output)
		}
	}
}

func TestEvidenceLockRejectsInvalidHandle(t *testing.T) {
	file, err := os.CreateTemp(t.TempDir(), "closed-lock")
	if err != nil {
		t.Fatal(err)
	}
	if err := file.Close(); err != nil {
		t.Fatal(err)
	}
	if locked, err := tryLockEvidence(file); locked || err == nil {
		t.Fatalf("invalid lock handle must fail explicitly: locked=%v, err=%v", locked, err)
	}
}
