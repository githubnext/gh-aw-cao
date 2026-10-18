package hostedcli

import (
	"context"
	"errors"
	"reflect"
	"slices"
	"testing"
	"time"

	"github.com/githubnext/gh-aw-cao/server/internal/operational"
)

type fakeContainerLifecycle struct {
	calls     []string
	identity  operational.CLICommandExecution
	spec      ContainerSpec
	state     ContainerState
	failures  map[string]error
	runtimeID string
	onCall    func(context.Context, string)
}

func (f *fakeContainerLifecycle) call(ctx context.Context, stage string) error {
	f.calls = append(f.calls, stage)
	if f.onCall != nil {
		f.onCall(ctx, stage)
	}
	if ctx.Err() != nil {
		return ctx.Err()
	}
	return f.failures[stage]
}

func (f *fakeContainerLifecycle) RuntimeID(ctx context.Context) (string, error) {
	return f.runtimeID, f.call(ctx, "runtime")
}

func (f *fakeContainerLifecycle) Create(ctx context.Context, execution operational.CLICommandExecution, spec ContainerSpec) error {
	f.identity, f.spec = execution, spec
	return f.call(ctx, "create")
}

func (f *fakeContainerLifecycle) Start(ctx context.Context, execution operational.CLICommandExecution) error {
	if execution != f.identity {
		return errors.New("start identity changed")
	}
	return f.call(ctx, "start")
}

func (f *fakeContainerLifecycle) Inspect(ctx context.Context, execution operational.CLICommandExecution) (ContainerState, error) {
	if execution != f.identity {
		return ContainerState{}, errors.New("inspect identity changed")
	}
	return f.state, f.call(ctx, "inspect")
}

func (f *fakeContainerLifecycle) Stop(ctx context.Context, execution operational.CLICommandExecution) error {
	if execution != f.identity {
		return errors.New("stop identity changed")
	}
	return f.call(ctx, "stop")
}

func (f *fakeContainerLifecycle) CollectOutput(ctx context.Context, execution operational.CLICommandExecution, output OutputFunc) error {
	if execution != f.identity {
		return errors.New("output identity changed")
	}
	if output != nil {
		output("stdout", []byte("early output\n"))
		output("stderr", []byte("later output\n"))
	}
	return f.call(ctx, "output")
}

func lifecycleTest(t *testing.T) (*ContainerRunner, *fakeContainerLifecycle, Process) {
	t.Helper()
	code := 17
	lifecycle := &fakeContainerLifecycle{
		runtimeID: "virtual:test-namespace",
		state:     ContainerState{Terminated: true, ExitCode: &code},
		failures:  map[string]error{},
	}
	runner, err := NewContainerRunner("", lifecycle)
	if err != nil {
		t.Fatal(err)
	}
	process := Process{
		CommandID: 1, Workspace: "/private/command", Dir: "/private/command/work",
		Program: "gh-aw", Args: []string{"upgrade", "--repo", "octo/app"},
		Env: []string{"GH_TOKEN=test-token"},
		RegisterContainer: func(ctx context.Context, execution operational.CLICommandExecution) error {
			if err := execution.Validate(); err != nil {
				return err
			}
			return lifecycle.call(ctx, "register")
		},
	}
	return runner, lifecycle, process
}

func TestContainerRunnerUsesRuntimeNeutralLifecycle(t *testing.T) {
	runner, lifecycle, process := lifecycleTest(t)
	var output []string
	code, err := runner.Run(t.Context(), process, func(stream string, data []byte) {
		output = append(output, stream+":"+string(data))
	})
	if code != 17 || err != nil {
		t.Fatalf("result = %d %v", code, err)
	}
	wantCalls := []string{"runtime", "register", "create", "start", "output", "runtime", "inspect", "stop"}
	if !slices.Equal(lifecycle.calls, wantCalls) {
		t.Fatalf("lifecycle order = %v", lifecycle.calls)
	}
	wantSpec := ContainerSpec{
		Image: DefaultContainerImage, Workspace: process.Workspace, Directory: process.Dir,
		Program: process.Program, Args: process.Args, Env: process.Env,
	}
	if !reflect.DeepEqual(lifecycle.spec, wantSpec) {
		t.Fatal("lifecycle did not receive the exact private command specification")
	}
	if !slices.Equal(output, []string{"stdout:early output\n", "stderr:later output\n"}) {
		t.Fatalf("output = %v", output)
	}
}

