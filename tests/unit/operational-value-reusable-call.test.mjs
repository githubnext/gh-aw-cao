import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  assessReusableCallReceipt, reusableCallModule, reusableCallOpportunity, scoreReusableCallMetric,
} from "../../scripts/collect-reusable-call-value.mjs";
import { censusDigest, readCensusJson } from "../../scripts/operational-value-census-io.mjs";
import { verifyPublicGitBlob } from "../../scripts/immutable-public-git-source.mjs";

const root = fileURLToPath(new URL("../../", import.meta.url));
const evidencePath = "docs/operational-value/proof/reusable-call";
const contract = readCensusJson(`${evidencePath}/contract.json`);
const repositoryId = contract.repositoryId, repository = contract.repository;
const sha = "a".repeat(40), hash = "b".repeat(64);
const assessContract = {
  calledWorkflowFile: contract.coupling.calledWorkflowFile,
  expectedTaskDescriptionLiteral: contract.coupling.expectedTaskDescriptionLiteral,
  orchestratorLockGitBlob: contract.orchestrator.lockGitBlob,
};

function baseRun(event, orchestratorDispatched = null) {
  return { repository, repositoryId, event, orchestratorDispatched };
}

function receipt(role, overrides = {}) {
  const base = {
    runId: 777, attempt: 1, repository, repositoryId, event: "pull_request",
    lockGitBlob: contract.orchestrator.lockGitBlob, sourceVerified: true, policyAdmitted: true,
    orchestrator: {
      dispatched: true, calledWorkflowFile: contract.coupling.calledWorkflowFile,
      taskDescriptionActual: contract.coupling.expectedTaskDescriptionLiteral,
    },
    worker: {
      headSha: sha, expectedHeadSha: sha, branch: "feature/pr", expectedRef: "feature/pr",
      clean: true, initialized: true, originPresent: true, visibleCommits: 3,
    },
  };
  const merged = { ...base, ...overrides };
  merged.runSha256 = overrides.runSha256 ?? censusDigest({
    runId: merged.runId, attempt: merged.attempt, event: merged.event,
    repository: merged.repository, repositoryId: merged.repositoryId,
  });
  return merged;
}

test("reusable-call orchestrator opportunity covers every policy-admitted trigger class, excludes controls", () => {
  assert.equal(reusableCallOpportunity(baseRun("schedule"), "orchestrator").triggerClass, "schedule-cycle");
  assert.equal(reusableCallOpportunity(baseRun("workflow_dispatch"), "orchestrator").triggerClass, "manual-dispatch");
  assert.equal(reusableCallOpportunity(baseRun("pull_request"), "orchestrator").triggerClass, "pr-labeled-water");
  assert.equal(reusableCallOpportunity(baseRun("issue_comment"), "orchestrator").triggerClass, "centralized-slash-dispatch");
  assert.equal(reusableCallOpportunity(baseRun("issues"), "orchestrator").triggerClass, "centralized-slash-dispatch");
  const control = reusableCallOpportunity(baseRun("check_suite"), "orchestrator");
  assert.equal(control.eligible, false);
  assert.equal(control.triggerClass, "unsupported-trigger-control");
  assert.equal(reusableCallOpportunity({}, "orchestrator").eligible, null);
  assert.equal(reusableCallOpportunity({ repository: "other/repo", repositoryId, event: "schedule" }, "orchestrator").eligible, null);
});

test("reusable-call worker opportunity is strictly conditional on the orchestrator's own dispatch receipt", () => {
  assert.equal(reusableCallOpportunity(baseRun("pull_request", true), "worker").eligible, true);
  assert.equal(reusableCallOpportunity(baseRun("pull_request", true), "worker").triggerClass, "nested-workflow-call-dispatch");
  const noDispatch = reusableCallOpportunity(baseRun("pull_request", false), "worker");
  assert.equal(noDispatch.eligible, false);
  assert.equal(noDispatch.triggerClass, "no-dispatch-control");
  assert.equal(reusableCallOpportunity(baseRun("pull_request", null), "worker").eligible, null);
});

