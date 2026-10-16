package hostedcli

import (
	"context"
	"errors"
	"io"
	"os/exec"
	"strings"
	"sync"
	"time"
)

// Process is one subprocess invocation. Env is the complete environment; the
// runner never inherits the server's environment.
type Process struct {
	Dir     string
	Program string
	Args    []string
	Env     []string
	Stdin   string
}

// OutputFunc receives subprocess output in arrival order.
type OutputFunc func(stream string, data []byte)

// Runner executes subprocesses.
type Runner interface {
	Run(context.Context, Process, OutputFunc) (int, error)
}

// ExecRunner runs subprocesses in their own process group and kills the group
// when the context ends.
type ExecRunner struct {
	// WaitDelay bounds how long output pipes may stay open after the process
	// group is killed.
	WaitDelay time.Duration
}

// Run starts process and waits for it. A non-zero exit returns the exit code
// with a nil error; err reports start failures and context termination.
func (r ExecRunner) Run(ctx context.Context, process Process, output OutputFunc) (int, error) {
	// #nosec G204 -- Program and Args come from the validated hosted plan.
	command := exec.Command(process.Program, process.Args...)
	command.Dir = process.Dir
	command.Env = process.Env
	if process.Stdin != "" {
		command.Stdin = strings.NewReader(process.Stdin)
	}
	configureProcessTree(command)
	command.WaitDelay = r.WaitDelay
	if command.WaitDelay <= 0 {
		command.WaitDelay = 5 * time.Second
	}
	var mutex sync.Mutex
	command.Stdout = streamWriter{stream: "stdout", output: output, mutex: &mutex}
	command.Stderr = streamWriter{stream: "stderr", output: output, mutex: &mutex}
	if err := command.Start(); err != nil {
		return -1, err
	}
	done := make(chan struct{})
	go func() {
		select {
		case <-ctx.Done():
			_ = terminateProcessTree(command.Process)
		case <-done:
		}
	}()
	err := command.Wait()
	close(done)
	// Kill any background helpers left in the group after a normal exit.
	_ = terminateProcessTree(command.Process)
	if ctx.Err() != nil {
		return exitCode(command), ctx.Err()
	}
	var exitErr *exec.ExitError
	if errors.As(err, &exitErr) {
		return exitErr.ExitCode(), nil
	}
	if err != nil && !errors.Is(err, exec.ErrWaitDelay) {
		return -1, err
	}
	return command.ProcessState.ExitCode(), nil
}

func exitCode(command *exec.Cmd) int {
	if command.ProcessState == nil {
		return -1
	}
	return command.ProcessState.ExitCode()
}

type streamWriter struct {
	stream string
	output OutputFunc
	mutex  *sync.Mutex
}

func (w streamWriter) Write(data []byte) (int, error) {
	if w.output != nil && len(data) > 0 {
		w.mutex.Lock()
		w.output(w.stream, append([]byte(nil), data...))
		w.mutex.Unlock()
	}
	return len(data), nil
}

var _ io.Writer = streamWriter{}
