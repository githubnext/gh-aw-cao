package hostedcli

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/githubnext/gh-aw-cao/server/internal/audit"
	"github.com/githubnext/gh-aw-cao/server/internal/githubapp"
	"github.com/githubnext/gh-aw-cao/server/internal/operational"
)

type fakeMinter struct {
	mutex      sync.Mutex
	next       int
	live       map[string]bool
	revoked    []string
	ttl        time.Duration
	failRevoke bool
}

func newFakeMinter() *fakeMinter {
	return &fakeMinter{live: map[string]bool{}, ttl: time.Hour}
}

func (m *fakeMinter) MintScopedToken(_ context.Context, installationID int64, scope githubapp.TokenScope) (githubapp.ScopedToken, error) {
	if err := scope.Validate(); err != nil {
		return githubapp.ScopedToken{}, err
	}
	m.mutex.Lock()
	defer m.mutex.Unlock()
	m.next++
	value := fmt.Sprintf("ghs_fake%04d", m.next)
	m.live[value] = true
	return githubapp.NewScopedToken(value, installationID, time.Now().Add(m.ttl)), nil
}

func (m *fakeMinter) RevokeToken(_ context.Context, token githubapp.ScopedToken) error {
	m.mutex.Lock()
	defer m.mutex.Unlock()
	if m.failRevoke {
		return errors.New("revoke failed")
	}
	delete(m.live, token.Secret())
	m.revoked = append(m.revoked, token.Secret())
	return nil
}

func (m *fakeMinter) liveCount() int {
	m.mutex.Lock()
	defer m.mutex.Unlock()
	return len(m.live)
}

var testScope = githubapp.TokenScope{Repositories: []string{"app"}, Permissions: map[string]string{"contents": "read"}}

func TestBrokerTokensAreSingleUseAndRevoked(t *testing.T) {
	minter := newFakeMinter()
	broker := NewBroker(minter, BrokerOptions{MaxPooled: 4})
	ctx := context.Background()
	need := time.Now().Add(15 * time.Minute)
	if err := broker.Prefetch(ctx, 1, testScope, need); err != nil {
		t.Fatal(err)
	}
	first, err := broker.Acquire(ctx, 1, testScope, need)
	if err != nil {
		t.Fatal(err)
	}
	second, err := broker.Acquire(ctx, 1, testScope, need)
	if err != nil {
		t.Fatal(err)
	}
	if first.Secret() == second.Secret() {
		t.Fatal("a token must never be handed out twice")
	}
	broker.Release(ctx, first)
	broker.Release(ctx, second)
	if minter.liveCount() != 0 {
		t.Fatalf("released tokens must be revoked, %d still live", minter.liveCount())
	}
	stats := broker.Stats()
	if stats.Minted != 2 || stats.Reused != 1 || stats.Revoked != 2 || stats.Pooled != 0 {
		t.Fatalf("unexpected stats %+v", stats)
	}
}

func TestBrokerPoolIsBoundedAndIdleTokensAreRevoked(t *testing.T) {
	minter := newFakeMinter()
	now := time.Now()
	broker := NewBroker(minter, BrokerOptions{MaxPooled: 3, MaxPooledPerScope: 2, IdleTTL: time.Minute, Now: func() time.Time { return now }})
	ctx := context.Background()
	need := now.Add(15 * time.Minute)
	for range 5 {
		if err := broker.Prefetch(ctx, 1, testScope, need); err != nil {
			t.Fatal(err)
		}
	}
	if pooled := broker.Stats().Pooled; pooled != 2 {
		t.Fatalf("per-scope bound not enforced: %d pooled", pooled)
	}
	other := githubapp.TokenScope{Repositories: []string{"other"}, Permissions: map[string]string{"contents": "read"}}
	for range 3 {
		_ = broker.Prefetch(ctx, 1, other, need)
	}
	if pooled := broker.Stats().Pooled; pooled != 3 {
		t.Fatalf("global bound not enforced: %d pooled", pooled)
	}
	now = now.Add(2 * time.Minute)
	broker.Maintain(ctx)
	if broker.Stats().Pooled != 0 || minter.liveCount() != 0 {
		t.Fatalf("idle tokens must be revoked: %+v live=%d", broker.Stats(), minter.liveCount())
	}
}

