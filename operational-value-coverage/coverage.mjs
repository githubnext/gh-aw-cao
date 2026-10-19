import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { lstatSync, readFileSync, readdirSync, realpathSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { readJsonArchive } from "../.github/skills/add-operational-value/scripts/json-archive.mjs";

export const digest = value => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const sha = value => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
const gitSha = value => typeof value === "string" && /^[a-f0-9]{40}$/.test(value);
const slug = value => typeof value === "string" && /^[a-z0-9][a-z0-9-]*$/.test(value);
const utc = value => typeof value === "string" && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/.test(value)
  && Number.isFinite(Date.parse(value));
const nonempty = value => typeof value === "string" && value.trim().length > 0;

export function localFile(root, file) {
  assert.ok(typeof file === "string" && file.length > 0 && !file.includes("\\")
    && !path.isAbsolute(file) && file.split("/").every(part => part && part !== "." && part !== ".."),
  "Expected a repository-relative file");
  const base = realpathSync(root);
  const resolved = path.join(base, file);
  assert.ok(!lstatSync(resolved).isSymbolicLink() && lstatSync(resolved).isFile(), "Expected a regular file");
  assert.ok(realpathSync(resolved).startsWith(`${base}${path.sep}`), "File escapes repository");
  return resolved;
}

export function fileHash(root, file) {
  return createHash("sha256").update(readFileSync(localFile(root, file))).digest("hex");
}

export function verifyPins(root, pins) {
  assert.ok(Array.isArray(pins) && pins.length > 0 && pins.length <= 4096, "Missing bounded file pins");
  assert.equal(new Set(pins.map(pin => pin.path)).size, pins.length, "Duplicate file pin");
  for (const pin of pins) {
    assert.ok(sha(pin.sha256), "Invalid file digest");
    assert.equal(fileHash(root, pin.path), pin.sha256, `Pinned file changed: ${pin.path}`);
  }
}

export function instrumentFiles(root) {
  const skill = ".github/skills/add-operational-value";
  return [
    `${skill}/SKILL.md`, `${skill}/references/module-contract.md`,
    ...readdirSync(path.join(root, skill, "scripts")).sort().map(file => `${skill}/scripts/${file}`),
    "operational-value-coverage/coverage.mjs", "operational-value-coverage/report.mjs",
    "operational-value-coverage/sweep.mjs", ".github/workflows/value-coverage-pump.yml",
  ];
}

export function readInventory(root, portfolioPath) {
  const portfolio = readJsonArchive(localFile(root, portfolioPath));
  assert.equal(portfolio.kind, "workflow-value-portfolio");
  assert.ok(gitSha(portfolio.sourceRevision) && utc(portfolio.until));
  assert.ok(Array.isArray(portfolio.partitions) && portfolio.partitions.length > 0
    && portfolio.partitions.length <= 128, "Invalid portfolio partitions");
  assert.equal(new Set(portfolio.partitions.map(part => part.file)).size, portfolio.partitions.length);
  const rows = portfolio.partitions.flatMap(part => {
    assert.match(part.file, /^workflows-\d{3}\.json\.gz$/);
    const data = readJsonArchive(localFile(root, path.posix.join(path.posix.dirname(portfolioPath), part.file)));
    assert.equal(digest(data), part.sha256, "Portfolio partition changed");
    assert.ok(Array.isArray(data) && data.length === part.count);
    return data;
  });
  assert.equal(new Set(rows.map(row => row.id)).size, rows.length, "Duplicate workflow");
  assert.equal(rows.length, portfolio.totals.workflows);
  assert.ok(rows.every(row => slug(row.id) && gitSha(row.gitBlob)
    && row.path === `.github/workflows/${row.id}.md` && nonempty(row.measurement?.status)));
  const measured = rows.filter(row => row.measurement.status === "measured").length;
  assert.equal(measured, portfolio.totals.measured, "Portfolio totals changed");
  return { portfolio, rows, summary: {
    repository: portfolio.repository, sourceRevision: portfolio.sourceRevision, until: portfolio.until,
    workflows: rows.length, measured, remaining: rows.length - measured,
    dispositions: Object.fromEntries([...new Set(rows.map(row => row.measurement.status))].sort()
      .map(status => [status, rows.filter(row => row.measurement.status === status).length])),
  } };
}

export function validatePlan(root, plan, inventory, { requireApproved = true } = {}) {
  assert.equal(plan.schemaVersion, 1);
  assert.ok(slug(plan.id) && ["proposed", "approved"].includes(plan.status));
  if (requireApproved) assert.equal(plan.status, "approved", "Plan requires a reviewed merge before execution");
  assert.equal(plan.repository, inventory.portfolio.repository);
  assert.equal(plan.sourceRevision, inventory.portfolio.sourceRevision);
  assert.equal(plan.until, inventory.portfolio.until, "Plan cutoff differs from inventory");
  assert.equal(plan.portfolioSha256, digest(inventory.portfolio));
  assert.ok(nonempty(plan.portfolioPath), "Missing pinned portfolio path");
  assert.ok(plan.pins?.some(pin => pin.path === plan.portfolioPath), "Portfolio must be pinned");
  assert.ok(gitSha(plan.instrumentRevision), "Missing immutable instrument revision");
  assert.deepEqual(plan.limits, { measurementLanes: 4, cohortSize: 5, maxAttempts: 2 });
  verifyPins(root, plan.pins);
  assert.ok(instrumentFiles(root).every(file => plan.pins.some(pin => pin.path === file)),
    "Missing pipeline/skill implementation pins");
  assert.ok(Array.isArray(plan.cohorts) && plan.cohorts.length <= 1024);
  const workflows = new Map(inventory.rows.map(row => [row.id, row]));
  const assigned = new Set();
  const cohortIds = new Set();
  for (const cohort of plan.cohorts) {
    assert.ok(slug(cohort.id) && !cohortIds.has(cohort.id), "Invalid or duplicate cohort");
    cohortIds.add(cohort.id);
    assert.ok(Number.isInteger(cohort.lane) && cohort.lane >= 1 && cohort.lane <= 4);
    assert.ok(nonempty(cohort.compatibility), "Explain shared evidence, never share outcome formulas");
    assert.ok(Array.isArray(cohort.workflows) && cohort.workflows.length >= 1 && cohort.workflows.length <= 5);
    for (const contract of cohort.workflows) {
      const row = workflows.get(contract.id);
      assert.ok(row && !assigned.has(contract.id), "Duplicate or unknown workflow assignment");
      assigned.add(contract.id);
      assert.equal(contract.sourceGitBlob, row.gitBlob);
      assert.ok(["author", "measure", "validate"].includes(contract.task));
      assert.ok(contract.task !== "measure" || row.measurement.status !== "measured",
        "Already measured workflows may be validated, never counted as new measurements");
      assert.ok(nonempty(contract.acceptance) && nonempty(contract.limitations)
        && ["ex-ante", "outcome-informed-retrospective"].includes(contract.design));
      assert.ok(plan.pins.some(pin => pin.path === contract.path && pin.sha256 === contract.sha256),
        "Contract must be pinned before inspection or execution");
      assert.ok(Array.isArray(contract.dependencies) && contract.dependencies.length > 0);
      assert.ok(contract.dependencies.every(file => plan.pins.some(pin => pin.path === file)),
        "Pin the complete evaluator/helper/oracle and retained evidence dependency closure");
    }
  }
  assert.ok(Array.isArray(plan.acquisition) && plan.acquisition.length <= 32);
  for (const acquisition of plan.acquisition) {
    assert.equal(acquisition.repository, plan.repository);
    assert.equal(acquisition.until, plan.until);
    assert.ok(["retained", "blocked"].includes(acquisition.status),
      "Fresh acquisition requires a separate reviewed producer; workers only reuse retained facts");
    assert.ok(nonempty(acquisition.reason));
    if (acquisition.status === "retained") {
      assert.ok(plan.pins.some(pin => pin.path === acquisition.index && pin.sha256 === acquisition.sha256));
    }
  }
  return plan;
}

export const workKey = (plan, contract) => digest({
  plan: digest(plan), repository: plan.repository, source: contract.sourceGitBlob,
  workflow: contract.id, contract: contract.sha256, until: plan.until,
});

export function buildLedger(plan, receipts = []) {
  assert.ok(Array.isArray(receipts) && receipts.length <= 16384, "Invalid bounded receipt log");
  const entries = plan.cohorts.flatMap(cohort => cohort.workflows.map(contract => ({
    key: workKey(plan, contract), cohort: cohort.id, lane: cohort.lane, workflow: contract.id,
    task: contract.task, status: "pending", attempts: 0, reason: null,
  })));
  const byKey = new Map(entries.map(entry => [entry.key, entry]));
  const seen = new Map();
  for (const receipt of receipts) {
    assert.ok(sha(receipt.key) && byKey.has(receipt.key), "Receipt belongs to another frozen plan");
    assert.ok(Number.isInteger(receipt.attempt) && receipt.attempt >= 1 && receipt.attempt <= 2);
    assert.ok(["submitted", "blocked", "rework", "accepted-native", "accepted-partial", "unavailable"].includes(receipt.status));
    const identity = `${receipt.key}:${receipt.attempt}:${receipt.status}`;
    if (seen.has(identity)) {
      assert.equal(seen.get(identity), digest(receipt), "Conflicting duplicate receipt");
      continue;
    }
    seen.set(identity, digest(receipt));
    assert.ok(nonempty(receipt.reason));
    const entry = byKey.get(receipt.key);
    assert.ok(!["accepted-native", "accepted-partial", "unavailable"].includes(entry.status), "Terminal work cannot be replaced");
    const nextAttempt = receipt.attempt === entry.attempts + 1;
    assert.ok((nextAttempt && ["pending", "rework"].includes(entry.status))
      || (receipt.attempt === entry.attempts && (
        (entry.status === "submitted" && ["blocked", "rework", "accepted-native", "accepted-partial", "unavailable"].includes(receipt.status))
        || (entry.status === "blocked" && ["rework", "unavailable"].includes(receipt.status))
      )), "Receipt transitions must be ordered; blocked work requires reviewed disposition");
    if (["accepted-native", "accepted-partial", "unavailable"].includes(receipt.status)) {
      if (receipt.status !== "unavailable") assert.ok(entry.status === "submitted"
        && receipt.attempt === entry.attempts && entry.task !== "author",
      "Native acceptance requires submitted measurement or validation, not contract authoring");
      assert.ok(nonempty(receipt.reviewCommit) && gitSha(receipt.reviewCommit)
        && sha(receipt.reportManifestSha256), "Acceptance needs independent reviewed integration");
    }
    Object.assign(entry, { attempts: receipt.attempt, status: receipt.status, reason: receipt.reason });
  }
  const done = entries.filter(entry => ["accepted-native", "accepted-partial", "unavailable"].includes(entry.status));
  return { planSha256: digest(plan), entries, summary: {
    assigned: entries.length, disposed: done.length,
    native: entries.filter(entry => entry.status === "accepted-native").length,
    partial: entries.filter(entry => entry.status === "accepted-partial").length,
    unavailable: entries.filter(entry => entry.status === "unavailable").length,
  } };
}

export function selectCohort(plan, ledger, lane, excludedKeys = []) {
  assert.ok(Number.isInteger(lane) && lane >= 1 && lane <= 4);
  assert.equal(ledger.planSha256, digest(plan));
  assert.ok(Array.isArray(excludedKeys) && excludedKeys.every(sha));
  const excluded = new Set(excludedKeys);
  return plan.cohorts.find(cohort => cohort.lane === lane && ledger.entries.some(entry =>
    entry.cohort === cohort.id && ["pending", "rework"].includes(entry.status) && entry.attempts < 2
    && !excluded.has(entry.key))) ?? null;
}

export function progressMetrics(plan, receipts, executions, startAt, endAt) {
  const ledger = buildLedger(plan, receipts);
  assert.ok(utc(startAt) && utc(endAt) && Date.parse(startAt) < Date.parse(endAt));
  assert.ok(Array.isArray(executions) && executions.length <= 8192);
  const attempts = new Set();
  const keys = new Set(ledger.entries.map(entry => entry.key));
  for (const execution of executions) {
    assert.ok(keys.has(execution.key) && [1, 2].includes(execution.attempt));
    const id = `${execution.key}:${execution.attempt}`;
    assert.ok(!attempts.has(id), "Duplicate execution cost");
    attempts.add(id);
    assert.ok(execution.aiCredits === null || (Number.isFinite(execution.aiCredits) && execution.aiCredits >= 0));
  }
  const accepted = ledger.entries.filter(entry => entry.task === "measure"
    && ["accepted-native", "accepted-partial"].includes(entry.status)).length;
  const attempted = ledger.entries.reduce((count, entry) => count + entry.attempts, 0);
  const matched = executions.length === attempted && executions.every(execution =>
    execution.aiCredits !== null && execution.attempt <= ledger.entries.find(entry => entry.key === execution.key).attempts);
  const rework = new Set(receipts.filter(receipt => receipt.status === "rework")
    .map(receipt => `${receipt.key}:${receipt.attempt}`)).size;
  return {
    acceptedNativeEvaluations: accepted,
    acceptedPerHour: accepted / ((Date.parse(endAt) - Date.parse(startAt)) / 3_600_000),
    creditsPerAcceptedEvaluation: accepted > 0 && matched
      ? executions.reduce((total, execution) => total + execution.aiCredits, 0) / accepted : null,
    reworkFraction: attempted > 0 ? rework / attempted : null,
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const [command, root, portfolioPath, planPath, receiptsPath, lane, ...extra] = process.argv.slice(2);
  assert.ok(root && portfolioPath && !extra.length && ["inventory", "ledger", "select"].includes(command),
    "usage: coverage.mjs inventory ROOT PORTFOLIO | (ledger|select) ROOT PORTFOLIO PLAN RECEIPTS [LANE]");
  const inventory = readInventory(root, portfolioPath);
  let result = inventory.summary;
  if (command !== "inventory") {
    const plan = validatePlan(root, readJsonArchive(localFile(root, planPath)), inventory);
    const receipts = readJsonArchive(localFile(root, receiptsPath));
    assert.ok(Array.isArray(receipts));
    const ledger = buildLedger(plan, receipts);
    result = command === "ledger" ? ledger : selectCohort(plan, ledger, Number(lane));
  }
  console.log(JSON.stringify(result, null, 2));
}
