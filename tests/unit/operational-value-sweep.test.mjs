import assert from "node:assert/strict";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { gzipSync } from "node:zlib";
import { parse } from "yaml";
import { buildLedger, digest, fileHash, instrumentFiles, readInventory, selectCohort, workKey } from "../../operational-value-coverage/coverage.mjs";
import { inspectSweep, sweepDecision } from "../../operational-value-coverage/sweep.mjs";

const root = path.resolve(import.meta.dirname, "../..");
const control = "githubnext/gh-aw-cao";
const sha = "a".repeat(40);
const hash = "b".repeat(64);
function fixture(count = 8) {
  const rows = Array.from({ length: count }, (_, i) => ({
    id: `workflow-${i}`, path: `.github/workflows/workflow-${i}.md`, gitBlob: sha,
    measurement: { status: "outcome-contract-needed" },
  }));
  const plan = { schemaVersion: 1, scope: "full-inventory", id: "full-first-pass", status: "approved",
    repository: "github/gh-aw", sourceRevision: sha, until: "2026-10-18T15:00:12Z",
    cohorts: rows.map((row, i) => ({ id: `cohort-${i}`, lane: i % 4 + 1, compatibility: "Independent source contracts.",
      workflows: [{ id: row.id, sourceGitBlob: sha, sha256: hash, task: "measure" }] })) };
  return { plan, inventory: { rows }, receipts: [] };
}
const key = (plan, index) => workKey(plan, plan.cohorts[index].workflows[0]);
const proposal = (plan, index, { state = "open", merged = false, attempt = 1 } = {}) => ({
  state, body: `<!-- value-coverage-work:${key(plan, index)}:${attempt} -->`,
  pull_request: { merged_at: merged ? "2026-10-19T12:00:00Z" : null },
});
const event = (plan, index, status, attempt = 1) => ({ key: key(plan, index), attempt, status, reason: "Reviewed evidence.",
  ...(["accepted-native", "accepted-partial", "unavailable"].includes(status)
    ? { reviewCommit: sha, reportManifestSha256: hash } : {}) });

test("automatic sweep covers the whole inventory and keeps all four lanes fed without a pilot", () => {
  const { plan, inventory } = fixture();
  const first = sweepDecision(plan, inventory, []);
  assert.equal(first.dispatch, true);
  assert.equal(first.summary.assigned, 8);
  assert.deepEqual(first.readyCohorts.map(item => item.cohort), ["cohort-0", "cohort-1", "cohort-2", "cohort-3"]);
  const claimed = sweepDecision(plan, inventory, [], { pullRequests: [proposal(plan, 0)] });
  assert.equal(claimed.readyCohorts.find(item => item.lane === 1).cohort, "cohort-4");
  const narrowed = structuredClone(plan); narrowed.cohorts.pop();
  assert.throws(() => sweepDecision(narrowed, inventory, []), /every workflow/);
  assert.throws(() => sweepDecision({ ...plan, scope: "pilot" }, inventory, []), /not a pilot/);
});

test("the retained canonical inventory is fully assigned and measured entries remain validation-only", () => {
  const inventory = readInventory(root, "docs/operational-value/gh-aw-workflows/portfolio.json.gz");
  const { plan } = fixture(inventory.rows.length);
  plan.cohorts.forEach((cohort, i) => {
    cohort.workflows[0].id = inventory.rows[i].id;
    cohort.workflows[0].sourceGitBlob = inventory.rows[i].gitBlob;
    cohort.workflows[0].task = inventory.rows[i].measurement.status === "measured" ? "validate" : "author";
  });
  plan.reservations = [
    "artifacts-summary", "avenger", "blog-auditor", "cli-consistency-checker",
    "daily-aw-cross-repo-compile-check", "daily-cli-performance", "daily-credit-limit-test",
    "daily-model-inventory", "daily-model-resolution", "daily-observability-report",
    "daily-safe-outputs-conformance", "daily-syntax-error-quality", "step-name-alignment",
    "weekly-editors-health-check", "workflow-normalizer",
    "go-logger", "go-pattern-detector", "daily-testify-uber-super-expert",
    "metrics-collector", "daily-firewall-report", "daily-code-debt-aider", "code-simplifier",
  ].map(id => ({ id, reason: "Reserved by source-session handoffs; reconcile before remote work on this baseline." }));
  const result = sweepDecision(plan, inventory, []);
  assert.equal(result.summary.assigned, inventory.rows.length);
  assert.equal(result.reservations.length, 22);
  const reserved = new Set(plan.reservations.map(reservation => {
    const cohort = plan.cohorts.find(item => item.workflows[0].id === reservation.id);
    return workKey(plan, cohort.workflows[0]);
  }));
  assert.ok(result.readyCohorts.every(cohort => cohort.keys.every(item => !reserved.has(item))));
  assert.ok([...reserved].every(item => result.excludedKeys.includes(item)));
  const exemplar = plan.cohorts.find(cohort => cohort.workflows[0].id === "daily-file-diet");
  assert.equal(exemplar.workflows[0].task, "validate");
  exemplar.workflows[0].task = "author";
  assert.throws(() => sweepDecision(plan, inventory, []), /validation-only/);
});

