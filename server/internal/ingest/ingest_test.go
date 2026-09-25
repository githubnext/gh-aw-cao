package ingest

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/githubnext/gh-aw-cao/server/internal/model"
)

func TestValidateManifestVerifiesHashesAndRunShard(t *testing.T) {
	directory := scratchDirectory(t)
	runName := "gh-aw-logs-runs/runs-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-aaaaaaaaaaaaaaaa.jsonl"
	content := []byte("{\"kind\":\"metadata\"}\n")
	writeTestFile(t, filepath.Join(directory, filepath.FromSlash(runName)), content)
	sum := sha256.Sum256(content)
	manifest, _ := json.Marshal(map[string]string{runName: hex.EncodeToString(sum[:])})
	writeTestFile(t, filepath.Join(directory, "payload-hashes.json"), manifest)
	_, runs, records, err := ValidateManifest(directory)
	if err != nil {
		t.Fatal(err)
	}
	if len(runs) != 1 || len(records) != 0 {
		t.Fatalf("unexpected shard phases: runs=%v records=%v", runs, records)
	}
}

func TestValidateManifestFailsClosed(t *testing.T) {
	t.Run("hash mismatch", func(t *testing.T) {
		directory := scratchDirectory(t)
		name := "gh-aw-logs-runs/runs.jsonl"
		writeTestFile(t, filepath.Join(directory, filepath.FromSlash(name)), []byte("{}\n"))
		manifest, _ := json.Marshal(map[string]string{name: strings.Repeat("0", 64)})
		writeTestFile(t, filepath.Join(directory, "payload-hashes.json"), manifest)
		if _, _, _, err := ValidateManifest(directory); err == nil || !strings.Contains(err.Error(), "hash mismatch") {
			t.Fatalf("expected hash mismatch, got %v", err)
		}
	})
	t.Run("raw shards", func(t *testing.T) {
		directory := scratchDirectory(t)
		manifest, _ := json.Marshal(map[string]string{"gh-aw-logs-shards/raw.jsonl": strings.Repeat("0", 64)})
		writeTestFile(t, filepath.Join(directory, "payload-hashes.json"), manifest)
		if _, _, _, err := ValidateManifest(directory); err == nil || !strings.Contains(err.Error(), "raw activity") {
			t.Fatalf("expected raw shard rejection, got %v", err)
		}
	})
	t.Run("missing run phase", func(t *testing.T) {
		directory := scratchDirectory(t)
		name := "gh-aw-logs-records/records.jsonl"
		content := []byte("{}\n")
		writeTestFile(t, filepath.Join(directory, filepath.FromSlash(name)), content)
		sum := sha256.Sum256(content)
		manifest, _ := json.Marshal(map[string]string{name: hex.EncodeToString(sum[:])})
		writeTestFile(t, filepath.Join(directory, "payload-hashes.json"), manifest)
		if _, _, _, err := ValidateManifest(directory); err == nil || !strings.Contains(err.Error(), "run-information") {
			t.Fatalf("expected missing run phase error, got %v", err)
		}
	})
	t.Run("non-shard identities are not file content hashes", func(t *testing.T) {
		directory := scratchDirectory(t)
		name := "gh-aw-logs-runs/runs.jsonl"
		content := []byte("{\"kind\":\"metadata\"}\n")
		writeTestFile(t, filepath.Join(directory, filepath.FromSlash(name)), content)
		sum := sha256.Sum256(content)
		manifest, _ := json.Marshal(map[string]string{
			name:                hex.EncodeToString(sum[:]),
			"gh-aw-logs.sqlite": strings.Repeat("f", 64),
		})
		writeTestFile(t, filepath.Join(directory, "payload-hashes.json"), manifest)
		if _, _, _, err := ValidateManifest(directory); err != nil {
			t.Fatalf("non-shard identity must not be validated as a file hash: %v", err)
		}
	})
}