func TestBrokerRejectsTokensThatExpireBeforeDeadline(t *testing.T) {
	minter := newFakeMinter()
	minter.ttl = 5 * time.Minute
	broker := NewBroker(minter, BrokerOptions{})
	_, err := broker.Acquire(context.Background(), 1, testScope, time.Now().Add(time.Hour))
	if err == nil {
		t.Fatal("short-lived token must be rejected")
	}
	if minter.liveCount() != 0 {
		t.Fatal("rejected token must be revoked")
	}
}

func TestBrokerRetriesFailedRevocationAndCloseRevokesPool(t *testing.T) {
	minter := newFakeMinter()
	broker := NewBroker(minter, BrokerOptions{MaxPooled: 2})
	ctx := context.Background()
	need := time.Now().Add(time.Minute)
	token, _ := broker.Acquire(ctx, 1, testScope, need)
	minter.failRevoke = true
	broker.Release(ctx, token)
	if broker.Stats().PendingRevocations != 1 {
		t.Fatal("failed revocation must be retried")
	}
	minter.failRevoke = false
	_ = broker.Prefetch(ctx, 1, testScope, need)
	broker.Close(ctx)
	if minter.liveCount() != 0 || broker.Stats().PendingRevocations != 0 {
		t.Fatalf("close must revoke everything: live=%d", minter.liveCount())
	}
	if _, err := broker.Acquire(ctx, 1, testScope, need); !errors.Is(err, ErrBrokerClosed) {
		t.Fatalf("want ErrBrokerClosed, got %v", err)
	}
}

// fakeQueue is a single-process CLICommandQueue for executor tests.
type fakeQueue struct {
	mutex    sync.Mutex
	commands map[int64]*operational.CLICommand
	order    []int64
	output   map[int64][]operational.CLICommandOutput
	settled  map[int64]bool
	next     int64
}

func newFakeQueue() *fakeQueue {
	return &fakeQueue{commands: map[int64]*operational.CLICommand{}, output: map[int64][]operational.CLICommandOutput{}, settled: map[int64]bool{}}
}

