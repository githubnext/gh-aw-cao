package hostedcli

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/githubnext/gh-aw-cao/server/internal/operational"
)

// ErrContainerTerminationUnconfirmed means the durable claim must not be
// settled and the workspace must remain intact for operator recovery.
var ErrContainerTerminationUnconfirmed = errors.New("hosted CLI container termination is unconfirmed")

func (r *ContainerRunner) runtimeID(ctx context.Context) (string, error) {
	if err := r.requireLocalDockerContext(ctx); err != nil {
		return "", err
	}
	value, code, err := r.capture(ctx, []string{"info", "--format={{.ID}}"})
	id := strings.TrimSpace(value)
	if err != nil || code != 0 || id == "" || len(id) > 128 || strings.ContainsAny(id, "\x00\r\n") {
		return "", errors.New("hosted CLI Docker daemon identity is unavailable")
	}
	return id, nil
}

func (r *ContainerRunner) capture(ctx context.Context, args []string) (string, int, error) {
	var value strings.Builder
	overflow := false
	code, err := r.Commands.Run(ctx, Process{
		Program: r.DockerBinary, Args: append([]string{"--context", "default"}, args...), Env: r.HostEnv,
	}, func(stream string, data []byte) {
		if stream != "stdout" {
			return
		}
		if value.Len()+len(data) > 4096 {
			overflow = true
			return
		}
		_, _ = value.Write(data)
	})
	if overflow {
		return "", code, errors.New("hosted CLI Docker response exceeded its limit")
	}
	return value.String(), code, err
}

// Reconcile forcibly removes a recorded container on its original daemon.
// The caller must first ensure the old executor and Docker requests stopped:
// an old process must not be able to create/start it after this check.
func (r *ContainerRunner) Reconcile(ctx context.Context, execution operational.CLICommandExecution) error {
	cleanupCtx, cancel := context.WithTimeout(context.WithoutCancel(ctx), 10*time.Second)
	defer cancel()
	if err := execution.Validate(); err != nil {
		return fmt.Errorf("%w: invalid recovery identity", ErrContainerTerminationUnconfirmed)
	}
	if err := r.sameRuntime(cleanupCtx, execution); err != nil {
		return err
	}
	if err := r.removeContainer(cleanupCtx, execution.Name); err != nil {
		return fmt.Errorf("%w: removal could not be confirmed", ErrContainerTerminationUnconfirmed)
	}
	return nil
}

func (r *ContainerRunner) sameRuntime(ctx context.Context, execution operational.CLICommandExecution) error {
	id, err := r.runtimeID(ctx)
	if err != nil || id != execution.RuntimeID {
		return fmt.Errorf("%w: original Docker daemon is unavailable", ErrContainerTerminationUnconfirmed)
	}
	return nil
}

func (r *ContainerRunner) removeContainer(ctx context.Context, name string) error {
	code, err := r.Commands.Run(ctx, Process{
		Program: r.DockerBinary, Args: []string{"--context", "default", "rm", "--force", name}, Env: r.HostEnv,
	}, nil)
	if err == nil && code == 0 {
		return nil
	}
	// A successful, empty exact-name inventory proves absence. An inspect/rm
	// error alone cannot distinguish absence from a disconnected daemon.
	value, code, err := r.capture(ctx, []string{"container", "ls", "--all", "--quiet", "--no-trunc", "--filter", "name=^/" + name + "$"})
	if err == nil && code == 0 && strings.TrimSpace(value) == "" {
		return nil
	}
	return errors.New("hosted CLI container removal failed")
}

func (r *ContainerRunner) finishContainer(ctx context.Context, execution operational.CLICommandExecution, attachCode int, attachErr error) (int, error) {
	cleanupCtx, cancel := context.WithTimeout(context.WithoutCancel(ctx), 10*time.Second)
	defer cancel()
	if err := r.sameRuntime(cleanupCtx, execution); err != nil {
		return -1, err
	}
	value, inspectCode, inspectErr := r.capture(cleanupCtx, []string{"inspect", "--format={{json .State}}", execution.Name})
	var state struct {
		Status     string
		Running    *bool
		Restarting *bool
		ExitCode   *int
	}
	confirmed := inspectErr == nil && inspectCode == 0 && json.Unmarshal([]byte(value), &state) == nil &&
		state.Status == "exited" && state.Running != nil && !*state.Running &&
		state.Restarting != nil && !*state.Restarting && state.ExitCode != nil &&
		*state.ExitCode >= 0 && *state.ExitCode <= 255
	removeErr := r.removeContainer(cleanupCtx, execution.Name)
	if !confirmed {
		if removeErr != nil {
			return -1, ErrContainerTerminationUnconfirmed
		}
		if attachErr != nil {
			return -1, attachErr
		}
		return -1, fmt.Errorf("hosted CLI Docker attachment exited with code %d without a confirmed workload result", attachCode)
	}
	if removeErr != nil {
		return *state.ExitCode, errors.New("hosted CLI container exited but could not be removed")
	}
	return *state.ExitCode, attachErr
}
