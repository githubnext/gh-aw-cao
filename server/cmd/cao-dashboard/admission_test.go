package main

import (
	"bytes"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/githubnext/gh-cao/server/internal/admission"
)

func TestAdmissionValidateOperatorReadiness(t *testing.T) {
	t.Setenv("CAO_ADMISSION_POLICY_FILE", "")
	t.Setenv("CAO_ADMISSION_AUDIENCE", "")
	path := filepath.Join(t.TempDir(), "snapshot.json")
	used := int64(10)
	now := time.Now()
	entry := admission.Enrollment{
		Repository: "acme/project", RepositoryID: "1001", OwnerID: "42", Enabled: true,
		Subjects: []string{"repo:acme/project:ref:refs/heads/main"},
		Workflows: []admission.Policy{{
			WorkflowRef: "acme/project/.github/workflows/triage.lock.yml@refs/heads/main",
			WorkflowSHA: strings.Repeat("a", 40), Events: []string{"workflow_dispatch"},
			ActorIDs: []string{"101"}, Allowances: admission.Allowances{Primary: 1000},
		}},
		Usage: admission.Usage{Unit: "ai-credits", Used: &used, Limit: 10000,
			ObservedAt: now, WindowStart: now.Add(-time.Hour), WindowEnd: now.Add(time.Hour)},
	}
	check := func(want bool) {
		t.Helper()
		data, err := json.Marshal(admission.Snapshot{Version: 1, Repositories: []admission.Enrollment{entry}})
		if err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(path, data, 0600); err != nil {
			t.Fatal(err)
		}
		cmd := newRootCommand()
		var output bytes.Buffer
		cmd.SetOut(&output)
		cmd.SetErr(&output)
		cmd.SetArgs([]string{"admission", "validate", "--policy", path, "--audience", "https://cao.example/api/admission"})
		err = cmd.ExecuteContext(t.Context())
		if (err == nil) != want {
			t.Fatalf("ready=%t error=%v output=%s", want, err, &output)
		}
		if want && !strings.Contains(output.String(), `"ok":true`) {
			t.Fatal("readiness not reported")
		}
		after, err := os.ReadFile(path) // #nosec G304 -- fixture path is within testing.T.TempDir.
		if err != nil || !bytes.Equal(data, after) {
			t.Fatal("validation modified the snapshot")
		}
	}
	check(true)
	entry.Usage.ObservedAt = now.Add(-3 * time.Minute)
	check(false)
	entry.Usage.ObservedAt = now
	used = 10000
	check(false)
	used = 10
	entry.Enabled = false
	check(false)
	entry.Enabled = true
	check(true)
	t.Setenv("CAO_ADMISSION_POLICY_FILE", path)
	t.Setenv("CAO_ADMISSION_AUDIENCE", "https://cao.example/api/admission")
	cmd := newRootCommand()
	cmd.SetOut(new(bytes.Buffer))
	cmd.SetArgs([]string{"admission", "validate"})
	if err := cmd.ExecuteContext(t.Context()); err != nil {
		t.Fatalf("environment defaults: %v", err)
	}
}
