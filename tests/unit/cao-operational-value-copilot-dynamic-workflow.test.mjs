import assert from "node:assert/strict";
import { existsSync, readFileSync, renameSync } from "node:fs";
import { createHash } from "node:crypto";
import { test } from "node:test";
import {
  copilotDynamicWorkflowModule, dynamicEvidenceDirectory, scoreDynamicWorkflow, verifyDynamicProjection,
} from "../../scripts/copilot-dynamic-workflow-value.mjs";
import {
  classifyDynamicSelection, validateRunInventory,
} from "../../scripts/collect-copilot-dynamic-workflow-value.mjs";
import { censusDigest, readCensusJson } from "../../scripts/operational-value-census-io.mjs";

const projection = () => ({
  authority: "protected-native-runtime", sourceProfileSha256: "a".repeat(64),
  protectedReceiptSha256: "b".repeat(64), packageSha256: "c".repeat(64),
  workflowRunId: "native-run", workflowName: "smoke-copilot-dynamic-workflow",
  attempt: 1, status: "completed", consumedSubagents: 1,
  subagents: [{ invocationId: "child-1", workflowRunId: "native-run", name: "smoke-marker",
    status: "completed", cancelled: false }],
  resultRunId: "native-run",
  result: { status: "PASS", marker: "GH_AW_DYNAMIC_WORKFLOW_SMOKE_OK", packageVersion: 1,
    supportFile: "support/.fixture.json", subagents: 1 },
});
const binding = { sourceProfileSha256: "a".repeat(64), packageSha256: "c".repeat(64) };

test("exact fixture text without native invocation never establishes dynamic capability", () => {
  assert.equal(verifyDynamicProjection(projection().result, binding), null);
  for (const field of ["authority", "protectedReceiptSha256", "sourceProfileSha256", "packageSha256", "workflowRunId"]) {
    const row = projection();
    delete row[field];
    assert.equal(verifyDynamicProjection(row, binding), null, field);
  }
  assert.equal(verifyDynamicProjection(projection(), { ...binding, packageSha256: "d".repeat(64) }), null);
  assert.equal(verifyDynamicProjection(projection(), { ...binding, sourceProfileSha256: "d".repeat(64) }), null);
});

test("native partial completion survives unknown exact-result acceptance", () => {
  const row = projection();
  assert.deepEqual(verifyDynamicProjection(row, binding), { invocation: true, fullAcceptance: true });
  row.resultRunId = "another-run";
  assert.deepEqual(verifyDynamicProjection(row, binding), { invocation: true, fullAcceptance: null });
  row.subagents[0].workflowRunId = "another-run";
  assert.equal(verifyDynamicProjection(row, binding), null);
});

test("all five exact fields and one completed correlated child are required", () => {
  for (const field of Object.keys(projection().result)) {
    const row = projection();
    row.result[field] = "incorrect";
    assert.equal(verifyDynamicProjection(row, binding).fullAcceptance, null, field);
  }
  const row = projection();
  row.result.extra = true;
  assert.equal(verifyDynamicProjection(row, binding).fullAcceptance, null);
  row.consumedSubagents = 2;
  assert.equal(verifyDynamicProjection(row, binding), null);
});

test("unknown never becomes zero and complete fixture evidence cannot bypass invocation", () => {
  const row = { valid: true, assessments: [{ id: "one", invocation: null, fullAcceptance: null }] };
  assert.equal(scoreDynamicWorkflow("verified-invocations", row), null);
  assert.equal(scoreDynamicWorkflow("full-acceptance", row), null);
  row.assessments.push({ id: "two", invocation: true, fullAcceptance: null });
  assert.equal(scoreDynamicWorkflow("verified-invocations", row), 1);
  assert.equal(scoreDynamicWorkflow("full-acceptance", row), null);
  row.assessments[0].fullAcceptance = true;
  assert.equal(scoreDynamicWorkflow("verified-invocations", row), null);
});

test("complete inventories reject missing pages, duplicate identities and foreign workflow paths", () => {
  const run = { id: 1, run_attempt: 1, head_sha: "a".repeat(40), path: "workflow.yml",
    created_at: "2026-10-07T00:00:00Z" };
  assert.deepEqual(validateRunInventory({ total_count: 1, workflow_runs: [run] }, "workflow.yml"), [run]);
  assert.throws(() => validateRunInventory({ total_count: 2, workflow_runs: [run] }, "workflow.yml"));
  assert.throws(() => validateRunInventory({ total_count: 2, workflow_runs: [run, run] }, "workflow.yml"));
  assert.throws(() => validateRunInventory({ total_count: 1, workflow_runs: [run] }, "other.yml"));
});

