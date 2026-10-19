import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { brotliDecompressSync, gunzipSync } from "node:zlib";
import { createHash } from "node:crypto";
import { collectBatch, definition, scoreMetric } from "../../docs/operational-value/proof/functions/smoke-ci.mjs";
import { evaluateNative, inspectCliComment, inspectPersisted, inspectPostconditions, timestamp, treeEntries, verifiedBytes, verifyRun, verifySources } from "../../scripts/native-smoke-ci.mjs";

// Synthetic boundary probes exercise parsing only; none enter native reports.
const run = () => ({
  id: 123, run_attempt: 1, repository: { id: 1036865607, full_name: "github/gh-aw" },
  path: ".github/workflows/smoke-ci.lock.yml", head_sha: "a".repeat(40),
  created_at: "2026-10-17T12:00:00Z",
});
const issue = () => ({
  id: 456, node_id: "I_fixture", number: 789,
  url: "https://api.github.com/repos/github/gh-aw/issues/789",
  created_at: "2026-10-17T12:01:00Z",
  title: "[smoke-ci] safe-outputs samples replay",
  body: "Deterministic samples replay for run 123.\n\nThis issue is produced by `safe-outputs.create-issue.samples`, not by an agent.",
});
const comment = () => ({
  id: 987, node_id: "IC_fixture", issue_url: issue().url,
  created_at: "2026-10-17T12:02:00Z",
  updated_at: "2026-10-17T12:02:00Z",
  body: "smoke-ci samples replay comment for run 123.",
});

test("real original Git objects prove source addition against its actual parent", () => {
  assert.equal(verifySources().length, 17);
  assert.equal(definition.adoption.adoptedAt, "2026-04-18T11:23:19Z");
});

test("complete production reader discovery keeps absence and partial semantics", () => {
  const discovery = JSON.parse(gunzipSync(readFileSync(new URL("../../docs/operational-value/proof/smoke-ci/discovery.json.gz", import.meta.url))));
  assert.equal(discovery.partitions, 346);
  assert.equal(discovery.checkedEntities, 58048);
  assert.equal(discovery.roots.length, 140);
  assert.equal(discovery.closure.reachedCount, 2937);
  assert.equal(discovery.closure.absentReferences.length, 16);
  assert.equal(discovery.completeConnections.issues.complete, true);
  assert.equal(discovery.completeConnections.pullRequests.complete, true);
});

test("native field parser recognizes only exact independently observable partial facets", () => {
  const effects = inspectPersisted(run(), issue(), [comment()]);
  assert.deepEqual(effects.map(row => row.operation), ["create_issue", "add_comment"]);
  assert.ok(effects.every(row => row.receiptLinked === false));
  assert.equal(inspectPersisted(run(), { ...issue(), body: "agent says success" }).length, 0);
  assert.equal(inspectPersisted(run(), { ...issue(), title: "other" }).length, 0);
  assert.equal(inspectPersisted(run(), issue(), [{ ...comment(), body: "wrong run" }]).length, 1);
  assert.equal(inspectPersisted(run(), null).length, 0);
});

test("labels, appended mutable body and green jobs are not inferred effects", () => {
  const state = { ...issue(), labels: [{ name: "ai-generated" }],
    body: `${issue().body}\nsmoke-ci samples replay confirmed the update-issue handler for run 123.` };
  assert.deepEqual(inspectPersisted({ ...run(), conclusion: "success" }, state).map(row => row.operation),
    ["create_issue"]);
});

test("reject foreign repository, wrong workflow, bad source and clock identities", () => {
  for (const mutation of [
    { repository: { id: 1, full_name: "github/gh-aw" } },
    { path: ".github/workflows/daily-safe-outputs-conformance.lock.yml" },
    { head_sha: "not-sha" }, { run_attempt: 0 },
    { created_at: "2026-10-18T15:00:12Z" },
  ]) assert.throws(() => verifyRun({ ...run(), ...mutation }));
  assert.throws(() => inspectPersisted(run(), { ...issue(), url: "https://api.github.com/repos/other/repo/issues/789" }));
  assert.throws(() => inspectPersisted(run(), issue(), [{ ...comment(), issue_url: "other" }]));
  assert.throws(() => inspectPersisted(run(), { ...issue(), created_at: "2026-10-16T12:00:00Z" }));
  assert.throws(() => timestamp("2026-02-30T12:00:00Z"));
  assert.throws(() => timestamp("2026-10-17"));
  assert.throws(() => timestamp("2026-10-17T12:00:00+01:00"));
});