func TestContainerLifecycleAdmissionFailsBeforeCreate(t *testing.T) {
	for _, stage := range []string{"runtime", "register", "invalid-runtime", "stdin", "executable", "cancel-after-register"} {
		t.Run(stage, func(t *testing.T) {
			runner, lifecycle, process := lifecycleTest(t)
			ctx, cancel := context.WithCancel(t.Context())
			defer cancel()
			switch stage {
			case "invalid-runtime":
				lifecycle.runtimeID = ""
			case "stdin":
				process.Stdin = "must not be silently dropped"
			case "executable":
				process.Program = "sh"
			case "cancel-after-register":
				lifecycle.onCall = func(_ context.Context, call string) {
					if call == "register" {
						cancel()
					}
				}
			default:
				lifecycle.failures[stage] = errors.New("unavailable")
			}
			if _, err := runner.Run(ctx, process, nil); err == nil {
				t.Fatal("invalid execution accepted")
			}
			if slices.Contains(lifecycle.calls, "create") {
				t.Fatal("container created despite failed admission")
			}
		})
	}
	if _, err := NewContainerRunner("", nil); err == nil {
		t.Fatal("missing lifecycle accepted")
	}
}

func TestContainerLifecycleFailureKeepsUnconfirmedClaim(t *testing.T) {
	for _, stage := range []string{"create", "start", "output", "inspect", "cancel", "runtime-changed"} {
		t.Run(stage, func(t *testing.T) {
			runner, lifecycle, process := lifecycleTest(t)
			lifecycle.state = ContainerState{}
			lifecycle.failures["stop"] = errors.New("termination not confirmed")
			lifecycle.failures[stage] = errors.New("transport unavailable")
			ctx, cancel := context.WithCancel(t.Context())
			defer cancel()
			lifecycle.onCall = func(callCtx context.Context, call string) {
				if call == "output" {
					if stage == "cancel" {
						cancel()
					}
					if stage == "runtime-changed" {
						lifecycle.runtimeID = "virtual:different-namespace"
					}
				}
				if call == "stop" || call == "inspect" {
					deadline, ok := callCtx.Deadline()
					if callCtx.Err() != nil || !ok || time.Until(deadline) > 10*time.Second {
						t.Fatal("cleanup must detach cancellation and retain its time bound")
					}
				}
			}
			code, err := runner.Run(ctx, process, nil)
			if code != -1 || !errors.Is(err, ErrContainerTerminationUnconfirmed) {
				t.Fatalf("uncertainty settled: %d %v", code, err)
			}
			if stage == "runtime-changed" && slices.Contains(lifecycle.calls, "stop") {
				t.Fatal("stopped container on a different runtime")
			}
			if stage == "create" && slices.Contains(lifecycle.calls, "start") {
				t.Fatal("started after failed create")
			}
			if stage == "start" && slices.Contains(lifecycle.calls, "output") {
				t.Fatal("collected output after failed start")
			}
		})
	}
}

func TestContainerLifecycleRequiresValidWorkloadEvidence(t *testing.T) {
	validCode, invalidCode := 0, 256
	for _, tc := range []struct {
		name        string
		state       ContainerState
		inspectFail bool
		unconfirmed bool
	}{
		{name: "zero-state", unconfirmed: true},
		{name: "running-with-code", state: ContainerState{ExitCode: &validCode}, unconfirmed: true},
		{name: "invalid-code", state: ContainerState{Terminated: true, ExitCode: &invalidCode}, unconfirmed: true},
		{name: "failed-inspection", state: ContainerState{Terminated: true, ExitCode: &validCode}, inspectFail: true, unconfirmed: true},
		{name: "terminated-without-result", state: ContainerState{Terminated: true}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			runner, lifecycle, process := lifecycleTest(t)
			lifecycle.state = tc.state
			lifecycle.failures["stop"] = errors.New("cleanup unavailable")
			if tc.inspectFail {
				lifecycle.failures["inspect"] = errors.New("state unavailable")
			}
			code, err := runner.Run(t.Context(), process, nil)
			if code != -1 || err == nil || errors.Is(err, ErrContainerTerminationUnconfirmed) != tc.unconfirmed {
				t.Fatalf("workload evidence = %d %v", code, err)
			}
		})
	}
}
