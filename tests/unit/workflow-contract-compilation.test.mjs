import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { cpSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { generatedJobs, ghAwVersion, root, workflow, workflowsDirectory } from "./workflow-contract.helpers.mjs";

// Compiled workflow output contracts.

test("compiled workflow expressions do not contain HTML-escaped operators", () => {
  const lockNames = readdirSync(workflowsDirectory).filter((name) => name.endsWith(".lock.yml"));

  for (const lockName of lockNames) {
    const expressions = workflow(lockName).match(/\$\{\{[\s\S]*?\}\}/g) ?? [];
    for (const expression of expressions) {
      assert.doesNotMatch(
        expression,
        /\\+u(?:0026|003c|003e)/i,
        `${lockName} contains an HTML-escaped operator in ${expression}`,
      );
    }
  }
});

test("clean-room compilation emits the expected GitHub Actions settings", { timeout: 120_000 }, () => {
  const temporaryRoot = mkdtempSync(join(tmpdir(), "central-agentic-ops-test-"));

  try {
    cpSync(join(root, ".github"), join(temporaryRoot, ".github"), { recursive: true });
    cpSync(join(root, "AGENTS.md"), join(temporaryRoot, "AGENTS.md"));
    cpSync(join(root, "aw.yml"), join(temporaryRoot, "aw.yml"));
    cpSync(join(root, "cao.sh"), join(temporaryRoot, "cao.sh"));
    cpSync(join(root, "README.md"), join(temporaryRoot, "README.md"));
    for (const packageDirectory of ["activity", "cao-evolution", "dashboard", "dependabot", "optimization", "repo-assist"]) {
      cpSync(join(root, packageDirectory), join(temporaryRoot, packageDirectory), { recursive: true });
    }
    for (const manifest of ["aw.yml", "activity/aw.yml", "cao-evolution/aw.yml", "dashboard/aw.yml", "dependabot/aw.yml", "optimization/aw.yml", "repo-assist/aw.yml"]) {
      const manifestPath = join(temporaryRoot, manifest);
      writeFileSync(manifestPath, readFileSync(manifestPath, "utf8").replaceAll(ghAwVersion, "v0.89.4"));
    }
    execFileSync("git", ["init", "--quiet"], { cwd: temporaryRoot });

    execFileSync("gh", [
      "aw",
      "compile",
      "--no-check-update",
      "--schedule-seed",
      "githubnext/gh-aw-cao",
    ], { cwd: temporaryRoot, stdio: "pipe" });

    const generatedDirectory = join(temporaryRoot, ".github", "workflows");
    const lockNames = readdirSync(generatedDirectory)
      .filter((name) => name.endsWith(".lock.yml"))
      .sort();
    const packageLockNames = [
      "uk-ai-advisory-operational-resilience.lock.yml",
      "uk-ai-advisory.lock.yml",
      "optimization-agents-md-curator.lock.yml",
      "optimization-skills-curator.lock.yml",
      "cao-evolution-failures-investigator.lock.yml",
      "cao-evolution-compiler-security.lock.yml",
      "cao-evolution-catalog-advisor.lock.yml",
      "cao-evolution-efficiency.lock.yml",
      "cao-evolution-integrity.lock.yml",
      "cao-evolution-reliability.lock.yml",
      "cao-evolution.lock.yml",
      "dependabot-release-train-updater.lock.yml",
      "dependabot.lock.yml",
      "eslint-rules-applier.lock.yml",
      "eslint-rules-inventory.lock.yml",
      "eslint-rules-librarian.lock.yml",
      "eslint-rules-miner.lock.yml",
      "eslint-rules-refiner.lock.yml",
      "eslint-rules.lock.yml",
      "eu-cra-compliance-article-14-reporting-readiness.lock.yml",
      "eu-cra-compliance-conformity-release-evidence.lock.yml",
      "eu-cra-compliance-scope-classifier.lock.yml",
      "eu-cra-compliance-security-requirements-auditor.lock.yml",
      "eu-cra-compliance-supply-chain-sbom-auditor.lock.yml",
      "eu-cra-compliance-vulnerability-handling-auditor.lock.yml",
      "eu-cra-compliance.lock.yml",
      "optimization-ai-credit-auditor.lock.yml",
      "optimization-ai-credit-optimizer.lock.yml",
      "optimization-token-efficiency-verifier.lock.yml",
      "optimization-token-optimizer.lock.yml",
      "optimization.lock.yml",
      "repo-assist-issue-fix.lock.yml",
      "repo-assist-issue-triage.lock.yml",
      "repo-assist-maintenance.lock.yml",
      "repo-assist-pr-upkeep.lock.yml",
      "repo-assist.lock.yml",
      "self-care-accessibility-checker.lock.yml",
      "self-care-code-improvement.lock.yml",
      "self-care-dashboard-data-schema.lock.yml",
      "self-care-dashboard-debug-logging.lock.yml",
      "self-care-dashboard-performance.lock.yml",
      "self-care-data-acquisition-audit.lock.yml",
      "self-care-dashboard-language-refactor.lock.yml",
      "self-care-dashboard-review.lock.yml",
      "self-care-docs-build-time-investigator.lock.yml",
      "self-care-experimental-views.lock.yml",
      "self-care-glossary.lock.yml",
      "self-care-open-source-failures.lock.yml",
      "self-care-pages-health.lock.yml",
      "self-care-primer-brand-checker.lock.yml",
      "self-care-reactive-ui-expert.lock.yml",
      "self-care.lock.yml",
      "software-development-practices-github-well-architected.lock.yml",
      "software-development-practices-nist-ssdf.lock.yml",
      "software-development-practices.lock.yml",
    ];
    const expectedLockNames = [
      ...packageLockNames,
      "uk-ai-advisory-package-maintainer.lock.yml",
      "dashboard-authoring-corpus.lock.yml",
      "design-decision-gate.lock.yml",
      "multi-device-docs-tester.lock.yml",
      "eu-cra-compliance-package-maintainer.lock.yml",
      "docs-explanatory-diagrams.lock.yml",
      "mattpocock-skills-reviewer.lock.yml",
      "pr-reviewer.lock.yml",
      "pr-sous-chef.lock.yml",
      "release.lock.yml",
      "svg-visual-audit.lock.yml",
    ].sort();

    assert.deepEqual(lockNames, expectedLockNames);
    for (const name of packageLockNames) {
      const generated = workflow(name, generatedDirectory);
      const jobs = generatedJobs(generated);
      const preActivation = jobs.get("pre_activation").block;
      const agent = jobs.get("agent").block;

      assert.match(preActivation, /actions: read/);
      assert.match(preActivation, /name: Evaluate Central Agentic Ops admission/);
      assert.match(preActivation, /name: Checkout CAO control modules/);
      assert.match(preActivation, /sparse-checkout: \.github/);
      assert.match(preActivation, /name: Resolve CAO control runtime/);
      assert.match(preActivation, /\.cao\/\.github\/workflows\/shared\/control\.mjs/);
      assert.doesNotMatch(preActivation, /name: Checkout installed CAO control source|\.cao-runtime|# Source: /);
      assert.match(preActivation, /fetch-depth: 1/);
      assert.doesNotMatch(preActivation, /contents\/\.github\/cao\/src\/(?:control|policy)\.mjs/);
      assert.doesNotMatch(preActivation, /github\/gh-aw-actions\/setup-cli@/);
      assert.doesNotMatch(preActivation, /steps\.cao_admission\.outputs\.monthly_credit_budget != '0'/);
      assert.match(preActivation, /name: Run CAO control precompute/);
      assert.match(preActivation, /CAO_DISPATCH_MAX: "\d+"/);
      assert.match(preActivation, /CAO_ORCHESTRATOR_CREDITS: "\d+"/);
      assert.match(preActivation, /CAO_WORKER_CREDITS_PER_TARGET: "\d+"/);
      assert.doesNotMatch(preActivation, /github\.aw\.import-inputs/);
      assert.match(preActivation, /uses: actions\/github-script@[0-9a-f]{40}/);
      assert.match(preActivation, /await control\.main\(\{ core, github, context, exec, io, getOctokit \}, \['precompute'\]\)/);
      assert.match(preActivation, /name: Validate CAO control precompute artifact/);
      assert.match(preActivation, /\.authorized == true/);
      assert.match(preActivation, /\.policy_source == \{repository:\$repository,path:"\.github\/workflows\/cao\.json",sha:\$sha\}/);
      assert.match(preActivation, /name: Upload CAO control precompute artifact/);
      assert.match(preActivation, /retention-days: 1(?:\.0)?/);

      assert.match(agent, /name: Download CAO control precompute artifact/);
      assert.doesNotMatch(agent, /name: Validate CAO control precompute artifact/);
      assert.doesNotMatch(agent, /contents\/\.github\/cao\/(?:control|policy)/);
      assert.doesNotMatch(agent, /node .*cao\/control\.mjs.*precompute|target-authority\.json|candidate-pages\.jsonl/);
      assert.doesNotMatch(generated, /vars\.CENTRAL_AGENTIC_OPS_|central-agentic-ops\.yml/);
      assert.doesNotMatch(generated, /github\.aw\.import-inputs/);
      assert.doesNotMatch(
        generated,
        /github\.event\.inputs\.(?:max_repos|rollout_percent|correlation_id|central_repo|control_plane_run_url)/
      );
      assert.doesNotMatch(generated, /PREVIEW_ONLY|preview_only/);
      assert.doesNotMatch(generated, /== 'preview'/);
      assert.doesNotMatch(generated, /safe_output_mode == 'private'/);
    }

    const orchestratorGates = new Map([
      ["uk-ai-advisory.lock.yml", "uk-ai-advisory"],
      ["cao-evolution.lock.yml", "cao-evolution"],
      ["dependabot.lock.yml", "dependabot"],
      ["eslint-rules.lock.yml", "eslint-rules"],
      ["eu-cra-compliance.lock.yml", "eu-cra-compliance"],
      ["optimization.lock.yml", "optimization"],
      ["repo-assist.lock.yml", "repo-assist"],
      ["self-care.lock.yml", "self-care"],
      ["software-development-practices.lock.yml", "software-development-practices"],
    ]);
    for (const [name, packageName] of orchestratorGates) {
      const generated = workflow(name, generatedDirectory);
      assert.match(generated, new RegExp(`CAO_PACKAGE: ${packageName}`));
      assert.match(generated, /CAO_ROLE: orchestrator/);
      assert.match(generated, /CAO_WORKER: __none__/);
      assert.match(generated, /GH_AW_SAFE_OUTPUT_MODE:.*inputs\.safe_output_mode.*\|\| 'review'/);
      assert.match(generated, /CAO_REQUESTED_ROLLOUT_PERCENT: \$\{\{ inputs\.rollout_percent \|\| '' \}\}/);
      assert.match(generated, /rollout_percent:\n\s+default: 100\n\s+type: number/);
      assert.match(generated, /timeout-minutes: 15/);
      assert.match(generated, /cancel-in-progress: true/);
      const outputPlaceholder = generated.indexOf("- name: Write agent output placeholder if missing");
      const dispatcherTelemetry = generated.indexOf("name: Emit control-plane dispatcher telemetry");
      const agentArtifact = generated.indexOf("- name: Upload agent artifacts");
      assert.ok(outputPlaceholder < dispatcherTelemetry, `${name} emits dispatcher telemetry before output normalization`);
      assert.ok(dispatcherTelemetry < agentArtifact, `${name} uploads the agent artifact before dispatcher telemetry`);
      assert.match(generated, /otlp\.logSpan\('central-agentic-ops\.dispatcher'/);
    }

    const workerGates = new Map([
      ["uk-ai-advisory-operational-resilience.lock.yml", ["uk-ai-advisory", "operational-resilience"]],
      ["optimization-agents-md-curator.lock.yml", ["optimization", "agents-md-curator"]],
      ["optimization-skills-curator.lock.yml", ["optimization", "skills-curator"]],
      ["cao-evolution-failures-investigator.lock.yml", ["cao-evolution", "failures-investigator"]],
      ["cao-evolution-compiler-security.lock.yml", ["cao-evolution", "compiler-security"]],
      ["cao-evolution-catalog-advisor.lock.yml", ["cao-evolution", "catalog-advisor"]],
      ["cao-evolution-efficiency.lock.yml", ["cao-evolution", "efficiency"]],
      ["cao-evolution-integrity.lock.yml", ["cao-evolution", "integrity"]],
      ["cao-evolution-reliability.lock.yml", ["cao-evolution", "reliability"]],
      ["dependabot-release-train-updater.lock.yml", ["dependabot", "release-train-updater"]],
      ["eslint-rules-applier.lock.yml", ["eslint-rules", "applier"]],
      ["eslint-rules-inventory.lock.yml", ["eslint-rules", "inventory"]],
      ["eslint-rules-librarian.lock.yml", ["eslint-rules", "librarian"]],
      ["eslint-rules-miner.lock.yml", ["eslint-rules", "miner"]],
      ["eslint-rules-refiner.lock.yml", ["eslint-rules", "refiner"]],
      ["eu-cra-compliance-article-14-reporting-readiness.lock.yml", ["eu-cra-compliance", "article-14-reporting-readiness"]],
      ["eu-cra-compliance-conformity-release-evidence.lock.yml", ["eu-cra-compliance", "conformity-release-evidence"]],
      ["eu-cra-compliance-scope-classifier.lock.yml", ["eu-cra-compliance", "scope-classifier"]],
      ["eu-cra-compliance-security-requirements-auditor.lock.yml", ["eu-cra-compliance", "security-requirements-auditor"]],
      ["eu-cra-compliance-supply-chain-sbom-auditor.lock.yml", ["eu-cra-compliance", "supply-chain-sbom-auditor"]],
      ["eu-cra-compliance-vulnerability-handling-auditor.lock.yml", ["eu-cra-compliance", "vulnerability-handling-auditor"]],
      ["optimization-ai-credit-auditor.lock.yml", ["optimization", "ai-credit-auditor"]],
      ["optimization-ai-credit-optimizer.lock.yml", ["optimization", "ai-credit-optimizer"]],
      ["optimization-token-optimizer.lock.yml", ["optimization", "token-optimizer"]],
      ["repo-assist-issue-fix.lock.yml", ["repo-assist", "issue-fix"]],
      ["repo-assist-issue-triage.lock.yml", ["repo-assist", "issue-triage"]],
      ["repo-assist-maintenance.lock.yml", ["repo-assist", "maintenance"]],
      ["repo-assist-pr-upkeep.lock.yml", ["repo-assist", "pr-upkeep"]],
      ["self-care-accessibility-checker.lock.yml", ["self-care", "accessibility-checker"]],
      ["self-care-code-improvement.lock.yml", ["self-care", "code-improvement"]],
      ["self-care-dashboard-data-schema.lock.yml", ["self-care", "dashboard-data-schema"]],
      ["self-care-dashboard-debug-logging.lock.yml", ["self-care", "dashboard-debug-logging"]],
      ["self-care-dashboard-performance.lock.yml", ["self-care", "dashboard-performance"]],
      ["self-care-data-acquisition-audit.lock.yml", ["self-care", "data-acquisition-audit"]],
      ["self-care-dashboard-language-refactor.lock.yml", ["self-care", "dashboard-language-refactor"]],
      ["self-care-dashboard-review.lock.yml", ["self-care", "dashboard-review"]],
      ["self-care-docs-build-time-investigator.lock.yml", ["self-care", "docs-build-time-investigator"]],
      ["self-care-glossary.lock.yml", ["self-care", "glossary"]],
      ["self-care-open-source-failures.lock.yml", ["self-care", "open-source-failures"]],
      ["self-care-pages-health.lock.yml", ["self-care", "pages-health"]],
      ["self-care-primer-brand-checker.lock.yml", ["self-care", "primer-brand-checker"]],
      ["self-care-reactive-ui-expert.lock.yml", ["self-care", "reactive-ui-expert"]],
      ["software-development-practices-github-well-architected.lock.yml", ["software-development-practices", "github-well-architected"]],
      ["software-development-practices-nist-ssdf.lock.yml", ["software-development-practices", "nist-ssdf"]],
    ]);
    for (const [name, [packageName, workerName]] of workerGates) {
      const generated = workflow(name, generatedDirectory);
      assert.match(generated, new RegExp(`CAO_PACKAGE: ${packageName}`));
      assert.match(generated, /CAO_ROLE: worker/);
      assert.match(generated, new RegExp(`CAO_WORKER: ${workerName}`));
      assert.match(generated, /GH_AW_SAFE_OUTPUT_MODE: \$\{\{ inputs\.safe_output_mode \|\| 'review' \}\}/);
      assert.match(generated, /SAFE_OUTPUT_REPO:.*safe_output_mode.*'review'.*safe_output_repo.*github\.repository.*inputs\.target_repo/);
      assert.match(generated, /CAO_REQUESTED_ROLLOUT_PERCENT: \$\{\{ inputs\.rollout_percent \|\| '' \}\}/);
      assert.match(generated, /GH_AW_SAFE_OUTPUTS_CONFIG:/);
    }

    const generatedDependabotPlan = workflow("dependabot-release-train-updater.lock.yml", generatedDirectory);
    assert.match(generatedDependabotPlan, /create_issue/);
    assert.match(generatedDependabotPlan, /update_issue/);
    assert.match(generatedDependabotPlan, /add_comment/);
    assert.doesNotMatch(generatedDependabotPlan, /create_pull_request/);

    const advisoryMaintainer = workflow("uk-ai-advisory-package-maintainer.lock.yml", generatedDirectory);
    assert.match(advisoryMaintainer, /schedule:/);
    assert.match(advisoryMaintainer, /uk-ai-advisory\/implementation-status\.md/);
    assert.match(advisoryMaintainer, /copilot\/gpt-5\.4/);

    const craMaintainer = workflow("eu-cra-compliance-package-maintainer.lock.yml", generatedDirectory);
    assert.match(craMaintainer, /schedule:/);
    assert.match(craMaintainer, /eu-cra-compliance\/implementation-status\.md/);
    assert.match(craMaintainer, /copilot\/gpt-5\.4/);

    const prReviewer = workflow("pr-reviewer.lock.yml", generatedDirectory);
    assert.match(prReviewer, /create_pull_request_review_comment/);
    assert.match(prReviewer, /name: "Workflow PR Validator"/);
    assert.match(prReviewer, /submit_pull_request_review/);
    assert.match(prReviewer, /REQUEST_CHANGES/);
    assert.match(prReviewer, /agenticworkflows/);
    assert.match(prReviewer, /Mount MCP servers as CLIs/);
    assert.doesNotMatch(prReviewer, /go build .*cmd\/gh-aw/);

    const prReviewerSource = workflow("pr-reviewer.md");
    assert.match(prReviewerSource, /types: \[ready_for_review\]/);
    assert.match(prReviewerSource, /^max-daily-ai-credits: -1$/m);
    assert.match(prReviewerSource, /agentic-workflows: true/);
    assert.match(prReviewerSource, /cli-proxy: true/);
    assert.match(prReviewerSource, /agentic-workflows compile/);

    const svgVisualAudit = workflow("svg-visual-audit.lock.yml", generatedDirectory);
    assert.match(svgVisualAudit, /name: "SVG Visual Audit"/);
    assert.match(svgVisualAudit, /create_check_run/);
    assert.match(svgVisualAudit, /upload_artifact/);
    assert.match(svgVisualAudit, /GH_AW_INFO_ALLOWED_DOMAINS: '\["defaults","playwright"\]'/);
    assert.doesNotMatch(svgVisualAudit, /python3 -m http\.server 4321/);

    const docsDiagramGenerator = workflow("docs-explanatory-diagrams.lock.yml", generatedDirectory);
    assert.match(docsDiagramGenerator, /name: "Docs Diagrams"/);
    assert.match(docsDiagramGenerator, /create_pull_request/);
  } finally {
    rmSync(temporaryRoot, { recursive: true, force: true });
  }
});