test("fail closed on corrupt originals, paths and truncated trees", () => {
  const record = JSON.parse(readFileSync(new URL("../../docs/operational-value/proof/smoke-ci/sources.json", import.meta.url))).records[0];
  assert.throws(() => verifiedBytes({ ...record, sha256: "0".repeat(64) }));
  assert.throws(() => verifiedBytes({ ...record, gitObject: "0".repeat(40) }));
  assert.throws(() => verifiedBytes({ ...record, file: "../sources.json" }));
  assert.throws(() => treeEntries(Buffer.from("100644 truncated\0")));
});

test("native scoring preserves zero, unknown, malformed and attribution subset", () => {
  for (const metric of definition.metrics) {
    assert.ok(scoreMetric(metric.id, definition.validationExamples.targetAttained) >
      scoreMetric(metric.id, definition.validationExamples.targetMissed));
    assert.equal(scoreMetric(metric.id, definition.validationExamples.missing), null);
    assert.equal(scoreMetric(metric.id, definition.validationExamples.malformed), null);
  }
  assert.equal(scoreMetric("persisted-effects", { nativeEvidenceValid: true, persistedEffects: 0, receiptLinkedEffects: 0 }), 0);
  assert.equal(scoreMetric("persisted-effects", { nativeEvidenceValid: true, persistedEffects: 1, receiptLinkedEffects: 2 }), null);
  assert.equal(scoreMetric("unknown", definition.validationExamples.targetAttained), null);
});

test("historical CLI facet requires its original PR target and exact native body", () => {
  const original = { ...run(), event: "pull_request", pull_requests: [{
    number: 789, url: "https://api.github.com/repos/github/gh-aw/pulls/789",
  }] };
  const state = { ...comment(), body: "\u2705 smoke-ci: safeoutputs CLI comment + comment-memory run (123)" };
  assert.equal(inspectCliComment(original, state).length, 1);
  assert.equal(inspectCliComment(original, { ...state, body: "agent says comment posted" }).length, 0);
  assert.equal(inspectCliComment(original, { ...state, body: state.body.replace("(123)", "(124)") }).length, 0);
  assert.equal(inspectCliComment(original, { ...state, updated_at: "2026-10-18T12:02:00Z" }).length, 0);
  assert.throws(() => inspectCliComment({ ...original, event: "push" }, state));
  assert.throws(() => inspectCliComment({ ...original, pull_requests: [] }, state));
  assert.throws(() => inspectCliComment(original, { ...state, issue_url: state.issue_url.replace("789", "788") }));
});

test("actual local collector preserves production periods and missingness at the cutoff", async () => {
  const requests = [
    { observedAt: "2026-10-18T15:00:12Z", windowStart: "2026-10-17T15:00:12Z", windowEnd: "2026-10-18T15:00:12Z" },
    { observedAt: "2026-10-17T15:00:12Z", windowStart: "2026-10-16T15:00:12Z", windowEnd: "2026-10-17T15:00:12Z" },
  ];
  const results = await collectBatch(requests);
  assert.equal(results.length, 2);
  for (const [i, result] of results.entries()) {
    assert.equal(result.evidence.windowStart, requests[i].windowStart);
    assert.equal(result.evidence.windowEnd, requests[i].windowEnd);
    assert.equal(result.evidence.observedAt, requests[i].observedAt);
    assert.equal(result.evidence.persistedEffects, null);
    assert.equal(result.evidence.coverageStatus, "missing");
    assert.equal(result.evidence.completePopulationEligibleCount, null);
    assert.ok(result.provenance.length > 0);
    assert.ok(result.evidence.missingReason.length > 0);
  }
  await assert.rejects(collectBatch([{ ...requests[0], observedAt: "2026-10-19T15:00:12Z" }]));
  await assert.rejects(collectBatch([{ ...requests[0], observedAt: "bad-clock" }]));
  await assert.rejects(collectBatch([{ ...requests[0], windowStart: requests[0].windowEnd }]));
  await assert.rejects(collectBatch([{ ...requests[0], repository: "other/repo" }]));
});