test("busy lanes do not enqueue duplicates and workers can inspect their own assignment", () => {
  const { plan, inventory } = fixture();
  const runs = [{ path: ".github/workflows/value-coverage-measure-1.lock.yml", status: "in_progress" }];
  assert.equal(sweepDecision(plan, inventory, [], { runs }).readyCohorts.length, 3);
  assert.equal(sweepDecision(plan, inventory, [], { runs, workerLane: 1 }).readyCohorts.length, 4);
  runs.push({ path: ".github/workflows/operational-value-coverage.lock.yml", status: "queued" });
  assert.equal(sweepDecision(plan, inventory, [], { runs }).dispatch, false);
  assert.equal(sweepDecision(plan, inventory, [], { enabledWorkers: [] }).dispatch, false);
  assert.equal(sweepDecision(plan, inventory, [], {
    runs: [{ path: ".github/workflows/value-coverage-skill.lock.yml", status: "in_progress" }],
  }).readyCohorts.length, 0);
});

test("reviewed reservations exclude external owners without consuming attempts or completing work", () => {
  const { plan, inventory } = fixture(5);
  plan.reservations = [{ id: "workflow-0", reason: "Reserved by an active local cohort; await its handoff." }];
  const result = sweepDecision(plan, inventory, []);
  assert.equal(result.readyCohorts.find(item => item.lane === 1).cohort, "cohort-4");
  assert.ok(result.excludedKeys.includes(key(plan, 0)));
  assert.deepEqual(result.reservations, plan.reservations);
  const ledger = buildLedger(plan);
  assert.equal(ledger.entries[0].attempts, 0);
  assert.equal(ledger.summary.disposed, 0);
  assert.equal(selectCohort(plan, ledger, 1).id, "cohort-4");
  assert.equal(sweepDecision(plan, inventory, [], {
    pullRequests: [proposal(plan, 0, { state: "closed", merged: true })],
  }).integrationKeys.length, 0);
  plan.reservations = inventory.rows.map(row => ({ id: row.id, reason: "Await the separately owned work." }));
  assert.equal(sweepDecision(plan, inventory, []).state, "blocked");
  assert.equal(sweepDecision(plan, inventory, []).dispatch, false);
});

test("open proposals wait for review while merged staging wakes independent integration", () => {
  const { plan, inventory } = fixture(1);
  const open = sweepDecision(plan, inventory, [], { pullRequests: [proposal(plan, 0)] });
  assert.equal(open.dispatch, false);
  assert.equal(open.state, "waiting-for-review");
  const merged = sweepDecision(plan, inventory, [], {
    pullRequests: [proposal(plan, 0, { state: "closed", merged: true })],
  });
  assert.equal(merged.dispatch, true);
  assert.deepEqual(merged.integrationKeys, [key(plan, 0)]);
  const integration = { state: "open", body: merged.integrationMarker, pull_request: { merged_at: null } };
  assert.equal(sweepDecision(plan, inventory, [], {
    pullRequests: [proposal(plan, 0, { state: "closed", merged: true }), integration],
  }).dispatch, false);
  integration.state = "closed";
  assert.equal(sweepDecision(plan, inventory, [], {
    pullRequests: [proposal(plan, 0, { state: "closed", merged: true }), integration],
  }).dispatch, false, "Rejected integration must not spin until reviewed receipts change");
});

