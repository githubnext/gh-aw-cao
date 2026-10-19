import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { readJson } from "../../.github/skills/add-operational-value/scripts/common.mjs";
import { classifyReviewedTrigger, produceSourceReview, verifySupplement } from "../../scripts/daily-credit-limit-test-source-review.mjs";

const root = "docs/operational-value/proof/daily-credit-limit-test/source-review-v2";
const sha256 = bytes => createHash("sha256").update(bytes).digest("hex");
const load = () => readJson(`${root}/sources-supplement.json.gz`);

test("thirteen acquired originals retain complete response and exact Git identities", () => {
  const archive = load();
  const originals = verifySupplement(archive);
  assert.equal(originals.size, 13);
  assert.equal(archive.manifest.receipts.length, 13);
  assert.equal(originals.get("60a2ab2fa1ff3f49efabcc82628b1efd3507482e").includes("max-daily-ai-credits: 10"), true);
});

test("all fourteen exact predecessor files remain untouched", () => {
  const archive = load();
  verifySupplement(archive);
  assert.equal(archive.predecessorFiles.length, 14);
  for (const row of archive.predecessorFiles) {
    const bytes = readFileSync(row.path);
    assert.equal(bytes.length, row.bytes, row.path);
    assert.equal(sha256(bytes), row.sha256, row.path);
  }
});

test("actual source bypasses every dispatch and limits current trigger population to schedule", () => {
  const archive = load();
  assert.equal(classifyReviewedTrigger("workflow_dispatch", archive), "bypassed");
  assert.equal(classifyReviewedTrigger("schedule", archive), "guardrail-applicable-not-proven-eligible");
  assert.throws(() => classifyReviewedTrigger("workflow_call", archive), /Outside selected compiled trigger/);
  const review = produceSourceReview(archive);
  assert.deepEqual(review.sourceFacts.eligibleTriggerScopeUnderActualCurrentChecker, ["schedule"]);
  assert.match(review.predecessor.invalidatedAssumption, /Non-command routed/);
});

test("adoption cap10 and copilot are not relabelled current cap1/pi", () => {
  const { sourceFacts, historicalReadiness } = produceSourceReview(load());
  assert.equal(sourceFacts.adoptionDailyCapAic, 10);
  assert.equal(sourceFacts.adoptionEngine, "copilot");
  assert.equal(sourceFacts.currentDailyCapAic, 1);
  assert.equal(sourceFacts.currentEngine, "pi");
  assert.equal(historicalReadiness.status, "unknown-not-exhausted");
});

test("source/spec mismatches and floating runtime checkout remain explicit", () => {
  const review = produceSourceReview(load());
  assert.deepEqual(review.specificationDrift.map(row => row.subject), ["dispatch", "cache", "repo-memory"]);
  assert.equal(review.sourceFacts.componentCoverageVersion, 3);
  assert.match(review.sourceFacts.repoMemoryRead, /unreadable.*throw/);
  assert.equal(review.currentSourceClosure.completeRuntimeTransitiveClosure, false);
  assert.ok(review.currentSourceClosure.limitations.some(text => /without an explicit ref/.test(text)));
  assert.ok(review.directDependencies.length > 0);
});

test("no digest-shaped verification flags or source declarations become native observations", () => {
  const archive = load();
  archive.authentication = "verified";
  archive.producerStatus = "independently-authenticated";
  archive.opportunities = [{ eligible: true, accepted: true, authentication: "verified" }];
  const { nativeProducer } = produceSourceReview(archive);
  assert.equal(nativeProducer.status, "blocked-not-implemented");
  assert.equal(nativeProducer.admittedNativeObservations, null);
  assert.equal(nativeProducer.eligibleCount, null);
  assert.equal(nativeProducer.outcome, null);
  assert.equal(nativeProducer.acceptingVerifiedFlags, false);
  assert.equal(nativeProducer.acquisitionReleased, false);
});

test("frozen portfolio cutoff is unchanged; later prospective report remains separate", () => {
  const review = produceSourceReview(load());
  assert.equal(review.cutoff, "2026-10-18T15:00:12Z");
  assert.equal(review.portfolio.cutoff, review.cutoff);
  assert.equal(review.portfolio.reportPublished, false);
  assert.equal(review.portfolio.retrospectiveEvaluationCreated, false);
  assert.match(review.portfolio.prospectivePredecessorReport, /after cutoff; excluded/);
});

test("tampered raw blob and response, missing original and repeated identity fail explicitly", () => {
  const blob = load();
  blob.originals[0].blobBase64 = Buffer.from("fake").toString("base64");
  assert.throws(() => verifySupplement(blob), /original identity mismatch/);
  const response = load();
  response.originals[0].responseBase64 = Buffer.from("{}").toString("base64");
  assert.throws(() => verifySupplement(response), /original identity mismatch/);
  const missing = load();
  missing.originals.pop();
  assert.throws(() => verifySupplement(missing), /scope/);
  const repeated = load();
  repeated.originals[0] = repeated.originals[1];
  assert.throws(() => verifySupplement(repeated), /Repeated/);
});

test("altered manifest and altered predecessor identities cannot self-authenticate", () => {
  const archive = load();
  archive.manifest.receipts[0].status = 201;
  archive.manifestOriginal = Buffer.from(JSON.stringify(archive.manifest)).toString("base64");
  archive.manifestSha256 = sha256(Buffer.from(archive.manifestOriginal, "base64"));
  assert.throws(() => verifySupplement(archive), /manifest mismatch/);
  const predecessor = load();
  predecessor.predecessorFiles[0].sha256 = "a".repeat(64);
  assert.throws(() => verifySupplement(predecessor), /preservation manifest mismatch/);
});

test("stored review deterministically regenerates solely from retained source originals", () => {
  assert.deepEqual(produceSourceReview(load()), readJson(`${root}/review.json`));
});
