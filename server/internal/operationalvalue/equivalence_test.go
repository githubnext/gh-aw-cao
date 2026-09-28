package operationalvalue

import (
	"bytes"
	"context"
	"encoding/json"
	"os"
	"os/exec"
	"path/filepath"
	"reflect"
	"testing"
	"time"
)

const adapter = `
const chunks = [];
for await (const chunk of process.stdin) chunks.push(chunk);
const request = JSON.parse(Buffer.concat(chunks).toString());
console.log(JSON.stringify({
  kind: "operational_value_definition",
  workflowSlug: "example-worker",
  adoptedAt: "2026-09-15T23:30:36Z",
  evaluationMode: "baseline-comparable",
  cadenceDays: 1,
  repositories: ["githubnext/gh-aw-cao"],
  valueIds: ["example-worker.current"]
}));
console.log(JSON.stringify({
  timestamp: request.timestamp,
  repository: request.repositories[0],
  valueId: "example-worker.current",
  value: 3,
  metricRole: "primary",
  metricName: "Current value",
  metricUnit: "items",
  metricDirection: "decrease",
  maturityStatus: "matured",
  adoptionAt: "2026-09-15T23:30:36Z",
  evaluationMode: "baseline-comparable",
  workflowSlug: "example-worker",
  workflowName: "Example Worker",
  rollupNumerator: 3,
  rollupDenominator: 1
}));
`

func TestGoCollectorMatchesActivityCollector(t *testing.T) {
	root := repositoryRoot(t)
	temporary := t.TempDir()
	packages := filepath.Join(temporary, "packages")
	campaign := filepath.Join(packages, "example")
	if err := os.MkdirAll(campaign, 0o750); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(campaign, "operational-value.mjs"), []byte(adapter), 0o600); err != nil {
		t.Fatal(err)
	}
	nodeOutput := filepath.Join(temporary, "node.jsonl")
	goOutput := filepath.Join(temporary, "go.jsonl")
	for _, output := range []string{nodeOutput, goOutput} {
		writeRetainedFixture(t, output)
	}
	observedAt, err := time.Parse(time.RFC3339, "2026-09-24T10:00:00Z")
	if err != nil {
		t.Fatal(err)
	}
	node := exec.CommandContext( // #nosec G204 -- fixed Node binary and test-owned temporary paths.
		t.Context(),
		"node", filepath.Join(root, "activity", "cao.mjs"),
		"operational-value",
		"--database", filepath.Join(temporary, "activity.sqlite"),
		"--root", packages,
		"--output", nodeOutput,
		"--timestamp", observedAt.Format(time.RFC3339),
		"--repository", "githubnext/gh-aw-cao",
		"--retention-days", "30",
		"--history-campaign", "example",
	)
	node.Dir = root
	node.Env = testEnvironment()
	if output, err := node.CombinedOutput(); err != nil {
		t.Fatalf("Activity collector failed: %v\n%s", err, output)
	}

	result, err := Collect(context.Background(), Config{
		Root: packages, Database: filepath.Join(temporary, "activity.sqlite"),
		Output: goOutput, ObservedAt: observedAt,
		Repositories:    []string{"githubnext/gh-aw-cao"},
		HistoryCampaign: "example", Retention: 30 * day,
		NodeBinary: "node", Environment: testEnvironment(),
	})
	if err != nil {
		t.Fatal(err)
	}
	if len(result.Warnings) != 0 {
		t.Fatalf("Go collector warnings: %v", result.Warnings)
	}
	if result.HistoryValues != 12 {
		t.Fatalf("history values = %d, want 12", result.HistoryValues)
	}
	nodeRecords := readJSONL(t, nodeOutput)
	goRecords := readJSONL(t, goOutput)
	if !reflect.DeepEqual(goRecords, nodeRecords) {
		t.Fatalf("Go and Activity collectors differ:\nGo:   %#v\nNode: %#v", goRecords, nodeRecords)
	}

	repeated, err := Collect(context.Background(), Config{
		Root: packages, Database: filepath.Join(temporary, "activity.sqlite"),
		Output: goOutput, ObservedAt: observedAt,
		Repositories:    []string{"githubnext/gh-aw-cao"},
		HistoryCampaign: "example", Retention: 30 * day,
		NodeBinary: "node", Environment: testEnvironment(),
	})
	if err != nil {
		t.Fatal(err)
	}
	if repeated.HistoryValues != 0 {
		t.Fatalf("repeat history values = %d, want 0", repeated.HistoryValues)
	}
}