test("rejected staging needs reviewed rework and never becomes an automatic retry loop", () => {
  const { plan, inventory } = fixture(1);
  const pullRequests = [proposal(plan, 0, { state: "closed" })];
  assert.equal(sweepDecision(plan, inventory, [], { pullRequests }).dispatch, false);
  const reviewed = [event(plan, 0, "submitted"), event(plan, 0, "rework")];
  assert.equal(sweepDecision(plan, inventory, reviewed, { pullRequests }).dispatch, true);
  reviewed.push(event(plan, 0, "submitted", 2), event(plan, 0, "rework", 2));
  const exhausted = sweepDecision(plan, inventory, reviewed, { pullRequests });
  assert.equal(exhausted.dispatch, false);
  assert.equal(exhausted.state, "blocked");
});

test("merged authoring proposals wait for the approved measurement plan after one submitted receipt", () => {
  const { plan, inventory } = fixture(1);
  plan.cohorts[0].workflows[0].task = "author";
  const pullRequests = [proposal(plan, 0, { state: "closed", merged: true })];
  assert.equal(sweepDecision(plan, inventory, [], { pullRequests }).dispatch, true);
  const result = sweepDecision(plan, inventory, [event(plan, 0, "submitted")], { pullRequests });
  assert.equal(result.dispatch, false);
  assert.equal(result.state, "waiting-for-review");
  assert.equal(result.integrationKeys.length, 0);
});

test("only reviewed final dispositions complete the sweep; contract proposals are not native results", () => {
  const { plan, inventory } = fixture(2);
  const receipts = [event(plan, 0, "submitted"), event(plan, 0, "accepted-partial"), event(plan, 1, "unavailable")];
  const result = sweepDecision(plan, inventory, receipts);
  assert.equal(result.state, "complete");
  assert.equal(result.dispatch, false);
  assert.equal(result.summary.disposed, inventory.rows.length);
  plan.cohorts[0].workflows[0].task = "author";
  assert.throws(() => sweepDecision(plan, inventory, [
    event(plan, 0, "submitted"), event(plan, 0, "accepted-native"),
  ]), /not contract authoring/);
});

