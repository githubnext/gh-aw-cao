package hostedcli

import (
	"errors"
	"strings"
	"testing"
	"time"

	"github.com/githubnext/gh-cao/server/internal/operational"
)

func TestExecutorRequesterIdentityAtPrefetchAndExecution(t *testing.T) {
	for _, test := range []struct {
		name       string
		actorID    int64
		github     fakeGitHub
		wantStatus operational.CLICommandStatus
	}{
		{name: "original writer", actorID: 101, github: fakeGitHub{permission: "write"}, wantStatus: operational.CLICommandCompleted},
		{name: "same login different account", actorID: 101, github: fakeGitHub{permission: "admin", accountID: 202}, wantStatus: operational.CLICommandFailed},
		{name: "renamed original old login unavailable", actorID: 101, github: fakeGitHub{permission: "none"}, wantStatus: operational.CLICommandFailed},
		{name: "writer revoked", actorID: 101, github: fakeGitHub{permission: "read"}, wantStatus: operational.CLICommandFailed},
		{name: "provider unavailable", actorID: 101, github: fakeGitHub{permissionError: errors.New("unavailable")}, wantStatus: operational.CLICommandFailed},
		{name: "legacy missing account ID", github: fakeGitHub{permission: "write"}, wantStatus: operational.CLICommandFailed},
		{name: "invalid account ID", actorID: -1, github: fakeGitHub{permission: "write"}, wantStatus: operational.CLICommandFailed},
	} {
		t.Run(test.name, func(t *testing.T) {
			queue, minter, runner := newFakeQueue(), newFakeMinter(), &fakeRunner{}
			broker := NewBroker(minter, BrokerOptions{MaxPooled: 2})
			t.Cleanup(func() {
				if err := broker.Close(t.Context()); err != nil {
					t.Error(err)
				}
			})
			executor, err := NewExecutor(queue, broker, test.github, runner, Options{Owner: "identity-test", Prefetch: 1, WorkRoot: t.TempDir()})
			if err != nil {
				t.Fatal(err)
			}
			invocation := operational.CLICommandInvocation{
				ActionID: "upgrade", Command: "gh aw upgrade --repo octo/app --create-pull-request",
				Repository: "octo/app", Actor: "mona", ActorID: test.actorID,
			}
			queued, err := queue.Enqueue(t.Context(), invocation, "", 0)
			if err != nil {
				t.Fatal(err)
			}
			executor.prefetch(t.Context())
			if test.wantStatus != operational.CLICommandCompleted && minter.workTokensMinted() != 0 {
				t.Fatal("unauthorized requester received a prefetched work token")
			}
			lease, err := queue.Acquire(t.Context(), "identity-test", time.Minute)
			if err != nil {
				t.Fatal(err)
			}
			command, err := queue.Claim(t.Context(), lease)
			if err != nil || command == nil {
				t.Fatalf("claim = %+v, %v", command, err)
			}
			executor.execute(t.Context(), lease, *command)
			result, err := queue.Detail(t.Context(), queued.ID)
			if err != nil || result.Status != test.wantStatus || result.Actor != invocation.Actor || result.ActorID != invocation.ActorID || !queue.settled[queued.ID] {
				t.Fatalf("result = %+v, %v; original identity and settled result must be retained", result, err)
			}
			if test.wantStatus == operational.CLICommandCompleted {
				if len(runner.processes) != 1 {
					t.Fatal("verified requester did not execute")
				}
			} else if len(runner.processes) != 0 || minter.workTokensMinted() != 0 || result.Error == "" {
				t.Fatal("unverifiable requester must fail explicitly without work tokens or execution")
			}
			if test.actorID <= 0 {
				if broker.Stats().Minted != 0 || !strings.Contains(result.Error, "account ID") {
					t.Fatal("legacy identity must fail before minting any credential with an actionable retained error")
				}
			}
			if minter.liveCount() != 0 {
				t.Fatal("verification and execution credentials must be revoked")
			}
		})
	}
}

func TestExecutorRechecksIdentityBeforeTakingPrefetchedToken(t *testing.T) {
	for _, changed := range []fakeGitHub{
		{permission: "admin", accountID: 202},
		{permission: "read"},
	} {
		t.Run(changed.permission, func(t *testing.T) {
			queue, minter, runner := newFakeQueue(), newFakeMinter(), &fakeRunner{}
			broker := NewBroker(minter, BrokerOptions{MaxPooled: 2})
			t.Cleanup(func() {
				if err := broker.Close(t.Context()); err != nil {
					t.Error(err)
				}
			})
			executor, err := NewExecutor(queue, broker, fakeGitHub{permission: "write"}, runner, Options{Owner: "identity-test", Prefetch: 1})
			if err != nil {
				t.Fatal(err)
			}
			id := enqueue(t, queue, "gh workflow run collect.yml --repo octo/app", "octo/app", "mona")
			executor.prefetch(t.Context())
			if broker.Stats().Pooled != 1 || minter.workTokensMinted() != 1 {
				t.Fatal("expected a work token prefetched while the original account was authorized")
			}
			executor.github = changed
			lease, _ := queue.Acquire(t.Context(), "identity-test", time.Minute)
			command, err := queue.Claim(t.Context(), lease)
			if err != nil || command == nil {
				t.Fatalf("claim = %+v, %v", command, err)
			}
			executor.execute(t.Context(), lease, *command)
			result, err := queue.Detail(t.Context(), id)
			if err != nil || result.Status != operational.CLICommandFailed || len(runner.processes) != 0 {
				t.Fatalf("changed authority must not execute: %+v, %v", result, err)
			}
			if minter.workTokensMinted() != 1 || broker.Stats().Pooled != 1 {
				t.Fatal("failed execution recheck must neither mint nor consume a work token")
			}
		})
	}
}
