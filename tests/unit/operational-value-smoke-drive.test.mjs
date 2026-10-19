import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { candidateClosure } from "../../scripts/collect-smoke-drive.mjs";
import {
  aggregateAttempts, inspectExactReadback, inspectNotStarted, inspectRepositoryAccess, parseCodexCommands, readRetainedAttempts,
  verifyLineage, verifySourceProfile,
} from "../../scripts/native-smoke-drive.mjs";
import { collectBatch, definition, scoreMetric } from "../../docs/operational-value/proof/functions/smoke-drive.mjs";

const file = "/tmp/gh-aw/drive-memory/smoke-drive.txt";
const commandEvent = (id, command, output, exitCode = 0) => JSON.stringify({
  type: "item.completed",
  item: { id, type: "command_execution", command, aggregated_output: output, exit_code: exitCode },
});
const exact = () => parseCodexCommands([
  commandEvent("write", `printf 'run_id=123\\n' > ${file}`, ""),
  commandEvent("read", `cat ${file}`, "run_id=123\n"),
].join("\n"));

test("native exact readback requires the write, exact run id and final newline", () => {
  assert.equal(inspectExactReadback(exact(), 123).attained, true);
  for (const output of ["run_id=123", "run_id=124\n", "run_id=123\n\n", "PASS\n"]) {
    const commands = exact();
    commands[1].output = output;
    assert.equal(inspectExactReadback(commands, 123).attained, false);
  }
  assert.equal(inspectExactReadback(exact(), 124).attained, null);
  assert.equal(inspectExactReadback(exact().slice(1), 123).attained, null);
});

test("assistant statements and mutable report claims cannot become native command evidence", () => {
  const event = JSON.stringify({ type: "item.completed", item: {
    id: "report", type: "agent_message", text: "PASS; previous memory restored; git log succeeded",
  } });
  assert.deepEqual(parseCodexCommands(event), []);
  assert.equal(inspectExactReadback(parseCodexCommands(event), 123).attained, null);
  assert.throws(() => parseCodexCommands("{broken"), /Malformed/);
  assert.throws(() => parseCodexCommands([commandEvent("a", "true", ""), commandEvent("a", "true", "")].join("\n")),
    /Repeated/);
});

test("unsupported mutations invalidate an otherwise matching write/read pair", () => {
  const commands = exact();
  commands.splice(1, 0, { id: "mutate", command: "rm -rf /tmp/gh-aw/drive-memory", output: "", exitCode: 0 });
  assert.equal(inspectExactReadback(commands, 123).attained, null);
  const failed = exact();
  failed[0].exitCode = 1;
  assert.equal(inspectExactReadback(failed, 123).attained, false);
});

test("repository access needs a real immutable target commit, not plausible hash text", () => {
  const sha = "1234567".padEnd(40, "a");
  const commands = [{ id: "git", command: "git log --oneline -1", output: "1234567 Commit\n", exitCode: 0 }];
  assert.equal(inspectRepositoryAccess(commands, [sha]).attained, true);
  assert.equal(inspectRepositoryAccess(commands, []).attained, null);
  assert.equal(inspectRepositoryAccess([{ ...commands[0], command: "echo '1234567 Commit'" }], [sha]).attained, null);
  assert.equal(inspectRepositoryAccess(commands, [sha, "1234567".padEnd(40, "b")]).attained, null);
});

test("complete bidirectional candidate closure includes pull requests and absent references", () => {
  const entities = [
    { number: 1, workflowReference: { workflowId: "smoke-drive" }, relatedCandidates: [] },
    { number: 2, kind: "PullRequest", relatedCandidates: [1, 99] },
    { number: 3, relatedCandidates: [2] },
    { number: 4, relatedCandidates: [] },
  ];
  const result = candidateClosure(entities);
  assert.deepEqual(result.direct, [1]);
  assert.deepEqual(result.entities.map(row => row.number), [1, 2, 3]);
  assert.deepEqual(result.absentReferences, [99]);
});

