package postgresx

import (
	"encoding/json"
	"os"
	"os/exec"
	"path/filepath"
	"testing"

	"github.com/githubnext/gh-aw-cao/server/internal/model"
	"github.com/githubnext/gh-aw-cao/server/internal/query"
)

func TestAuditProjectionSharedFixtureRoundTrip(t *testing.T) {
	store, _ := nativeTestStore(t)
	root, err := filepath.Abs("../../..")
	if err != nil {
		t.Fatal(err)
	}
	command := exec.CommandContext(t.Context(), "node", "--input-type=module", "-e", `
import { readFileSync } from 'node:fs';
import { normalize } from './dashboard/site/src/data/normalize/index.js';
import { projectAuditEvidence } from './dashboard/site/src/data/model/audit-projection.js';
const fixture = JSON.parse(readFileSync('tests/fixtures/audit-projection.json', 'utf8'));
const batch = {...normalize([]),
  repositories:[{id:'repo',owner:'example',name:'project'}],
  workflows:[{id:'w',repositoryId:'repo',path:'.github/workflows/test.md'}],
  runs:[fixture.run], graders:[fixture.grader], graderObservations:[fixture.result],
  audits:fixture.audits.map((audit, sequence) => ({runId:'r',timestamp:fixture.clock,
    observedAt:fixture.clock,attempt:1,sequence,sourceSequence:sequence,
    payloadRef:'private-evidence#L1',provenance:{source:'gh-aw-logs',sourceId:audit.id,
    observedAt:fixture.clock},...audit}))};
console.log(JSON.stringify(projectAuditEvidence(batch)));`)
	command.Dir = root
	content, err := command.CombinedOutput()
	if err != nil {
		t.Fatalf("production projection fixture failed: %v\n%s", err, content)
	}
	var projection struct {
		Batch   map[string][]model.Row `json:"batch"`
		Receipt AuditProjectionReceipt `json:"receipt"`
	}
	if err := json.Unmarshal(content, &projection); err != nil {
		t.Fatal(err)
	}
	writer, err := store.BeginIngestion(t.Context())
	if err != nil {
		t.Fatal(err)
	}
	defer writer.Abort(t.Context())
	if err := writer.ObserveAuditProjection(&projection.Receipt); err != nil {
		t.Fatal(err)
	}
	for collection, rows := range projection.Batch {
		for _, row := range rows {
			if err := writer.Append(t.Context(), "$"+collection, row); err != nil {
				t.Fatalf("%s: %v", collection, err)
			}
		}
	}
	state, err := writer.Publish(t.Context(), "shared-information-fixture")
	if err != nil {
		t.Fatal(err)
	}
	if state.Counts["$audits"] != 5 {
		t.Fatalf("independent evidence count changed: %+v", state.Counts)
	}
	definitionBytes, err := os.ReadFile(filepath.Join(root, "dashboard/site/src/data/queries/database.json"))
	if err != nil {
		t.Fatal(err)
	}
	var definitions []query.Definition
	if err := json.Unmarshal(definitionBytes, &definitions); err != nil {
		t.Fatal(err)
	}
	sources, _, err := store.ExecuteSQLPlan(t.Context(), definitions, []string{"runs", "grader-observations"})
	if err != nil {
		t.Fatal(err)
	}
	result := sources["grader-observations"].Rows[0]
	if result["status"] != "unavailable" || result["value"] != nil || result["error"] != "Missing runtime helper" ||
		result["unit"] != "historical-unit" || result["current-definition-unit"] != "new-unit" {
		t.Fatalf("result information did not round-trip through hosted queries: %+v", result)
	}
	if value, present := result["direction"]; !present || value != nil {
		t.Fatalf("recorded null became unrecorded or current metadata: %+v", result)
	}
	if _, present := result["audit-id"]; present {
		t.Fatal("absorbed Audit backlink survived publication")
	}
	if sources["runs"].Rows[0]["session-label"] != "Pi/copilot/gpt-5.4" {
		t.Fatal("session display text was lost")
	}
}

func TestInformationProjectionReceiptAndUnknownChildFields(t *testing.T) {
	writer := &Writer{}
	receipt := &AuditProjectionReceipt{Version: 1, InputAudits: 2, RepresentedAudits: 1, ResidualAudits: 1}
	if err := writer.ObserveAuditProjection(receipt); err != nil {
		t.Fatal(err)
	}
	conflict := *receipt
	conflict.SourceClock = "2026-10-07T12:00:00Z"
	if err := writer.ObserveAuditProjection(&conflict); err == nil {
		t.Fatal("inconsistent cross-shard receipt accepted")
	}
	for _, source := range []string{"$runs", "$graderObservations", "$issues"} {
		field := "auditEvidence"
		if source == "$runs" {
			field = "behaviorEvidence"
		}
		if err := validateInformationObjects(source, model.Row{field: model.Row{"unrecorded": nil}}); err == nil {
			t.Fatalf("%s silently lost unknown explicit-null attribution", source)
		}
	}
}