func (q *fakeQueue) Acquire(_ context.Context, owner string, _ time.Duration) (operational.CLICommandLease, error) {
	return operational.CLICommandLease{Owner: owner}, nil
}
func (q *fakeQueue) Renew(_ context.Context, lease operational.CLICommandLease, _ time.Duration) (operational.CLICommandLease, error) {
	return lease, nil
}
func (q *fakeQueue) Release(context.Context, operational.CLICommandLease) error { return nil }
func (q *fakeQueue) AcknowledgeRecovery(context.Context, operational.CLICommandLease) error {
	return nil
}
func (q *fakeQueue) Enqueue(_ context.Context, invocation operational.CLICommandInvocation, key string, _ int64) (operational.CLICommand, error) {
	q.mutex.Lock()
	defer q.mutex.Unlock()
	q.next++
	command := &operational.CLICommand{ID: q.next, CLICommandInvocation: invocation, Status: operational.CLICommandQueued, IdempotencyKey: key, CreatedAt: time.Now()}
	q.commands[command.ID] = command
	q.order = append(q.order, command.ID)
	return *command, nil
}
func (q *fakeQueue) Claim(context.Context, operational.CLICommandLease) (*operational.CLICommand, error) {
	q.mutex.Lock()
	defer q.mutex.Unlock()
	for _, id := range q.order {
		command := q.commands[id]
		if command.Status == operational.CLICommandQueued {
			command.Status = operational.CLICommandRunning
			deadline := time.Now().Add(time.Minute)
			command.Deadline = &deadline
			command.ExecutionClaimed = true
			copy := *command
			return &copy, nil
		}
	}
	return nil, nil //nolint:nilnil // CLICommandQueue.Claim reports no runnable command as nil, nil.
}
func (q *fakeQueue) Finish(_ context.Context, _ operational.CLICommandLease, id int64, result operational.CLICommandResult) error {
	q.mutex.Lock()
	defer q.mutex.Unlock()
	command := q.commands[id]
	if command.Status.Terminal() {
		return nil
	}
	command.Status, command.ExitCode, command.Error = result.Status, result.ExitCode, result.Error
	return nil
}
func (q *fakeQueue) AppendOutput(_ context.Context, _ operational.CLICommandLease, id int64, stream, data string) (operational.CLICommandOutput, error) {
	q.mutex.Lock()
	defer q.mutex.Unlock()
	if q.commands[id].Status != operational.CLICommandRunning {
		return operational.CLICommandOutput{}, operational.ErrConflict
	}
	chunk := operational.CLICommandOutput{Sequence: int64(len(q.output[id]) + 1), Stream: stream, Data: data}
	q.output[id] = append(q.output[id], chunk)
	return chunk, nil
}
func (q *fakeQueue) Settle(_ context.Context, _ operational.CLICommandLease, id int64, _ *int) error {
	q.mutex.Lock()
	defer q.mutex.Unlock()
	if !q.commands[id].Status.Terminal() {
		return operational.ErrConflict
	}
	q.commands[id].ExecutionClaimed = false
	q.settled[id] = true
	return nil
}
func (q *fakeQueue) Cancel(_ context.Context, id int64) (operational.CLICommand, error) {
	q.mutex.Lock()
	defer q.mutex.Unlock()
	command := q.commands[id]
	if !command.Status.Terminal() {
		command.Status = operational.CLICommandCanceled
	}
	return *command, nil
}
func (q *fakeQueue) Detail(_ context.Context, id int64) (operational.CLICommand, error) {
	q.mutex.Lock()
	defer q.mutex.Unlock()
	command, ok := q.commands[id]
	if !ok {
		return operational.CLICommand{}, operational.ErrCLICommandNotFound
	}
	return *command, nil
}
func (q *fakeQueue) List(_ context.Context, filter operational.CLICommandFilter) (operational.CLICommandPage, error) {
	q.mutex.Lock()
	defer q.mutex.Unlock()
	page := operational.CLICommandPage{}
	for _, id := range q.order {
		command := q.commands[id]
		for _, status := range filter.Statuses {
			if command.Status == status && len(page.Commands) < filter.Limit {
				page.Commands = append(page.Commands, *command)
			}
		}
	}
	return page, nil
}
func (q *fakeQueue) Output(_ context.Context, id int64, _ int64, _ int) ([]operational.CLICommandOutput, error) {
	q.mutex.Lock()
	defer q.mutex.Unlock()
	return append([]operational.CLICommandOutput(nil), q.output[id]...), nil
}
func (q *fakeQueue) Retain(context.Context) (int64, error) { return 0, nil }

