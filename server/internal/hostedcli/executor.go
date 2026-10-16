package hostedcli

import (
	"context"
	"errors"
	"fmt"
	"log"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"sync"
	"time"
	"unicode/utf8"

	"github.com/githubnext/gh-aw-cao/server/internal/githubapp"
	"github.com/githubnext/gh-aw-cao/server/internal/logger"
	"github.com/githubnext/gh-aw-cao/server/internal/operational"
)

var executorLog = logger.New("cao:hostedcli:executor")

// QueueName is the operational CLI command queue drained by hosted execution.
const QueueName = "hosted-cli"

// GitHub resolves installations, requester permissions, and the App's Git
// identity. *githubapp.Client implements it.
type GitHub interface {
	FindRepositoryInstallation(context.Context, string) (int64, error)
	CollaboratorPermission(context.Context, githubapp.ScopedToken, string, string) (string, error)
	BotIdentity(context.Context) (githubapp.BotIdentity, error)
}

// Options configure the executor.
type Options struct {
	// Owner names this executor's queue lease.
	Owner string
	// ControlRepository is the OWNER/REPOSITORY cloned for ./cao.sh commands.
	ControlRepository string
	// GitHubHost is the GitHub hostname; empty selects github.com.
	GitHubHost string
	// GitHubBinary is the gh executable; empty resolves "gh" from Path.
	GitHubBinary string
	// Path is the PATH given to subprocesses.
	Path string
	// DataHome is XDG_DATA_HOME for subprocesses so installed gh extensions
	// such as gh-aw resolve while HOME stays ephemeral.
	DataHome string
	// WorkRoot holds per-command ephemeral workspaces; empty uses os.TempDir.
	WorkRoot string
	// CommandTimeout must match the queue's Timeout; it sizes token lifetime
	// for prefetched tokens.
	CommandTimeout     time.Duration
	LeaseTTL           time.Duration
	PollInterval       time.Duration
	CancelPollInterval time.Duration
	// Prefetch bounds how many queued commands get pre-minted tokens.
	Prefetch int
	// AcknowledgeRecovery clears a recovery block left by an interrupted
	// executor. Enable only after confirming the previous executor's
	// subprocesses have terminated.
	AcknowledgeRecovery bool
	Logger              *log.Logger
}

func (o Options) resolve() (Options, error) {
	if strings.TrimSpace(o.Owner) == "" {
		return o, errors.New("hosted CLI executor owner is required")
	}
	if o.ControlRepository != "" && !targetRepository.MatchString(o.ControlRepository) {
		return o, errors.New("hosted CLI control repository must be OWNER/REPOSITORY")
	}
	if o.GitHubHost == "" {
		o.GitHubHost = "github.com"
	}
	if o.GitHubBinary == "" {
		o.GitHubBinary = "gh"
	}
	if o.CommandTimeout <= 0 {
		o.CommandTimeout = 15 * time.Minute
	}
	if o.LeaseTTL <= 0 {
		o.LeaseTTL = 30 * time.Second
	}
	if o.LeaseTTL > time.Minute {
		return o, errors.New("hosted CLI lease TTL must not exceed one minute")
	}
	if o.PollInterval <= 0 {
		o.PollInterval = 2 * time.Second
	}
	if o.CancelPollInterval <= 0 {
		o.CancelPollInterval = 2 * time.Second
	}
	if o.Prefetch < 0 {
		o.Prefetch = 0
	}
	if o.Logger == nil {
		o.Logger = log.New(os.Stderr, "cao-hosted-cli: ", log.LstdFlags)
	}
	return o, nil
}

// Executor drains the hosted CLI command queue.
type Executor struct {
	queue   operational.CLICommandQueue
	broker  *Broker
	github  GitHub
	runner  Runner
	options Options
	now     func() time.Time

	installationsMutex sync.Mutex
	installations      map[string]cachedInstallation
}

type cachedInstallation struct {
	id      int64
	expires time.Time
}

// NewExecutor constructs a hosted CLI executor.
func NewExecutor(queue operational.CLICommandQueue, broker *Broker, github GitHub, runner Runner, options Options) (*Executor, error) {
	if queue == nil || broker == nil || github == nil || runner == nil {
		return nil, errors.New("hosted CLI executor requires a queue, token broker, GitHub client, and runner")
	}
	resolved, err := options.resolve()
	if err != nil {
		return nil, err
	}
	return &Executor{
		queue: queue, broker: broker, github: github, runner: runner, options: resolved,
		now: time.Now, installations: map[string]cachedInstallation{},
	}, nil
}

