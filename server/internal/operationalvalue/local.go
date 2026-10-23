package operationalvalue

import (
	"context"
	"encoding/json"
	"errors"
	"log/slog"
	"os/exec"
	"path/filepath"
	"slices"
	"strings"
	"time"
)

func WriteCollectionHealth(ctx context.Context, config Config, policy, snapshot string) error {
	arguments := make([]string, 0, 19+2*len(config.Repositories))
	arguments = append(arguments,
		filepath.Join(config.Root, "activity", "workflow-values.mjs"),
		"--root", config.Root, "--policy", policy, "--defer", "shared-budget-unavailable",
		"--database", filepath.Join(snapshot, "unused-value.sqlite"),
		"--output", filepath.Join(snapshot, "gh-aw-logs-shards", "workflow-values.jsonl"),
		"--inventory", filepath.Join(snapshot, "inventory-sources.json"),
		"--workspace", filepath.Join(snapshot, "workflow-value-workspaces"),
		"--localRequest", filepath.Join(snapshot, "gh-aw-logs-shards", "workflow-value-local.json"),
		"--snapshot", "hosted",
	)
	for _, repository := range config.Repositories {
		arguments = append(arguments, "--repository", repository)
	}
	return runLocalRuntime(ctx, config, arguments)
}

func ComputeLocalSnapshot(ctx context.Context, config Config, policy, snapshot, retentionDays string) error {
	if err := runLocalRuntime(ctx, config, []string{
		filepath.Join(config.Root, "activity", "cao.mjs"), "ingest-jsonl",
		"--database", config.Database, "--runs-dir", filepath.Join(snapshot, "gh-aw-logs-runs"),
		"--records-dir", filepath.Join(snapshot, "gh-aw-logs-records"),
		"--retention-days", retentionDays, "--run-retention-days", retentionDays,
	}); err != nil {
		return err
	}
	return runLocalRuntime(ctx, config, []string{
		filepath.Join(config.Root, "activity", "local-values.mjs"), "compute",
		"--root", config.Root, "--policy", policy, "--snapshot", snapshot, "--snapshotKey", "hosted",
		"--database", config.Database, "--output", config.Output,
	})
}

func runLocalRuntime(ctx context.Context, config Config, arguments []string) error {
	timeout := config.WorkerTimeout
	if timeout <= 0 {
		timeout = 2 * time.Minute
	}
	ctx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()
	node := config.NodeBinary
	if node == "" {
		node = "node"
	}
	command := exec.CommandContext(ctx, node, arguments...) // #nosec G204 -- fixed trusted local runtime and explicit paths.
	command.Dir = config.Root
	command.Env = slices.DeleteFunc(slices.Clone(config.Environment), func(value string) bool {
		return strings.HasPrefix(value, "GH_TOKEN=") || strings.HasPrefix(value, "GITHUB_TOKEN=") ||
			strings.HasPrefix(value, "CAO_OPERATIONAL_VALUE_GH_TOKEN=")
	})
	command.Env = append(command.Env, "CAO_VALUE_SHARED_PROCESS_GROUP=1")
	configureProcessTree(command)
	command.Cancel = func() error { return terminateProcessTree(command.Process) }
	command.WaitDelay = 5 * time.Second
	stdout, stderr := newLimitedBuffer(1<<20, cancel), newLimitedBuffer(16384, cancel)
	command.Stdout, command.Stderr = stdout, stderr
	err := command.Run()
	_ = terminateProcessTree(command.Process)
	if err != nil || stdout.Exceeded() || stderr.Exceeded() {
		return errors.New("local Value runtime failed or exceeded its budget; accepted evidence retained")
	}
	if len(stdout.Bytes()) != 0 {
		var result struct {
			Warnings []json.RawMessage `json:"warnings"`
		}
		if err := json.Unmarshal(stdout.Bytes(), &result); err != nil {
			return errors.New("local Value runtime returned an invalid result")
		}
		if len(result.Warnings) != 0 {
			slog.WarnContext(ctx, "local Value adapters deferred or failed; only completed evidence retained",
				"warning_count", len(result.Warnings))
		}
	}
	return nil
}
