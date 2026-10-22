package operationalvalue

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"time"

	"github.com/githubnext/gh-cao/server/internal/model"
)

type WorkflowRegistration struct {
	Repository string `json:"repository"`
	Workflow   string `json:"workflow"`
	Collector  string `json:"collector"`
}

func WorkflowRegistrations(ctx context.Context, config Config, policy string) ([]WorkflowRegistration, error) {
	node := config.NodeBinary
	if node == "" {
		node = "node"
	}
	worker, cancel := context.WithTimeout(ctx, 30*time.Second)
	defer cancel()
	command := exec.CommandContext(worker, node, filepath.Join(config.Root, "activity", "workflow-values.mjs"), "--registrations", policy) // #nosec G204 -- trusted runtime.
	command.Dir, command.Env = config.Root, config.Environment
	configureProcessTree(command)
	command.Cancel = func() error { return terminateProcessTree(command.Process) }
	command.WaitDelay = 5 * time.Second
	stdout, stderr := newLimitedBuffer(1024*1024, cancel), newLimitedBuffer(4096, cancel)
	command.Stdout, command.Stderr = stdout, stderr
	err := command.Run()
	_ = terminateProcessTree(command.Process)
	if err != nil || stdout.Exceeded() {
		return nil, errors.New("cannot resolve reviewed workflow Value registrations")
	}
	var entries []WorkflowRegistration
	if err := json.Unmarshal(stdout.Bytes(), &entries); err != nil {
		return nil, err
	}
	return entries, nil
}

// CollectWorkflows executes only reviewed exact opt-ins through the shared
// Activity producer. previous contains canonical accepted envelopes, not code.
func CollectWorkflows(ctx context.Context, config Config, policy, workspace, previous string) ([]model.Row, []string, error) {
	if config.RateLimitReserve > 0 {
		remaining, err := githubAPIRemaining(ctx, config)
		if err != nil {
			return nil, nil, err
		}
		if remaining <= config.RateLimitReserve {
			return nil, []string{"workflow Value acquisition skipped: API budget reserve"}, nil
		}
	}
	if err := os.MkdirAll(workspace, 0o700); err != nil {
		return nil, nil, err
	}
	scratch, err := os.MkdirTemp(workspace, ".invocation-")
	if err != nil {
		return nil, nil, err
	}
	defer func() { _ = os.RemoveAll(scratch) }()
	output := filepath.Join(scratch, "packets.jsonl")
	arguments := []string{
		filepath.Join(config.Root, "activity", "workflow-values.mjs"),
		"--root", config.Root, "--policy", policy, "--database", config.Database,
		"--workspace", workspace, "--previous", previous, "--output", output,
		"--observedAt", formatTimestamp(config.ObservedAt),
	}
	for _, repository := range config.Repositories {
		arguments = append(arguments, "--repository", repository)
	}
	timeout := config.WorkerTimeout
	if timeout <= 0 {
		timeout = 10*time.Minute + 10*time.Second
	}
	worker, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()
	node := config.NodeBinary
	if node == "" {
		node = "node"
	}
	command := exec.CommandContext(worker, node, arguments...) // #nosec G204 -- reviewed runtime and bounded arguments.
	command.Dir = config.Root
	command.Env = append(append([]string{}, config.Environment...), "CAO_WORKFLOW_VALUE_SHARED_PROCESS_GROUP=1")
	configureProcessTree(command)
	command.Cancel = func() error { return terminateProcessTree(command.Process) }
	command.WaitDelay = 5 * time.Second
	stdout, stderr := newLimitedBuffer(maxWorkerOutput, cancel), newLimitedBuffer(maxWorkerOutput, cancel)
	command.Stdout, command.Stderr = stdout, stderr
	err = command.Run()
	_ = terminateProcessTree(command.Process)
	if err != nil || stdout.Exceeded() || stderr.Exceeded() {
		return nil, nil, errors.New("reviewed workflow Value producer failed or exceeded its budget; accepted evidence retained")
	}
	var report struct {
		Warnings []string `json:"warnings"`
	}
	if err := json.Unmarshal(stdout.Bytes(), &report); err != nil {
		return nil, nil, fmt.Errorf("decode workflow Value result: %w", err)
	}
	file, err := os.Open(output) // #nosec G304 -- fixed filename in this invocation's private scratch directory.
	if err != nil {
		return nil, nil, err
	}
	defer func() { _ = file.Close() }()
	scanner := bufio.NewScanner(file)
	scanner.Buffer(make([]byte, 64*1024), 8*1024*1024+1)
	packets := []model.Row{}
	for scanner.Scan() {
		var envelope struct {
			SchemaVersion int       `json:"schema_version"`
			Kind          string    `json:"kind"`
			Packet        model.Row `json:"operational_value_evidence"`
		}
		decoder := json.NewDecoder(bytes.NewReader(scanner.Bytes()))
		decoder.UseNumber()
		if err := decoder.Decode(&envelope); err != nil || envelope.SchemaVersion != 2 || envelope.Kind != "operational_value_evidence" {
			return nil, nil, errors.New("invalid workflow Value producer envelope")
		}
		packets = append(packets, envelope.Packet)
		if len(packets) > 1000 {
			return nil, nil, errors.New("workflow Value packet count exceeds budget")
		}
	}
	return packets, report.Warnings, scanner.Err()
}
