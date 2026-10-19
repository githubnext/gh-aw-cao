import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { readProof, replayParser, verifyProof, writeProof, writeReports } from "../../scripts/prove-workflow-operational-value.mjs";
import { collectBatch, collectProof, definition, scoreMetric, study } from "../fixtures/operational-value-proof/rendering.mjs";

const root = path.resolve(import.meta.dirname, "../..");
const file = path.join(root, "docs/operational-value/proof/rendering.json.gz");
const windows = proof => proof.snapshots.map(item => ({
  windowStart: new Date(Date.parse(item.endAt) - 7 * 86_400_000).toISOString(),
  windowEnd: item.endAt, observedAt: proof.observedAt,
}));

test("a real provider failure is repaired by the original workflow patch and remains repaired across five immutable weekly revisions", () => {
  const proof = verifyProof(readProof(file));
  assert.equal(proof.study.workflow, "daily-rendering-scripts-verifier");
  assert.equal(proof.pullRequest.originalParent, proof.producer.head_sha);
  assert.equal(proof.connection.creatorVerified, true);
  assert.deepEqual(proof.snapshots.map(item => [item.rendered, item.normalized]), [
    [false, false], [true, true], [true, true], [true, true], [true, true],
  ]);
  assert.equal(proof.repair.before.result.rendered, false);
  assert.equal(proof.repair.original.result.rendered, true);
  assert.equal(proof.repair.merged.result.rendered, true);
});

test("the real function measures actor-independent conformance and credits the delivered fix exactly once, not once per surviving snapshot", async () => {
  const proof = readProof(file);
  const requests = windows(proof);
  const results = await collectBatch(requests);
  assert.deepEqual(results.map(item => scoreMetric("conformance", item.evidence)), [0, 100, 100, 100, 100]);
  assert.deepEqual(results.map(item => scoreMetric("linked-repairs", item.evidence)), [0, 1, 0, 0, 0]);
  const noCreator = structuredClone(proof);
  noCreator.connection.creatorVerified = false;
  const independent = collectProof(noCreator, requests);
  assert.deepEqual(independent.map(item => scoreMetric("conformance", item.evidence)), [0, 100, 100, 100, 100]);
  assert.deepEqual(independent.map(item => scoreMetric("linked-repairs", item.evidence)), [null, null, null, null, null]);
  const missing = collectProof(proof, [{ ...requests[0], windowEnd: "2025-01-01T00:00:00Z" }])[0];
  assert.equal(scoreMetric("conformance", missing.evidence), null);
  assert.throws(() => collectProof(proof, [{ ...requests[0], repository: "other/repo" }]), /outside this proof/);
});

test("acceptance requires preserved error semantics in both layers, not output, a merge or an agent success claim", () => {
  const evidence = structuredClone(definition.validationExamples.targetAttained);
  for (const field of ["rendered", "normalized"]) {
    const broken = structuredClone(evidence);
    broken.cases[0][field] = false;
    assert.equal(scoreMetric("conformance", broken), 0);
    assert.equal(scoreMetric("linked-repairs", broken), 0);
  }
  assert.equal(scoreMetric("conformance", { merged: true, success: true, reports: 100 }), null);
  assert.equal(scoreMetric("conformance", { ...evidence, eligibleCount: 0 }), null);
  assert.equal(scoreMetric("conformance", { ...evidence, coverageStatus: "partial" }), null);
  assert.equal(scoreMetric("unknown", evidence), null);
});

test("tampered source, creation receipt, run identity or claimed replay results fail closed", () => {
  const proof = readProof(file);
  const node = structuredClone(proof);
  node.pullRequest.nodeId = "unrelated";
  assert.throws(() => verifyProof(node), /unrelated/);
  const run = structuredClone(proof);
  run.producer.path = ".github/workflows/unrelated.lock.yml";
  assert.throws(() => verifyProof(run), /identity.*mismatch/i);
  const source = structuredClone(proof);
  const id = source.repair.original.files["parse_pi_log.cjs"];
  source.sources[id].content += "\n";
  assert.throws(() => replayParser(source, source.repair.original), /digest mismatch/i);
  const result = structuredClone(proof);
  result.snapshots[0].result.rendered = true;
  assert.throws(() => verifyProof(result), /Replay differs/);
});

test("the real evidence replays offline into the production timeline and Markdown report with no invented keep recommendation", () => {
  const proof = readProof(file);
  const temporary = mkdtempSync(path.join(os.tmpdir(), "workflow-value-proof-test-"));
  try {
    const roundtrip = path.join(temporary, "proof.json.gz");
    writeProof(roundtrip, proof);
    assert.deepEqual(verifyProof(readProof(roundtrip)).snapshots, proof.snapshots);
    const outputs = writeReports(proof, temporary);
    const timeline = JSON.parse(readFileSync(outputs.timeline, "utf8"));
    assert.deepEqual(timeline.snapshots.map(item => item.metrics), [
      { conformance: 0, "linked-repairs": 0 }, { conformance: 100, "linked-repairs": 1 },
      { conformance: 100, "linked-repairs": 0 }, { conformance: 100, "linked-repairs": 0 },
      { conformance: 100, "linked-repairs": 0 },
    ]);
    assert.equal(timeline.valueReview.decision.status, "not-rated");
    assert.equal(timeline.valueReview.cost.status, "not-measured");
    const markdown = readFileSync(outputs.markdown, "utf8");
    assert.equal(JSON.parse(markdown.split("\n").find(line => line.startsWith("title: ")).slice(7)),
      `What ${definition.workflowName} measures`);
    assert.match(markdown, /One fixed, independently acquired/);
    execFileSync(process.execPath, [
      path.join(root, ".github/skills/add-operational-value/scripts/verify-value-function.mjs"),
      "--collector", path.join(root, "tests/fixtures/operational-value-proof/rendering.mjs"),
    ], { stdio: "pipe" });
    assert.equal(study.repository, "github/gh-aw");
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
});
