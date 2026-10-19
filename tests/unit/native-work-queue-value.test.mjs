import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { parse } from "yaml";
import { assessQueueRun, queueHostSuccess, scoreQueueMetric, workQueueModule } from "../../scripts/native-work-queue-value.mjs";
import { reviewQueueSource } from "../../scripts/collect-work-queue-native.mjs";
import { censusDigest, readCensusJson } from "../../scripts/operational-value-census-io.mjs";
import { timelinePulse } from "../../.github/skills/add-operational-value/scripts/pulse-model.mjs";

const directory = "docs/operational-value/proof/work-queue";
const contract = readCensusJson(`${directory}/contract.json`);
const interpreterSha256 = createHash("sha256").update(readFileSync("scripts/native-work-queue-value.mjs")).digest("hex");
const value = workQueueModule(contract, interpreterSha256, censusDigest(contract));
const fixture = () => ({
  run: { id: 1, repositoryId: contract.repositoryId, attempt: 1, headSha: "a".repeat(40),
    path: contract.compiledPath, event: "schedule", createdAt: "2026-10-15T00:00:00Z" },
  source: { reviewed: true, headSha: "a".repeat(40), sourceGitBlob: contract.sourceGitBlob, hostJobSha256: contract.hostJobSha256 },
  jobs: [{ id: 2, runId: 1, attempt: 1, headSha: "a".repeat(40), name: contract.smokeReadback.job,
    steps: [
      { name: contract.smokeReadback.downloadStep, number: 2, status: "completed", conclusion: "success",
        started_at: "2026-10-15T00:01:00Z", completed_at: "2026-10-15T00:02:00Z" },
      { name: contract.smokeReadback.assertionStep, number: 3, status: "completed", conclusion: "success",
        started_at: "2026-10-15T00:02:00Z", completed_at: "2026-10-15T00:03:00Z" },
    ] }],
});

test("successful protected noop check is a smoke readback, never a queue predicate proof", () => {
  const assessment = assessQueueRun(fixture(), contract);
  assert.equal(assessment.smokeReadback, true);
  assert.deepEqual(assessment.predicates.map(item => item.passed), [null, null, null]);
  const evidence = { valid: true, contractSha256: censusDigest(contract), assessments: [{ id: 1, ...assessment }] };
  assert.equal(scoreQueueMetric("observed-predicates", evidence, contract), null);
  assert.equal(scoreQueueMetric("smoke-readbacks", evidence, contract), 1);
});

test("native scorer preserves established partial proof and treats all-unknown/zero opportunities as null", () => {
  const evidence = structuredClone(value.definition.validationExamples.targetAttained);
  assert.equal(value.scoreMetric("observed-predicates", evidence), 6);
  evidence.assessments[1].predicates.forEach(item => { item.passed = null; });
  assert.equal(value.scoreMetric("observed-predicates", evidence), 3);
  evidence.assessments[0].predicates.forEach(item => { item.passed = null; });
  assert.equal(value.scoreMetric("observed-predicates", evidence), null);
  evidence.assessments = [];
  assert.equal(value.scoreMetric("observed-predicates", evidence), null);
  assert.equal(value.scoreMetric("observed-predicates", value.definition.validationExamples.targetMissed), 0);
});

test("wrong source, repository, rerun, path, head, event, and cutoff stay unassessed", () => {
  const variants = [
    row => { row.source.reviewed = false; },
    row => { row.source.sourceGitBlob = "b".repeat(40); },
    row => { row.source.headSha = "b".repeat(40); },
    row => { row.run.repositoryId++; },
    row => { row.run.attempt = 2; },
    row => { row.run.path = ".github/workflows/other.yml"; },
    row => { row.run.event = "pull_request"; },
    row => { row.run.createdAt = contract.until; },
  ];
  for (const mutate of variants) {
    const row = fixture(); mutate(row);
    const result = assessQueueRun(row, contract);
    assert.equal(result.smokeReadback, null);
    assert.ok(result.predicates.every(item => item.passed === null));
  }
});

test("duplicate, missing, failed, skipped, late and unordered host steps prove nothing", () => {
  const variants = [
    row => { row.jobs.push(structuredClone(row.jobs[0])); },
    row => { row.jobs[0].steps.push(structuredClone(row.jobs[0].steps[1])); },
    row => { row.jobs[0].steps.pop(); },
    row => { row.jobs[0].steps[1].conclusion = "failure"; },
    row => { row.jobs[0].steps[1].conclusion = "skipped"; },
    row => { row.jobs[0].steps[1].completed_at = contract.until; },
    row => { row.jobs[0].steps[0].completed_at = "2026-10-15T00:04:00Z"; },
    row => { row.jobs[0].attempt = 2; },
    row => { row.jobs[0].runId = 3; },
  ];
  for (const mutate of variants) {
    const row = fixture(); mutate(row);
    assert.equal(assessQueueRun(row, contract).smokeReadback, null);
  }
  assert.equal(queueHostSuccess({ ...fixture().jobs[0].steps[0], number: 0 }, contract.until), false);
});

