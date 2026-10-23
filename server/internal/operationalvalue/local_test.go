package operationalvalue

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
	"time"
)

func TestLocalCollectionHealthNeedsNeitherCollectorNorCredential(t *testing.T) {
	root, err := filepath.Abs("../../..")
	if err != nil {
		t.Fatal(err)
	}
	snapshot := t.TempDir()
	policy := filepath.Join(snapshot, "cao.json")
	content := `{"version":1,"gh-aw-version":"v0.93.1","control-plane":{
		"scope":{"allowed-repositories":["org/repo"]},"activity":{"repositories":["org/repo"]},
		"campaigns":{"activity":{"workflow-values":[
			{"repository":"org/repo","workflow":"worker","collector":"not-present.mjs"}
		]}}}}`
	if err := os.WriteFile(policy, []byte(content), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(snapshot, "inventory-sources.json"),
		[]byte(`{"repositories":{"rows":[]},"workflows":{"rows":[]}}`), 0o600); err != nil {
		t.Fatal(err)
	}
	config := Config{Root: root, Repositories: []string{"org/repo"}, Environment: []string{
		"PATH=" + os.Getenv("PATH"), "GH_TOKEN=test-only", "GITHUB_TOKEN=test-only",
	}}
	if err := WriteCollectionHealth(t.Context(), config, policy, snapshot); err != nil {
		t.Fatal(err)
	}
	data, err := os.ReadFile(filepath.Join(snapshot, "gh-aw-logs-shards", "workflow-values-collections.jsonl")) // #nosec G304 -- fixed test-owned temporary output.
	if err != nil {
		t.Fatal(err)
	}
	var envelope struct {
		Record map[string]any `json:"workflow_value_collection"`
	}
	if err := json.Unmarshal(data, &envelope); err != nil {
		t.Fatal(err)
	}
	if envelope.Record["registration"] != "enabled" || envelope.Record["state"] != "deferred" ||
		envelope.Record["reasonCode"] != "shared-budget-unavailable" || envelope.Record["lastAttemptAt"] != nil {
		t.Fatalf("hosted health did not preserve registration without an attempt: %v", envelope.Record)
	}
	if _, err := os.Stat(filepath.Join(snapshot, "workflow-value-workspaces")); !os.IsNotExist(err) {
		t.Fatal("health publication must not start acquisition or create proof workspaces")
	}
}

func TestLocalRuntimeCancellationOwnsDescendantsAndStripsCredentials(t *testing.T) {
	directory := t.TempDir()
	started, leaked := filepath.Join(directory, "started"), filepath.Join(directory, "leaked")
	marker, _ := json.Marshal(started)
	target, _ := json.Marshal(leaked)
	child := `require("node:fs").writeFileSync(` + string(marker) + `,"ready");
		setTimeout(()=>require("node:fs").writeFileSync(` + string(target) + `,"leaked"),500);
		setInterval(()=>{},1000)`
	childSource, _ := json.Marshal(child)
	source := `if(process.env.GH_TOKEN || process.env.GITHUB_TOKEN || process.env.CAO_OPERATIONAL_VALUE_GH_TOKEN)
		throw new Error("credentials crossed local boundary");
		require("node:child_process").spawn(process.execPath,["-e",` + string(childSource) + `]);
		setInterval(()=>{},1000)`
	ctx, cancel := context.WithCancel(t.Context())
	defer cancel()
	done := make(chan error, 1)
	go func() {
		done <- runLocalRuntime(ctx, Config{Root: directory, WorkerTimeout: 5 * time.Second,
			Environment: []string{"PATH=" + os.Getenv("PATH"), "GH_TOKEN=test-only", "GITHUB_TOKEN=test-only",
				"CAO_OPERATIONAL_VALUE_GH_TOKEN=test-only"}},
			[]string{"-e", source})
	}()
	deadline := time.Now().Add(3 * time.Second)
	for {
		if _, err := os.Stat(started); err == nil {
			break
		}
		select {
		case err := <-done:
			t.Fatalf("local child did not start with credentials removed: %v", err)
		default:
		}
		if time.Now().After(deadline) {
			t.Fatal("local runtime did not start within its bounded deadline")
		}
		time.Sleep(10 * time.Millisecond)
	}
	cancel()
	if err := <-done; err == nil {
		t.Fatal("canceled local work must report failure")
	}
	time.Sleep(600 * time.Millisecond)
	if _, err := os.Stat(leaked); !os.IsNotExist(err) {
		t.Fatal("a descendant survived local runtime cancellation")
	}
}
