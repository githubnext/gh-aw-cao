package hostedcli

import (
	"context"
	"errors"
	"slices"
	"testing"
)

func TestWindowsSandboxUnsafeWorkspaceRejectedBeforeVMCreation(t *testing.T) {
	for _, boundary := range []string{"work-root", "workspace", "home", "work", "data", "reparse-child", "foreign-owner"} {
		t.Run(boundary, func(t *testing.T) {
			f := newWindowsSandboxFixture(t)
			unsafe := errors.New("unsafe Windows workspace boundary: " + boundary)
			f.host.privateWorkspace = func(context.Context, string) (func(), error) { return nil, unsafe }
			runner := f.runner(t)
			err := runner.Lifecycle.Create(t.Context(), f.execution(1), f.spec(t, boundary))
			if !errors.Is(err, unsafe) {
				t.Fatal("unsafe Windows ownership/DACL/reparse evidence was ignored:", err)
			}
			if len(f.machine.operations()) != 0 || f.machine.hcsReads != 0 {
				t.Fatal("unsafe workspace reached VM runtime operations")
			}
		})
	}
}

func TestWindowsSandboxWorkspaceRevalidatedImmediatelyBeforeMapping(t *testing.T) {
	f := newWindowsSandboxFixture(t)
	unsafe := false
	f.host.privateWorkspace = func(context.Context, string) (func(), error) {
		if unsafe {
			return nil, errors.New("workspace child DACL is no longer private")
		}
		return func() {}, nil
	}
	runner := f.runner(t)
	execution := f.execution(1)
	if err := runner.Lifecycle.Create(t.Context(), execution, f.spec(t, "acl-changed")); err != nil {
		t.Fatal(err)
	}
	unsafe = true
	if err := runner.Lifecycle.Start(t.Context(), execution); err == nil {
		t.Fatal("workspace was mapped after losing its private boundary")
	}
	if slices.Contains(f.machine.operations(), "start") {
		t.Fatal("VM creation preceded the second workspace ACL check")
	}
	// No VM was launched. Unsafe workspace contents do not prevent removing
	// the separately protected staging/ownership reservation.
	if err := runner.Reconcile(t.Context(), execution); err != nil {
		t.Fatal(err)
	}
}

func TestWindowsSandboxWorkspaceBoundaryPinnedDuringLaunch(t *testing.T) {
	f := newWindowsSandboxFixture(t)
	held := false
	f.host.privateWorkspace = func(context.Context, string) (func(), error) {
		held = true
		return func() { held = false }, nil
	}
	f.machine.startGate = func() {
		if !held {
			t.Error("private workspace path was unpinned before VM creation")
		}
	}
	runner := f.runner(t)
	execution := f.execution(1)
	if err := runner.Lifecycle.Create(t.Context(), execution, f.spec(t, "pinned")); err != nil {
		t.Fatal(err)
	}
	if held {
		t.Fatal("workspace handles were not released after staging")
	}
	ctx, cancel := context.WithCancel(t.Context())
	defer cancel()
	if err := runner.Lifecycle.Start(ctx, execution); err != nil {
		t.Fatal(err)
	}
	if held {
		t.Fatal("workspace handles were not released after mapping")
	}
	if err := runner.Reconcile(t.Context(), execution); err != nil {
		t.Fatal(err)
	}
}

func TestWindowsSandboxMissingWorkspaceACLValidatorFailsClosed(t *testing.T) {
	f := newWindowsSandboxFixture(t)
	f.host.privateWorkspace = nil
	runner := f.runner(t)
	if err := runner.Lifecycle.Create(t.Context(), f.execution(1), f.spec(t, "missing-validator")); err == nil {
		t.Fatal("Windows workspace privacy was inferred from Unix permission bits")
	}
	if len(f.machine.operations()) != 0 {
		t.Fatal("missing Windows ACL evidence reached the runtime")
	}
}
