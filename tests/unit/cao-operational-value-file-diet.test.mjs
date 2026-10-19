import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { newlineCount, readProof, verifyProof, writeProof, writeReports } from "../../scripts/prove-file-diet-operational-value.mjs";
import { readCensusJson, writeCensusJson } from "../../scripts/operational-value-census-io.mjs";
import { acceptedRefactor, collectBatch, collectProof, definition, eligiblePath, scoreMetric } from "../fixtures/operational-value-proof/file-diet.mjs";

const root = path.resolve(import.meta.dirname, "../..");
const file = path.join(root, "docs/operational-value/proof/file-diet.json.gz");
const windows = proof => proof.snapshots.map(item => ({
  windowStart: new Date(Date.parse(item.endAt) - 7 * 86_400_000).toISOString(),
  windowEnd: item.endAt, observedAt: proof.observedAt,
}));
const accepted = () => ({
  creatorVerified: true, historyComplete: true, completed: true, merged: true,
  closingPullRequests: [{ id: "PR_accepted", mergedAt: "2026-09-26T10:16:09Z" }],
  gates: { size: true, tests: true, lint: true, build: true, coverage: true, publicApi: true },
});

test("File Diet counts source-defined newline boundaries, not reports, test files or agent verdicts", () => {
  const evidence = { valid: true, coverageStatus: "complete", eligibleCount: 3, lineCounts: [799, 800, 801] };
  assert.equal(scoreMetric("oversized", evidence), 2);
  assert.equal(scoreMetric("oversized", { ...evidence, eligibleCount: 0, lineCounts: [] }), 0);
  for (const lineCounts of [[null, 800, 801], [-1, 800, 801], [1.5, 800, 801], [800]]) {
    assert.equal(scoreMetric("oversized", { ...evidence, lineCounts }), null);
  }
  assert.equal(scoreMetric("oversized", { ...evidence, coverageStatus: "partial" }), null);
  assert.equal(scoreMetric("oversized", { reports: 100, passed: true }), null);
  assert.equal(scoreMetric("unknown", evidence), null);
  for (const name of ["pkg/cli/main.go", "pkg/generated/generated.go"]) assert.equal(eligiblePath(name), true);
  for (const name of ["pkg/main_test.go", "cmd/main.go", "pkg/main.js", null]) assert.equal(eligiblePath(name), false);
  for (const text of ["", "last line", "a\nlast line", "a\r\nb\r\n", "\n\n"]) {
    const bytes = Buffer.from(text);
    assert.equal(newlineCount(bytes), Number(execFileSync("wc", ["-l"], { input: bytes, encoding: "utf8" }).trim()));
  }
});

test("all five real inventories and seven authoritative issue receipts support reproducible native values", async () => {
  const proof = verifyProof(readProof(file));
  assert.equal(proof.acquisition.uniqueBlobs, 2845);
  assert.equal(proof.acquisition.requests, 32);
  assert.equal(proof.candidates.length, 7);
  assert.ok(proof.candidates.every(item => item.creatorVerified && item.correctTarget
    && item.graph.stateReason === "NOT_PLANNED" && item.closingPullRequests.length === 0));
  const results = await collectBatch(windows(proof));
  assert.deepEqual(results.map(item => scoreMetric("oversized", item.evidence)), [40, 42, 45, 49, 53]);
  assert.deepEqual(results.map(item => scoreMetric("correct-issues", item.evidence)), [0, 2, 2, 2, 1]);
  assert.deepEqual(results.map(item => scoreMetric("accepted-refactors", item.evidence)), [0, 0, 0, 0, 0]);
  const related = proof.candidates.flatMap(item => item.relatedPullRequests);
  assert.equal(related.length, 1);
  assert.equal(related[0].number, 64854);
  assert.equal(related[0].mergedAt, null);
  assert.equal(related[0].targetLinesAfter, 370);
  assert.deepEqual(related[0].newGoFiles.map(item => item.lines), [331, 147, 226, 181]);
});

test("independent structural measurements survive missing attribution while contribution diagnostics abstain", () => {
  const proof = readProof(file);
  for (const mutate of [
    copy => { copy.discovery.complete = false; },
    copy => { copy.candidates[0].creatorVerified = false; },
    copy => { copy.candidates[0].historyComplete = false; },
    copy => { copy.candidates[0].graph.closingLinksComplete = false; },
  ]) {
    const copy = structuredClone(proof);
    mutate(copy);
    const results = collectProof(copy, windows(copy));
    assert.deepEqual(results.map(item => scoreMetric("oversized", item.evidence)), [40, 42, 45, 49, 53]);
    assert.ok(results.every(item => scoreMetric("accepted-refactors", item.evidence) === null
      && scoreMetric("correct-issues", item.evidence) === null));
  }
  const missing = collectProof(proof, [{ windowEnd: "2000-01-01T00:00:00Z" }])[0];
  assert.equal(scoreMetric("oversized", missing.evidence), null);
  assert.throws(() => collectProof(proof, [{ repository: "another/repo" }]), /outside File Diet scope/);
});

