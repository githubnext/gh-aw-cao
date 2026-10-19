//go:build unix

package localops

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"testing"
	"time"
)

func processExited(pid int) bool { return errors.Is(syscall.Kill(pid, 0), syscall.ESRCH) }

func TestNativeReadOnlyPTYAndOperatorNormalization(t *testing.T) {
	s := service(t, nil)
	t.Setenv("NO_COLOR", "1")
	t.Setenv("LOCALOPS_EXPECT_IDENTITY", "1")
	t.Setenv("GIT_AUTHOR_NAME", "Parent author")
	t.Setenv("GIT_AUTHOR_EMAIL", "parent@example.test")
	t.Setenv("GH_TOKEN", "reviewed-auth-token")
	for _, command := range []string{"gh aw terminal", "./cao.sh terminal", "gh-cao terminal"} {
		t.Run(command, func(t *testing.T) {
			ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
			defer cancel()
			var output strings.Builder
			result, err := executeCommand(ctx, s.options, Invocation{Command: command}, func(stream, data string) error {
				if stream != "stdout" {
					t.Errorf("PTY must combine terminal streams, got %s", stream)
				}
				output.WriteString(data)
				return nil
			})
			if err != nil || result["ok"] != true {
				t.Fatalf("PTY execution failed: %v %v, output: %q", result, err, output.String())
			}
			for _, fragment := range []string{"\x1b[32mterminal:80x24\x1b[0m", "\rprogress:1\r", "\x1b[31mterminal-stderr\x1b[0m", "progress:2"} {
				if !strings.Contains(output.String(), fragment) {
					t.Errorf("missing terminal output %q: %q", fragment, output.String())
				}
			}
		})
	}
	if os.Getenv("GIT_AUTHOR_NAME") != "Parent author" || os.Getenv("GIT_AUTHOR_EMAIL") != "parent@example.test" || os.Getenv("NO_COLOR") != "1" {
		t.Fatal("command preparation mutated the parent environment")
	}
}

func TestNativePTYCancellationAndPersistenceFailure(t *testing.T) {
	s := service(t, nil)
	for _, outputFailure := range []bool{false, true} {
		ctx, cancel := context.WithCancel(context.Background())
		emitted := make(chan struct{})
		var once sync.Once
		finished := make(chan error, 1)
		go func() {
			_, err := executeCommand(ctx, s.options, Invocation{Command: "gh aw terminal-slow"}, func(_ string, data string) error {
				if strings.Contains(data, "progress:1") {
					once.Do(func() { close(emitted) })
				}
				if outputFailure {
					return errors.New("storage unavailable")
				}
				return nil
			})
			finished <- err
		}()
		select {
		case <-emitted:
		case <-time.After(10 * time.Second):
			cancel()
			t.Fatal("terminal did not produce progress")
		}
		if !outputFailure {
			cancel()
		}
		select {
		case err := <-finished:
			if err == nil {
				t.Error("PTY interruption reported successful execution")
			}
			if !outputFailure && !errors.Is(err, context.Canceled) {
				t.Errorf("cancellation was not propagated: %v", err)
			}
		case <-time.After(5 * time.Second):
			cancel()
			t.Fatal("PTY process did not terminate")
		}
		cancel()
	}
}

func TestPTYQueuePublishesCarriageReturnProgress(t *testing.T) {
	s := service(t, nil)
	document := fixtureDocument()
	mapping(document["dashboard"])["cli-actions"] = append(array(mapping(document["dashboard"])["cli-actions"]), map[string]any{"id": "terminal", "command": "gh aw terminal-slow"})
	s.options.Dashboard = func() map[string]any { return document }
	job := enqueue(t, s, "terminal")
	deadline := time.Now().Add(10 * time.Second)
	for time.Now().Before(deadline) {
		detail := call(t, s, "queue.detail", map[string]any{"id": job["id"]})
		if strings.Contains(text(detail["stdout"]), "progress:1\r") {
			if detail["status"] != "running" {
				t.Fatalf("progress was not published while running: %v", detail)
			}

			call(t, s, "queue.cancel", map[string]any{"id": job["id"]})
			return
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatal("PTY carriage-return progress was buffered until completion")
}

func TestNativeTerminalUnicodeDrainLiteralArgumentsAndInputRejection(t *testing.T) {
	s := service(t, nil)
	var captured strings.Builder
	result, err := executeCommand(t.Context(), s.options, Invocation{Command: "gh aw terminal-unicode"}, func(_ string, data string) error {
		time.Sleep(2 * time.Millisecond)
		captured.WriteString(data)
		return nil
	})
	expected := "✓\x1b[38;2;1;2;3m" + strings.Repeat("x", 300000) + "\x1b[0m\n"
	if err != nil || result["ok"] != false || result["exitCode"] != 7 || strings.ReplaceAll(captured.String(), "\r\n", "\n") != expected {
		t.Fatalf("terminal output was corrupted or not drained: %v %v, bytes %d", result, err, captured.Len())
	}

	argument := "$(printf unsafe); 'literal'"
	captured.Reset()
	result, err = executeCommand(t.Context(), s.options, Invocation{Command: "gh aw terminal-literal " + strconv.Quote(argument)}, func(_ string, data string) error {
		captured.WriteString(data)
		return nil
	})
	var arguments []string
	if err != nil || result["ok"] != true || json.Unmarshal([]byte(captured.String()), &arguments) != nil || len(arguments) != 1 || arguments[0] != argument {
		t.Fatal("terminal evaluated or changed literal argv", captured.String(), result, err)
	}
	input := "private prompt"
	_, err = executeCommand(t.Context(), s.options, Invocation{Command: "gh aw terminal", Input: &input}, nil)
	statusError(t, err, 400)
}

func TestNativePreparationCancellationTerminatesDescendants(t *testing.T) {
	s := compilerFixture(t)
	t.Setenv("LOCALOPS_COMPILER_HOLD", "1")
	ctx, cancel := context.WithCancel(t.Context())
	defer cancel()
	done := make(chan error, 1)
	go func() { _, err := ensureGhAW(ctx, s.options); done <- err }()
	var child int
	deadline := time.Now().Add(10 * time.Second)
	for child == 0 && time.Now().Before(deadline) {
		raw, err := os.ReadFile(filepath.Join(s.options.Workspace, "child.pid"))
		if err == nil {
			child, _ = strconv.Atoi(string(raw))
		}
		time.Sleep(5 * time.Millisecond)
	}
	if child == 0 {
		t.Fatal("preparation did not start its descendant")
	}
	cancel()
	select {
	case err := <-done:
		if !errors.Is(err, context.Canceled) {
			t.Fatal("preparation lost cancellation", err)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("preparation did not terminate")
	}
	deadline = time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		if processExited(child) {
			return
		}
		state, err := exec.CommandContext(t.Context(), "ps", "-p", strconv.Itoa(child), "-o", "stat=").Output() // #nosec G204 -- only the exact fixture PID is inspected.
		if err != nil || strings.HasPrefix(strings.TrimSpace(string(state)), "Z") {
			return
		}
		time.Sleep(5 * time.Millisecond)
	}
	t.Fatal("cancellation left a preparation descendant running")
}
