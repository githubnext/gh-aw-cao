package hostedcli

import (
	"context"
	"errors"
	"os"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/githubnext/gh-aw-cao/server/internal/operational"
)

type appleOutput struct {
	stream string
	data   []byte
}

type appleExecution struct {
	workspace  string
	output     chan appleOutput
	mutex      sync.Mutex
	cancel     context.CancelFunc
	clientCode int
	err        error
}

func (r *AppleContainerLifecycle) Start(ctx context.Context, execution operational.CLICommandExecution) error {
	run, err := r.execution(execution.Name)
	if err != nil {
		return err
	}
	run.mutex.Lock()
	defer run.mutex.Unlock()
	if run.cancel != nil {
		return errors.New("hosted CLI native execution was already started")
	}
	runCtx, cancel := context.WithCancel(ctx)
	run.cancel = cancel
	// Attached startup preserves both streams from the first byte. Apple's
	// logs --follow has no workload-exit signal and can wait indefinitely.
	go func() {
		defer close(run.output)
		code, err := r.Commands.Run(runCtx, Process{
			Program: r.Binary, Args: []string{"start", "--attach", execution.Name}, Env: r.HostEnv,
		}, func(stream string, data []byte) {
			for len(data) > 0 {
				size := min(len(data), 4096)
				chunk := appleOutput{stream: stream, data: append([]byte(nil), data[:size]...)}
				select {
				case run.output <- chunk:
				case <-runCtx.Done():
					return
				}
				data = data[size:]
			}
		})
		run.clientCode = code
		switch {
		case runCtx.Err() != nil:
			run.err = runCtx.Err()
		case err != nil:
			run.err = errors.New("hosted CLI native output transport exited unsuccessfully")
		}
	}()
	return nil
}

func (r *AppleContainerLifecycle) CollectOutput(ctx context.Context, execution operational.CLICommandExecution, output OutputFunc) error {
	run, err := r.execution(execution.Name)
	if err != nil {
		return err
	}
	for chunk := range run.output {
		if output != nil {
			output(chunk.stream, chunk.data)
		}
	}
	if ctx.Err() != nil {
		return ctx.Err()
	}
	// The attached process can return just before the API server unregisters
	// its VM service. Bound that normal shutdown race separately from cleanup.
	waitCtx, cancel := context.WithTimeout(ctx, 2*time.Second)
	defer cancel()
	for {
		stopped, err := r.stopped(waitCtx, execution)
		if err != nil {
			return errors.Join(run.err, err)
		}
		if stopped {
			if run.err == nil && run.clientCode != 0 {
				state, err := r.Inspect(waitCtx, execution)
				if err != nil || state.ExitCode == nil || *state.ExitCode != run.clientCode {
					return errors.New("hosted CLI native output transport exited unsuccessfully")
				}
			}
			return run.err
		}
		select {
		case <-waitCtx.Done():
			return errors.Join(run.err, errors.New("hosted CLI native VM shutdown was not confirmed"))
		case <-time.After(50 * time.Millisecond):
		}
	}
}

func (r *AppleContainerLifecycle) Inspect(ctx context.Context, execution operational.CLICommandExecution) (ContainerState, error) {
	stopped, err := r.stopped(ctx, execution)
	if err != nil || !stopped {
		return ContainerState{}, err
	}
	active, ok := r.runs.Load(execution.Name)
	if !ok {
		return ContainerState{Terminated: true}, nil
	}
	run := active.(*appleExecution)
	value, err := appleReadPrivateFile(run.workspace, ".cao-apple/result", 96)
	if errors.Is(err, os.ErrNotExist) {
		return ContainerState{Terminated: true}, nil
	}
	if err != nil {
		return ContainerState{}, errors.New("hosted CLI native workload receipt is unavailable")
	}
	lines := strings.Split(strings.TrimSuffix(string(value), "\n"), "\n")
	if len(lines) != 2 || lines[0] != execution.Name {
		return ContainerState{}, errors.New("hosted CLI native workload receipt is invalid")
	}
	code, err := strconv.Atoi(lines[1])
	if err != nil || code < 0 || code > 255 || strconv.Itoa(code) != lines[1] {
		return ContainerState{}, errors.New("hosted CLI native workload receipt has an invalid exit code")
	}
	return ContainerState{Terminated: true, ExitCode: &code}, nil
}

func (r *AppleContainerLifecycle) Stop(ctx context.Context, execution operational.CLICommandExecution) error {
	ctx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
	if err := execution.Validate(); err != nil {
		return errors.New("hosted CLI native recovery identity is invalid")
	}
	if run, err := r.execution(execution.Name); err == nil {
		run.mutex.Lock()
		if run.cancel != nil {
			run.cancel()
		}
		run.mutex.Unlock()
	}
	// Even successful delete is not enough: native runtime versions can swallow
	// launchd deregistration failures. Independently check the VM service.
	_, _, _ = r.capture(ctx, r.Binary, []string{"delete", "--force", execution.Name})
	for {
		present, err := r.servicePresent(ctx, execution.Name)
		if err != nil {
			return err
		}
		value, code, err := r.capture(ctx, r.Binary, []string{"list", "--all", "--quiet"})
		if err != nil || code != 0 {
			return errors.New("hosted CLI native container inventory is unavailable")
		}
		retained := false
		for _, line := range strings.Split(strings.TrimSpace(value), "\n") {
			if line == "" && strings.TrimSpace(value) == "" {
				break
			}
			name := strings.TrimSpace(line)
			if strings.ContainsAny(name, " \t\r") || name == "" {
				return errors.New("hosted CLI native container inventory is invalid")
			}
			retained = retained || name == execution.Name
		}
		if !present && !retained {
			r.runs.Delete(execution.Name)
			return nil
		}
		select {
		case <-ctx.Done():
			return errors.New("hosted CLI native VM termination could not be confirmed")
		case <-time.After(50 * time.Millisecond):
		}
	}
}
