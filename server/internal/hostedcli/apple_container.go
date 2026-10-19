package hostedcli

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"sync"

	"github.com/githubnext/gh-cao/server/internal/operational"
)

// AppleContainerLifecycle is a local-development adapter for Apple's container
// CLI on Apple Silicon. Every workload runs in its own Linux VM.
type AppleContainerLifecycle struct {
	Binary   string
	HostEnv  []string
	Commands Runner
	runs     sync.Map
}

var _ ContainerLifecycle = (*AppleContainerLifecycle)(nil)

// Apple's inspect API omits exit codes. Record a bounded receipt inside the
// pinned guest, but accept it only after the VM service has disappeared.
const appleContainerBootstrap = `identity=$1; shift
git -c init.defaultBranch=main init --quiet --template= . && "$@"
status=$?
(umask 077; printf '%s\n%s\n' "$identity" "$status" > /workspace/.cao-apple/result.tmp && mv /workspace/.cao-apple/result.tmp /workspace/.cao-apple/result)
exit "$status"`

func NewAppleContainerLifecycle(binary string, commands Runner) (*AppleContainerLifecycle, error) {
	if runtime.GOOS != "darwin" || runtime.GOARCH != "arm64" {
		return nil, errors.New("the Apple container runtime requires macOS on Apple Silicon")
	}
	if os.Getuid() == 0 {
		return nil, errors.New("the Apple container runtime requires an unprivileged local user")
	}
	if binary == "" {
		binary = "container"
	}
	if commands == nil {
		commands = ExecRunner{}
	}
	var environment []string
	for _, entry := range os.Environ() {
		name, _, _ := strings.Cut(entry, "=")
		if name == "PATH" || name == "HOME" {
			environment = append(environment, entry)
		}
	}
	return &AppleContainerLifecycle{Binary: binary, Commands: commands, HostEnv: environment}, nil
}

func (r *AppleContainerLifecycle) Create(ctx context.Context, execution operational.CLICommandExecution, spec ContainerSpec) error {
	workspace, workdir, err := containerPaths(spec.Workspace, spec.Directory)
	if err != nil {
		return err
	}
	if strings.ContainsAny(workspace, ",\r\n") {
		return errors.New("hosted CLI workspace path cannot be mounted by the Apple runtime")
	}
	if err := os.Mkdir(filepath.Join(workspace, ".cao-apple"), 0o700); err != nil {
		return errors.New("hosted CLI native execution receipt directory could not be created")
	}
	run := &appleExecution{workspace: workspace, output: make(chan appleOutput, 16)}
	if _, loaded := r.runs.LoadOrStore(execution.Name, run); loaded {
		return errors.New("hosted CLI native execution identity is already in use")
	}
	environmentFile, err := writeContainerEnvironment(spec.Env)
	if err != nil {
		return err
	}
	defer func() { _ = os.Remove(environmentFile) }()
	args := append([]string{
		"create", "--name", execution.Name, "--init",
		"--runtime", "container-runtime-linux", "--platform", "linux/amd64", "--rosetta",
		"--network", "default", "--read-only", "--cap-drop", "ALL",
		"--user", containerUser(), "--cpus", "2", "--memory", "1g",
		"--ulimit", "nproc=256:256", "--ulimit", "core=0:0",
		"--mount", "type=bind,source=" + workspace + ",target=/workspace",
		"--mount", "type=tmpfs,target=/tmp,size=64m,mode=1777",
		"--workdir", workdir, "--env-file", environmentFile,
		"--entrypoint", "/bin/setpriv", spec.Image,
		"--no-new-privs", "/bin/sh", "-c", appleContainerBootstrap,
		"cao-hosted-cli", execution.Name, spec.Program,
	}, spec.Args...)
	value, code, createErr := r.capture(ctx, r.Binary, args)
	if err := os.Remove(environmentFile); err != nil && !errors.Is(err, os.ErrNotExist) {
		return errors.New("hosted CLI native container environment could not be removed")
	}
	if createErr != nil || code != 0 || strings.TrimSpace(value) != execution.Name {
		return errors.New("hosted CLI native container could not be created")
	}
	return nil
}

func (r *AppleContainerLifecycle) execution(name string) (*appleExecution, error) {
	value, ok := r.runs.Load(name)
	if !ok {
		return nil, errors.New("hosted CLI native execution was not prepared")
	}
	return value.(*appleExecution), nil
}

func (r *AppleContainerLifecycle) capture(ctx context.Context, program string, args []string) (string, int, error) {
	var value strings.Builder
	overflow := false
	code, err := r.Commands.Run(ctx, Process{Program: program, Args: args, Env: r.HostEnv}, func(stream string, data []byte) {
		if stream != "stdout" {
			return
		}
		if value.Len()+len(data) > 64*1024 {
			overflow = true
			return
		}
		_, _ = value.Write(data)
	})
	if overflow {
		return "", code, errors.New("hosted CLI native runtime response exceeded its limit")
	}
	return value.String(), code, err
}
