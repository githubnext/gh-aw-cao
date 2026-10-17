package hostedcli

import (
	"context"
	"errors"
	"os"
	"slices"
	"strings"
	"testing"
	"time"
)

func TestWindowsSandboxHCSInventoryContract(t *testing.T) {
	for _, test := range []struct {
		name string
		raw  string
		vms  int
	}{
		{name: "empty", raw: `[]`},
		{name: "container", raw: `[{"Id":"container","SystemType":"Container"}]`},
		{name: "running-vm", raw: `[{"Id":"not-a-wsb-guid","SystemType":"VirtualMachine","State":"Running","Owner":"other-user"}]`, vms: 1},
		{name: "stopped-vm-still-exists", raw: `[{"Id":"stopped","SystemType":"VirtualMachine","Stopped":true}]`, vms: 1},
		{name: "mixed", raw: `[{"Id":"vm","SystemType":"VirtualMachine"},{"Id":"container","SystemType":"Container"}]`, vms: 1},
		{name: "multiple-vms", raw: `[{"Id":"first","SystemType":"VirtualMachine"},{"Id":"second","SystemType":"VirtualMachine"}]`, vms: 2},
	} {
		t.Run(test.name, func(t *testing.T) {
			count, err := parseWindowsSandboxHCSInventory([]byte(test.raw))
			if err != nil || count != test.vms {
				t.Fatalf("HCS VM inventory = %d, %v; want %d", count, err, test.vms)
			}
		})
	}
	for _, raw := range []string{
		"", "null", "{}", `{"VirtualMachines":[]}`, "[] trailing", "[null]", "[[]]", "[{}]",
		`[{"Id":"vm","SystemType":"Unknown"}]`, `[{"Id":"vm"}]`, `[{"SystemType":"VirtualMachine"}]`,
		`[{"Id":"vm","SystemType":null}]`, `[{"Id":"vm","SystemType":1}]`,
		`[{"Id":"vm","SystemType":"VirtualMachine","systemtype":"Container"}]`,
		`[{"Id":"vm","SystemType":"VirtualMachine"},{"Id":"VM","SystemType":"Container"}]`,
		strings.Repeat(" ", windowsSandboxResponseMax) + "[{}]",
	} {
		if _, err := parseWindowsSandboxHCSInventory([]byte(raw)); err == nil {
			t.Fatalf("malformed HCS inventory accepted: %.100q", raw)
		}
	}
}

func TestWindowsSandboxHCSDetectsVMOutsideCLIInventory(t *testing.T) {
	for _, cli := range []string{"[]", `[{"Id":"aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa","Status":"stopped"}]`} {
		f := newWindowsSandboxFixture(t)
		f.machine.raw = cli
		f.machine.hcsRetained = true
		runner := f.runner(t)
		if err := runner.Lifecycle.Create(t.Context(), f.execution(1), f.spec(t, "hcs-preexisting")); err == nil {
			t.Fatal("headless, orphaned, or other-user HCS VM was ignored")
		}
		for _, operation := range f.machine.operations() {
			if operation != "list" {
				t.Fatal("unrelated HCS VM caused a modifying CLI request:", operation)
			}
		}
		root, err := os.OpenRoot(f.host.root)
		if err != nil {
			t.Fatal(err)
		}
		_, ownerErr := windowsSandboxOwner(root)
		_ = root.Close()
		if !errors.Is(ownerErr, os.ErrNotExist) {
			t.Fatal("HCS preflight failure took global ownership")
		}
	}
}

func TestWindowsSandboxHCSRechecksVMsImmediatelyBeforeLaunch(t *testing.T) {
	f := newWindowsSandboxFixture(t)
	runner := f.runner(t)
	execution := f.execution(1)
	if err := runner.Lifecycle.Create(t.Context(), execution, f.spec(t, "hcs-after-prepare")); err != nil {
		t.Fatal(err)
	}
	f.machine.hcsRetained = true
	if err := runner.Lifecycle.Start(t.Context(), execution); err == nil {
		t.Fatal("HCS VM appeared after staging but launch still proceeded")
	}
	if slices.Contains(f.machine.operations(), "start") {
		t.Fatal("VM was launched while another HCS VM existed")
	}
}