// Run holds the queue lease and executes commands until ctx ends. Replicas
// that cannot acquire the lease stand by.
func (e *Executor) Run(ctx context.Context) error {
	defer e.broker.Close(context.WithoutCancel(ctx))
	for {
		lease, err := e.queue.Acquire(ctx, e.options.Owner, e.options.LeaseTTL)
		switch {
		case err == nil:
			e.options.Logger.Printf("hosted CLI executor acquired the queue lease")
			e.drain(ctx, lease)
		case errors.Is(err, operational.ErrConflict):
			executorLog.Printf("queue lease held elsewhere; standing by")
		default:
			if ctx.Err() == nil {
				e.options.Logger.Printf("hosted CLI executor could not acquire the queue lease: %v", err)
			}
		}
		if !sleep(ctx, e.options.LeaseTTL/2) {
			return nil
		}
	}
}

func (e *Executor) drain(ctx context.Context, lease operational.CLICommandLease) {
	leaseCtx, cancel := context.WithCancel(ctx)
	defer cancel()
	var workers sync.WaitGroup
	defer func() {
		cancel()
		workers.Wait()
		releaseCtx, releaseCancel := context.WithTimeout(context.WithoutCancel(ctx), 10*time.Second)
		defer releaseCancel()
		if err := e.queue.Release(releaseCtx, lease); err != nil && !errors.Is(err, operational.ErrConflict) {
			e.options.Logger.Printf("hosted CLI executor could not release the queue lease: %v", err)
		}
	}()
	workers.Add(1)
	go func() {
		defer workers.Done()
		e.renew(leaseCtx, cancel, lease)
	}()
	if e.options.AcknowledgeRecovery {
		if err := e.queue.AcknowledgeRecovery(leaseCtx, lease); err == nil {
			e.options.Logger.Printf("hosted CLI executor acknowledged queue recovery")
		}
	}
	wake := make(chan struct{}, 1)
	recoveryReported := false
	for leaseCtx.Err() == nil {
		command, err := e.queue.Claim(leaseCtx, lease)
		switch {
		case errors.Is(err, operational.ErrCLIQueueRecovery):
			if !recoveryReported {
				e.options.Logger.Printf("hosted CLI queue requires operator recovery; restart the executor with recovery acknowledgement after confirming interrupted commands stopped")
				recoveryReported = true
			}
		case errors.Is(err, operational.ErrConflict):
			return
		case err != nil:
			executorLog.Printf("claim failed: %v", err)
		case command != nil:
			workers.Add(1)
			go func(command operational.CLICommand) {
				defer workers.Done()
				e.execute(leaseCtx, lease, command)
				select {
				case wake <- struct{}{}:
				default:
				}
			}(*command)
			continue
		default:
			e.prefetch(leaseCtx)
		}
		e.broker.Maintain(leaseCtx)
		select {
		case <-leaseCtx.Done():
		case <-wake:
		case <-time.After(e.options.PollInterval):
		}
	}
}

func (e *Executor) renew(ctx context.Context, abort context.CancelFunc, lease operational.CLICommandLease) {
	ticker := time.NewTicker(e.options.LeaseTTL / 3)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			if _, err := e.queue.Renew(ctx, lease, e.options.LeaseTTL); err != nil {
				if ctx.Err() == nil {
					e.options.Logger.Printf("hosted CLI executor lost the queue lease; aborting running commands")
				}
				abort()
				return
			}
		}
	}
}

func (e *Executor) prefetch(ctx context.Context) {
	if e.options.Prefetch == 0 {
		return
	}
	page, err := e.queue.List(ctx, operational.CLICommandFilter{
		Statuses: []operational.CLICommandStatus{operational.CLICommandQueued}, Limit: e.options.Prefetch,
	})
	if err != nil {
		return
	}
	needUntil := e.now().Add(e.options.CommandTimeout + time.Minute)
	for _, command := range page.Commands {
		plan, err := PlanCommand(command.Command, e.options.ControlRepository)
		if err != nil {
			continue
		}
		installationID, err := e.installation(ctx, plan.Repository)
		if err != nil {
			continue
		}
		if err := e.broker.Prefetch(ctx, installationID, scopeFor(plan), needUntil); err != nil {
			executorLog.Printf("token prefetch failed: %v", err)
		}
	}
}

func scopeFor(plan Plan) githubapp.TokenScope {
	return githubapp.TokenScope{Repositories: []string{plan.Name()}, Permissions: plan.Permissions}
}