test("reusable-call orchestrator attainment requires the exact declared workflow file and literal task-description", () => {
  const result = assessReusableCallReceipt(receipt("orchestrator"), "orchestrator", assessContract);
  assert.equal(result.headMatches, true);
  assert.equal(result.attained, true);
  const wrongFile = receipt("orchestrator");
  wrongFile.orchestrator.calledWorkflowFile = "./.github/workflows/other-worker.lock.yml";
  const missedFile = assessReusableCallReceipt(wrongFile, "orchestrator", assessContract);
  assert.equal(missedFile.headMatches, false);
  assert.equal(missedFile.attained, false);
  const wrongInput = receipt("orchestrator");
  wrongInput.orchestrator.taskDescriptionActual = "unexpected task";
  const missedInput = assessReusableCallReceipt(wrongInput, "orchestrator", assessContract);
  assert.equal(missedInput.headMatches, true);
  assert.equal(missedInput.attained, false, "declared file matched but resolved input literal did not");
  const notDispatched = receipt("orchestrator");
  notDispatched.orchestrator.dispatched = false;
  const control = assessReusableCallReceipt(notDispatched, "orchestrator", assessContract);
  assert.equal(control.eligible, true, "a policy-admitted trigger remains an invocation opportunity regardless of outcome");
  assert.equal(control.headMatches, false);
  assert.equal(control.attained, false);
});

test("reusable-call worker attainment requires head/ref match plus the full clean Git-state conjunction", () => {
  const result = assessReusableCallReceipt(receipt("worker"), "worker", assessContract);
  assert.equal(result.headMatches, true);
  assert.equal(result.attained, true);
  for (const [field, value] of [["clean", false], ["initialized", false], ["originPresent", false], ["visibleCommits", 0]]) {
    const row = receipt("worker");
    row.worker[field] = value;
    assert.equal(assessReusableCallReceipt(row, "worker", assessContract).attained, false, field);
  }
  for (const [field, value] of [["headSha", "c".repeat(40)], ["branch", "different-feature"]]) {
    const row = receipt("worker");
    row.worker[field] = value;
    const mismatch = assessReusableCallReceipt(row, "worker", assessContract);
    assert.equal(mismatch.headMatches, false);
    assert.equal(mismatch.attained, false);
  }
});

test("reusable-call retains independent head-match improvement without erasing missing cleanliness", () => {
  const row = receipt("worker");
  delete row.worker.clean;
  const result = assessReusableCallReceipt(row, "worker", assessContract);
  assert.equal(result.headMatches, true);
  assert.equal(result.attained, null);
  const evidence = { valid: true, assessments: [{ id: "777:1", ...result }] };
  const scoreMetric = scoreReusableCallMetric("verified-workflow-call-checkouts", "verified-workflow-call-heads");
  assert.equal(scoreMetric("verified-workflow-call-heads", evidence), 1);
  assert.equal(scoreMetric("verified-workflow-call-checkouts", evidence), null);
});

test("reusable-call tampered custody (run identity, source policy, nested lock) collapses to unknown, never a false pass", () => {
  for (const [role, modify] of [
    ["worker", (row) => { row.runSha256 = hash; }],
    ["worker", (row) => { row.sourceVerified = false; }],
    ["worker", (row) => { row.policyAdmitted = false; }],
    ["worker", (row) => { row.lockGitBlob = "d".repeat(40); }],
    ["worker", (row) => { row.attempt = 2; }],
    ["orchestrator", (row) => { row.runSha256 = hash; }],
    ["orchestrator", (row) => { row.sourceVerified = false; }],
    ["orchestrator", (row) => { delete row.orchestrator.calledWorkflowFile; }],
    ["worker", (row) => { delete row.worker.headSha; }],
  ]) {
    const row = receipt(role);
    modify(row);
    const result = assessReusableCallReceipt(row, role, assessContract);
    assert.equal(result.attained, null, `${role}:${modify}`);
  }
});