test("actual original native candidates remain rejected without invented zero or execution", () => {
  const native = evaluateNative();
  assert.equal(native.attempts.length, 2);
  assert.deepEqual(native.attempts.map(attempt => attempt.capturedCommentCount), [9, 6]);
  assert.deepEqual(native.attempts.map(attempt => attempt.matchingUnchangedNativeLines), [0, 0]);
  assert.ok(native.attempts.every(attempt => attempt.nativeEffectCount === null));
  assert.ok(native.attempts.every(attempt => !attempt.originalTriggerTargetBound && !attempt.executedWorkflowBound));
  assert.equal(native.attempts[0].protectedLogsStatus, 410);
  assert.equal(native.effects.length, 0);
});

test("original native comment mutations enforce the frozen partial predicate, not a success flag", () => {
  const index = JSON.parse(readFileSync(new URL("../../docs/operational-value/proof/smoke-ci/native-index.json", import.meta.url)));
  const records = index.attempts[0].files;
  const original = role => JSON.parse(verifiedBytes(records.find(record => record.role === role)));
  const metadata = original("run"), pr = original("pr"), comments = original("comments");
  assert.equal(inspectPostconditions(metadata, pr, comments).nativeEffectCount, null);
  const base = comments.find(row => row.created_at >= metadata.created_at && row.created_at === row.updated_at);
  assert.ok(base);
  const mutated = { ...base, body: `\u2705 smoke-ci: safeoutputs CLI comment + comment-memory run (${metadata.id})\n\nSynthetic boundary footer; never native acceptance.` };
  assert.equal(inspectPostconditions(metadata, pr, [mutated]).effects.length, 1);
  assert.equal(inspectPostconditions(metadata, pr, [{ ...mutated, updated_at: "2026-10-19T12:00:00Z" }]).nativeEffectCount, null);
  assert.equal(inspectPostconditions(metadata, pr, [{ ...mutated, body: mutated.body.replace(String(metadata.id), "1") }]).nativeEffectCount, null);
  assert.throws(() => inspectPostconditions(metadata, pr, [{ ...mutated, issue_url: "foreign" }]));
  assert.throws(() => inspectPostconditions(metadata, { ...pr, base: { repo: { id: 1 } } }, [mutated]));
  assert.throws(() => inspectPostconditions(metadata, pr, [mutated, mutated]));
});

test("actual original candidates occupy disjoint periods while all acceptance metrics stay unknown", async () => {
  const results = await collectBatch([
    { windowStart: "2026-06-28T15:00:12Z", windowEnd: "2026-06-29T15:00:12Z", observedAt: "2026-06-29T15:00:12Z" },
    { windowStart: "2026-07-16T15:00:12Z", windowEnd: "2026-07-17T15:00:12Z", observedAt: "2026-07-17T15:00:12Z" },
  ]);
  assert.deepEqual(results.map(result => result.evidence.nativeAssessments[0].capturedCommentCount), [6, 9]);
  for (const result of results) {
    assert.equal(result.evidence.selectedAttemptCount, 1);
    assert.equal(result.evidence.coverageStatus, "partial");
    for (const metric of definition.metrics) assert.equal(scoreMetric(metric.id, result.evidence), null);
  }
});

test("complete predecessor report remains lossless and explicitly unavailable", () => {
  const archive = JSON.parse(brotliDecompressSync(readFileSync(new URL("../../docs/operational-value/proof/smoke-ci/predecessor/pre-native-report.documents.json.br", import.meta.url))));
  assert.equal(archive.documents.length, 5);
  for (const document of archive.documents) {
    assert.equal(Buffer.byteLength(document.content), document.bytes);
    assert.equal(createHash("sha256").update(document.content).digest("hex"), document.sha256);
  }
  const timeline = JSON.parse(archive.documents.find(document => document.file === "smoke-ci-timeline.json").content);
  assert.equal(timeline.snapshots.length, 184);
  assert.ok(timeline.snapshots.every(snapshot => Object.values(snapshot.metrics).every(value => value === null)));
});
