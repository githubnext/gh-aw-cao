import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { cpSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { root, workflow } from "./workflow-contract.helpers.mjs";

// Operational-value grader, smoke, and canary contracts.

test("operational-value graders cap GitHub API usage while collecting logs", () => {
  for (const name of [
    "optimization-agents-md-curator-operational-value.sh",
    "optimization-ai-credit-auditor-operational-value.sh",
    "optimization-ai-credit-optimizer-operational-value.sh",
  ]) {
    const source = readFileSync(join(root, ".github", "workflows", "graders", name), "utf8");
    assert.match(source, /gh aw logs[\s\S]*--max-github-api-rate-limit -2000/, name);
  }
});

test("operational-value graders expose deterministic run-scoped contracts", () => {
  const gradersDirectory = join(root, ".github", "workflows", "graders");
  const graders = readdirSync(gradersDirectory).filter((name) => name.endsWith("-operational-value.sh"));
  assert.deepEqual(graders.sort(), [
    "cao-evolution-compiler-security-operational-value.sh",
    "cao-evolution-failures-investigator-operational-value.sh",
    "dependabot-update-planner-operational-value.sh",
    "eu-cra-compliance-article-14-reporting-readiness-operational-value.sh",
    "eu-cra-compliance-conformity-release-evidence-operational-value.sh",
    "eu-cra-compliance-package-maintainer-operational-value.sh",
    "eu-cra-compliance-scope-classifier-operational-value.sh",
    "eu-cra-compliance-security-requirements-auditor-operational-value.sh",
    "eu-cra-compliance-supply-chain-sbom-auditor-operational-value.sh",
    "eu-cra-compliance-vulnerability-handling-auditor-operational-value.sh",
    "optimization-agents-md-curator-operational-value.sh",
    "optimization-ai-credit-auditor-operational-value.sh",
    "optimization-ai-credit-optimizer-operational-value.sh",
    "optimization-token-optimizer-operational-value.sh",
    "repo-assist-issue-fix-operational-value.sh",
    "repo-assist-issue-triage-operational-value.sh",
    "repo-assist-maintenance-operational-value.sh",
    "repo-assist-pr-upkeep-operational-value.sh",
    "self-care-docs-build-time-investigator-operational-value.sh",
    "software-development-practices-github-well-architected-operational-value.sh",
    "software-development-practices-nist-ssdf-operational-value.sh",
  ]);
  const oneShotGraders = new Set([
    "repo-assist-issue-fix-operational-value.sh",
    "repo-assist-issue-triage-operational-value.sh",
    "repo-assist-maintenance-operational-value.sh",
    "repo-assist-pr-upkeep-operational-value.sh",
  ]);
  for (const name of graders.filter((name) => !oneShotGraders.has(name))) {
    const executable = join(gradersDirectory, name);
    const workflowName = name.replace(/-operational-value\.sh$/, ".md");
    assert.match(
      workflow(workflowName),
      new RegExp(`graders:\\s+operational-value:[\\s\\S]*?run: ${`./graders/${name}`.replaceAll(".", "\\.")}`),
      `${name}: workflow must execute the frozen operational-value evaluator`,
    );
    const definition = JSON.parse(execFileSync(executable, ["--definition"], { encoding: "utf8" }));
    const materializedDirectory = mkdtempSync(join(tmpdir(), "cao-grader-"));
    const materializedEvaluator = join(materializedDirectory, "operational_value_evaluator.sh");
    try {
      cpSync(executable, materializedEvaluator);
      const materializedDefinition = JSON.parse(execFileSync(materializedEvaluator, ["--definition"], {
        encoding: "utf8",
        env: { ...process.env, GITHUB_WORKSPACE: root },
      }));
      assert.deepEqual(materializedDefinition, definition, `${name}: materialized evaluator`);
    } finally {
      rmSync(materializedDirectory, { recursive: true, force: true });
    }
    assert.equal(definition.schemaVersion, 4, name);
    assert.equal(definition.grader, "operational-value", name);
    const score = (example) => JSON.parse(execFileSync(executable, ["--metric"], {
      encoding: "utf8",
      input: JSON.stringify(definition.validationExamples[example]),
    }));
    assert.ok(score("targetAttained") > score("targetMissed"), name);
    assert.equal(score("targetMissed"), 0, `${name}: complete missed opportunity`);
    assert.equal(score("missing"), null, `${name}: missing`);
    assert.equal(score("malformed"), null, `${name}: malformed`);
  }

  for (const name of oneShotGraders) {
    const executable = join(gradersDirectory, name);
    const workflowName = name.replace(/-operational-value\.sh$/, ".md");
    const fixtures = JSON.parse(readFileSync(executable.replace(/\.sh$/, ".fixtures.json"), "utf8"));
    assert.match(
      workflow(workflowName),
      new RegExp(`graders:\\s+operational-value:[\\s\\S]*run: ${`./graders/${name}`.replaceAll(".", "\\.")}`),
      `${name}: workflow must execute the frozen operational-value evaluator`,
    );
    for (const fixture of fixtures) {
      const evaluate = () => JSON.parse(execFileSync(executable, {
        encoding: "utf8",
        input: JSON.stringify(fixture.request),
      }));
      assert.deepEqual(evaluate(), fixture.expected, `${name}: ${fixture.name}`);
      assert.deepEqual(evaluate(), fixture.expected, `${name}: ${fixture.name} deterministic rerun`);
    }
  }

  for (const name of [...oneShotGraders].filter((name) => name.startsWith("repo-assist-"))) {
    assert.equal(
      readFileSync(join(root, "repo-assist", ".github", "graders", name), "utf8"),
      readFileSync(join(gradersDirectory, name), "utf8"),
      `${name}: packaged evaluator must match the compiled source`,
    );
  }

  const dependabotWorker = workflow("dependabot-update-planner.md");
  const dependabotName = "dependabot-update-planner-operational-value.sh";
  const dependabotEvaluator = readFileSync(join(gradersDirectory, dependabotName), "utf8");
  assert.match(dependabotWorker, new RegExp(`graders:\\s+operational-value:[\\s\\S]*run: \\.\\/graders\\/${dependabotName}`));
  const auditorWorker = workflow("optimization-ai-credit-auditor.md");
  const auditorEvaluator = readFileSync(join(gradersDirectory, "optimization-ai-credit-auditor-operational-value.sh"), "utf8");
  const optimizerWorker = workflow("optimization-ai-credit-optimizer.md");
  const optimizerEvaluator = readFileSync(join(gradersDirectory, "optimization-ai-credit-optimizer-operational-value.sh"), "utf8");
  assert.match(dependabotWorker, /checks: read/);
  assert.match(dependabotWorker, /statuses: read/);
  assert.match(dependabotWorker, /create-issue:\n(?:    .*\n)*?    deduplicate-by-title: true/);
  assert.match(dependabotWorker, /canonical unprefixed subject/i);
  assert.match(dependabotWorker, /Use that exact subject on every run/);
  assert.match(dependabotWorker, /repo-memory:/);
  assert.match(dependabotWorker, /Do not call `search_issues`/);
  assert.match(dependabotWorker, /target\/\.github\/dependabot\.md/);
  assert.match(dependabotWorker, /GET \/orgs\/\{org\}\/dependabot\/repository-access/);
  assert.match(dependabotWorker, /Do not treat pull requests as required input/);
  assert.match(dependabotWorker, /Apply in this order/);
  assert.match(dependabotWorker, /Security and access boundaries/);
  assert.match(dependabotWorker, /Respond to issue comments/);
  assert.match(dependabotEvaluator, /dependabot-plan-consumption/);
  assert.match(dependabotEvaluator, /--definition\|--metric\|--grade-run/);
  assert.match(dependabotEvaluator, /repos\/\$evidence_repo\/issues\/\$issue_number/);
  assert.match(auditorWorker, /window_start: \$windowStart/);
  assert.match(auditorWorker, /window_end: \$windowEnd/);
  assert.match(auditorEvaluator, /workflow_path \/\/ \.workflow_name/);
  assert.match(auditorEvaluator, /evidenceRepo: \.run\.repository/);
  assert.match(optimizerWorker, /GH_REPO: \$\{\{ inputs\.target_repo \}\}/);
  assert.match(optimizerWorker, /gh aw logs \\\n\s+--repo "\$TARGET_REPO"/);
  assert.match(optimizerWorker, /\$\{TARGET_PREFIX\}__optimization-log\.json/);
  assert.match(optimizerWorker, /"optimizer_run_id":"\$\{\{ github\.run_id \}\}"/);
  assert.match(optimizerEvaluator, /\.optimizer_run_id \| tostring/);
  assert.match(optimizerEvaluator, /target-workflow:\$\{target_repo\}:\$\{workflow\}:\$\{optimizer_run_id\}/);
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
