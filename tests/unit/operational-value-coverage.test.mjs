import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { parse } from "yaml";
import { buildLedger, digest, fileHash, instrumentFiles, localFile, progressMetrics, readInventory, selectCohort, validatePlan, workKey } from "../../operational-value-coverage/coverage.mjs";
import { reportingChecklist, validateReport } from "../../operational-value-coverage/report.mjs";
import { readJsonArchive } from "../../.github/skills/add-operational-value/scripts/json-archive.mjs";
import { eventPulse } from "../../.github/skills/add-operational-value/scripts/pulse-model.mjs";
import { renderPulse } from "../../.github/skills/add-operational-value/scripts/render-pulse.mjs";
import { reportingChecklist as skillChecklist } from "../../.github/skills/add-operational-value/scripts/report-completeness.mjs";

const root = path.resolve(import.meta.dirname, "../..");
const portfolioPath = "docs/operational-value/gh-aw-workflows/portfolio.json.gz";
const inventory = () => readInventory(root, portfolioPath);
const pin = file => ({ path: file, sha256: fileHash(root, file) });
const source = file => readFileSync(path.join(root, file), "utf8");
const config = file => parse(/^---\n([\s\S]*?)\n---/.exec(source(file))[1]);
const modulePath = "tests/fixtures/operational-value-proof/file-diet.mjs";

function retainedPlan() {
  const { portfolio, rows } = inventory();
  const row = rows.find(item => item.id === "daily-file-diet");
  return {
    schemaVersion: 1, id: "retained-artifact-validation-only", status: "approved",
    repository: portfolio.repository, sourceRevision: portfolio.sourceRevision, until: portfolio.until,
    portfolioPath, portfolioSha256: digest(portfolio), instrumentRevision: "c576d538cf9a8463d8d8a7d1de852f90358dfa3c",
    limits: { measurementLanes: 4, cohortSize: 5, maxAttempts: 2 },
    pins: [portfolioPath, ...instrumentFiles(root), modulePath].map(pin),
    acquisition: [{ repository: portfolio.repository, until: portfolio.until, status: "retained",
      index: portfolioPath, sha256: fileHash(root, portfolioPath), reason: "Existing evidence only; no external acquisition." }],
    cohorts: [{ id: "existing-exemplar-artifact-check", lane: 1, compatibility: "Retained exemplar validation, not a new measurement.",
      workflows: [{ id: row.id, sourceGitBlob: row.gitBlob, task: "validate",
        path: modulePath, sha256: fileHash(root, modulePath), dependencies: [modulePath],
        acceptance: "Retain original contract and separately verify its existing reporting path.",
        limitations: "No new File Diet outcome or coverage is claimed.", design: "outcome-informed-retrospective" }] }],
  };
}

function manifestFor(plan) {
  const contract = plan.cohorts[0].workflows[0];
  const reports = "docs/operational-value/proof/reports";
  const timeline = `${reports}/daily-file-diet-timeline.json`;
  const definitions = `${reports}/daily-file-diet-definitions.md`;
  const pulseJson = `${reports}/daily-file-diet-pulse.json`;
  const pulseHtml = `${reports}/daily-file-diet-pulse.html`;
  const facts = `${reports}/file-diet-value-events.json`;
  const files = [timeline, definitions, pulseJson, pulseHtml, facts,
    "docs/operational-value/gh-aw-workflows/daily-file-diet-pulse.html"].map(pin);
  return {
    schemaVersion: 1, key: workKey(plan, contract), repository: plan.repository, workflow: contract.id,
    disposition: "partial", nativeEvaluated: true, metricId: "oversized", timeline, definitions, plotInput: timeline, pulseJson, pulseHtml,
    files, decision: "not-rated", cost: "not-measured",
    limitation: "Original snapshot report and lifetime structural progress are distinct; behavior/costs remain unknown.",
    checks: Object.fromEntries(reportingChecklist.map(name => [name, {
      status: name === "cost-and-unrated-decision" ? "unavailable" : "verified",
      reason: "Existing File Diet definitions and independently retained lifetime facts document this dimension; no new measurement.",
      evidence: [definitions, facts],
    }])),
  };
}

test("canonical portfolio is reconciled from checked partitions, not fixed backlog counts", () => {
  const { portfolio, rows, summary } = inventory();
  assert.equal(summary.workflows, rows.length);
  assert.equal(summary.measured, rows.filter(row => row.measurement.status === "measured").length);
  assert.equal(summary.remaining + summary.measured, summary.workflows);
  assert.equal(summary.measured, portfolio.totals.measured);
  assert.ok(summary.dispositions["evidence-unavailable"] > 0);
});

