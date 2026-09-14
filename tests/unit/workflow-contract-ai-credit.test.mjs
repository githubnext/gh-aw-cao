import assert from "node:assert/strict";
import { readdirSync } from "node:fs";
import test from "node:test";
import { resolvePolicy, workflow, workflowsDirectory } from "./workflow-contract.helpers.mjs";

// AI Credit collection, budgets, and admission contracts.

test("AI Credit workers collect all workflow logs with bounded resources", () => {
  for (const name of ["optimization-ai-credit-auditor.md", "optimization-ai-credit-optimizer.md"]) {
    const source = workflow(name);
    const commands = source.match(/gh aw logs \\\n/g) || [];
    assert.equal(commands.length, 1, name);
    assert.match(source, /--repo "\$TARGET_REPO"/);
    assert.match(source, /--output \/tmp\/gh-aw\/token-audit\/logs/);
    assert.match(source, /--timeout \d+/);
    assert.match(source, /--max-github-api-rate-limit -2000/);
    assert.match(source, /--max-storage 1024/);
    assert.doesNotMatch(source, /for workflow in target\/\.github\/workflows\/\*\.md/);
  }
});

test("workers disable costly daily AIC burn checks", () => {
  const workers = readdirSync(workflowsDirectory)
    .filter((name) => name.endsWith(".md"))
    .map((name) => [name, workflow(name)])
    .filter(([, source]) => /^\s+role: worker$/m.test(source));

  assert.ok(workers.length > 0, "expected at least one worker workflow");

  for (const [name, source] of workers) {
    assert.match(source, /^max-daily-ai-credits: -1$/m, name);
  }
});

test("AI Credit auditor uses gh-aw forecast for cost projections", () => {
  const auditor = workflow("optimization-ai-credit-auditor.md");

  assert.match(auditor, /gh aw forecast \\/);
  assert.match(auditor, /--repo "\$TARGET_REPOSITORY"/);
  assert.match(auditor, /--days 30/);
  assert.match(auditor, /--period month/);
  assert.match(auditor, /--json/);
  assert.match(auditor, /FORECAST_EXIT_CODE=0/);
  assert.match(auditor, /FORECAST_JSON_VALID=false/);
  assert.match(auditor, /weekly_monte_carlo/);
  assert.match(auditor, /monthly_monte_carlo/);
  assert.match(auditor, /1 AIC = \$0\.01 USD/);
  assert.match(auditor, /billing dashboards remain authoritative/);
});

test("aggregate AI Credit admission reduces target fan-out", () => {
  const base = {
    eventName: "schedule",
    configuredMode: "live",
    maxRepos: 50,
    rolloutPercent: 100,
    totalRepositories: 100,
    dispatchMax: 50,
  };

  assert.equal(resolvePolicy({
    ...base,
    orchestratorCredits: 250,
    workerCreditsPerTarget: 600,
    aggregateCreditLimit: 1100,
  }).effectiveMaxRepos, 1);
  assert.equal(resolvePolicy({
    ...base,
    orchestratorCredits: 250,
    workerCreditsPerTarget: 600,
    aggregateCreditLimit: 2050,
  }).effectiveMaxRepos, 3);
  assert.equal(resolvePolicy({
    ...base,
    orchestratorCredits: 250,
    workerCreditsPerTarget: 850,
    aggregateCreditLimit: 250,
  }).effectiveMaxRepos, 0);
});
