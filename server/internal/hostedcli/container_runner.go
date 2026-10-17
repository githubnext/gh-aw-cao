package hostedcli

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"time"
)

const DefaultContainerImage = "ghcr.io/github/gh-aw@sha256:7ff77dc03182d4edcebc902fa94b0239eb9cde65ea212509aef700bcab354090"

var (
	containerImagePattern = regexp.MustCompile(`^[a-z0-9.-]+(?::[0-9]+)?/[a-z0-9._/-]+@sha256:[a-f0-9]{64}$`)
	containerIDPattern    = regexp.MustCompile(`^[a-f0-9]{12,64}$`)
	containerEnvName      = regexp.MustCompile(`^[A-Za-z_][A-Za-z0-9_]*$`)
)

// ContainerRunner executes only gh and gh-aw commands in the pinned gh-aw
// container. The only host path mounted into the container is the command's
// ephemeral workspace.
type ContainerRunner struct {
	DockerBinary string
	Image        string
	HostEnv      []string
	Commands     Runner
}

// NewContainerRunner creates a runner for the official gh-aw image or an
// operator-configured digest-pinned mirror.
func NewContainerRunner(image, dockerBinary string, commands Runner) (*ContainerRunner, error) {
	if image == "" {
		image = DefaultContainerImage
	}
	if !containerImagePattern.MatchString(image) {
		return nil, errors.New("hosted CLI container image must be a digest-pinned OCI image reference")
	}
	if dockerBinary == "" {
		dockerBinary = "docker"
	}
	if commands == nil {
		commands = ExecRunner{}
	}
	return &ContainerRunner{
		DockerBinary: dockerBinary,
		Image:        image,
		HostEnv:      dockerHostEnvironment(os.Environ()),
		Commands:     commands,
	}, nil
}

func (r *ContainerRunner) Run(ctx context.Context, process Process, output OutputFunc) (int, error) {
	if process.Program != "gh" && process.Program != "gh-aw" {
		return -1, errors.New("hosted CLI container rejected an unsupported executable")
	}
	workspace, workdir, err := containerPaths(process.Workspace, process.Dir)
	if err != nil {
		return -1, err
	}
	if strings.ContainsAny(workspace, ",\r\n") {
		return -1, errors.New("hosted CLI workspace path cannot be mounted by the container runtime")
	}
	if err := r.requireLocalDockerContext(ctx); err != nil {
		return -1, err
	}
	environmentFile, err := writeContainerEnvironment(process.Env)
	if err != nil {
		return -1, err
	}
	defer func() { _ = os.Remove(environmentFile) }()
	name, err := containerName()
	if err != nil {
		return -1, err
	}
	args := []string{
		"--context", "default", "create", "--rm", "--init", "--name", name,
		"--network", "bridge",
		"--read-only",
		"--cap-drop", "ALL",
		"--security-opt", "no-new-privileges",
		"--pids-limit", "256",
		"--memory", "1g",
		"--tmpfs", "/tmp:rw,nosuid,nodev,noexec,size=64m",
		"--mount", "type=bind,src=" + workspace + ",dst=/workspace,rw",
		"--workdir", workdir,
		"--env-file", environmentFile,
	}
	if user := containerUser(); user != "" {
		args = append(args, "--user", user)
	}
	if process.Stdin != "" {
		args = append(args, "--interactive")
	}
	args = append(args, "--entrypoint", process.Program, r.Image)
	args = append(args, process.Args...)

	var containerID strings.Builder
	createCode, createErr := r.Commands.Run(ctx, Process{
		Program: r.DockerBinary, Args: args, Env: r.HostEnv,
	}, func(stream string, data []byte) {
		if stream == "stdout" && containerID.Len()+len(data) <= 256 {
			_, _ = containerID.Write(data)
		}
	})
	if err := os.Remove(environmentFile); err != nil && !errors.Is(err, os.ErrNotExist) {
		if cleanupErr := r.removeContainer(ctx, name); cleanupErr != nil {
			return -1, fmt.Errorf("hosted CLI container environment could not be removed; container cleanup failed: %w", cleanupErr)
		}
		return -1, errors.New("hosted CLI container environment could not be removed")
	}
	if createErr != nil || createCode != 0 || !containerIDPattern.MatchString(strings.TrimSpace(containerID.String())) {
		cleanupErr := r.removeContainer(ctx, name)
		if cleanupErr != nil {
			return -1, fmt.Errorf("hosted CLI container could not be created or removed: %w", cleanupErr)
		}
		return createCode, errors.New("hosted CLI container could not be created")
	}
	code, runErr := r.Commands.Run(ctx, Process{
		Program: r.DockerBinary, Args: []string{"--context", "default", "start", "--attach", name},
		Env: r.HostEnv, Stdin: process.Stdin,
	}, output)
	if runErr == nil {
		return code, nil
	}
	if cleanupErr := r.removeContainer(ctx, name); cleanupErr != nil {
		return -1, fmt.Errorf("hosted CLI container stopped but could not be removed: %w", cleanupErr)
	}
	return code, runErr
}

