package hostedcli

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"testing"
)

type containerCommandRunner struct {
	processes []Process
	run       func(context.Context, Process, OutputFunc) (int, error)
}

func (r *containerCommandRunner) Run(ctx context.Context, process Process, output OutputFunc) (int, error) {
	r.processes = append(r.processes, process)
	if r.run != nil {
		return r.run(ctx, process, output)
	}
	return 0, nil
}

func TestContainerRunnerUsesPinnedImageAndPrivateEnvironmentFile(t *testing.T) {
	workspace := t.TempDir()
	work := filepath.Join(workspace, "work")
	if err := os.Mkdir(work, 0o700); err != nil {
		t.Fatal(err)
	}
	commands := &containerCommandRunner{}
	runner, err := NewContainerRunner("", "", commands)
	if err != nil {
		t.Fatal(err)
	}
	runner.HostEnv = dockerHostEnvironment([]string{"PATH=/usr/bin", "HOME=/operator", "CAO_PRIVATE_KEY=excluded"})
	var environmentFile string
	commands.run = func(_ context.Context, process Process, output OutputFunc) (int, error) {
		if len(commands.processes) == 2 {
			if process.Args[0] != "--context" || process.Args[2] != "start" {
				t.Fatalf("unexpected container start %v", process.Args)
			}
			if _, err := os.Stat(environmentFile); !errors.Is(err, os.ErrNotExist) {
				t.Fatalf("environment file remained after container creation: %v", err)
			}
			return 0, nil
		}
		if process.Program != "docker" {
			t.Fatalf("unexpected runtime executable %q", process.Program)
		}
		if slices.Contains(process.Env, "CAO_PRIVATE_KEY=excluded") {
			t.Fatal("server credentials must not be inherited by the container runtime")
		}
		if slices.Contains(process.Args, "scoped-value") {
			t.Fatal("the scoped token must not appear in runtime arguments")
		}
		environmentFile = process.Args[slices.Index(process.Args, "--env-file")+1]
		info, err := os.Stat(environmentFile)
		if err != nil {
			t.Fatal(err)
		}
		if info.Mode().Perm() != 0o600 {
			t.Fatalf("environment file mode = %o, want 0600", info.Mode().Perm())
		}
		// #nosec G304 -- the path is created by writeContainerEnvironment in this test.
		contents, err := os.ReadFile(environmentFile)
		if err != nil {
			t.Fatal(err)
		}
		if !strings.Contains(string(contents), "GH_TOKEN=scoped-value\n") {
			t.Fatal("container must receive the scoped token through its protected environment file")
		}
		for _, arg := range []string{"--context", "default", "create", "--read-only", "--cap-drop", "ALL", "--security-opt", "no-new-privileges", "--network", "bridge"} {
			if !slices.Contains(process.Args, arg) {
				t.Fatalf("runtime arguments %v do not include %q", process.Args, arg)
			}
		}
		if !slices.Contains(process.Args, DefaultContainerImage) ||
			!slices.Contains(process.Args, "--entrypoint") ||
			!slices.Contains(process.Args, "gh-aw") ||
			!slices.Contains(process.Args, "update") {
			t.Fatalf("unexpected container invocation %v", process.Args)
		}
		mount := process.Args[slices.Index(process.Args, "--mount")+1]
		if mount != "type=bind,src="+workspace+",dst=/workspace,rw" {
			t.Fatalf("unexpected workspace mount %q", mount)
		}
		output("stdout", []byte(strings.Repeat("a", 64)+"\n"))
		return 0, nil
	}
	_, err = runner.Run(context.Background(), Process{
		Workspace: workspace, Dir: work, Program: "gh-aw", Args: []string{"update", "https://github.com/githubnext/gh-aw-cao/security"},
		Env: []string{"GH_TOKEN=scoped-value", "HOME=/workspace/home"},
	}, nil)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(environmentFile); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("environment file was not removed: %v", err)
	}
}

func TestContainerRunnerRemovesContainerAfterCancellation(t *testing.T) {
	workspace := t.TempDir()
	commands := &containerCommandRunner{}
	runner, err := NewContainerRunner(DefaultContainerImage, "docker", commands)
	if err != nil {
		t.Fatal(err)
	}
	cancelContext := func() {}
	commands.run = func(ctx context.Context, process Process, output OutputFunc) (int, error) {
		switch len(commands.processes) {
		case 1:
			if len(process.Args) < 3 || process.Args[0] != "--context" || process.Args[1] != "default" || process.Args[2] != "create" {
				t.Fatalf("first call = %v, want docker create", process.Args)
			}
			output("stdout", []byte(strings.Repeat("b", 64)+"\n"))
			return 0, nil
		case 2:
			if len(process.Args) < 4 || process.Args[2] != "start" || process.Args[3] != "--attach" {
				t.Fatalf("second call = %v, want docker start --attach", process.Args)
			}
			cancelContext()
			return -1, context.Canceled
		}
		if err := ctx.Err(); err != nil {
			t.Fatalf("cleanup context is canceled: %v", err)
		}
		if len(process.Args) != 5 || process.Args[0] != "--context" || process.Args[1] != "default" || process.Args[2] != "rm" || process.Args[3] != "--force" {
			t.Fatalf("unexpected container cleanup %v", process.Args)
		}
		runName := commands.processes[0].Args[slices.Index(commands.processes[0].Args, "--name")+1]
		if process.Args[4] != runName {
			t.Fatalf("cleanup target %q does not match running container %q", process.Args[4], runName)
		}
		return 0, nil
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancelContext = cancel
	_, err = runner.Run(ctx, Process{
		Workspace: workspace, Dir: workspace, Program: "gh", Args: []string{"workflow", "run", "cao.yml"},
		Env: []string{"GH_TOKEN=scoped-value"},
	}, nil)
	if !errors.Is(err, context.Canceled) {
		t.Fatalf("run error = %v, want cancellation", err)
	}
	if len(commands.processes) != 3 {
		t.Fatalf("container cleanup calls = %d, want create, start, and remove", len(commands.processes))
	}
}

func TestContainerRunnerRejectsMutableImagesAndOutsideWorkspaces(t *testing.T) {
	for _, image := range []string{"ghcr.io/github/gh-aw:latest", "ghcr.io/github/gh-aw@sha256:abc"} {
		if _, err := NewContainerRunner(image, "", nil); err == nil {
			t.Errorf("mutable or invalid image %q was accepted", image)
		}
	}
	runner, err := NewContainerRunner(DefaultContainerImage, "", &containerCommandRunner{})
	if err != nil {
		t.Fatal(err)
	}
	_, err = runner.Run(context.Background(), Process{
		Workspace: t.TempDir(), Dir: t.TempDir(), Program: "gh-aw",
	}, nil)
	if err == nil || !strings.Contains(err.Error(), "inside its workspace") {
		t.Fatalf("outside working directory was not rejected: %v", err)
	}
}