func TestWindowsSandboxHCSVMRemainingAfterCLIStopRetainsFence(t *testing.T) {
	for _, cliState := range []string{"absent", "stopped"} {
		t.Run(cliState, func(t *testing.T) {
			f := newWindowsSandboxFixture(t)
			runner := f.runner(t)
			execution := f.execution(1)
			if err := runner.Lifecycle.Create(t.Context(), execution, f.spec(t, "hcs-lingering")); err != nil {
				t.Fatal(err)
			}
			ctx, cancel := context.WithCancel(t.Context())
			defer cancel()
			if err := runner.Lifecycle.Start(ctx, execution); err != nil {
				t.Fatal(err)
			}
			id, err := windowsSandboxID(execution)
			if err != nil {
				t.Fatal(err)
			}
			f.machine.mutex.Lock()
			f.machine.hcsRetained = true
			f.machine.raw = "[]"
			if cliState == "stopped" {
				f.machine.raw = `[{"Id":"` + id + `","Status":"stopped"}]`
			}
			f.machine.mutex.Unlock()

			short, end := context.WithTimeout(t.Context(), 2*time.Second)
			defer end()
			lifecycle := runner.Lifecycle.(*windowsSandboxLifecycle)
			inventory := lifecycle.host.computeSystems
			cleanupReads := 0
			lifecycle.host.computeSystems = func(ctx context.Context) ([]byte, error) {
				data, err := inventory(ctx)
				cleanupReads++
				if cleanupReads == 2 {
					end()
				}
				return data, err
			}
			if err := runner.Lifecycle.Stop(short, execution); err == nil {
				t.Fatal("CLI absence/stopped result overrode a remaining HCS VM")
			}
			state, err := runner.Lifecycle.Inspect(t.Context(), execution)
			if err != nil || state.Terminated || state.ExitCode != nil {
				t.Fatalf("remaining HCS VM produced termination evidence: %#v, %v", state, err)
			}
			fresh := f.runner(t)
			if err := fresh.Lifecycle.Create(t.Context(), f.execution(2), f.spec(t, "hcs-blocked")); err == nil {
				t.Fatal("unconfirmed HCS absence released the cross-process ownership fence")
			}
			f.machine.mutex.Lock()
			for _, call := range f.machine.calls {
				if call.Args[0] == "stop" && (len(call.Args) < 3 || call.Args[1] != "--id" || call.Args[2] != id) {
					t.Error("stop request addressed an ID not owned by this executor")
				}
			}
			if cleanupReads < 2 {
				t.Error("independent HCS inventory was not polled after stopping")
			}
			f.machine.hcsRetained = false
			f.machine.mutex.Unlock()
			if err := fresh.Reconcile(t.Context(), execution); err != nil {
				t.Fatal("confirmed zero HCS VMs did not permit acknowledged-launch recovery:", err)
			}
		})
	}
}

func TestWindowsSandboxHCSInventoryFailuresBlockLaunchAndCleanup(t *testing.T) {
	for _, failure := range []string{"unavailable", "malformed", "missing-provider"} {
		t.Run(failure, func(t *testing.T) {
			f := newWindowsSandboxFixture(t)
			runner := f.runner(t)
			setFailure := func() {
				f.machine.mutex.Lock()
				defer f.machine.mutex.Unlock()
				switch failure {
				case "unavailable":
					f.machine.hcsError = errors.New("private platform diagnostics")
				case "malformed":
					f.machine.hcsRaw = `{"VirtualMachines":[]}`
				case "missing-provider":
					runner.Lifecycle.(*windowsSandboxLifecycle).host.computeSystems = nil
				}
			}
			setFailure()
			spec := f.spec(t, "hcs-failure")
			if err := runner.Lifecycle.Create(t.Context(), f.execution(1), spec); err == nil ||
				strings.Contains(err.Error(), "private platform diagnostics") {
				t.Fatal("missing HCS evidence either allowed launch or exposed diagnostics:", err)
			}
			if slices.Contains(f.machine.operations(), "start") {
				t.Fatal("missing HCS inventory allowed VM creation")
			}
			f.machine.hcsError, f.machine.hcsRaw = nil, ""
			runner.Lifecycle.(*windowsSandboxLifecycle).host.computeSystems = f.machine.computeSystems
			if err := runner.Lifecycle.Create(t.Context(), f.execution(1), spec); err != nil {
				t.Fatal(err)
			}
			ctx, cancel := context.WithCancel(t.Context())
			defer cancel()
			if err := runner.Lifecycle.Start(ctx, f.execution(1)); err != nil {
				t.Fatal(err)
			}
			setFailure()
			if err := runner.Reconcile(t.Context(), f.execution(1)); !errors.Is(err, ErrContainerTerminationUnconfirmed) {
				t.Fatal("missing HCS evidence allowed cleanup to settle:", err)
			}
		})
	}
}

func TestWindowsSandboxHCSZeroDoesNotClearUncertainStart(t *testing.T) {
	f := newWindowsSandboxFixture(t)
	runner := f.runner(t)
	f.machine.startError = true
	execution := f.execution(1)
	if err := runner.Lifecycle.Create(t.Context(), execution, f.spec(t, "hcs-uncertain-start")); err != nil {
		t.Fatal(err)
	}
	if err := runner.Lifecycle.Start(t.Context(), execution); err == nil {
		t.Fatal("uncertain start was accepted")
	}
	count, err := runner.Lifecycle.(*windowsSandboxLifecycle).hcsVMCount(t.Context())
	if err != nil || count != 0 {
		t.Fatal("test requires independent zero-VM evidence")
	}
	if err := f.runner(t).Reconcile(t.Context(), execution); !errors.Is(err, ErrContainerTerminationUnconfirmed) {
		t.Fatal("an empty HCS snapshot cleared the still-pending start fence:", err)
	}
}