test("campaign reporting uses the portable operational-value skill without a parallel implementation", t => {
  assert.equal(reportingChecklist, skillChecklist);
  const plan = retainedPlan(), contract = plan.cohorts[0].workflows[0], manifest = manifestFor(plan);
  const temporary = mkdtempSync(path.join(tmpdir(), "value-skill-reporting-"));
  t.after(() => rmSync(temporary, { recursive: true, force: true }));
  const portable = path.join(temporary, "standalone-skill");
  cpSync(path.join(root, ".github/skills/add-operational-value"), portable, {
    recursive: true, filter: file => path.basename(file) !== "node_modules",
  });
  const checkout = path.join(temporary, "checkout");
  mkdirSync(checkout);
  for (const file of manifest.files) {
    const target = path.join(checkout, file.path);
    mkdirSync(path.dirname(target), { recursive: true });
    cpSync(path.join(root, file.path), target);
  }
  const expected = { key: workKey(plan, contract), repository: plan.repository, workflow: contract.id,
    contractSha256: contract.sha256, until: plan.until, sourcePath: `.github/workflows/${contract.id}.md` };
  writeFileSync(path.join(checkout, "expected.json"), JSON.stringify(expected));
  writeFileSync(path.join(checkout, "manifest.json"), JSON.stringify(manifest));
  const result = JSON.parse(execFileSync(process.execPath, [
    path.join(portable, "scripts/report-completeness.mjs"), checkout, "expected.json", "manifest.json",
  ], { encoding: "utf8", stdio: "pipe" }));
  assert.deepEqual(result, validateReport(root, plan, contract, manifest));
  assert.equal(existsSync(path.join(checkout, "operational-value-coverage")), false);
  assert.equal(existsSync(path.join(checkout, ".github/workflows/cao.json")), false);
  assert.equal(existsSync(path.join(portable, "node_modules")), false);
  assert.doesNotMatch(source("operational-value-coverage/report.mjs"), /eventPulse|renderPulse|timelinePulse/);
});

test("plan rejects unapproved, changed, duplicated, widened or unpinned work", () => {
  const plan = retainedPlan();
  assert.equal(validatePlan(root, plan, inventory()), plan);
  for (const mutate of [
    copy => { copy.status = "proposed"; },
    copy => { copy.until = "2026-10-19T15:00:12Z"; },
    copy => { copy.limits.measurementLanes = 5; },
    copy => { copy.limits.cohortSize = 6; },
    copy => { copy.cohorts[0].lane = 0; },
    copy => { copy.cohorts.push(copy.cohorts[0]); },
    copy => { copy.cohorts[0].workflows.push(copy.cohorts[0].workflows[0]); },
    copy => { copy.cohorts[0].workflows[0].sourceGitBlob = "f".repeat(40); },
    copy => { copy.cohorts[0].workflows[0].dependencies.push("unreviewed.mjs"); },
    copy => { copy.pins[0].sha256 = "f".repeat(64); },
    copy => { copy.pins = copy.pins.filter(item => !item.path.endsWith("/pulse-model.mjs")); },
    copy => { copy.acquisition[0].status = "fresh"; },
    copy => { copy.repository = "another/repository"; },
    copy => { copy.cohorts[0].workflows[0].task = "measure"; },
    copy => { copy.reservations = [{ id: "not-assigned", reason: "Unknown reservation." }]; },
    copy => { copy.reservations = [{ id: "daily-file-diet", reason: "" }]; },
    copy => { copy.reservations = Array(2).fill({ id: "daily-file-diet", reason: "Duplicate owner." }); },
    copy => { copy.reservations = "daily-file-diet"; },
    copy => { copy.reservations = null; },
  ]) {
    const copy = structuredClone(plan); mutate(copy);
    assert.throws(() => validatePlan(root, copy, inventory()));
  }
});

