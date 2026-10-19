import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import test from "node:test";
import { readJsonArchive } from "../../.github/skills/add-operational-value/scripts/json-archive.mjs";
import { scope } from "../../scripts/investigate-weekly-editors-health-check.mjs";

const report = readJsonArchive("docs/operational-value/proof/weekly-editors-health-check/investigation.json");

test("offline editor investigation preserves frozen source and complete inventory identity", () => {
  assert.deepEqual(report.scope, scope);
  assert.equal(report.outputHistory.index.repositoryId, scope.repositoryId);
  assert.equal(report.outputHistory.index.sourceRevision, scope.revision);
  assert.equal(report.outputHistory.index.until, scope.cutoff);
  assert.equal(report.outputHistory.index.complete, true);
  assert.equal(report.outputHistory.inspectedEntities, report.outputHistory.index.totalEntities);
  assert.equal(report.outputHistory.index.partitions.reduce((sum, part) => sum + part.count, 0),
    report.outputHistory.inspectedEntities);
  assert.equal(report.outputHistory.candidates.length, 18);
  assert.equal(new Set(report.outputHistory.candidates.map(row => row.id)).size, 18);
  assert.ok(report.outputHistory.candidates.every(row =>
    row.workflowReference.workflowId === scope.workflow && Date.parse(row.createdAt) < Date.parse(scope.cutoff)));
});

test("complete supplied source closure never turns Git API 200s into editor HTTP measurements", () => {
  assert.equal(report.readiness.function, "independent-function-verification-required");
  assert.equal(report.readiness.nativeHttpReceipts, 0);
  assert.equal(report.readiness.nativeOutcomeCount, null);
  assert.equal(report.readiness.historicalCoverage, "unknown");
  assert.equal(report.sources.length, 5);
  assert.equal(report.sources.filter(row => row.available).length, 5);
  assert.equal(report.inventoryHistory.filter(row => row.available).length, 12);
  assert.equal(report.adoption.compiled.available, true);
  assert.equal(report.readiness.sourceClosure, "complete-frozen-and-adoption-source-imports-and-inventory-history");
  assert.ok(report.pending.every(row => !row.endpoint.includes("/git/blobs/")));
  for (const row of report.sources.filter(row => !row.available)) {
    assert.equal(row.pendingEndpoint, `repos/${scope.repository}/git/blobs/${row.blob}`);
    assert.ok(row.missingReason.length > 0);
  }
  assert.ok(report.pending.every(row => row.approval === "required-before-network"));
  assert.ok(report.pending.every(row => !row.endpoint.includes("undefined")));
  assert.ok(report.pending.filter(row => row.attempt).every(row => row.attempt.includes("Unverified")));
  assert.equal(report.adoption.source.blob, "8031eea07e2c2e113d9c13703262b6b8db057725");
  assert.equal(report.adoption.predecessor, "");
  for (const row of [...report.sources, ...report.inventoryHistory].filter(row => row.available)) {
    const bytes = Buffer.from(row.content, "base64");
    assert.equal(createHash("sha256").update(bytes).digest("hex"), row.sha256);
    assert.equal(createHash("sha1").update(`blob ${bytes.length}\0`).update(bytes).digest("hex"), row.blob);
  }
});

test("retained investigation archive satisfies the portable per-file budget", () => {
  const file = "docs/operational-value/proof/weekly-editors-health-check/investigation.json";
  const raw = JSON.parse(readFileSync(file));
  for (const name of [file, ...(raw.parts ?? []).map(part =>
    `docs/operational-value/proof/weekly-editors-health-check/${part.file}`)]) {
    assert.ok(statSync(name).size <= 256 * 1024, name);
    assert.match(createHash("sha256").update(readFileSync(name)).digest("hex"), /^[a-f0-9]{64}$/);
  }
});

test("single authorized run listing retains exact provider body, actual headers and scope without HTTP outcomes", () => {
  const root = "docs/operational-value/proof/weekly-editors-health-check";
  const packet = readJsonArchive(`${root}/run-discovery-page-1.json`);
  const summary = readJsonArchive(`${root}/run-discovery-summary.json`);
  const body = Buffer.from(packet.originalBody, "base64");
  assert.equal(createHash("sha256").update(body).digest("hex"),
    "c1eecdb7c0e188847cecb0c510350892bcc3db24760d50cfb214fa830f6e54c3");
  assert.equal(body.length, 965207);
  assert.equal(packet.receipt.status, 200);
  assert.equal(packet.receipt.headers["x-ratelimit-remaining"], "14934");
  assert.equal(packet.receipt.attempts, 1);
  assert.equal(packet.receipt.additionalRequests, 0);
  assert.equal(packet.receipt.refusal, false);
  const provider = JSON.parse(body);
  assert.equal(provider.total_count, 79);
  assert.equal(provider.workflow_runs.length, 79);
  assert.equal(summary.discovery.totalCount, 79);
  assert.equal(summary.discovery.returnedCount, 79);
  assert.equal(summary.discovery.additionalRunsWithoutRetainedSeedOutputs, 61);
  assert.equal(summary.discovery.retainedCandidateRunCount, 18);
  assert.equal(summary.discovery.nextCursor, null);
  assert.equal(summary.discovery.link, null);
  assert.equal(summary.nextAcquisition.authorization, "not released");
  assert.equal(summary.nextAcquisition.exactEndpoints.length, 237);
  assert.equal(summary.nativeEvidence.originalHttpReceipts, 0);
  assert.equal(summary.nativeEvidence.acceptedNativeObservations, 0);
  assert.equal(summary.nativeEvidence.availableEditorCount, null);
  assert.equal(summary.nativeEvidence.failedEditorCount, null);
  assert.ok(summary.runs.every(run => run.repositoryId === scope.repositoryId
    && run.workflowId === 237095871 && run.runAttempt === 1
    && run.path === ".github/workflows/weekly-editors-health-check.lock.yml"));
});

test("all22 members of preceding closure remain lossless behind unchanged bounded codec", () => {
  const root = "docs/operational-value/proof/weekly-editors-health-check";
  const previous = readJsonArchive(`${root}/predecessor-closure-v018.json`);
  const bytes = Buffer.from(previous.content, "base64");
  assert.equal(createHash("sha256").update(bytes).digest("hex"),
    "e87be8f96431165719ffba42f4007ebaa16d050981046e29cc46e9960aa0c8ff");
  assert.equal(previous.manifest.members.length, 22);
  for (const member of previous.manifest.members) {
    const actual = execFileSync("tar", ["-xzOf", "-", member.path], { input: bytes, maxBuffer: 256 * 1024 });
    assert.equal(actual.length, member.bytes);
    assert.equal(createHash("sha256").update(actual).digest("hex"), member.sha256);
  }
});