test("protected skipped caller receipts are ineligible, empty job lists remain unknown", () => {
  const jobs = { status: "available", value: { jobs: [] } };
  assert.equal(classifyDynamicSelection("caller.yml", jobs), "unknown-reusable-branch");
  jobs.value.jobs.push({ name: "call-smoke-copilot-dynamic-workflow", status: "completed", conclusion: "skipped",
    completed_at: "2026-10-14T18:00:00Z" });
  assert.equal(classifyDynamicSelection("caller.yml", jobs), "protected-caller-skipped");
});

test("actual retained acquisition replays all candidates and fails closed if a partition disappears", () => {
  const contract = readCensusJson(`${dynamicEvidenceDirectory}/contract.json`);
  const index = readCensusJson(`${dynamicEvidenceDirectory}/index.json`);
  assert.equal(index.contractSha256, censusDigest(contract));
  assert.equal(index.candidateAttempts, 50);
  assert.equal(index.confirmedIneligible, 43);
  assert.equal(index.unresolvedSelection, 7);
  assert.equal(index.directRuns, 0);
  assert.equal(index.measured, false);
  assert.equal(index.historicalCallerReview.complete, true);
  assert.equal(index.historicalCallerReview.uniqueSourceVersions, 729);
  assert.equal(index.sourceGaps.length, 0);
  for (const source of index.sourceArchive) {
    const retained = readCensusJson(`${dynamicEvidenceDirectory}/sources/${source.gitBlob}.json.gz`);
    assert.equal(censusDigest(retained), source.sha256);
    const bytes = Buffer.from(retained.content, "base64");
    assert.equal(createHash("sha1").update(`blob ${bytes.length}\0`).update(bytes).digest("hex"), source.gitBlob);
  }
  const module = copilotDynamicWorkflowModule(contract);
  const windows = [{ windowStart: contract.adoption.adoptedAt, windowEnd: contract.until, observedAt: contract.until }];
  const [result] = module.collectBatch(windows);
  assert.equal(module.scoreMetric("verified-invocations", result.evidence), null);
  assert.equal(result.evidence.candidateAttempts, 50);
  assert.equal(result.evidence.eligibleCount, null);
  assert.ok(result.provenance.some(row => row.kind === "copilot-dynamic-runtime-evidence-index"));
  const file = `${dynamicEvidenceDirectory}/${index.partitions[0].file}`, temporary = `${file}.test-hidden`;
  assert.ok(existsSync(file));
  assert.ok(readFileSync(file).length > 0);
  renameSync(file, temporary);
  try { assert.throws(() => module.collectBatch(windows), /ENOENT/); }
  finally { renameSync(temporary, file); }
  const sourceFile = `${dynamicEvidenceDirectory}/sources/${index.sourceArchive[0].gitBlob}.json.gz`;
  const hiddenSource = `${sourceFile}.test-hidden`;
  renameSync(sourceFile, hiddenSource);
  try { assert.throws(() => module.collectBatch(windows), /ENOENT/); }
  finally { renameSync(hiddenSource, sourceFile); }
});

test("partitioned predecessor replays the exact original tar and fails closed on a missing part", () => {
  const analysis = readCensusJson(`${dynamicEvidenceDirectory}/source-analysis.json`);
  const file = `${dynamicEvidenceDirectory}/${analysis.versionPreservation.predecessor}`;
  const envelope = readCensusJson(file);
  assert.equal(envelope.schemaVersion, 1);
  assert.equal(envelope.kind, "preserved-native-value-tar");
  assert.equal(envelope.encoding, "base64");
  const bytes = Buffer.from(envelope.contentBase64, "base64");
  const originalSha256 = "b18e5c95dedba5d50845215ad89d37dd21c6595fdb971b8852ec0280eb205316";
  assert.equal(bytes.toString("base64"), envelope.contentBase64);
  assert.equal(bytes.length, 6534421);
  assert.equal(envelope.archiveBytes, bytes.length);
  assert.equal(envelope.archiveSha256, originalSha256);
  assert.equal(createHash("sha256").update(bytes).digest("hex"), originalSha256);
  assert.equal(analysis.versionPreservation.decodedTarSha256, originalSha256);
  const manifest = JSON.parse(readFileSync(file, "utf8"));
  assert.equal(manifest.kind, "partitioned-census-json");
  assert.equal(manifest.parts.length, 45);
  for (const part of manifest.parts) {
    assert.ok(readFileSync(`${dynamicEvidenceDirectory}/versions/${part.file}`).length <= 256 * 1024);
  }
  const first = `${dynamicEvidenceDirectory}/versions/${manifest.parts[0].file}`, temporary = `${first}.test-hidden`;
  renameSync(first, temporary);
  try { assert.throws(() => readCensusJson(file), /ENOENT/); }
  finally { renameSync(temporary, first); }
});