test("a suggestion, closure or proposed split cannot replace a merged refactor and every independent safeguard", () => {
  assert.equal(acceptedRefactor(accepted()), true);
  for (const key of ["size", "tests", "lint", "build", "coverage", "publicApi"]) {
    const failed = accepted();
    failed.gates[key] = false;
    assert.equal(acceptedRefactor(failed), false);
    delete failed.gates[key];
    assert.equal(acceptedRefactor(failed), null);
  }
  for (const closingPullRequests of [null, [null], [{ id: "PR_accepted" }], [accepted().closingPullRequests[0], accepted().closingPullRequests[0]]]) {
    assert.equal(acceptedRefactor({ ...accepted(), closingPullRequests }), null);
  }
  assert.equal(acceptedRefactor({ ...accepted(), closingPullRequests: [] }), false);
  assert.equal(acceptedRefactor({ ...accepted(), closingPullRequests: [{ id: "PR_accepted", mergedAt: null }] }), false);
  assert.equal(acceptedRefactor({ ...accepted(), completed: false }), false);
  assert.equal(acceptedRefactor({ ...accepted(), gates: null }), null);
  assert.equal(acceptedRefactor({ ...accepted(), creatorVerified: false }), null);
});

test("completed deliveries are counted once per target and merge revision in non-overlapping periods", () => {
  const proof = readProof(file);
  Object.assign(proof.candidates[0], accepted());
  Object.assign(proof.candidates[1], accepted());
  const results = collectProof(proof, windows(proof));
  assert.deepEqual(results.map(item => scoreMetric("accepted-refactors", item.evidence)), [0, 0, 1, 0, 0]);
  proof.candidates[0].gates = null;
  assert.equal(scoreMetric("accepted-refactors", collectProof(proof, windows(proof))[2].evidence), null);
});

test("tampered inventories, receipts, target claims, run identities and downstream proposal counts fail closed", () => {
  for (const mutate of [
    copy => { copy.inventories[copy.snapshots[0].commit].files[0].lines++; },
    copy => { copy.candidates[0].receipt.content += " "; },
    copy => { copy.candidates[0].correctTarget = false; },
    copy => { copy.candidates[0].runValidation.executionPath = ".github/workflows/other.lock.yml"; },
    copy => { copy.candidates.find(item => item.relatedPullRequests.length).relatedPullRequests[0].targetLinesAfter++; },
  ]) {
    const copy = readProof(file);
    mutate(copy);
    assert.throws(() => verifyProof(copy));
  }
});

test("digest-linked evidence replays through production reporting without oversized artifacts or invented ROI", () => {
  const proof = readProof(file);
  const temporary = mkdtempSync(path.join(os.tmpdir(), "file-diet-proof-test-"));
  try {
    const roundtrip = path.join(temporary, "proof.json.gz");
    writeProof(roundtrip, proof);
    assert.deepEqual(verifyProof(readProof(roundtrip)).snapshots, proof.snapshots);
    const outputs = writeReports(proof, temporary);
    const timeline = JSON.parse(readFileSync(outputs.timeline, "utf8"));
    assert.deepEqual(timeline.snapshots.map(item => item.metrics.oversized), [40, 42, 45, 49, 53]);
    assert.equal(timeline.valueReview.decision.status, "not-rated");
    assert.equal(timeline.valueReview.cost.status, "not-measured");
    for (const name of [outputs.timeline, outputs.markdown, path.join(temporary, "file-diet-observations.json")]) {
      assert.ok(readFileSync(name).length < 256 * 1024, `${name} exceeds repository file budget`);
    }
    execFileSync(process.execPath, [
      path.join(root, ".github/skills/add-operational-value/scripts/verify-value-function.mjs"),
      "--collector", path.join(root, "tests/fixtures/operational-value-proof/file-diet.mjs"),
    ], { stdio: "pipe" });
    const index = readCensusJson(roundtrip);
    const part = path.join(temporary, index.inventoryPartitions[0].file);
    const data = readCensusJson(part);
    data.files[0].lines++;
    writeCensusJson(part, data);
    assert.throws(() => readProof(roundtrip), /partition digest mismatch/);
    assert.equal(definition.evidence.measurementKind, "snapshot");
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
});
