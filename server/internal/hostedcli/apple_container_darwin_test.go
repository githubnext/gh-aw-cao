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

	"github.com/githubnext/gh-aw-cao/server/internal/operational"
)

func TestAppleContainerNativeCancellation(t *testing.T) {
	if os.Getenv("CAO_TEST_APPLE_CONTAINER") != "1" {
		t.Skip("set CAO_TEST_APPLE_CONTAINER=1 with Apple container services running")
	}
	ctx, cancel := context.WithTimeout(t.Context(), 30*time.Second)
	defer cancel()
	lifecycle, err := NewAppleContainerLifecycle("", ExecRunner{})
	if err != nil {
		t.Fatal(err)
	}
	runner, err := NewContainerRunner("", lifecycle)
	if err != nil {
		t.Fatal(err)
	}
	id, err := lifecycle.RuntimeID(ctx)
	if err != nil {
		t.Fatal(err)
	}
	name, err := containerName()
	if err != nil {
		t.Fatal(err)
	}
	execution := operational.CLICommandExecution{CommandID: 1, Name: name, RuntimeID: id}
	workspace := t.TempDir()
	work := filepath.Join(workspace, "work")
	if err := os.Mkdir(work, 0o700); err != nil {
		t.Fatal(err)
	}
	defer func() {
		if err := runner.Reconcile(ctx, execution); err != nil {
			t.Errorf("native cancellation cleanup: %v", err)
		}
	}()
	// Exercise actual VM cancellation without GitHub effects. This fixed probe
	// calls the adapter directly; the production runner still rejects /bin/sh.
	if err := lifecycle.Create(ctx, execution, ContainerSpec{
		Image: DefaultContainerImage, Workspace: workspace, Directory: work,
		Program: "/bin/sh", Args: []string{"-c", `awk '$1=="NoNewPrivs:" && $2=="1" {n=1} $1=="CapEff:" && $2=="0000000000000000" {c=1} END {exit !(n && c)}' /proc/self/status || exit 99
printf 'ready\n'; sleep 60`},
		Env: []string{"HOME=/workspace", "GIT_CONFIG_NOSYSTEM=1"},
	}); err != nil {
		t.Fatal(err)
	}
	runCtx, cancelRun := context.WithCancel(ctx)
	defer cancelRun()
	if err := lifecycle.Start(runCtx, execution); err != nil {
		t.Fatal(err)
	}
	ready := make(chan struct{})
	done := make(chan error, 1)
	var once sync.Once
	go func() {
		done <- lifecycle.CollectOutput(runCtx, execution, func(_ string, data []byte) {
			if strings.Contains(string(data), "ready") {
				once.Do(func() { close(ready) })
			}
		})
	}()
	select {
	case <-ready:
	case err := <-done:
		t.Fatalf("native probe exited before cancellation: %v", err)
	case <-ctx.Done():
		t.Fatal(ctx.Err())
	}
	cancelRun()
	if err := <-done; !errors.Is(err, context.Canceled) {
		t.Fatalf("native cancellation was lost: %v", err)
	}
	if err := runner.Reconcile(ctx, execution); err != nil {
		t.Fatal(err)
	}
	present, err := lifecycle.servicePresent(ctx, execution.Name)
	if err != nil || present {
		t.Fatal("owned native VM service survived confirmed cleanup")
	}
}

func TestAppleContainerNative(t *testing.T) {
	if os.Getenv("CAO_TEST_APPLE_CONTAINER") != "1" {
		t.Skip("set CAO_TEST_APPLE_CONTAINER=1 with Apple container services running")
	}
	ctx, cancel := context.WithTimeout(t.Context(), 90*time.Second)
	defer cancel()
	lifecycle, err := NewAppleContainerLifecycle("", ExecRunner{})
	if err != nil {
		t.Fatal(err)
	}
	runner, err := NewContainerRunner("", lifecycle)
	if err != nil {
		t.Fatal(err)
	}
	for _, test := range []struct {
		name    string
		program string
		args    []string
		success bool
		output  string
	}{
		{name: "gh", program: "gh", args: []string{"--version"}, success: true, output: "version"},
		{name: "gh-aw", program: "gh-aw", args: []string{"--version"}, success: true, output: "version"},
		{name: "nonzero-exit", program: "gh", args: []string{"--cao-hosted-cli-invalid-flag"}, output: "unknown flag"},
	} {
		t.Run(test.name, func(t *testing.T) {
			workspace := t.TempDir()
			for _, name := range []string{"home", "work", "data"} {
				if err := os.Mkdir(filepath.Join(workspace, name), 0o700); err != nil {
					t.Fatal(err)
				}
			}
			var execution operational.CLICommandExecution
			defer func() {
				if execution.Name != "" {
					if err := runner.Reconcile(ctx, execution); err != nil {
						t.Errorf("native smoke cleanup: %v", err)
					}
				}
			}()
			var output strings.Builder
			code, err := runner.Run(ctx, Process{
				CommandID: 1, Workspace: workspace, Dir: filepath.Join(workspace, "work"),
				Program: test.program, Args: test.args,
				Env: []string{"HOME=/workspace/home", "GIT_CONFIG_NOSYSTEM=1", "GH_PROMPT_DISABLED=1"},
				RegisterContainer: func(_ context.Context, value operational.CLICommandExecution) error {
					execution = value
					return value.Validate()
				},
			}, func(_ string, data []byte) { output.Write(data) })
			if err != nil || code < 0 || (code == 0) != test.success || !strings.Contains(strings.ToLower(output.String()), test.output) {
				t.Fatalf("native %s result: code=%d err=%v output=%q", test.program, code, err, output.String())
			}
			if _, err := os.Stat(filepath.Join(workspace, "work", ".git")); err != nil {
				t.Fatal("native pinned-image Git bootstrap did not initialize the private workspace")
			}
		})
	}
}
