import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { root, workflow } from "./workflow-contract.helpers.mjs";

// Repository-scoped operational-value, smoke, and canary contracts.

test("no per-workflow operational-value graders remain", () => {
  const workflowDirectory = join(root, ".github", "workflows");
  const workflowSources = readdirSync(workflowDirectory).filter((name) => name.endsWith(".md"));
  assert.ok(workflowSources.length > 0);
  for (const name of workflowSources) {
    assert.doesNotMatch(
      readFileSync(join(workflowDirectory, name), "utf8"),
      /^graders:\n\s+operational-value:/m,
      name,
    );
  }
});

test("review smoke is manual, protected, bounded, and cannot change the target", () => {
  const smoke = workflow("review-smoke.yml");
  const harness = readFileSync(join(root, "tests", "e2e", "run-canary.sh"), "utf8");
  assert.match(smoke, /workflow_dispatch:/);
  assert.doesNotMatch(smoke, /^\s+schedule:/m);
  assert.match(smoke, /actions: write/);
  assert.match(smoke, /timeout-minutes: 75/);
  assert.match(smoke, /environment: central-agentic-ops-review/);
  assert.match(smoke, /SAFE_OUTPUT_MODE: review/);
  assert.match(smoke, /SAFE_OUTPUT_REPO: \$\{\{ inputs\.safe_output_repo \}\}/);
  assert.match(smoke, /bash tests\/e2e\/run-canary\.sh/);
  assert.match(smoke, /group: review-smoke-/);
  assert.match(harness, /max_repos=1/);
  assert.match(harness, /snapshot_repository/);
  assert.match(harness, /review canary mutated target repository state/);
  assert.match(harness, /No correlated worker run was found/);
});

test("enterprise canaries are manual, protected, confirmed, and bounded", () => {
  const canary = workflow("enterprise-canary.yml");
  const stress = workflow("enterprise-stress.yml");
  const canaryHarness = readFileSync(join(root, "tests", "e2e", "run-canary.sh"), "utf8");
  const stressHarness = readFileSync(join(root, "tests", "e2e", "run-stress.sh"), "utf8");

  for (const source of [canary, stress]) {
    assert.match(source, /workflow_dispatch:/);
    assert.doesNotMatch(source, /^\s+schedule:/m);
    assert.match(source, /actions: write/);
    assert.match(source, /timeout-minutes: 120/);
    assert.match(source, /GH_AW_E2E_TOKEN/);
  }

  assert.match(canary, /bash tests\/e2e\/run-canary\.sh/);
  assert.match(stress, /bash tests\/e2e\/run-stress\.sh/);

  assert.match(canary, /options: \[review, live\]/);
  assert.match(canary, /environment: central-agentic-ops-\$\{\{ inputs\.safe_output_mode \}\}/);
  assert.match(canary, /require_output:/);
  assert.match(canaryHarness, /confirmation must be REVIEW/);
  assert.match(canaryHarness, /confirmation must be LIVE/);
  assert.match(canaryHarness, /review canary mutated target repository state/);
  assert.match(canaryHarness, /live canary required an output/);

  assert.match(stress, /environment: central-agentic-ops-\$\{\{ 'stress' \}\}/);
  assert.match(stress, /options: \[2, 3, 5\]/);
  assert.match(stressHarness, /target_repo must use OWNER\/REPO form/);
  assert.match(stressHarness, /STRESS \$TARGET_REPO REVIEW \$SAFE_OUTPUT_REPO \$RUNS/);
  assert.match(stressHarness, /RUNS - 1/);
  assert.match(stressHarness, /safe_output_mode=review/);
  assert.match(stressHarness, /review stress run mutated target repository state/);
});