test("native attempts are deduplicated and counted in disjoint inclusive/exclusive periods", () => {
  const row = { key: "github/gh-aw/123/1", completedAt: "2026-10-11T00:00:00Z",
    sameRun: { attained: true }, persistence: { attained: null }, fullGoal: { attained: null } };
  const window = (start, end) => ({ windowStart: start, windowEnd: end, observedAt: end });
  const before = aggregateAttempts([row], window("2026-10-04T00:00:00Z", "2026-10-11T00:00:00Z"));
  const after = aggregateAttempts([row, row], window("2026-10-11T00:00:00Z", "2026-10-18T00:00:00Z"));
  assert.equal(before.sameRunReadbacks, null);
  assert.equal(after.sameRunReadbacks, 1);
  assert.equal(after.restoredTransitions, null);
  assert.equal(after.fullGoalAttainments, null);
  assert.equal(after.coverageStatus, "partial");
  assert.equal(after.assessedAttemptCount, 1);
  assert.throws(() => aggregateAttempts([row, { ...row, sameRun: { attained: false } }],
    window("2026-10-11T00:00:00Z", "2026-10-18T00:00:00Z")), /Conflicting/);
  assert.throws(() => aggregateAttempts([{ ...row, completedAt: null }],
    window("2026-10-11T00:00:00Z", "2026-10-18T00:00:00Z")), /timestamp/);
});

test("genuine provider originals prove two not-started attempts, not missing persistence or useful delivery", () => {
  const rows = readRetainedAttempts("docs/operational-value/proof/smoke-drive");
  assert.equal(rows.length, 2);
  assert.deepEqual(rows.map(row => row.runId).sort(), ["38327858802", "38986380447"]);
  assert.ok(rows.every(row => row.sameRun.attained === false && row.fullGoal.attained === false
    && row.persistence.attained === null && row.repositoryAccess.attained === null
    && row.failure.kind === "drive-service-permission-denied"));
  const result = aggregateAttempts(rows, { windowStart: "2026-10-11T15:00:12Z",
    windowEnd: "2026-10-18T15:00:12Z", observedAt: "2026-10-18T15:00:12Z" });
  assert.equal(result.sameRunReadbacks, 0);
  assert.equal(result.fullGoalAttainments, 0);
  assert.equal(result.restoredTransitions, null);
  assert.equal(result.coverageStatus, "partial");
});