test("reusable-call scoring preserves zero, unknown, no-opportunity and duplicate-id semantics distinctly", () => {
  const scoreMetric = scoreReusableCallMetric("verified-call-workflow-invocations", "verified-call-workflow-dispatches");
  const evidence = { valid: true, assessments: [{ id: "1:1", eligible: true, attained: false, headMatches: false }] };
  assert.equal(scoreMetric("verified-call-workflow-invocations", evidence), 0);
  evidence.assessments[0].attained = null;
  assert.equal(scoreMetric("verified-call-workflow-invocations", evidence), null);
  assert.equal(scoreMetric("verified-call-workflow-invocations", { valid: true, assessments: [] }), null);
  evidence.assessments.push({ ...evidence.assessments[0] });
  assert.equal(scoreMetric("verified-call-workflow-invocations", evidence), null);
  assert.equal(scoreMetric("unknown-id", {}), null);
  assert.equal(scoreMetric("verified-call-workflow-invocations", { valid: false, assessments: [] }), null);
});

test("reusable-call modules import cleanly, declare a single primary metric each, and never call out to the network", () => {
  for (const role of ["worker", "orchestrator"]) {
    const value = reusableCallModule(role);
    assert.equal(value.definition.schemaVersion, 3);
    assert.equal(value.definition.evaluation.mode, "attainment-only");
    const primaries = value.definition.metrics.filter((metric) => metric.role === "primary");
    assert.equal(primaries.length, 1);
    for (const metric of value.definition.metrics) assert.ok(metric.presentation.legendLabel.length <= 24);
    assert.ok(!value.collectBatch.toString().includes("execFileSync"));
    assert.ok(!value.collectBatch.toString().includes("fetch("));
  }
});

test("reusable-call real acquisition honestly records a blocked Actions API transport, never fabricated rows", () => {
  for (const [role, workflowId] of [["worker", "smoke-workflow-call"], ["orchestrator", "smoke-call-workflow"]]) {
    const subDirectory = `${evidencePath}/${workflowId}`;
    const index = readCensusJson(`${subDirectory}/index.json`);
    const rows = readCensusJson(`${subDirectory}/observations.json.gz`);
    assert.equal(index.repository, "github/gh-aw");
    assert.equal(index.role, role);
    assert.equal(index.inventoryComplete, false);
    assert.equal(index.inventoryRuns, 0);
    assert.equal(rows.length, 0);
    assert.ok(Array.isArray(index.acquisitionAttempts) && index.acquisitionAttempts.length > 0);
    assert.ok(index.acquisitionAttempts.every((attempt) => attempt.ok === false));
    assert.equal(index.classification, "blocked-acquisition");
  }
});

test("reusable-call real replay returns null evidence over disjoint periods, missing is never coerced to zero", () => {
  for (const role of ["worker", "orchestrator"]) {
    const value = reusableCallModule(role);
    const metricId = value.definition.metrics.find((metric) => metric.role === "primary").id;
    const periodA = { windowStart: "2026-09-27T15:00:12Z", windowEnd: "2026-10-04T15:00:12Z", observedAt: "2026-10-04T15:00:12Z" };
    const periodB = { windowStart: "2026-10-11T15:00:12Z", windowEnd: "2026-10-18T15:00:12Z", observedAt: "2026-10-18T15:00:12Z" };
    const [resultA, resultB] = value.collectBatch([periodA, periodB]);
    assert.equal(resultA.evidence.valid, false);
    assert.equal(resultB.evidence.valid, false);
    assert.equal(value.scoreMetric(metricId, resultA.evidence), null);
    assert.equal(value.scoreMetric(metricId, resultB.evidence), null);
    assert.notDeepEqual(periodA, periodB);
  }
});

test("reusable-call retained originals verify native Git blob identity for both workflow sources", () => {
  for (const blob of [
    { id: contract.worker.sourceGitBlob }, { id: contract.worker.lockGitBlob },
    { id: contract.orchestrator.sourceGitBlob }, { id: contract.orchestrator.lockGitBlob },
  ]) {
    assert.match(blob.id, /^[a-f0-9]{40}$/);
  }
  assert.equal(contract.worker.sourceGitBlob, "4c18d992aaa8ceee3bcc4b0a5bcb505d7a79758b");
  assert.equal(contract.orchestrator.sourceGitBlob, "7e126368cd292d93519d66aa3a317c46db414a51");
  assert.equal(contract.worker.lockGitBlob, "8a4ebdd786a55296e7d7f5beeb09cade276b4db9");
  assert.equal(contract.orchestrator.lockGitBlob, "631f36c009524dfbf35a1244ad07f012e2343de0");
  assert.equal(contract.sourceRevision, "c86377ec47b38f0b5af463277ee55d1d03d08da8");
  assert.equal(contract.until, "2026-10-18T15:00:12Z");
  // Worker eligibility for workflow_call context cannot predate the
  // orchestrator's own adoption, even though the worker itself was adopted earlier.
  assert.ok(Date.parse(contract.orchestrator.adoption.adoptedAt) > Date.parse(contract.worker.adoption.adoptedAt));
  assert.equal(contract.coupling.workerEligibilityFloor, contract.orchestrator.adoption.adoptedAt);
});