test("work ledger is restartable, phase-aware and idempotent without accepting submitted work", () => {
  const plan = retainedPlan(), contract = plan.cohorts[0].workflows[0];
  const key = workKey(plan, contract);
  const submitted = { key, attempt: 1, status: "submitted", reason: "Isolated report ready for independent validation." };
  const accepted = { key, attempt: 1, status: "accepted-partial", reason: "Human-reviewed independent integration.",
    reviewCommit: "a".repeat(40), reportManifestSha256: "b".repeat(64) };
  const empty = buildLedger(plan);
  assert.equal(selectCohort(plan, empty, 1).id, plan.cohorts[0].id);
  assert.equal(selectCohort(plan, empty, 2), null);
  assert.equal(selectCohort(plan, buildLedger(plan, [submitted]), 1), null);
  const ledger = buildLedger(plan, [submitted, accepted, accepted]);
  assert.deepEqual(ledger.summary, { assigned: 1, disposed: 1, native: 0, partial: 1, unavailable: 0 });
  assert.equal(selectCohort(plan, ledger, 1), null);
  for (const receipts of [
    [{ ...submitted, key: "f".repeat(64) }], [{ ...submitted, attempt: 2 }],
    [submitted, { ...submitted, reason: "Conflicting duplicate." }],
    [submitted, { ...accepted, reviewCommit: null }],
    [submitted, accepted, { ...submitted, attempt: 2 }],
  ]) assert.throws(() => buildLedger(plan, receipts));
  const changed = structuredClone(plan); changed.until = "2026-10-19T00:00:00Z";
  assert.notEqual(workKey(changed, contract), key);
  assert.throws(() => buildLedger(changed, [submitted]), /another frozen plan/);
});

test("bounded retry never loops blocked or exhausted work", () => {
  const plan = retainedPlan(), key = workKey(plan, plan.cohorts[0].workflows[0]);
  const event = (attempt, status) => ({ key, attempt, status, reason: "Bounded independent investigation." });
  const first = [event(1, "submitted"), event(1, "blocked")];
  assert.equal(selectCohort(plan, buildLedger(plan, first), 1), null);
  assert.throws(() => buildLedger(plan, [...first, event(2, "submitted")]));
  const rework = [...first, event(1, "rework")];
  assert.ok(selectCohort(plan, buildLedger(plan, rework), 1));
  const exhausted = [...rework, event(2, "submitted"), event(2, "rework")];
  assert.equal(selectCohort(plan, buildLedger(plan, exhausted), 1), null);
  assert.throws(() => buildLedger(plan, [...exhausted, event(3, "submitted")]));
});

test("scale feedback excludes validation-only work, unknown cost and empty denominators", () => {
  const plan = retainedPlan(), key = workKey(plan, plan.cohorts[0].workflows[0]);
  const receipts = [
    { key, attempt: 1, status: "submitted", reason: "Retained reporting check." },
    { key, attempt: 1, status: "accepted-partial", reason: "Independent reviewed evidence.",
      reviewCommit: "a".repeat(40), reportManifestSha256: "b".repeat(64) },
  ];
  const start = "2026-10-19T10:00:00Z", end = "2026-10-19T12:00:00Z";
  assert.deepEqual(progressMetrics(plan, receipts, [{ key, attempt: 1, aiCredits: 3 }], start, end), {
    acceptedNativeEvaluations: 0, acceptedPerHour: 0, creditsPerAcceptedEvaluation: null, reworkFraction: 0,
  });
  const measurement = retainedPlan();
  measurement.cohorts[0].workflows[0].task = "measure";
  const newKey = workKey(measurement, measurement.cohorts[0].workflows[0]);
  const changed = receipts.map(receipt => ({ ...receipt, key: newKey }));
  const costs = [{ key: newKey, attempt: 1, aiCredits: 3 }];
  assert.equal(progressMetrics(measurement, changed, costs, start, end).acceptedPerHour, 0.5);
  assert.equal(progressMetrics(measurement, changed, costs, start, end).creditsPerAcceptedEvaluation, 3);
  assert.equal(progressMetrics(measurement, changed, [], start, end).creditsPerAcceptedEvaluation, null);
  assert.equal(progressMetrics(measurement, changed, [{ ...costs[0], aiCredits: null }], start, end).creditsPerAcceptedEvaluation, null);
  assert.throws(() => progressMetrics(measurement, changed, [...costs, ...costs], start, end), /Duplicate/);
});

