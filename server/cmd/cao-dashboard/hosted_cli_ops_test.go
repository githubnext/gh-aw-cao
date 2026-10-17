package main

import (
	"bytes"
	"encoding/json"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"testing"

	"github.com/githubnext/gh-aw-cao/server/internal/operational"
	"github.com/githubnext/gh-aw-cao/server/internal/server"
)

func TestHostedCLIQueueOperationsSQLite(t *testing.T) {
	sqlitePath := filepath.Join(t.TempDir(), "hosted-cli.sqlite")
	auditPath := filepath.Join(t.TempDir(), "audit.jsonl")
	t.Setenv("CAO_AUDIT_LOG", auditPath)
	store, err := server.OpenHostedCLISQLite(t.Context(), sqlitePath)
	if err != nil {
		t.Fatal(err)
	}
	options, err := (operational.CLICommandQueueOptions{}).Resolve()
	if err != nil {
		t.Fatal(err)
	}
	queue, err := store.OpenCLICommandQueue(t.Context(), "hosted-cli", options)
	if err != nil {
		t.Fatal(err)
	}
	var command operational.CLICommand
	for index := range 3 {
		command, err = queue.Enqueue(t.Context(), operational.CLICommandInvocation{
			ActionID: "run-workflow", Command: "gh workflow run build.yml",
			Actor: "octocat", Repository: "acme/widgets",
		}, "operator-test-"+strconv.Itoa(index), 0)
		if err != nil {
			t.Fatal(err)
		}
	}
	if err := store.Close(); err != nil {
		t.Fatal(err)
	}

	output, err := runHostedCLIQueueTestCommand(t, sqlitePath, "list", "--status", "queued", "--limit", "2")
	if err != nil {
		t.Fatal(err)
	}
	var page struct {
		Commands   []map[string]any `json:"commands"`
		Total      int              `json:"total"`
		Running    int              `json:"running"`
		Offset     int              `json:"offset"`
		Limit      int              `json:"limit"`
		HasMore    bool             `json:"hasMore"`
		NextOffset int              `json:"nextOffset"`
	}
	if err := json.Unmarshal([]byte(output), &page); err != nil {
		t.Fatal(err)
	}
	if page.Total != 3 || page.Running != 0 || len(page.Commands) != 2 ||
		page.Commands[0]["id"] != float64(command.ID) ||
		page.Commands[0]["actor"] != "octocat" ||
		page.Offset != 0 || page.Limit != 2 || !page.HasMore || page.NextOffset != 2 {
		t.Fatalf("unexpected queue list: %s", output)
	}
	if strings.Contains(output, "gh workflow run") {
		t.Fatalf("queue summary disclosed command text: %s", output)
	}
	output, err = runHostedCLIQueueTestCommand(t, sqlitePath, "list", "--status", "queued", "--limit", "2", "--offset", "2")
	if err != nil {
		t.Fatal(err)
	}
	if err := json.Unmarshal([]byte(output), &page); err != nil {
		t.Fatal(err)
	}
	if page.Total != 3 || len(page.Commands) != 1 || page.Offset != 2 ||
		page.Limit != 2 || page.HasMore || page.NextOffset != 3 {
		t.Fatalf("unexpected final queue page: %s", output)
	}

	output, err = runHostedCLIQueueTestCommand(t, sqlitePath, "show", "1")
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(output, "gh workflow run") || !strings.Contains(output, `"repository": "acme/widgets"`) {
		t.Fatalf("unexpected command summary: %s", output)
	}

	if _, err := runHostedCLIQueueTestCommand(t, sqlitePath, "cancel", "1", "--actor", "ops-user"); err != nil {
		t.Fatal(err)
	}
	if _, err := runHostedCLIQueueTestCommand(t, sqlitePath, "cancel", "1"); err == nil {
		t.Fatal("cancel without an operator identity succeeded")
	}

	verifyStore, err := server.OpenHostedCLISQLite(t.Context(), sqlitePath)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = verifyStore.Close() }()
	verifyQueue, err := verifyStore.OpenCLICommandQueue(t.Context(), "hosted-cli", options)
	if err != nil {
		t.Fatal(err)
	}
	canceled, err := verifyQueue.Detail(t.Context(), 1)
	if err != nil || canceled.Status != operational.CLICommandCanceled {
		t.Fatalf("command after cancel = %q, %v", canceled.Status, err)
	}
	events, err := verifyStore.ListAudit(t.Context(), operational.AuditFilter{Limit: 20})
	if err != nil {
		t.Fatal(err)
	}
	foundRequest, foundCanceled := false, false
	for _, event := range events {
		if event.Actor != "ops-user" {
			continue
		}
		foundRequest = foundRequest || event.Event == "cli_command.operator_cancel_requested"
		foundCanceled = foundCanceled || event.Event == "cli_command.operator_cancelled"
	}
	if !foundRequest || !foundCanceled {
		t.Fatalf("operator cancellation audit events missing: %+v", events)
	}
	if _, err := os.Stat(auditPath); err != nil {
		t.Fatalf("audit mirror was not created: %v", err)
	}
}

func runHostedCLIQueueTestCommand(t *testing.T, sqlitePath string, args ...string) (string, error) {
	t.Helper()
	root := newRootCommand()
	var output bytes.Buffer
	root.SetOut(&output)
	root.SetErr(&output)
	root.SetArgs(append([]string{"hosted-cli", "queue"}, append(args, "--sqlite", sqlitePath)...))
	err := root.Execute()
	return output.String(), err
}