func (q *fakeQueue) waitSettled(t *testing.T, id int64) operational.CLICommand {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		q.mutex.Lock()
		settled := q.settled[id]
		command := *q.commands[id]
		q.mutex.Unlock()
		if settled {
			return command
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatalf("command %d was not settled", id)
	return operational.CLICommand{}
}

func (q *fakeQueue) text(id int64) string {
	q.mutex.Lock()
	defer q.mutex.Unlock()
	var builder strings.Builder
	for _, chunk := range q.output[id] {
		builder.WriteString(chunk.Data)
	}
	return builder.String()
}

type fakeGitHub struct {
	permission string
}

func (g fakeGitHub) FindRepositoryInstallation(_ context.Context, repository string) (int64, error) {
	if repository == "octo/missing" {
		return 0, githubapp.ErrNotFound
	}
	return 42, nil
}
func (g fakeGitHub) CollaboratorPermission(_ context.Context, token githubapp.ScopedToken, _, _ string) (string, error) {
	if token.Secret() == "" {
		return "", errors.New("missing token")
	}
	return g.permission, nil
}
func (g fakeGitHub) BotIdentity(context.Context) (githubapp.BotIdentity, error) {
	return githubapp.BotIdentity{Name: "cao[bot]", Email: "1+cao[bot]@users.noreply.github.com"}, nil
}

type fakeRunner struct {
	mutex     sync.Mutex
	processes []Process
	run       func(context.Context, Process, OutputFunc) (int, error)
	minter    *fakeMinter
	liveAtRun []bool
}

func (r *fakeRunner) Run(ctx context.Context, process Process, output OutputFunc) (int, error) {
	r.mutex.Lock()
	r.processes = append(r.processes, process)
	if r.minter != nil {
		r.liveAtRun = append(r.liveAtRun, r.minter.liveCount() > 0)
	}
	r.mutex.Unlock()
	if r.run != nil {
		return r.run(ctx, process, output)
	}
	return 0, nil
}

func envValue(process Process, name string) string {
	for _, entry := range process.Env {
		if value, ok := strings.CutPrefix(entry, name+"="); ok {
			return value
		}
	}
	return ""
}

const testControlRevision = "0123456789abcdef0123456789abcdef01234567"

func startExecutor(t *testing.T, queue *fakeQueue, minter *fakeMinter, github GitHub, runner Runner) {
	t.Helper()
	startExecutorWith(t, queue, minter, github, runner, func(*Options) {})
}

func startExecutorWith(t *testing.T, queue *fakeQueue, minter *fakeMinter, github GitHub, runner Runner, configure func(*Options)) {
	t.Helper()
	options := Options{
		Owner: "test", ControlRepository: "octo/cao", ControlRevision: testControlRevision,
		Path: "/usr/bin", DataHome: filepath.Join(t.TempDir(), "missing"),
		LeaseTTL: 300 * time.Millisecond, PollInterval: 20 * time.Millisecond, CancelPollInterval: 20 * time.Millisecond,
		CommandTimeout: time.Minute, Prefetch: 2, WorkRoot: t.TempDir(),
	}
	configure(&options)
	executor, err := NewExecutor(queue, NewBroker(minter, BrokerOptions{MaxPooled: 2, Audit: options.Audit}), github, runner, options)
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})
	go func() {
		defer close(done)
		_ = executor.Run(ctx)
	}()
	t.Cleanup(func() {
		cancel()
		<-done
	})
}

func enqueue(t *testing.T, queue *fakeQueue, command, repository, actor string) int64 {
	t.Helper()
	queued, err := queue.Enqueue(context.Background(), operational.CLICommandInvocation{
		ActionID: "test-action", Command: command, Repository: repository, Actor: actor,
	}, "", 0)
	if err != nil {
		t.Fatal(err)
	}
	return queued.ID
}

func TestExecutorRunsWithScopedTokenAndRevokesIt(t *testing.T) {
	queue, minter := newFakeQueue(), newFakeMinter()
	runner := &fakeRunner{minter: minter}
	runner.run = func(_ context.Context, process Process, output OutputFunc) (int, error) {
		output("stdout", []byte("created PR with "+envValue(process, "GH_TOKEN")+"\n"))
		output("stderr", []byte("token=ghp_abcdefghijklmnopqrstuvwxyz0123456789\n"))
		return 0, nil
	}
	startExecutor(t, queue, minter, fakeGitHub{permission: "write"}, runner)
	id := enqueue(t, queue, "gh aw upgrade --repo octo/app --create-pull-request", "octo/app", "mona")
	command := queue.waitSettled(t, id)
	if command.Status != operational.CLICommandCompleted || command.ExitCode == nil || *command.ExitCode != 0 {
		t.Fatalf("unexpected result %+v", command)
	}
	if minter.liveCount() != 0 {
		t.Fatal("token must be revoked after the command exits")
	}
	if len(runner.liveAtRun) != 1 || !runner.liveAtRun[0] {
		t.Fatal("token must be live while the command runs")
	}
	process := runner.processes[0]
	token := envValue(process, "GH_TOKEN")
	if !strings.HasPrefix(token, "ghs_fake") || strings.Contains(strings.Join(process.Args, " "), token) {
		t.Fatalf("token must be passed only through the environment: %v", process.Args)
	}
	workspace := process.Dir[:len(process.Dir)-len("/work")]
	if envValue(process, "XDG_DATA_HOME") != filepath.Join(workspace, "data") || envValue(process, "GH_PROMPT_DISABLED") != "1" ||
		envValue(process, "GIT_AUTHOR_NAME") != "cao[bot]" || !strings.HasPrefix(envValue(process, "HOME"), process.Dir[:len(process.Dir)-len("/work")]) {
		t.Fatalf("unexpected environment %v", process.Env)
	}
	for _, entry := range process.Env {
		if strings.HasPrefix(entry, "CAO_") || strings.HasPrefix(entry, "DATABASE") {
			t.Fatalf("server environment leaked: %s", entry)
		}
	}
	text := queue.text(id)
	if strings.Contains(text, token) || strings.Contains(text, "ghp_abcdefghijklmnopqrstuvwxyz0123456789") {
		t.Fatalf("output must be redacted: %q", text)
	}
	if !strings.Contains(text, "created PR with [REDACTED]") || !strings.Contains(text, "single-use token scoped to octo/app") {
		t.Fatalf("unexpected output %q", text)
	}
}