test("malformed native evidence cannot become a zero or a successful observation", () => {
  const fixture = structuredClone(value.definition.validationExamples.targetAttained);
  for (const evidence of [null, {}, { ...fixture, contractSha256: "wrong" },
    { ...fixture, assessments: [fixture.assessments[0], fixture.assessments[0]] },
    { ...fixture, assessments: [{ ...fixture.assessments[0], predicates: [null, null, null] }] },
    { ...fixture, assessments: [{ ...fixture.assessments[0], predicates: [{ id: "absent-read", passed: "success" }] }] }]) {
    assert.equal(value.scoreMetric("observed-predicates", evidence), null);
  }
  assert.throws(() => value.scoreMetric("unknown", fixture), /Unknown/);
  assert.throws(() => workQueueModule(contract, "0".repeat(64), censusDigest(contract)), /interpreter changed/);
  assert.throws(() => workQueueModule(contract, interpreterSha256, "0".repeat(64)), /contract changed/);
});

test("source replay establishes the exact upload omission and lack of native host checker", () => {
  const sources = readCensusJson(`${directory}/sources.json.gz`);
  const byHash = new Map(sources.map(item => [item.sha256, item]));
  const reader = { read: (_head, file) => {
    const expected = contract.sources.find(item => item.path === file);
    const source = byHash.get(expected.sha256);
    return { ...source, bytes: Buffer.from(source.content, "base64") };
  } };
  const profile = reviewQueueSource(reader, contract.sourceRevision, contract);
  assert.equal(profile.reviewed, true);
  assert.equal(profile.finishIncludedInAgentUpload, false);
  assert.equal(profile.nativeCheckerCount, 0);
  const lock = parse(reader.read(null, contract.compiledPath).bytes.toString());
  assert.ok(lock.jobs.agent.steps.some(step => step.name === "Copy work queue claim finish intent"));
  const workflow = reader.read(null, contract.sourcePath).bytes.toString();
  assert.match(workflow, /not proof of native run binding, effect delivery, or full runtime conformance/);
});

test("real history separates twelve initial executions from five observer opportunities without native proof", () => {
  const request = { repository: contract.repository, windowStart: contract.adoption.adoptedAt, windowEnd: contract.until };
  const [{ evidence }] = value.collectBatch([request]);
  assert.equal(evidence.inventoryInitialAttempts, 12);
  assert.equal(evidence.observerInitialAttempts, 5);
  assert.equal(evidence.incompatibleIntentAttempts, 7);
  assert.equal(evidence.nativePredicateOpportunities, 15);
  assert.equal(evidence.unassessedInitialAttempts, 5);
  assert.equal(evidence.independentlyAssessedPredicates, 0);
  assert.equal(evidence.eligibleCount, 15);
  assert.equal(value.scoreMetric("observed-predicates", evidence), null);
  assert.equal(value.scoreMetric("smoke-readbacks", evidence), null);
  assert.throws(() => value.collectBatch([{ ...request, repository: "other/repo" }]), /repository mismatch/);
  assert.throws(() => value.collectBatch([{ ...request, windowStart: "invalid" }]), /Invalid/);
});

test("source-reviewed incompatible historical goals are ineligible, not native failures", () => {
  for (const profile of contract.incompatibleIntentProfiles) {
    const row = fixture();
    row.source.sourceGitBlob = profile.sourceGitBlob;
    const assessment = assessQueueRun(row, contract);
    assert.equal(assessment.eligible, false);
    assert.ok(assessment.predicates.every(item => item.passed === null));
    assert.equal(assessment.smokeReadback, null);
  }
});

test("native plot supports improvement and worsening but never judges all-unknown real evidence", () => {
  const window = { startAt: "2026-10-04T15:00:12Z", endAt: contract.until };
  const snapshot = (startAt, endAt, quantity) => ({
    window: { startAt, endAt }, observedAt: endAt, evidence: { coverageStatus: "complete", eligibleCount: 9 },
    metrics: { "observed-predicates": quantity, "smoke-readbacks": 1 },
  });
  const timeline = { repository: contract.repository, window, valueFunction: { definition: value.definition },
    metricReview: { metrics: [{ id: "observed-predicates", recentComparison: {} }] },
    snapshots: [
      snapshot("2026-10-04T15:00:12Z", "2026-10-11T15:00:12Z", 3),
      snapshot("2026-10-11T15:00:12Z", contract.until, 6),
    ] };
  assert.equal(timelinePulse(timeline).signal.status, "improving");
  timeline.snapshots[1].metrics["observed-predicates"] = 1;
  assert.equal(timelinePulse(timeline).signal.status, "worsening");
  assert.equal(timelinePulse(timeline).signal.attention, "review");
  const [{ evidence }] = value.collectBatch([{ windowStart: window.startAt, windowEnd: window.endAt }]);
  timeline.snapshots[1].evidence = evidence;
  timeline.snapshots[1].metrics["observed-predicates"] = value.scoreMetric("observed-predicates", evidence);
  assert.equal(timelinePulse(timeline).signal.status, "insufficient-evidence");
  assert.equal(timelinePulse(timeline).signal.attention, "evidence-needed");
  assert.equal(timelinePulse(timeline).signal.current, null);
});

test("retained source and observation gaps fail closed rather than inventing a clean period", () => {
  const original = process.cwd();
  const temporary = mkdtempSync(path.join(os.tmpdir(), "cao-queue-evidence-"));
  try {
    mkdirSync(path.join(temporary, directory), { recursive: true });
    process.chdir(temporary);
    assert.throws(() => value.collectBatch([]), /ENOENT/);
    writeFileSync(`${directory}/index.json`, JSON.stringify({ complete: false }));
    assert.throws(() => value.collectBatch([]), /ENOENT/);
  } finally {
    process.chdir(original);
    rmSync(temporary, { recursive: true });
  }
});
