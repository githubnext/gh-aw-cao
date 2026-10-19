import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { appendFileSync, existsSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { effectivePolicy, loadPolicyFile } from "../.github/workflows/shared/policy.mjs";
import { readJsonArchive } from "../.github/skills/add-operational-value/scripts/json-archive.mjs";
import { buildLedger, digest, localFile, readInventory, selectCohort, validatePlan } from "./coverage.mjs";

const stateDirectory = ".github/cao/operational-value-coverage";
const campaignName = "operational-value-coverage";
const terminal = new Set(["accepted-native", "accepted-partial", "unavailable"]);
const activeStatuses = ["requested", "pending", "queued", "waiting", "in_progress"];
const workerId = lane => `value-coverage-measure-${lane}`;
const workflowId = run => path.posix.basename(run.path).replace(/(?:\.lock)?\.yml$/, "");

export function sweepDecision(plan, inventory, receipts, {
  runs = [], pullRequests = [], workerLane = null,
  enabledWorkers = [...[1, 2, 3, 4].map(workerId), "value-coverage-integrate"],
} = {}) {
  assert.equal(plan.scope, "full-inventory", "Automatic sweep requires the full inventory, not a pilot");
  const assigned = plan.cohorts.flatMap(cohort => cohort.workflows.map(contract => contract.id));
  assert.equal(assigned.length, inventory.rows.length, "Full sweep must account for every workflow");
  assert.deepEqual([...assigned].sort(), inventory.rows.map(row => row.id).sort());
  assert.ok(inventory.rows.filter(row => row.measurement.status === "measured").every(row =>
    plan.cohorts.some(cohort => cohort.workflows.some(contract => contract.id === row.id && contract.task === "validate"))),
  "Existing measurements are validation-only, never new measurements or replacement contracts");
  assert.ok(workerLane === null || (Number.isInteger(workerLane) && workerLane >= 1 && workerLane <= 4));
  const ledger = buildLedger(plan, receipts);
  const result = { dispatch: false, state: "waiting-for-review", target: plan.repository,
    planSha256: digest(plan), summary: ledger.summary, readyCohorts: [], integrationKeys: [], excludedKeys: [],
    integrationMarker: `<!-- value-coverage-integration:${digest(plan)}:${digest(receipts)} -->` };
  if (ledger.entries.every(entry => terminal.has(entry.status))) return { ...result, state: "complete" };

  const busy = new Set(runs.filter(run => activeStatuses.includes(run.status)).map(workflowId));
  const claims = pullRequests.flatMap(pr => [...pr.body.matchAll(
    /<!-- value-coverage-work:([a-f0-9]{64}):([12]) -->/g,
  )].map(match => ({ key: match[1], attempt: Number(match[2]), open: pr.state === "open", merged: Boolean(pr.pull_request.merged_at) })));
  for (const entry of ledger.entries.filter(item => !terminal.has(item.status))) {
    const attempt = entry.status === "submitted" ? entry.attempts : entry.attempts + 1;
    const relevant = claims.filter(claim => claim.key === entry.key && (claim.open || claim.attempt === attempt));
    if (entry.status === "submitted" || relevant.length > 0) result.excludedKeys.push(entry.key);
    if (relevant.some(claim => claim.merged && claim.attempt === attempt)
      && ["pending", "rework", "submitted"].includes(entry.status)
      && !(entry.task === "author" && entry.status === "submitted")) result.integrationKeys.push(entry.key);
  }
  const excluded = new Set(result.excludedKeys);
  for (let lane = 1; lane <= 4; lane += 1) {
    if (!enabledWorkers.includes(workerId(lane)) || busy.has("value-coverage-skill")) continue;
    if (busy.has(workerId(lane)) && workerLane !== lane) continue;
    const cohort = selectCohort(plan, ledger, lane, result.excludedKeys);
    if (cohort) result.readyCohorts.push({ lane, cohort: cohort.id,
      keys: ledger.entries.filter(entry => entry.cohort === cohort.id && !excluded.has(entry.key)
        && ["pending", "rework"].includes(entry.status) && entry.attempts < 2).map(entry => entry.key) });
  }
  const integrationOpen = pullRequests.some(pr => pr.state === "open"
    && pr.body.includes(`<!-- value-coverage-integration:${result.planSha256}:`));
  const integrationAlreadyProposed = pullRequests.some(pr => pr.body.includes(result.integrationMarker));
  const integrationReady = result.integrationKeys.length > 0 && !integrationOpen && !integrationAlreadyProposed
    && !busy.has("value-coverage-integrate") && enabledWorkers.includes("value-coverage-integrate");
  if (result.readyCohorts.length || integrationReady) {
    result.dispatch = !busy.has(campaignName);
    result.state = result.dispatch ? "ready" : "running";
  } else if (busy.size) result.state = "running";
  else if (ledger.entries.some(entry => !terminal.has(entry.status))
    && ledger.entries.filter(entry => !terminal.has(entry.status)).every(entry =>
      entry.status === "blocked" || (entry.status === "rework" && entry.attempts >= 2))) result.state = "blocked";
  return result;
}

function githubPages(route) {
  const pages = JSON.parse(execFileSync("gh", ["api", "--paginate", "--slurp", route], {
    encoding: "utf8", maxBuffer: 32 * 1024 * 1024,
  }));
  assert.ok(Array.isArray(pages), "Expected GitHub API pages");
  return pages;
}

export function inspectSweep(root, controlRepository, { workerLane = null, github = githubPages } = {}) {
  assert.match(controlRepository, /^[A-Za-z0-9][A-Za-z0-9-]*\/[A-Za-z0-9._-]+$/);
  const document = loadPolicyFile(localFile(root, ".github/workflows/cao.json"));
  const policy = effectivePolicy(document, {
    campaignName, role: "orchestrator", controlRepository, requestedMode: "review",
  });
  if (!policy.authorized) return { dispatch: false, state: policy.reason };
  const planPath = `${stateDirectory}/active.json`;
  if (!existsSync(path.join(root, planPath))) return { dispatch: false, state: "awaiting-plan" };
  const plan = readJsonArchive(localFile(root, planPath));
  if (plan.status === "proposed") return { dispatch: false, state: "awaiting-plan-review" };
  assert.match(plan.repository, /^[A-Za-z0-9][A-Za-z0-9-]*\/[A-Za-z0-9._-]+$/);
  const inventory = readInventory(root, plan.portfolioPath);
  validatePlan(root, plan, inventory);
  const receipts = readJsonArchive(localFile(root, `${stateDirectory}/receipts.json`));
  const enabledWorkers = Object.entries(policy.worker_policies)
    .filter(([, worker]) => worker.enabled).map(([workflow]) => workflow);
  const preliminary = sweepDecision(plan, inventory, receipts, { enabledWorkers });
  if (preliminary.state === "complete" || preliminary.state === "blocked") return preliminary;
  const runs = activeStatuses.flatMap(status => github(
    `repos/${controlRepository}/actions/runs?status=${status}&per_page=100`,
  ).flatMap(page => page.workflow_runs)).filter(run =>
    [campaignName, "value-coverage-integrate", "value-coverage-skill", ...[1, 2, 3, 4].map(workerId)].includes(workflowId(run)));
  const pullRequests = github(
    `repos/${controlRepository}/issues?state=all&labels=operational-value-coverage&per_page=100`,
  ).flat().filter(issue => issue.pull_request).map(issue => ({ ...issue, body: issue.body ?? "" }));
  return sweepDecision(plan, inventory, receipts, { runs, pullRequests, workerLane, enabledWorkers });
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const [root, repository, lane, ...extra] = process.argv.slice(2);
  assert.ok(root && repository && !extra.length, "usage: sweep.mjs ROOT CONTROL_REPOSITORY [WORKER_LANE]");
  const result = inspectSweep(root, repository, { workerLane: lane === undefined ? null : Number(lane) });
  console.log(JSON.stringify(result, null, 2));
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT,
    `dispatch=${result.dispatch}\ntarget=${result.target ?? ""}\n`);
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY,
    `## Value Coverage sweep\n\nState: **${result.state}**\n\n`
    + (result.summary ? `Disposed: ${result.summary.disposed}/${result.summary.assigned}. `
      + `Ready lanes: ${result.readyCohorts.length}. Submitted integration candidates: ${result.integrationKeys.length}.\n` : ""));
}