function workspace(t) {
  const directory = mkdtempSync(path.join(tmpdir(), "value-coverage-sweep-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const write = (file, value) => {
    mkdirSync(path.dirname(path.join(directory, file)), { recursive: true });
    writeFileSync(path.join(directory, file), JSON.stringify(value));
  };
  const policy = JSON.parse(readFileSync(path.join(root, ".github/workflows/cao.json"), "utf8"));
  policy["control-plane"].campaigns["operational-value-coverage"].enabled = true;
  for (const worker of Object.values(policy["control-plane"].campaigns["operational-value-coverage"].workers)) worker.enabled = true;
  write(".github/workflows/cao.json", policy);
  return { directory, write };
}

test("disabled, missing and proposed plans never call the API or start agents", t => {
  const github = () => { throw new Error("Unexpected API call"); };
  assert.equal(inspectSweep(root, control, { github }).state, "campaign-disabled");
  const { directory, write } = workspace(t);
  assert.equal(inspectSweep(directory, control, { github }).state, "awaiting-plan");
  write(".github/cao/operational-value-coverage/active.json", { status: "proposed" });
  assert.equal(inspectSweep(directory, control, { github }).state, "awaiting-plan-review");
});

test("enabled inspection validates pins, reads paginated work metadata, and fails visibly on API errors", t => {
  const { directory, write } = workspace(t);
  for (const file of instrumentFiles(root)) {
    mkdirSync(path.dirname(path.join(directory, file)), { recursive: true });
    cpSync(path.join(root, file), path.join(directory, file));
  }
  const { plan, inventory } = fixture(1);
  plan.cohorts[0].workflows[0] = { ...plan.cohorts[0].workflows[0], task: "author", path: "contract.json",
    dependencies: ["contract.json"], acceptance: "Propose a contract before measurement.",
    limitations: "No native measurement is approved.", design: "ex-ante" };
  write("contract.json", { kind: "authoring-brief-only" });
  const partition = inventory.rows;
  mkdirSync(path.join(directory, "frozen"), { recursive: true });
  writeFileSync(path.join(directory, "frozen/workflows-001.json.gz"), gzipSync(JSON.stringify(partition)));
  const portfolio = { kind: "workflow-value-portfolio", repository: plan.repository, sourceRevision: sha, until: plan.until,
    totals: { workflows: 1, measured: 0 }, partitions: [{ file: "workflows-001.json.gz", count: 1, sha256: digest(partition) }] };
  write("frozen/portfolio.json", portfolio);
  Object.assign(plan, { portfolioPath: "frozen/portfolio.json", portfolioSha256: digest(portfolio),
    instrumentRevision: sha, limits: { measurementLanes: 4, cohortSize: 5, maxAttempts: 2 }, acquisition: [],
    pins: [...instrumentFiles(directory), "contract.json", "frozen/portfolio.json", "frozen/workflows-001.json.gz"]
      .map(file => ({ path: file, sha256: fileHash(directory, file) })) });
  plan.cohorts[0].workflows[0].sha256 = fileHash(directory, "contract.json");
  write(".github/cao/operational-value-coverage/active.json", plan);
  write(".github/cao/operational-value-coverage/receipts.json", []);
  const routes = [];
  const github = route => { routes.push(route); return route.includes("/issues?") ? [[]] : [{ workflow_runs: [] }]; };
  assert.equal(inspectSweep(directory, control, { github }).dispatch, true);
  assert.equal(routes.length, 6);
  assert.ok(routes.every(route => route.startsWith(`repos/${control}/`)));
  assert.throws(() => inspectSweep(directory, control, { github: () => { throw new Error("API unavailable"); } }), /API unavailable/);
  const noApi = () => { throw new Error("Terminal/blocked ledgers must not call the API"); };
  write(".github/cao/operational-value-coverage/active.json", { ...plan,
    reservations: [{ id: "workflow-0", reason: "Separately owned local cohort." }] });
  assert.equal(inspectSweep(directory, control, { github: noApi }).state, "blocked");
  write(".github/cao/operational-value-coverage/active.json", plan);
  write(".github/cao/operational-value-coverage/receipts.json", [event(plan, 0, "unavailable")]);
  assert.equal(inspectSweep(directory, control, { github: noApi }).state, "complete");
  write(".github/cao/operational-value-coverage/receipts.json", [event(plan, 0, "submitted"), event(plan, 0, "blocked")]);
  assert.equal(inspectSweep(directory, control, { github: noApi }).state, "blocked");
  write(".github/cao/operational-value-coverage/receipts.json", []);
  write("contract.json", { changed: true });
  assert.throws(() => inspectSweep(directory, control, { github }), /Pinned file changed/);
});

test("the packaged controller uses built-in authentication and the existing gh-aw run boundary without a spending cap", () => {
  const workflow = parse(readFileSync(path.join(root, ".github/workflows/value-coverage-pump.yml"), "utf8"));
  assert.deepEqual(workflow.on.schedule, [{ cron: "*/15 * * * *" }]);
  const steps = workflow.jobs.pump.steps;
  assert.ok(steps.some(step => step.run?.includes("gh aw run operational-value-coverage")));
  assert.ok(steps.filter(step => step.env?.GH_TOKEN).every(step => step.env.GH_TOKEN === "${{ github.token }}"));
  assert.ok(steps.filter(step => step.name.includes("gh-aw") || step.name.includes("Wake"))
    .every(step => step.if === "steps.sweep.outputs.dispatch == 'true'"));
  assert.doesNotMatch(JSON.stringify(workflow), /monthly-ai-credit-budget|max-ai-credits|--auto-merge|secrets\./);
  const manifest = parse(readFileSync(path.join(root, "operational-value-coverage/aw.yml"), "utf8"));
  assert.ok(manifest.includes.includes(".github/workflows/value-coverage-pump.yml"));
});