func TestGoCollectorMatchesActivityHistoryFailure(t *testing.T) {
	root := repositoryRoot(t)
	temporary := t.TempDir()
	packages := filepath.Join(temporary, "packages")
	campaign := filepath.Join(packages, "example")
	if err := os.MkdirAll(campaign, 0o750); err != nil {
		t.Fatal(err)
	}
	script := `
const chunks = [];
for await (const chunk of process.stdin) chunks.push(chunk);
const request = JSON.parse(Buffer.concat(chunks).toString());
if (process.env.CAO_OPERATIONAL_VALUE_MODULE === "first-worker") {
  console.error("injected history failure");
  process.exit(1);
}
for (const slug of ["first-worker", "second-worker"]) {
  console.log(JSON.stringify({
    kind: "operational_value_definition",
    workflowSlug: slug,
    adoptedAt: "2026-09-15T23:30:36Z",
    evaluationMode: "baseline-comparable",
    cadenceDays: 1,
    repositories: ["githubnext/gh-aw-cao"],
    valueIds: [slug + ".current"]
  }));
  console.log(JSON.stringify({
    timestamp: request.timestamp,
    repository: request.repositories[0],
    valueId: slug + ".current",
    value: 3
  }));
}
`
	if err := os.WriteFile(filepath.Join(campaign, "operational-value.mjs"), []byte(script), 0o600); err != nil {
		t.Fatal(err)
	}
	nodeOutput := filepath.Join(temporary, "node-failure.jsonl")
	goOutput := filepath.Join(temporary, "go-failure.jsonl")
	observedAt, err := time.Parse(time.RFC3339, "2026-09-24T10:00:00Z")
	if err != nil {
		t.Fatal(err)
	}
	node := exec.CommandContext( // #nosec G204 -- fixed Node binary and test-owned temporary paths.
		t.Context(),
		"node", filepath.Join(root, "activity", "cao.mjs"),
		"operational-value",
		"--database", filepath.Join(temporary, "activity.sqlite"),
		"--root", packages,
		"--output", nodeOutput,
		"--timestamp", observedAt.Format(time.RFC3339),
		"--repository", "githubnext/gh-aw-cao",
		"--retention-days", "30",
		"--history-campaign", "example",
	)
	node.Dir = root
	node.Env = testEnvironment()
	if output, err := node.CombinedOutput(); err != nil {
		t.Fatalf("Activity collector failed: %v\n%s", err, output)
	}
	result, err := Collect(context.Background(), Config{
		Root: packages, Database: filepath.Join(temporary, "activity.sqlite"),
		Output: goOutput, ObservedAt: observedAt,
		Repositories:    []string{"githubnext/gh-aw-cao"},
		HistoryCampaign: "example", Retention: 30 * day,
		NodeBinary: "node", Environment: testEnvironment(),
	})
	if err != nil {
		t.Fatal(err)
	}
	if len(result.Warnings) != 1 {
		t.Fatalf("Go collector warnings = %v, want one history failure", result.Warnings)
	}
	if result.HistoryValues != 0 {
		t.Fatalf("history values = %d, want 0", result.HistoryValues)
	}
	if !reflect.DeepEqual(readJSONL(t, goOutput), readJSONL(t, nodeOutput)) {
		t.Fatal("Go and Activity collectors differ after a history adapter failure")
	}
}

func writeRetainedFixture(t *testing.T, path string) {
	t.Helper()
	content := `{"schema_version":2,"kind":"operational_value","operational_value":{"timestamp":"2026-09-21T10:00:00.000Z","repository":"githubnext/gh-aw-cao","campaign":"example","campaign_id":"campaign:example","value_id":"example-worker.retired","value":1,"metric_role":"primary","metric_name":"retired","metric_direction":"increase","maturity_status":"matured"}}
{"schema_version":2,"kind":"operational_value","operational_value":{"timestamp":"2026-09-21T10:00:00.000Z","repository":"githubnext/gh-aw-cao","campaign":"unrelated","campaign_id":"campaign:unrelated","value_id":"preserved","value":4,"metric_role":"primary","metric_name":"preserved","metric_direction":"increase","maturity_status":"matured"}}
`
	if err := os.WriteFile(path, []byte(content), 0o600); err != nil {
		t.Fatal(err)
	}
}

func readJSONL(t *testing.T, path string) []map[string]any {
	t.Helper()
	content, err := os.ReadFile(path) // #nosec G304 -- test-owned temporary path.
	if err != nil {
		t.Fatal(err)
	}
	records := make([]map[string]any, 0, bytes.Count(content, []byte{'\n'}))
	for _, line := range bytesLines(content) {
		var record map[string]any
		if err := json.Unmarshal(line, &record); err != nil {
			t.Fatal(err)
		}
		records = append(records, record)
	}
	return records
}

func bytesLines(content []byte) [][]byte {
	var lines [][]byte
	start := 0
	for index, value := range content {
		if value == '\n' {
			if index > start {
				lines = append(lines, content[start:index])
			}
			start = index + 1
		}
	}
	return lines
}

func repositoryRoot(t *testing.T) string {
	t.Helper()
	root, err := filepath.Abs(filepath.Join("..", "..", ".."))
	if err != nil {
		t.Fatal(err)
	}
	return root
}

func testEnvironment() []string {
	return []string{
		"PATH=" + os.Getenv("PATH"),
		"HOME=" + os.Getenv("HOME"),
		"LANG=" + os.Getenv("LANG"),
	}
}
