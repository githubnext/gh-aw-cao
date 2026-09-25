package collect

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"time"

	"github.com/githubnext/gh-aw-cao/server/internal/githubapp"
	"github.com/githubnext/gh-aw-cao/server/internal/logger"
)

var runnerLog = logger.New("cao:collect:runner")

// TokenProvider mints a short-lived installation token for one collection.
type TokenProvider interface {
	InstallationToken(ctx context.Context, installationID int64) (string, error)
}

// Runner acquires one repository's evidence.
//
// It invokes the same `gh aw logs --audit` command and the same
// `activity/cao.mjs` compactor the Actions profile invokes. There is no second
// implementation of the audit mapping or the shard format; that shared
// implementation is what makes the two profiles equivalent.
type Runner struct {
	Lake Lake
	// CatalogRoot contains activity/cao.mjs.
	CatalogRoot string
	// NodeBinary and GitHubBinary are resolved from PATH when empty.
	NodeBinary   string
	GitHubBinary string
	// WindowDays bounds the retained collection window.
	WindowDays int
	// RunLimit bounds runs collected per repository per invocation.
	RunLimit int
	// MaxStorageMB bounds on-disk artifact usage per invocation.
	MaxStorageMB int
	// RequestTimeout is the per-request timeout passed to the CLI, in minutes.
	RequestTimeoutMinutes int
	// Timeout bounds one whole collection.
	Timeout time.Duration
	// MaxOutputBytes caps captured subprocess output.
	MaxOutputBytes int
	Tokens         TokenProvider
	Budget         *githubapp.Budget
}

// Validate reports whether the runner can collect at all.
func (r Runner) Validate() error {
	if err := r.Lake.Validate(); err != nil {
		return err
	}
	if strings.TrimSpace(r.CatalogRoot) == "" {
		return errors.New("catalog root containing activity/cao.mjs is required")
	}
	script := filepath.Join(r.CatalogRoot, "activity", "cao.mjs")
	if _, err := os.Stat(script); err != nil {
		return fmt.Errorf("activity CLI is unavailable at %s: %w", script, err)
	}
	if r.Tokens == nil {
		return errors.New("an installation token provider is required")
	}
	return nil
}

func (r Runner) node() string {
	if strings.TrimSpace(r.NodeBinary) != "" {
		return r.NodeBinary
	}
	return "node"
}

func (r Runner) gh() string {
	if strings.TrimSpace(r.GitHubBinary) != "" {
		return r.GitHubBinary
	}
	return "gh"
}

func (r Runner) windowDays() int {
	if r.WindowDays <= 0 {
		return 30
	}
	return r.WindowDays
}

func (r Runner) runLimit() int {
	if r.RunLimit <= 0 {
		return 10000
	}
	return r.RunLimit
}

func (r Runner) maxStorage() int {
	if r.MaxStorageMB <= 0 {
		return 1200
	}
	return r.MaxStorageMB
}

func (r Runner) requestTimeout() int {
	if r.RequestTimeoutMinutes <= 0 {
		return 15
	}
	return r.RequestTimeoutMinutes
}

func (r Runner) timeout() time.Duration {
	if r.Timeout <= 0 {
		return 20 * time.Minute
	}
	return r.Timeout
}

// Collect acquires and compacts evidence for exactly one repository.
//
// It reserves installation budget first and passes the derived reserve to the
// collection subprocess, so the subprocess fails closed rather than exhausting
// the installation.
func (r Runner) Collect(ctx context.Context, task Task) error {
	repository, err := NormalizeRepository(task.Repository)
	if err != nil {
		return err
	}
	if err := r.Lake.Prepare(); err != nil {
		return err
	}
	reserve := 2000
	if r.Budget != nil {
		reserved, err := r.Budget.Reserve(ctx, task.InstallationID)
		if err != nil {
			return err
		}
		reserve = reserved
	}
	token, err := r.Tokens.InstallationToken(ctx, task.InstallationID)
	if err != nil {
		return err
	}
	workspace, err := os.MkdirTemp("", "cao-collect-")
	if err != nil {
		return fmt.Errorf("create collection workspace: %w", err)
	}
	defer func() {
		_ = os.RemoveAll(workspace)
	}()
	ctx, cancel := context.WithTimeout(ctx, r.timeout())
	defer cancel()
	if err := r.downloadLogs(ctx, repository, workspace, token, reserve); err != nil {
		return err
	}
	if err := r.compact(ctx, repository); err != nil {
		return err
	}
	runnerLog.Printf("collected evidence repository=%s", repository)
	return nil
}