test("original metadata, provider ZIP and compiled byte tampering fail closed", () => {
  const temporary = mkdtempSync(path.join(process.cwd(), ".smoke-drive-test-"));
  try {
    cpSync("docs/operational-value/proof/smoke-drive", temporary, { recursive: true });
    const manifest = JSON.parse(readFileSync(path.join(temporary, "originals/protected/manifest.json")));
    const zip = manifest.requests.find(row => row.endpoint.includes("/artifacts/"));
    const file = path.join(temporary, "originals/protected", zip.file);
    const original = readFileSync(file);
    writeFileSync(file, Buffer.concat([original, Buffer.from("tampered")]));
    assert.throws(() => readRetainedAttempts(temporary), /tampering/);
    writeFileSync(file, original);
    const blob = path.join(temporary, "originals/compiled/991896b0834edffd669cb0d6d2662b047fb7f238.blob");
    writeFileSync(blob, "not the original compiled source");
    assert.throws(() => readRetainedAttempts(temporary), /tampering/);
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
});

test("native failure parser rejects changed execution state, missing independent error and invalid clocks", () => {
  const base = "docs/operational-value/proof/smoke-drive/originals";
  const jobs = JSON.parse(readFileSync(`${base}/protected/322a5bbba8d297f1517daea2e2d1957305880d8700bfa628e7596997c420bfbd.json`));
  const job = jobs.jobs.find(row => row.name === "agent");
  const execution = { version: 1, component: "agent", run_id: 38986380447, run_attempt: 1, state: "not_started" };
  const log = execFileSync("unzip", ["-p",
    `${base}/protected/a50b1487029b1f0ea19e7d2b03128cff64dc967c8b2f6901b0dcd2297c0df68e.zip`, "4_agent.txt"],
  { encoding: "utf8" });
  const source = readFileSync(`${base}/compiled/991896b0834edffd669cb0d6d2662b047fb7f238.blob`, "utf8");
  assert.equal(inspectNotStarted(execution, job, log, source).sameRun.attained, false);
  assert.equal(inspectNotStarted({ ...execution, state: "started" }, job, log, source), null);
  assert.equal(inspectNotStarted({ ...execution, run_attempt: 2 }, job, log, source), null);
  assert.equal(inspectNotStarted(execution, job, "PASS", source), null);
  assert.equal(inspectNotStarted(execution, job, log, ""), null);
  assert.throws(() => inspectNotStarted(execution, { ...job, completed_at: null }, log, source), /clock/);
});

test("schema-3 batch collection retains null gaps and scoped zero without claiming complete periods", async () => {
  const requests = [
    { windowStart: "2026-10-04T15:00:12Z", windowEnd: "2026-10-11T15:00:12Z", observedAt: "2026-10-11T15:00:12Z" },
    { windowStart: "2026-10-11T15:00:12Z", windowEnd: "2026-10-18T15:00:12Z", observedAt: "2026-10-18T15:00:12Z" },
  ];
  const results = await collectBatch(requests);
  assert.equal(results.length, 2);
  assert.equal(scoreMetric("same-run", results[0].evidence), null);
  assert.equal(scoreMetric("same-run", results[1].evidence), 0);
  assert.equal(scoreMetric("persistence", results[1].evidence), null);
  assert.equal(scoreMetric("full-goal", results[1].evidence), 0);
  assert.equal(results[1].evidence.eligibleCount, null);
  assert.equal(results[1].evidence.coverageStatus, "partial");
  assert.ok(results.every(row => row.provenance.length > 0));
  for (const metric of definition.metrics) {
    assert.equal(scoreMetric(metric.id, definition.validationExamples.targetAttained), 1);
    assert.equal(scoreMetric(metric.id, definition.validationExamples.targetMissed), 0);
    assert.equal(scoreMetric(metric.id, definition.validationExamples.missing), null);
    assert.equal(scoreMetric(metric.id, definition.validationExamples.malformed), null);
  }
  await assert.rejects(collectBatch([{ ...requests[0], repository: "elsewhere/repo" }]), /Unsupported/);
});

test("actual introduction is proved against the real parent, not the earliest output or retained boundary", () => {
  const lineage = JSON.parse(readFileSync("docs/operational-value/proof/smoke-drive/lineage.json"));
  assert.equal(verifyLineage(lineage).actualAdoption.commit, "bc565025e57baa1395065fb45c19f3d2b235c4a0");
  assert.equal(lineage.actualAdoption.at, "2026-08-22T13:21:39Z");
  assert.equal(lineage.baseline.commit, "01fb3b77f0e9478f91653232d2d89680dfad6678");
  const clock = structuredClone(lineage);
  clock.actualAdoption.at = "2026-08-22T14:13:12Z";
  assert.throws(() => verifyLineage(clock), /not established/);
  const tree = structuredClone(lineage);
  tree.proof.parent.trees[2].bytesBase64 = Buffer.from("invented empty tree").toString("base64");
  assert.throws(() => verifyLineage(tree), /object mismatch/);
});

test("exact-run source and imports are bound by portable raw Git tree proof, not supplied profile labels", () => {
  const { profiles } = JSON.parse(readFileSync("docs/operational-value/proof/smoke-drive/source-profiles.json"));
  for (const profile of profiles) assert.equal(verifySourceProfile(profile).revision, profile.revision);
  const falseTree = structuredClone(profiles[0]);
  falseTree.files.find(row => row.path.endsWith("smoke-drive.md")).gitBlob = "a".repeat(40);
  assert.throws(() => verifySourceProfile(falseTree), /not in actual run tree/);
  const falseImport = structuredClone(profiles[0]);
  falseImport.files.find(row => row.path.endsWith("reporting.md")).text += "\nchanged";
  assert.throws(() => verifySourceProfile(falseImport), /bytes mismatch/);
  const incomplete = structuredClone(profiles[0]);
  incomplete.trees.pop();
  assert.throws(() => verifySourceProfile(incomplete), /Incomplete/);
});