test("reusable-call real replay fails closed when acquired evidence disappears or changes", () => {
  mkdirSync(path.join(root, ".cache"), { recursive: true });
  const temporary = mkdtempSync(path.join(root, ".cache", "reusable-call-integrity-"));
  const run = () => execFileSync(process.execPath, ["--input-type=module", "-e",
    `import {reusableCallModule} from ${JSON.stringify(path.join(root, "scripts/collect-reusable-call-value.mjs"))};
     reusableCallModule("worker").collectBatch([{windowStart:"2026-10-11T15:00:12Z",windowEnd:"2026-10-18T15:00:12Z",observedAt:"2026-10-18T15:00:12Z"}]);`],
  { cwd: temporary, stdio: "pipe" });
  try {
    cpSync(path.join(root, evidencePath), path.join(temporary, evidencePath), { recursive: true });
    run();
    const target = path.join(temporary, evidencePath, "smoke-workflow-call", "observations.json.gz");
    const original = readFileSync(target);
    unlinkSync(target);
    assert.throws(run, /ENOENT/);
    writeFileSync(target, original);
    const indexFile = path.join(temporary, evidencePath, "smoke-workflow-call", "index.json");
    const index = JSON.parse(readFileSync(indexFile, "utf8"));
    index.inventoryRuns = 1;
    writeFileSync(indexFile, JSON.stringify(index));
    assert.throws(run, /integrity mismatch/);
  } finally {
    rmSync(temporary, { recursive: true });
  }
});

test("reusable-call frozen interpreter self-check rejects a module tampered after authoring", () => {
  mkdirSync(path.join(root, ".cache"), { recursive: true });
  const temporary = mkdtempSync(path.join(root, ".cache", "reusable-call-interpreter-"));
  try {
    cpSync(path.join(root, evidencePath), path.join(temporary, evidencePath), { recursive: true });
    cpSync(path.join(root, "scripts"), path.join(temporary, "scripts"), { recursive: true });
    cpSync(path.join(root, ".github/skills/add-operational-value/scripts"),
      path.join(temporary, ".github/skills/add-operational-value/scripts"), { recursive: true });
    const tamperedCollector = path.join(temporary, "scripts", "collect-reusable-call-value.mjs");
    writeFileSync(tamperedCollector, `${readFileSync(tamperedCollector, "utf8")}\n// tampered\n`);
    assert.throws(() => execFileSync(process.execPath, ["--input-type=module", "-e",
      `import {reusableCallModule} from ${JSON.stringify(tamperedCollector)}; reusableCallModule("worker");`],
    { cwd: temporary, stdio: "pipe" }), /Frozen reusable-call interpreter changed/);
  } finally {
    rmSync(temporary, { recursive: true });
  }
});

test("reusable-call frozen contract and sources remain cross-verifiable against retained census digests", () => {
  assert.equal(contract.schemaVersion, 1);
  assert.equal(censusDigest(contract), readCensusJson(`${evidencePath}/smoke-workflow-call/index.json`).contractSha256);
  assert.equal(censusDigest(contract), readCensusJson(`${evidencePath}/smoke-call-workflow/index.json`).contractSha256);
  const blob = Buffer.from("hello-world");
  const id = createHash("sha1").update(`blob ${blob.length}\0`).update(blob).digest("hex");
  assert.doesNotThrow(() => verifyPublicGitBlob(blob, id));
  assert.throws(() => verifyPublicGitBlob(blob, "0".repeat(40)));
});