func (r Runner) downloadLogs(ctx context.Context, repository, workspace, token string, reserve int) error {
	shardPrefix := filepath.Join(r.Lake.ShardDirectory(), r.Lake.ShardPrefix(repository))
	arguments := []string{
		"aw", "logs", "--audit",
		"--repo", repository,
		"--output", filepath.Join(workspace, "logs"),
		"--summary-file", "",
		"--cached-jsonl", shardPrefix + "*",
		"--artifacts", "usage",
		"--start-date", fmt.Sprintf("-%dd", r.windowDays()),
		"--cache-before", fmt.Sprintf("-%dd", r.windowDays()),
		"--count", strconv.Itoa(r.runLimit()),
		"--timeout", strconv.Itoa(r.requestTimeout()),
		"--max-github-api-rate-limit", strconv.Itoa(-reserve),
		"--max-storage", strconv.Itoa(r.maxStorage()),
		"--prune-older-runs",
	}
	return r.execute(ctx, r.gh(), arguments, []string{"GH_TOKEN=" + token})
}

func (r Runner) compact(ctx context.Context, repository string) error {
	arguments := []string{
		filepath.Join(r.CatalogRoot, "activity", "cao.mjs"),
		"compact-jsonl",
		"--input-dir", r.Lake.ShardDirectory(),
		"--group", repository + "=" + r.Lake.ShardPrefix(repository),
	}
	return r.execute(ctx, r.node(), arguments, nil)
}

func (r Runner) execute(ctx context.Context, name string, arguments []string, environment []string) error {
	// #nosec G204 -- name and arguments are constructed from validated
	// configuration and a normalized repository reference.
	command := exec.CommandContext(ctx, name, arguments...)
	command.Dir = r.CatalogRoot
	command.Env = append(collectionEnvironment(), environment...)
	var output bytes.Buffer
	limit := r.MaxOutputBytes
	if limit <= 0 {
		limit = 1 << 20
	}
	writer := &boundedWriter{buffer: &output, limit: limit}
	command.Stdout = writer
	command.Stderr = writer
	if err := command.Run(); err != nil {
		return fmt.Errorf("%s failed: %w: %s", filepath.Base(name), err, summarize(output.String()))
	}
	return nil
}

// collectionEnvironment builds a minimal environment for the subprocess. The
// process environment is not inherited wholesale so ambient credentials cannot
// leak into a collection.
func collectionEnvironment() []string {
	environment := []string{
		"PATH=" + os.Getenv("PATH"),
		"HOME=" + os.Getenv("HOME"),
		"LANG=" + os.Getenv("LANG"),
	}
	if value := os.Getenv("GH_HOST"); value != "" {
		environment = append(environment, "GH_HOST="+value)
	}
	if value := os.Getenv("GITHUB_API_URL"); value != "" {
		environment = append(environment, "GITHUB_API_URL="+value)
	}
	return environment
}

type boundedWriter struct {
	buffer *bytes.Buffer
	limit  int
}

func (w *boundedWriter) Write(content []byte) (int, error) {
	remaining := w.limit - w.buffer.Len()
	if remaining <= 0 {
		return len(content), nil
	}
	if len(content) > remaining {
		content = content[:remaining]
	}
	if _, err := w.buffer.Write(content); err != nil {
		return 0, err
	}
	return len(content), nil
}

func summarize(output string) string {
	trimmed := strings.TrimSpace(output)
	if len(trimmed) > 2000 {
		trimmed = trimmed[len(trimmed)-2000:]
	}
	return trimmed
}