test("existing File Diet timeline, definitions and plots satisfy reporting path without new acquisition or scoring", () => {
  const plan = retainedPlan(), contract = plan.cohorts[0].workflows[0], manifest = manifestFor(plan);
  const result = validateReport(root, plan, contract, manifest);
  assert.equal(result.disposition, "partial");
  const events = readJsonArchive(path.join(root, "docs/operational-value/proof/reports/file-diet-value-events.json"));
  const published = source("docs/operational-value/gh-aw-workflows/daily-file-diet-pulse.html");
  assert.equal(published, renderPulse(eventPulse(events)), "Published lifetime plot must match retained facts");
  assert.equal(events.events.reduce((total, item) => total + item.value, 0), 48);
  assert.ok(events.limitations.some(value => value.includes("13")));
  for (const mutate of [
    copy => { delete copy.checks["history-and-missing-versus-zero"]; },
    copy => { copy.files[0].sha256 = "f".repeat(64); },
    copy => { copy.key = "f".repeat(64); },
    copy => { copy.checks["html-and-json-plot"].evidence = ["unretained.txt"]; },
    copy => { copy.pulseJson = copy.timeline; },
    copy => { copy.pulseHtml = "docs/operational-value/gh-aw-workflows/daily-file-diet-pulse.html"; },
    copy => { copy.disposition = "unavailable"; },
    copy => { copy.metricId = "not-a-native-metric"; },
  ]) {
    const copy = structuredClone(manifest); mutate(copy);
    assert.throws(() => validateReport(root, plan, contract, copy));
  }
});

test("gap reports finish disposition but cannot claim native evaluation", () => {
  const plan = retainedPlan(), contract = plan.cohorts[0].workflows[0], manifest = manifestFor(plan);
  Object.assign(manifest, { disposition: "unavailable", nativeEvaluated: false, blocker: "Required historical originals expired." });
  assert.equal(validateReport(root, plan, contract, manifest).disposition, "unavailable");
  manifest.nativeEvaluated = true;
  assert.throws(() => validateReport(root, plan, contract, manifest), /not native/);
});

test("paths fail closed on traversal and symlinks", () => {
  const temporary = mkdtempSync(path.join(tmpdir(), "coverage-path-"));
  try {
    writeFileSync(path.join(temporary, "safe.json"), "{}");
    symlinkSync(path.join(root, "package.json"), path.join(temporary, "escape.json"));
    assert.ok(localFile(temporary, "safe.json"));
    for (const file of ["../package.json", "/package.json", "a\\b", "escape.json"]) {
      assert.throws(() => localFile(temporary, file));
    }
  } finally { rmSync(temporary, { recursive: true, force: true }); }
});

test("package is complete, review-disabled and has no schedule or global measurement write path", () => {
  const descriptor = JSON.parse(source("operational-value-coverage/cao.json"));
  const manifest = parse(source("operational-value-coverage/aw.yml"));
  const policy = JSON.parse(source(".github/workflows/cao.json"))["control-plane"].campaigns["operational-value-coverage"];
  assert.equal(policy.enabled, false);
  assert.equal(policy.mode, "review");
  const workflows = [descriptor.orchestrator, ...Object.values(descriptor.workers)];
  assert.deepEqual(manifest.includes.filter(file => file.endsWith(".md") && file.startsWith(".github/")),
    workflows.map(id => `.github/workflows/${id}.md`));
  for (const id of workflows) {
    const file = `.github/workflows/${id}.md`, cfg = config(file);
    assert.ok(!cfg.on.schedule);
    assert.equal(cfg.strict, true);
    assert.equal(cfg.concurrency["cancel-in-progress"], false);
    assert.ok(source(file).trimEnd().endsWith("{{#runtime-import? .github/cao/operational-value-coverage.md}}"));
    if (id === descriptor.orchestrator) continue;
    const worker = Object.entries(descriptor.workers).find(([, value]) => value === id)[0];
    assert.equal(policy.workers[worker].enabled, false);
    assert.equal(policy.workers[worker]["max-mode"], "review");
    assert.deepEqual(cfg.on.workflow_dispatch.inputs.safe_output_mode, { required: true, type: "string" });
    assert.ok(!cfg["safe-outputs"]["dispatch-workflow"]);
    if (worker.startsWith("measure-")) assert.deepEqual(cfg["safe-outputs"]["create-pull-request"]["allowed-files"],
      [`operational-value-coverage/work/${worker}/**`]);
  }
  const output = execFileSync(process.execPath, ["operational-value-coverage/coverage.mjs", "inventory", ".", portfolioPath],
    { cwd: root, encoding: "utf8" });
  assert.equal(JSON.parse(output).remaining, inventory().summary.remaining);
});