func TestDeployedSubsetProjectsCanonicalSources(t *testing.T) {
	const directory = "../../testdata/deployed-subset"

	manifest, runs, records, err := ValidateManifest(directory)
	if err != nil {
		t.Fatal(err)
	}
	if len(manifest) != 2 || len(runs) != 1 || len(records) != 1 {
		t.Fatalf("unexpected validated manifest: entries=%d runs=%v records=%v", len(manifest), runs, records)
	}

	inventoryContent, err := os.ReadFile("../../testdata/deployed-subset/inventory-sources.json")
	if err != nil {
		t.Fatal(err)
	}
	inventory, err := parseInventory(inventoryContent)
	if err != nil {
		t.Fatal(err)
	}
	canonical := map[string][]model.Row{}
	for _, collection := range collections {
		canonical[collection] = []model.Row{}
	}
	for _, name := range append(runs, records...) {
		if err := readShard(filepath.Join(directory, filepath.FromSlash(name)), canonical); err != nil {
			t.Fatal(err)
		}
	}
	definitions, err := loadDefinitions("../../../dashboard/site/src/data/queries/database.json")
	if err != nil {
		t.Fatal(err)
	}
	sources, err := projectSources(canonical, inventory, definitions)
	if err != nil {
		t.Fatal(err)
	}
	for _, name := range []string{"repositories", "workflows", "runs", "tools"} {
		if len(sources[name].Rows) == 0 {
			t.Errorf("projected source %q is empty", name)
		}
	}
}

func TestProjectsOperationalValuesWithCampaign(t *testing.T) {
	canonical := map[string][]model.Row{}
	for _, collection := range collections {
		canonical[collection] = []model.Row{}
	}
	canonical["campaigns"] = []model.Row{{
		"id": "campaign:dependabot", "slug": "dependabot", "name": "Dependabot", "icon": "dependabot",
	}}
	canonical["repositories"] = []model.Row{{
		"id": "repository:fixture", "owner": "githubnext", "name": "gh-aw-cao", "fullName": "githubnext/gh-aw-cao",
	}}
	canonical["operationalValues"] = []model.Row{{
		"id": "operational-value:dependabot", "repositoryId": "repository:fixture", "repository": "githubnext/gh-aw-cao",
		"campaign": "dependabot", "valueId": "dependabot-vulnerability-alerts", "value": 2.0,
		"timestamp": "2026-09-24T10:00:00Z",
	}}
	definitions, err := loadDefinitions("../../../dashboard/site/src/data/queries/database.json")
	if err != nil {
		t.Fatal(err)
	}

	sources, err := projectSources(canonical, map[string]model.Source{}, definitions)
	if err != nil {
		t.Fatal(err)
	}

	rows := sources["operational-values"].Rows
	if len(rows) != 1 {
		t.Fatalf("expected one operational value row, got %#v", rows)
	}
	if rows[0]["campaign"] != "dependabot" || rows[0]["campaign-name"] != "Dependabot" {
		t.Fatalf("operational value row omitted campaign fields: %#v", rows[0])
	}
	if rows[0]["operational-value-definition"] != "dependabot-vulnerability-alerts" || rows[0]["operational-value"] != 2.0 {
		t.Fatalf("operational value row omitted metric fields: %#v", rows[0])
	}
}

func TestOperationalValuesProjectionReplacesInventoryRows(t *testing.T) {
	canonical := map[string][]model.Row{}
	for _, collection := range collections {
		canonical[collection] = []model.Row{}
	}
	inventory := map[string]model.Source{
		"operational-values": {
			Source: "operational-values",
			Rows: []model.Row{{
				"repository": "control-plane", "observed-at": "2026-09-23T18:05:00Z", "operational-value": 42,
			}},
			Metadata: model.Metadata{},
		},
	}
	definitions, err := loadDefinitions("../../../dashboard/site/src/data/queries/database.json")
	if err != nil {
		t.Fatal(err)
	}

	sources, err := projectSources(canonical, inventory, definitions)
	if err != nil {
		t.Fatal(err)
	}

	if rows := sources["operational-values"].Rows; len(rows) != 0 {
		t.Fatalf("expected canonical operational-values projection to replace inventory rows, got %#v", rows)
	}
}