func TestExecutorClonesControlRepositoryForCAOUpdate(t *testing.T) {
	queue, minter := newFakeQueue(), newFakeMinter()
	runner := &fakeRunner{}
	startExecutor(t, queue, minter, fakeGitHub{permission: "admin"}, runner)
	id := enqueue(t, queue, "./cao.sh update --campaign security --create-pull-request", "octo/cao", "mona")
	command := queue.waitSettled(t, id)
	if command.Status != operational.CLICommandCompleted {
		t.Fatalf("unexpected result %+v", command)
	}
	if len(runner.processes) != 3 {
		t.Fatalf("want clone + checkout + update, got %d processes", len(runner.processes))
	}
	clone, checkout, update := runner.processes[0], runner.processes[1], runner.processes[2]
	if strings.Join(clone.Args[:3], " ") != "repo clone octo/cao" || !slices.Contains(clone.Args, "--no-checkout") {
		t.Fatalf("unexpected clone %v", clone.Args)
	}
	if checkout.Program != "git" || checkout.Args[len(checkout.Args)-1] != testControlRevision || checkout.Dir != update.Dir {
		t.Fatalf("control repository must run at the reviewed revision: %+v", checkout)
	}
	if update.Program != "sh" || update.Args[0] != "./cao.sh" || !strings.HasSuffix(update.Dir, "/control") {
		t.Fatalf("unexpected update process %+v", update)
	}
	if envValue(clone, "GH_TOKEN") != envValue(update, "GH_TOKEN") {
		t.Fatal("one command must use one token")
	}
}

func TestExecutorRejectsUnauthorizedOrMismatchedCommands(t *testing.T) {
	queue, minter := newFakeQueue(), newFakeMinter()
	runner := &fakeRunner{}
	startExecutor(t, queue, minter, fakeGitHub{permission: "read"}, runner)
	readOnly := enqueue(t, queue, "gh aw upgrade --repo octo/app --create-pull-request", "octo/app", "mona")
	mismatch := enqueue(t, queue, "gh aw upgrade --repo octo/app --create-pull-request", "octo/other", "mona")
	anonymous := enqueue(t, queue, "gh aw upgrade --repo octo/app --create-pull-request", "octo/app", "")
	local := enqueue(t, queue, "./cao.sh mode live security", "octo/cao", "mona")
	missing := enqueue(t, queue, "gh aw upgrade --repo octo/missing --create-pull-request", "octo/missing", "mona")
	for _, id := range []int64{readOnly, mismatch, anonymous, local, missing} {
		command := queue.waitSettled(t, id)
		if command.Status != operational.CLICommandFailed || command.Error == "" {
			t.Fatalf("command %d must fail closed: %+v", id, command)
		}
	}
	if len(runner.processes) != 0 {
		t.Fatal("rejected commands must not start subprocesses")
	}
	if minter.liveCount() != 0 {
		t.Fatal("every minted token must be revoked")
	}
}