func (e *Executor) installation(ctx context.Context, repository string) (int64, error) {
	key := strings.ToLower(repository)
	e.installationsMutex.Lock()
	cached, ok := e.installations[key]
	e.installationsMutex.Unlock()
	if ok && e.now().Before(cached.expires) {
		return cached.id, nil
	}
	id, err := e.github.FindRepositoryInstallation(ctx, repository)
	if err != nil {
		return 0, err
	}
	e.installationsMutex.Lock()
	e.installations[key] = cachedInstallation{id: id, expires: e.now().Add(5 * time.Minute)}
	e.installationsMutex.Unlock()
	return id, nil
}

// failure is a stored, credential-free explanation of a failed command.
type failure string

func (e *Executor) execute(ctx context.Context, lease operational.CLICommandLease, command operational.CLICommand) {
	sink := newOutputSink(ctx, e.queue, lease, command.ID)
	exitCode, status, reason := e.run(ctx, command, sink)
	sink.close()
	result := operational.CLICommandResult{Status: status, Error: storableError(string(reason))}
	if exitCode != nil {
		result.ExitCode = exitCode
	}
	finishCtx, cancel := context.WithTimeout(context.WithoutCancel(ctx), 30*time.Second)
	defer cancel()
	if err := e.queue.Finish(finishCtx, lease, command.ID, result); err != nil {
		e.options.Logger.Printf("hosted CLI command %d could not be finished: %v", command.ID, err)
	}
	if err := e.queue.Settle(finishCtx, lease, command.ID, exitCode); err != nil {
		e.options.Logger.Printf("hosted CLI command %d could not be settled: %v", command.ID, err)
		return
	}
	executorLog.Printf("command settled id=%d status=%s", command.ID, status)
}

func (e *Executor) run(ctx context.Context, command operational.CLICommand, sink *outputSink) (*int, operational.CLICommandStatus, failure) {
	plan, err := PlanCommand(command.Command, e.options.ControlRepository)
	if err != nil {
		return nil, operational.CLICommandFailed, failure("Hosted execution rejected the command: " + err.Error())
	}
	if command.Actor == "" || !strings.EqualFold(command.Repository, plan.Repository) {
		return nil, operational.CLICommandFailed, "Hosted execution requires an authenticated requester and a matching target repository."
	}
	deadline := e.now().Add(e.options.CommandTimeout)
	if command.Deadline != nil {
		deadline = *command.Deadline
	}
	runCtx, cancelRun := context.WithDeadline(ctx, deadline)
	defer cancelRun()
	canceled := e.watchCancellation(runCtx, cancelRun, command.ID)

	installationID, err := e.installation(runCtx, plan.Repository)
	if err != nil {
		return nil, operational.CLICommandFailed, "The GitHub App is not installed on the target repository."
	}
	token, err := e.broker.Acquire(runCtx, installationID, scopeFor(plan), deadline.Add(time.Minute))
	if err != nil {
		return nil, operational.CLICommandFailed, "A scoped GitHub App token could not be created for the target repository."
	}
	// The credential is single-use: revoke it as soon as the work ends.
	defer e.broker.Release(ctx, token)
	sink.secret(token.Secret())

	permission, err := e.github.CollaboratorPermission(runCtx, token, plan.Repository, command.Actor)
	if err != nil {
		return nil, operational.CLICommandFailed, "The requester's repository permission could not be verified."
	}
	if permission != "admin" && permission != "write" {
		return nil, operational.CLICommandFailed, "The requester no longer has write access to the target repository."
	}
	identity, err := e.github.BotIdentity(runCtx)
	if err != nil {
		return nil, operational.CLICommandFailed, "The GitHub App identity could not be resolved."
	}
	sink.notice(fmt.Sprintf("Running as %s for %s with a single-use token scoped to %s (%s).\n",
		identity.Name, command.Actor, plan.Repository, describePermissions(plan.Permissions)))

	workspace, err := os.MkdirTemp(e.options.WorkRoot, "cao-hosted-cli-")
	if err != nil {
		return nil, operational.CLICommandFailed, "The ephemeral workspace could not be created."
	}
	defer func() { _ = os.RemoveAll(workspace) }()
	home := filepath.Join(workspace, "home")
	work := filepath.Join(workspace, "work")
	for _, directory := range []string{home, work} {
		if err := os.MkdirAll(directory, 0o700); err != nil {
			return nil, operational.CLICommandFailed, "The ephemeral workspace could not be created."
		}
	}
	environment := e.environment(home, token, identity)
	directory := work
	program, args := e.options.GitHubBinary, plan.Args
	if plan.ControlCheckout {
		checkout := filepath.Join(work, "control")
		code, err := e.runner.Run(runCtx, Process{
			Dir: work, Program: e.options.GitHubBinary, Env: environment,
			Args: []string{"repo", "clone", plan.Repository, checkout, "--", "--filter=blob:none", "--no-tags"},
		}, sink.write)
		if status, reason, done := classify(runCtx, ctx, canceled, code, err); done || code != 0 {
			if !done {
				reason = "The control repository could not be cloned."
			}
			return &code, status, reason
		}
		directory, program, args = checkout, "sh", append([]string{"./cao.sh"}, plan.Args...)
	}
	code, err := e.runner.Run(runCtx, Process{Dir: directory, Program: program, Args: args, Env: environment}, sink.write)
	status, reason, _ := classify(runCtx, ctx, canceled, code, err)
	return &code, status, reason
}