func (r *ContainerRunner) requireLocalDockerContext(ctx context.Context) error {
	var endpoint strings.Builder
	code, err := r.Commands.Run(ctx, Process{
		Program: r.DockerBinary,
		Args:    []string{"--context", "default", "context", "inspect", "default", `--format={{ (index .Endpoints "docker").Host }}`},
		Env:     r.HostEnv,
	}, func(stream string, data []byte) {
		if stream == "stdout" && endpoint.Len()+len(data) <= 512 {
			_, _ = endpoint.Write(data)
		}
	})
	host := strings.TrimSpace(endpoint.String())
	local := strings.HasPrefix(host, "unix:///") || strings.HasPrefix(host, "npipe://")
	if err != nil || code != 0 || !local || strings.ContainsAny(host, "\r\n") {
		return errors.New("hosted CLI requires the Docker default context to use a local socket")
	}
	return nil
}

func (r *ContainerRunner) removeContainer(ctx context.Context, name string) error {
	cleanupCtx, cancel := context.WithTimeout(context.WithoutCancel(ctx), 10*time.Second)
	defer cancel()
	cleanupCode, cleanupErr := r.Commands.Run(cleanupCtx, Process{
		Program: r.DockerBinary, Args: []string{"--context", "default", "rm", "--force", name}, Env: r.HostEnv,
	}, nil)
	if cleanupErr == nil && cleanupCode == 0 {
		return nil
	}
	if cleanupErr == nil {
		cleanupErr = fmt.Errorf("docker rm exited with code %d", cleanupCode)
	}
	return cleanupErr
}

func containerPaths(workspace, directory string) (string, string, error) {
	if workspace == "" || directory == "" {
		return "", "", errors.New("hosted CLI container requires a workspace and working directory")
	}
	workspace, err := filepath.Abs(workspace)
	if err != nil {
		return "", "", errors.New("hosted CLI workspace path is invalid")
	}
	directory, err = filepath.Abs(directory)
	if err != nil {
		return "", "", errors.New("hosted CLI working directory is invalid")
	}
	workspace, err = filepath.EvalSymlinks(workspace)
	if err != nil {
		return "", "", errors.New("hosted CLI workspace path is unavailable")
	}
	directory, err = filepath.EvalSymlinks(directory)
	if err != nil {
		return "", "", errors.New("hosted CLI working directory is unavailable")
	}
	relative, err := filepath.Rel(workspace, directory)
	if err != nil || relative == ".." || strings.HasPrefix(relative, ".."+string(filepath.Separator)) || filepath.IsAbs(relative) {
		return "", "", errors.New("hosted CLI working directory must remain inside its workspace")
	}
	return workspace, filepath.ToSlash(filepath.Join("/workspace", relative)), nil
}

func writeContainerEnvironment(environment []string) (string, error) {
	file, err := os.CreateTemp("", "cao-hosted-cli-env-")
	if err != nil {
		return "", errors.New("hosted CLI container environment could not be prepared")
	}
	defer func() { _ = file.Close() }()
	if err := file.Chmod(0o600); err != nil {
		_ = os.Remove(file.Name())
		return "", errors.New("hosted CLI container environment could not be protected")
	}
	seen := make(map[string]bool, len(environment))
	for _, entry := range environment {
		name, value, ok := strings.Cut(entry, "=")
		if !ok || !containerEnvName.MatchString(name) || seen[name] || strings.ContainsAny(value, "\x00\r\n") {
			_ = os.Remove(file.Name())
			return "", errors.New("hosted CLI container environment is invalid")
		}
		seen[name] = true
		if _, err := fmt.Fprintf(file, "%s=%s\n", name, value); err != nil {
			_ = os.Remove(file.Name())
			return "", errors.New("hosted CLI container environment could not be written")
		}
	}
	if err := file.Close(); err != nil {
		_ = os.Remove(file.Name())
		return "", errors.New("hosted CLI container environment could not be closed")
	}
	return file.Name(), nil
}

func containerName() (string, error) {
	random := make([]byte, 16)
	if _, err := rand.Read(random); err != nil {
		return "", errors.New("hosted CLI container name could not be generated")
	}
	return "cao-hosted-cli-" + hex.EncodeToString(random), nil
}

func dockerHostEnvironment(environment []string) []string {
	allowed := map[string]bool{
		"PATH": true, "HOME": true, "DOCKER_CONFIG": true,
	}
	result := make([]string, 0, len(allowed))
	for _, entry := range environment {
		name, _, ok := strings.Cut(entry, "=")
		if ok && allowed[name] {
			result = append(result, entry)
		}
	}
	return result
}

func containerUser() string {
	return hostContainerUser()
}