func TestExecutorCancelsRunningCommandAndRevokesToken(t *testing.T) {
	queue, minter := newFakeQueue(), newFakeMinter()
	started := make(chan struct{})
	runner := &fakeRunner{run: func(ctx context.Context, _ Process, _ OutputFunc) (int, error) {
		close(started)
		<-ctx.Done()
		return -1, ctx.Err()
	}}
	startExecutor(t, queue, minter, fakeGitHub{permission: "write"}, runner)
	id := enqueue(t, queue, "gh workflow run cao.lock.yml", "octo/cao", "mona")
	<-started
	if _, err := queue.Cancel(context.Background(), id); err != nil {
		t.Fatal(err)
	}
	command := queue.waitSettled(t, id)
	if command.Status != operational.CLICommandCanceled {
		t.Fatalf("cancel must be preserved: %+v", command)
	}
	if minter.liveCount() != 0 {
		t.Fatal("canceled command token must be revoked")
	}
}

func TestOutputSinkSplitsLongLinesWithinChunkLimit(t *testing.T) {
	queue := newFakeQueue()
	id := enqueue(t, queue, "gh aw upgrade --repo octo/app --create-pull-request", "octo/app", "mona")
	_, _ = queue.Claim(context.Background(), operational.CLICommandLease{})
	sink := newOutputSink(context.Background(), queue, operational.CLICommandLease{}, id)
	sink.write("stdout", []byte(strings.Repeat("é", 10000)))
	sink.close()
	for _, chunk := range queue.output[id] {
		if len(chunk.Data) > 16*1024 {
			t.Fatalf("chunk too large: %d", len(chunk.Data))
		}
	}
	if got := queue.text(id); got != strings.Repeat("é", 10000) {
		t.Fatalf("output was corrupted: %d bytes", len(got))
	}
}

func TestExecutorRefusesControlCommandsWithoutReviewedRevision(t *testing.T) {
	queue, minter := newFakeQueue(), newFakeMinter()
	runner := &fakeRunner{}
	startExecutorWith(t, queue, minter, fakeGitHub{permission: "admin"}, runner, func(options *Options) {
		options.ControlRevision = ""
	})
	id := enqueue(t, queue, "./cao.sh update --campaign security --create-pull-request", "octo/cao", "mona")
	command := queue.waitSettled(t, id)
	if command.Status != operational.CLICommandFailed || !strings.Contains(command.Error, "CAO_HOSTED_CLI_CONTROL_REVISION") {
		t.Fatalf("control command must fail closed without a reviewed revision: %+v", command)
	}
	if len(runner.processes) != 0 {
		t.Fatal("no subprocess may run without a reviewed revision")
	}
}

func TestExecutorRejectsMalformedControlRevision(t *testing.T) {
	_, err := NewExecutor(newFakeQueue(), NewBroker(newFakeMinter(), BrokerOptions{}), fakeGitHub{}, &fakeRunner{}, Options{
		Owner: "test", ControlRepository: "octo/cao", ControlRevision: "main",
	})
	if err == nil {
		t.Fatal("a branch name must not be accepted as the control revision")
	}
}

func TestExecutorGivesEachCommandPrivateExtensions(t *testing.T) {
	dataHome := t.TempDir()
	extension := filepath.Join(dataHome, "gh", "extensions", "gh-aw")
	if err := os.MkdirAll(extension, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(extension, "gh-aw"), []byte("trusted"), 0o600); err != nil {
		t.Fatal(err)
	}
	queue, minter := newFakeQueue(), newFakeMinter()
	runner := &fakeRunner{}
	var seen []string
	runner.run = func(_ context.Context, process Process, _ OutputFunc) (int, error) {
		binary := filepath.Join(envValue(process, "XDG_DATA_HOME"), "gh", "extensions", "gh-aw", "gh-aw")
		content, err := os.ReadFile(binary) // #nosec G304 -- test workspace path
		if err != nil {
			return 1, err
		}
		seen = append(seen, string(content))
		return 0, os.WriteFile(binary, []byte("tampered"), 0o600)
	}
	startExecutorWith(t, queue, minter, fakeGitHub{permission: "write"}, runner, func(options *Options) {
		options.DataHome = dataHome
	})
	for range 2 {
		id := enqueue(t, queue, "gh aw upgrade --repo octo/app --create-pull-request", "octo/app", "mona")
		if command := queue.waitSettled(t, id); command.Status != operational.CLICommandCompleted {
			t.Fatalf("unexpected result %+v", command)
		}
	}
	if strings.Join(seen, ",") != "trusted,trusted" {
		t.Fatalf("a command must not alter extensions seen by later commands: %v", seen)
	}
	if content, _ := os.ReadFile(filepath.Join(extension, "gh-aw")); /* #nosec G304 -- test temporary file */ string(content) != "trusted" {
		t.Fatal("the operator's extensions must not be modified")
	}
}