// classify maps a subprocess result to a terminal status. done reports that
// the run ended for a reason other than the subprocess's own exit code.
func classify(runCtx, leaseCtx context.Context, canceled func() bool, code int, err error) (operational.CLICommandStatus, failure, bool) {
	switch {
	case canceled():
		return operational.CLICommandFailed, "The CLI action was canceled.", true
	case errors.Is(runCtx.Err(), context.DeadlineExceeded):
		return operational.CLICommandTimedOut, "The CLI action exceeded its time limit.", true
	case leaseCtx.Err() != nil:
		return operational.CLICommandFailed, "The hosted executor stopped before the CLI action finished.", true
	case err != nil:
		return operational.CLICommandFailed, "The CLI action could not be started.", true
	case code != 0:
		return operational.CLICommandFailed, failure(fmt.Sprintf("The CLI action exited with code %d.", code)), false
	}
	return operational.CLICommandCompleted, "", false
}

func (e *Executor) watchCancellation(ctx context.Context, cancel context.CancelFunc, id int64) func() bool {
	var mutex sync.Mutex
	canceled := false
	go func() {
		ticker := time.NewTicker(e.options.CancelPollInterval)
		defer ticker.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-ticker.C:
				command, err := e.queue.Detail(ctx, id)
				if err == nil && command.Status.Terminal() {
					mutex.Lock()
					canceled = true
					mutex.Unlock()
					cancel()
					return
				}
			}
		}
	}()
	return func() bool {
		mutex.Lock()
		defer mutex.Unlock()
		return canceled
	}
}

func (e *Executor) environment(home string, token githubapp.ScopedToken, identity githubapp.BotIdentity) []string {
	environment := []string{
		"HOME=" + home,
		"XDG_CONFIG_HOME=" + filepath.Join(home, ".config"),
		"XDG_CACHE_HOME=" + filepath.Join(home, ".cache"),
		"PATH=" + e.options.Path,
		"LANG=C.UTF-8",
		"NO_COLOR=1",
		"GH_PROMPT_DISABLED=1",
		"GH_NO_UPDATE_NOTIFIER=1",
		"GH_NO_EXTENSION_UPDATE_NOTIFIER=1",
		"GH_TOKEN=" + token.Secret(),
		"GIT_TERMINAL_PROMPT=0",
		"GIT_CONFIG_NOSYSTEM=1",
		"GIT_CONFIG_COUNT=2",
		"GIT_CONFIG_KEY_0=credential.helper",
		"GIT_CONFIG_VALUE_0=",
		"GIT_CONFIG_KEY_1=credential.helper",
		"GIT_CONFIG_VALUE_1=!" + e.options.GitHubBinary + " auth git-credential",
		"GIT_AUTHOR_NAME=" + identity.Name,
		"GIT_AUTHOR_EMAIL=" + identity.Email,
		"GIT_COMMITTER_NAME=" + identity.Name,
		"GIT_COMMITTER_EMAIL=" + identity.Email,
	}
	if e.options.DataHome != "" {
		environment = append(environment, "XDG_DATA_HOME="+e.options.DataHome)
	}
	if !strings.EqualFold(e.options.GitHubHost, "github.com") {
		environment = append(environment, "GH_HOST="+e.options.GitHubHost, "GH_ENTERPRISE_TOKEN="+token.Secret())
	}
	return environment
}

func describePermissions(permissions map[string]string) string {
	parts := make([]string, 0, len(permissions))
	for name, level := range permissions {
		parts = append(parts, name+":"+level)
	}
	slices.Sort(parts)
	return strings.Join(parts, ", ")
}

func storableError(message string) string {
	message = operational.RedactCLICommandText(message)
	for len(message) > 512 {
		_, size := utf8.DecodeLastRuneInString(message)
		message = message[:len(message)-size]
	}
	return message
}

func sleep(ctx context.Context, duration time.Duration) bool {
	timer := time.NewTimer(duration)
	defer timer.Stop()
	select {
	case <-ctx.Done():
		return false
	case <-timer.C:
		return true
	}
}
