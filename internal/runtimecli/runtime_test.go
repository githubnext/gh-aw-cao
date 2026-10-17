package runtimecli

import (
	"bufio"
	"bytes"
	"context"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func runtimeFile(t *testing.T, root string) string {
	t.Helper()
	entry := filepath.Join(root, "activity", "cao.mjs")
	if err := os.MkdirAll(filepath.Dir(entry), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(entry, []byte("// fixture"), 0o600); err != nil {
		t.Fatal(err)
	}
	return entry
}

func TestResolveRuntime(t *testing.T) {
	root := t.TempDir()
	entry := runtimeFile(t, root)
	subdirectory := filepath.Join(root, "nested", "directory")
	if err := os.MkdirAll(subdirectory, 0o755); err != nil {
		t.Fatal(err)
	}
	got, err := Resolve(subdirectory, "", "")
	if err != nil || got != entry {
		t.Fatalf("nested runtime = %q, %v, want %q", got, err, entry)
	}
	explicit := t.TempDir()
	want := runtimeFile(t, explicit)
	got, err = Resolve(subdirectory, explicit, "")
	if err != nil || got != want {
		t.Fatalf("explicit runtime = %q, %v", got, err)
	}
	_, err = Resolve(subdirectory, filepath.Join(explicit, "missing"), "")
	if err == nil {
		t.Fatal("an invalid explicit root must not fall back to another runtime")
	}
}

func TestResolveDoesNotCrossRepositoryBoundary(t *testing.T) {
	parent := t.TempDir()
	runtimeFile(t, parent)
	repository := filepath.Join(parent, "different-repo")
	if err := os.MkdirAll(repository, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(repository, ".git"), []byte("gitdir: fixture"), 0o600); err != nil {
		t.Fatal(err)
	}
	_, err := Resolve(repository, "", "")
	if err == nil || !strings.Contains(err.Error(), "CAO operator runtime is unavailable") {
		t.Fatalf("must not select a parent repository's code: %v", err)
	}
}

func TestResolveExecutableRuntime(t *testing.T) {
	root := t.TempDir()
	entry := runtimeFile(t, root)
	executable := filepath.Join(root, "gh-cao")
	if err := os.WriteFile(executable, nil, 0o700); err != nil {
		t.Fatal(err)
	}
	got, err := Resolve(t.TempDir(), "", executable)
	want, resolveErr := filepath.EvalSymlinks(entry)
	if err != nil || resolveErr != nil || got != want {
		t.Fatalf("executable runtime = %q, %v", got, err)
	}
}

func TestResolveRejectsNonFileEntryPoint(t *testing.T) {
	root := t.TempDir()
	if err := os.MkdirAll(filepath.Join(root, "activity", "cao.mjs"), 0o755); err != nil {
		t.Fatal(err)
	}
	if _, err := Resolve(root, "", ""); err == nil || !strings.Contains(err.Error(), "not a regular file") {
		t.Fatalf("error = %v, want invalid entry point", err)
	}
}

func TestExecuteRequiresNode(t *testing.T) {
	root := t.TempDir()
	runtimeFile(t, root)
	t.Setenv("CAO_RUNTIME_ROOT", root)
	t.Setenv("PATH", "")
	err := Execute(context.Background(), []string{"setup"}, strings.NewReader(""), io.Discard, io.Discard)
	if err == nil || !strings.Contains(err.Error(), "requires Node.js 24") {
		t.Fatalf("error = %v, want actionable Node dependency error", err)
	}
}

func TestCheckNode(t *testing.T) {
	node, err := exec.LookPath("node")
	if err != nil {
		t.Skip("Node is not installed")
	}
	output, err := exec.Command(node, "--version").Output()
	if err != nil {
		t.Fatal(err)
	}
	err = checkNode(context.Background(), node)
	var major int
	if _, scanErr := fmt.Sscanf(string(output), "v%d.", &major); scanErr != nil {
		t.Fatal(scanErr)
	}
	if major >= 24 && err != nil {
		t.Fatal(err)
	}
	if major < 24 && (err == nil || !strings.Contains(err.Error(), "requires Node.js 24")) {
		t.Fatalf("old Node must be rejected: %v", err)
	}
}

func TestRunStreamsWithoutShell(t *testing.T) {
	t.Setenv("CAO_TEST_HELPER", "1")
	input := "unmodified input\n"
	var stdout, stderr bytes.Buffer
	args := []string{"-test.run=^TestRuntimeHelper$", "--", "success", "literal $(not-a-command); value"}
	if err := run(context.Background(), os.Args[0], args, strings.NewReader(input), &stdout, &stderr); err != nil {
		t.Fatal(err)
	}
	if stdout.String() != input+"literal $(not-a-command); value\n" || stderr.String() != "diagnostic\n" {
		t.Fatalf("streams or arguments changed: stdout=%q stderr=%q", stdout.String(), stderr.String())
	}
}

func TestRunPreservesExitStatus(t *testing.T) {
	t.Setenv("CAO_TEST_HELPER", "1")
	for _, code := range []string{"1", "2", "7", "130", "143"} {
		t.Run(code, func(t *testing.T) {
			var stdout, stderr bytes.Buffer
			err := run(context.Background(), os.Args[0], []string{"-test.run=^TestRuntimeHelper$", "--", code}, nil, &stdout, &stderr)
			var exit *ExitError
			if !errors.As(err, &exit) || fmt.Sprint(exit.Code) != code {
				t.Fatalf("error = %v, want exit status %s", err, code)
			}
			if stdout.Len() != 0 || stderr.String() != "runtime failed\n" {
				t.Fatalf("failure streams changed: %q, %q", stdout.String(), stderr.String())
			}
		})
	}
}

func TestRunCancellation(t *testing.T) {
	t.Setenv("CAO_TEST_HELPER", "1")
	ctx, cancel := context.WithTimeout(context.Background(), 100*time.Millisecond)
	defer cancel()
	err := run(ctx, os.Args[0], []string{"-test.run=^TestRuntimeHelper$", "--", "wait"}, nil, io.Discard, io.Discard)
	if !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("error = %v, want cancellation", err)
	}
}

func TestRuntimeHelper(t *testing.T) {
	if os.Getenv("CAO_TEST_HELPER") != "1" {
		return
	}
	var args []string
	for index, arg := range os.Args {
		if arg == "--" {
			args = os.Args[index+1:]
			break
		}
	}
	switch args[0] {
	case "terminal":
		line, err := bufio.NewReader(os.Stdin).ReadString('\n')
		if err != nil {
			fmt.Fprintln(os.Stderr, err)
			os.Exit(1)
		}
		if _, err := fmt.Fprintln(os.Stdout, "terminal input: "+strings.TrimSpace(line)); err != nil {
			t.Fatal(err)
		}
		os.Exit(0)
	case "success":
		if _, err := io.Copy(os.Stdout, os.Stdin); err != nil {
			t.Fatal(err)
		}
		if _, err := fmt.Fprintln(os.Stdout, args[1]); err != nil {
			t.Fatal(err)
		}
		fmt.Fprintln(os.Stderr, "diagnostic")
		os.Exit(0)
	case "wait":
		time.Sleep(30 * time.Second)
		os.Exit(0)
	default:
		var code int
		if _, err := fmt.Sscan(args[0], &code); err != nil {
			t.Fatal(err)
		}
		fmt.Fprintln(os.Stderr, "runtime failed")
		os.Exit(code)
	}
}