type syncBuffer struct {
	mutex  sync.Mutex
	buffer bytes.Buffer
}

func (b *syncBuffer) Write(p []byte) (int, error) {
	b.mutex.Lock()
	defer b.mutex.Unlock()
	return b.buffer.Write(p)
}

func (b *syncBuffer) events() []map[string]any {
	b.mutex.Lock()
	defer b.mutex.Unlock()
	var events []map[string]any
	for _, line := range strings.Split(strings.TrimSpace(b.buffer.String()), "\n") {
		var event map[string]any
		if line != "" && json.Unmarshal([]byte(line), &event) == nil {
			events = append(events, event)
		}
	}
	return events
}

func (b *syncBuffer) String() string {
	b.mutex.Lock()
	defer b.mutex.Unlock()
	return b.buffer.String()
}

func TestExecutorAuditsCommandAndTokenLifecycleWithoutSecrets(t *testing.T) {
	queue, minter := newFakeQueue(), newFakeMinter()
	runner := &fakeRunner{minter: minter}
	var buffer syncBuffer
	startExecutorWith(t, queue, minter, fakeGitHub{permission: "write"}, runner, func(options *Options) {
		options.Audit = audit.New(&buffer)
	})
	allowed := enqueue(t, queue, "gh aw upgrade --repo octo/app --create-pull-request", "octo/app", "mona")
	queue.waitSettled(t, allowed)
	deadline := time.Now().Add(5 * time.Second)
	want := []string{"token.minted", "cli_command.started", "token.revoked", "cli_command.finished"}
	for {
		seen := map[string]map[string]any{}
		for _, event := range buffer.events() {
			seen[event["event"].(string)] = event
		}
		missing := false
		for _, name := range want {
			if seen[name] == nil {
				missing = true
			}
		}
		if !missing {
			started := seen["cli_command.started"]
			if started["actor"] != "mona" || started["repository"] != "octo/app" || started["hashed_token"] == "" ||
				started["hashed_token"] != seen["token.revoked"]["hashed_token"] {
				t.Fatalf("unexpected started event %v", started)
			}
			if seen["cli_command.finished"]["status"] != string(operational.CLICommandCompleted) {
				t.Fatalf("unexpected finished event %v", seen["cli_command.finished"])
			}
			break
		}
		if time.Now().After(deadline) {
			t.Fatalf("missing audit events in %s", buffer.String())
		}
		time.Sleep(10 * time.Millisecond)
	}
	if strings.Contains(buffer.String(), "ghs_") {
		t.Fatal("audit events must never contain token values")
	}
}

func TestExecutorAuditsRevokedRequesterPermission(t *testing.T) {
	queue, minter := newFakeQueue(), newFakeMinter()
	var buffer syncBuffer
	startExecutorWith(t, queue, minter, fakeGitHub{permission: "read"}, &fakeRunner{}, func(options *Options) {
		options.Audit = audit.New(&buffer)
	})
	queue.waitSettled(t, enqueue(t, queue, "gh aw upgrade --repo octo/app --create-pull-request", "octo/app", "mona"))
	deadline := time.Now().Add(5 * time.Second)
	for !strings.Contains(buffer.String(), `"cli_command.finished"`) {
		if time.Now().After(deadline) {
			t.Fatalf("missing finished event in %s", buffer.String())
		}
		time.Sleep(10 * time.Millisecond)
	}
	if !strings.Contains(buffer.String(), `"event":"cli_command.permission_denied","outcome":"denied"`) {
		t.Fatalf("permission denial must be audited: %s", buffer.String())
	}
}