func TestOperationalValueRelationshipErrorReportedOnce(t *testing.T) {
	canonical := map[string][]model.Row{}
	for _, collection := range collections {
		canonical[collection] = []model.Row{}
	}
	canonical["operationalValues"] = []model.Row{{
		"id": "operational-value:orphan", "repositoryId": "repository:missing",
	}}

	errors := relationshipErrors(canonical)
	if len(errors) != 1 {
		t.Fatalf("expected one relationship error, got %#v", errors)
	}
	if errors[0] != "operational-value:orphan.repositoryId does not reference an existing repository" {
		t.Fatalf("unexpected relationship error: %#v", errors)
	}
}

func TestSourceEvaluationTimeUsesLatestCanonicalOrSourceTimestamp(t *testing.T) {
	sources := map[string]model.Source{
		"runs": {
			Metadata: model.Metadata{"as-of": "2026-01-02T00:00:00Z"},
			Rows: []model.Row{
				{"started-at": "2026-01-03T00:00:00Z"},
				{"ended-at": "2026-01-04T12:30:00Z"},
			},
		},
	}

	if got := sourceEvaluationTime(sources).Format(time.RFC3339Nano); got != "2026-01-04T12:30:00Z" {
		t.Fatalf("got evaluatedAt %s", got)
	}
}

func TestValidateDiagnosticsRejectsInvalidStagingGeneration(t *testing.T) {
	if err := validateDiagnostics(model.Diagnostics{
		RelationshipErrors: []string{"session.runId does not reference an existing run"},
	}); err == nil {
		t.Fatal("relationship errors were accepted")
	}
	if err := validateDiagnostics(model.Diagnostics{
		DuplicateRecordIDs: map[string][]string{"runs": {"run-1"}},
	}); err == nil {
		t.Fatal("duplicate canonical IDs were accepted")
	}
	if err := validateDiagnostics(model.Diagnostics{
		DuplicateRecordIDs: map[string][]string{},
	}); err != nil {
		t.Fatalf("valid diagnostics were rejected: %v", err)
	}
}

func TestMergeLogicalReconcilesWorkflowIdentity(t *testing.T) {
	canonical := model.Source{
		Source: "workflows",
		Rows: []model.Row{{
			"organization": "githubnext",
			"repository":   "gh-aw-cao",
			"workflow":     ".github/workflows/dashboard.md",
			"campaign":     "dashboard",
			"observed-at":  "2026-09-22T00:00:00Z",
		}},
	}
	inventory := model.Source{
		Source: "workflows",
		Rows: []model.Row{{
			"organization":  "githubnext",
			"repository":    "gh-aw-cao",
			"workflow":      ".github/workflows/dashboard.md",
			"workflow-name": "Dashboard",
			"observed-at":   "2026-09-23T00:00:00Z",
		}},
	}

	merged := mergeLogical(inventory, canonical)

	if len(merged.Rows) != 1 {
		t.Fatalf("workflow identity was duplicated: %#v", merged.Rows)
	}
	if merged.Rows[0]["campaign"] != "dashboard" || merged.Rows[0]["workflow-name"] != "Dashboard" {
		t.Fatalf("workflow fields were not reconciled: %#v", merged.Rows[0])
	}
	if merged.Rows[0]["observed-at"] != "2026-09-23T00:00:00Z" {
		t.Fatalf("inventory observation did not win: %#v", merged.Rows[0])
	}
}

func scratchDirectory(t *testing.T) string {
	t.Helper()
	directory, err := os.MkdirTemp(".", ".test-data-")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.RemoveAll(directory) })
	return directory
}

func writeTestFile(t *testing.T, path string, content []byte) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(path), 0o750); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, content, 0o600); err != nil {
		t.Fatal(err)
	}
}
