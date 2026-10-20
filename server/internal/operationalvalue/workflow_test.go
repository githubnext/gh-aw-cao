package operationalvalue

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
	"time"
)

func TestWorkflowProducerUsesReviewedExactRegistrationAndOriginalPacket(t *testing.T) {
	root, err := filepath.Abs("../../..")
	if err != nil {
		t.Fatal(err)
	}
	directory, err := os.MkdirTemp(root, ".hosted-workflow-value-test-")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.RemoveAll(directory) })
	packet := map[string]any{
		"schemaVersion": 1, "repository": "org/repo", "workflow": "daily-review",
		"id":         "operational-value-evidence:org%2Frepo%3Adaily-review%3Alines%3Av1",
		"sourcePath": ".github/workflows/daily-review.md", "observedAt": "2026-10-20T12:00:00.000Z",
		"windowStart": "2026-10-01T00:00:00.000Z", "windowEnd": "2026-10-20T00:00:00.000Z",
		"contractDigest": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
		"facts": []any{
			map[string]any{
				"fact-kind": "contract", "fact-id": "contract", "goal": "Remove waste", "acceptance": "Accepted removal",
				"workflow-name": "Review", "metric-id": "lines", "metric-name": "Lines", "metric-unit": "lines",
				"metric-direction": "increase", "metric-version": "v1", "metric-formula": "accepted lines removed",
				"measurement-basis": "workflow-contribution", "cadence-days": 1,
				"outputs-available": false, "repository-state-available": false, "checks-available": false,
			},
			map[string]any{"fact-kind": "coverage", "fact-id": "window", "at": "2026-10-01T00:00:00.000Z",
				"end-at": "2026-10-20T00:00:00.000Z", "coverage-status": "complete"},
		},
	}
	envelope := map[string]any{"schema_version": 2, "kind": "operational_value_evidence", "operational_value_evidence": packet}
	content, _ := json.Marshal(envelope)
	module := `export const definition={schemaVersion:3,repository:"org/repo",slug:"daily-review",sourcePath:".github/workflows/daily-review.md",adoption:{adoptedAt:"2026-10-01T00:00:00.000Z"},evidence:{repositories:["org/repo"],window:{cadenceDays:1,maturationDays:0}}}; export async function collectValueEvidence(){return ` + string(content) + `;}`
	collector := filepath.Join(directory, "collector.mjs")
	if err := os.WriteFile(collector, []byte(module), 0o600); err != nil {
		t.Fatal(err)
	}
	relative, _ := filepath.Rel(root, collector)
	policy := map[string]any{
		"version": 1, "gh-aw-version": "v0.92.5", "control-plane": map[string]any{
			"scope":    map[string]any{"allowed-owners": []string{"org"}, "allowed-repositories": []string{"org/repo"}},
			"activity": map[string]any{"repositories": []string{"org/repo"}},
			"campaigns": map[string]any{"activity": map[string]any{"workflow-values": []any{
				map[string]any{"repository": "org/repo", "workflow": "daily-review", "collector": filepath.ToSlash(relative)},
			}}},
		},
	}
	policyPath := filepath.Join(directory, "cao.json")
	policyJSON, _ := json.Marshal(policy)
	if err := os.WriteFile(policyPath, policyJSON, 0o600); err != nil {
		t.Fatal(err)
	}
	previous := filepath.Join(directory, "previous.jsonl")
	if err := os.WriteFile(previous, nil, 0o600); err != nil {
		t.Fatal(err)
	}
	config := Config{Root: root, Database: filepath.Join(directory, "activity.sqlite"), Repositories: []string{"org/repo"}, ObservedAt: time.Date(2026, 10, 20, 12, 0, 0, 0, time.UTC), Environment: []string{"PATH=" + os.Getenv("PATH")}}
	entries, err := WorkflowRegistrations(context.Background(), config, policyPath)
	if err != nil || len(entries) != 1 || entries[0].Workflow != "daily-review" {
		t.Fatalf("registrations=%+v err=%v", entries, err)
	}
	packets, warnings, err := CollectWorkflows(context.Background(), config, policyPath, filepath.Join(directory, "proofs"), previous)
	if err != nil || len(packets) != 1 || len(warnings) != 0 || packets[0]["observedAt"] != packet["observedAt"] {
		t.Fatalf("packets=%+v warnings=%v err=%v", packets, warnings, err)
	}
	if err := os.WriteFile(previous, append(content, '\n'), 0o600); err != nil {
		t.Fatal(err)
	}
	packets, warnings, err = CollectWorkflows(context.Background(), config, policyPath, filepath.Join(directory, "proofs"), previous)
	if err != nil || len(packets) != 0 || len(warnings) != 0 {
		t.Fatalf("cadence was not satisfied by accepted canonical evidence: packets=%+v warnings=%v err=%v", packets, warnings, err)
	}
	config.Repositories = []string{"org/outside"}
	packets, warnings, err = CollectWorkflows(context.Background(), config, policyPath, filepath.Join(directory, "proofs"), previous)
	if err != nil || len(packets) != 0 || len(warnings) != 0 {
		t.Fatalf("runtime repository scope was enlarged: packets=%+v warnings=%v err=%v", packets, warnings, err)
	}
}
