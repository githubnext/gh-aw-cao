import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { cpSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { parse } from "yaml";
import { generatedJobs, ghAwVersion, root, workflow, workflowsDirectory } from "./workflow-contract.helpers.mjs";

// Compiled workflow output contracts.

function workflowConfig(name, directory = workflowsDirectory) {
  const frontmatter = /^---\n([\s\S]*?)\n---/.exec(workflow(name, directory))?.[1];
  assert.ok(frontmatter, `${name} must have frontmatter`);
  return parse(frontmatter);
}

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
    for (const campaignDirectory of ["activity", "cao-evolution", "dashboard", "dependabot", "optimization", "repo-assist"]) {
      cpSync(join(root, campaignDirectory), join(temporaryRoot, campaignDirectory), { recursive: true });
    }
    for (const manifest of ["aw.yml", "activity/aw.yml", "cao-evolution/aw.yml", "dashboard/aw.yml", "dependabot/aw.yml", "optimization/aw.yml", "repo-assist/aw.yml"]) {
      const manifestPath = join(temporaryRoot, manifest);
      writeFileSync(manifestPath, readFileSync(manifestPath, "utf8").replaceAll(ghAwVersion, "v0.89.4"));
    }
    execFileSync("git", ["init", "--quiet"], { cwd: temporaryRoot });

    const generatedDirectory = join(temporaryRoot, ".github", "workflows");
    const sourceNames = readdirSync(generatedDirectory)
      .filter((name) => name.endsWith(".md"))
      .sort();
    const expectedLockNames = sourceNames
      .map((name) => name.replace(/\.md$/, ".lock.yml"))
      .sort();
    for (const lockName of readdirSync(generatedDirectory).filter((name) => name.endsWith(".lock.yml"))) {
      rmSync(join(generatedDirectory, lockName));
    }
    const controlContracts = sourceNames.flatMap((sourceName) => {
      const controlImport = workflowConfig(sourceName, generatedDirectory).imports
        ?.find((entry) => entry.uses === "shared/control.md");
      if (!controlImport) return [];
      return [{
        sourceName,
        lockName: sourceName.replace(/\.md$/, ".lock.yml"),
        campaignName: controlImport.with.campaign,
        role: controlImport.with.role,
        workerName: controlImport.with.worker ?? "__none__",
      }];
    });

    execFileSync("gh", [
      "aw",
      "compile",
      "--no-check-update",
      "--schedule-seed",
      "githubnext/gh-aw-cao",
    ], { cwd: temporaryRoot, stdio: "pipe" });

    const lockNames = readdirSync(generatedDirectory)
      .filter((name) => name.endsWith(".lock.yml"))
      .sort();
    const campaignLockNames = controlContracts.map(({ lockName }) => lockName);

    assert.deepEqual(lockNames, expectedLockNames);
    for (const name of campaignLockNames) {
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

    for (const { lockName, campaignName, workerName } of controlContracts.filter(({ role }) => role === "orchestrator")) {
      const generated = workflow(lockName, generatedDirectory);
      assert.match(generated, new RegExp(`CAO_CAMPAIGN: ${campaignName}`));
      assert.match(generated, /CAO_ROLE: orchestrator/);
      assert.equal(workerName, "__none__", `${lockName}: orchestrators must not declare a worker identity`);
      assert.match(generated, new RegExp(`CAO_WORKER: ${workerName}`));
      assert.match(generated, /GH_AW_SAFE_OUTPUT_MODE:.*inputs\.safe_output_mode.*\|\| 'review'/);
      assert.match(generated, /CAO_REQUESTED_ROLLOUT_PERCENT: \$\{\{ inputs\.rollout_percent \|\| '' \}\}/);
      assert.match(generated, /rollout_percent:\n\s+default: 100\n\s+type: number/);
      assert.match(generated, /timeout-minutes: 15/);
      assert.match(generated, /cancel-in-progress: true/);
      const outputPlaceholder = generated.indexOf("- name: Write agent output placeholder if missing");
      const dispatcherTelemetry = generated.indexOf("name: Emit control-plane dispatcher telemetry");
      const agentArtifact = generated.indexOf("- name: Upload agent artifacts");
      assert.ok(outputPlaceholder < dispatcherTelemetry, `${lockName} emits dispatcher telemetry before output normalization`);
      assert.ok(dispatcherTelemetry < agentArtifact, `${lockName} uploads the agent artifact before dispatcher telemetry`);
      assert.match(generated, /otlp\.logSpan\('central-agentic-ops\.dispatcher'/);
    }

    for (const { lockName, campaignName, workerName } of controlContracts.filter(({ role }) => role === "worker")) {
      const generated = workflow(lockName, generatedDirectory);
      assert.match(generated, new RegExp(`CAO_CAMPAIGN: ${campaignName}`));
      assert.match(generated, /CAO_ROLE: worker/);
      assert.match(generated, new RegExp(`CAO_WORKER: ${workerName}`));
      assert.match(generated, /GH_AW_SAFE_OUTPUT_MODE: \$\{\{ inputs\.safe_output_mode \|\| 'review' \}\}/);
      assert.match(generated, /SAFE_OUTPUT_REPO:.*safe_output_mode.*'review'.*safe_output_repo.*github\.repository.*inputs\.target_repo/);
      assert.match(generated, /CAO_REQUESTED_ROLLOUT_PERCENT: \$\{\{ inputs\.rollout_percent \|\| '' \}\}/);
      assert.match(generated, /GH_AW_SAFE_OUTPUTS_CONFIG:/);
      const config = parse(generated);
      const source = workflowConfig(lockName.replace(".lock.yml", ".md"), generatedDirectory);
      const inboxImport = source.imports.find((entry) => entry.uses === "shared/review-inbox.md");
      const publisher = config.jobs.cao_review_inbox;
      if (!inboxImport) {
        assert.equal(publisher, undefined, `${lockName}: bundle-only workers must not acquire issue writes`);
        continue;
      }
      assert.ok(source["safe-outputs"]["create-issue"], `${lockName}: publisher requires existing issue authority`);
      assert.deepEqual(new Set(publisher.needs), new Set(["agent", "activation", "pre_activation", "safe_outputs"]));
      assert.match(publisher.if, /cao_authorized == 'true'/);
      assert.match(publisher.if, /safe_outputs.result == 'success'/);
      assert.match(publisher.if, /safe_output_mode.*== 'review'/);
      assert.deepEqual(publisher.permissions, { contents: "read", actions: "read", issues: "write" });
      assert.equal(publisher.concurrency.group, `cao-review-inbox-\${{ inputs.safe_output_repo || github.repository }}-${campaignName}`);
      assert.equal(publisher.concurrency["cancel-in-progress"], false);
      assert.equal(publisher.concurrency.queue, "max");
      assert.match(config.concurrency.group, /safe_output_mode != 'live'.*github.run_id/);
      assert.equal(config.concurrency["cancel-in-progress"], true, "live cancellation is unchanged");
      const interceptIndex = config.jobs.safe_outputs.steps.findIndex((step) => step.id === "cao_review_intercept");
      const handlerIndex = config.jobs.safe_outputs.steps.findIndex((step) => step.id === "process_safe_outputs");
      assert.ok(interceptIndex >= 0 && interceptIndex < handlerIndex, "interception must precede the builtin loop");
      const intercept = config.jobs.safe_outputs.steps[interceptIndex];
      assert.match(intercept.if, /CAO_REVIEW_INBOX.*true.*CAO_ROLE.*worker.*safe_output_mode.*review/);
      assert.equal(intercept.env.GH_AW_AGENT_OUTPUT, "${{ steps.setup-agent-output-env.outputs.GH_AW_AGENT_OUTPUT }}");
      const outputSetup = config.jobs.safe_outputs.steps.find((step) => step.id === "setup-agent-output-env");
      assert.match(outputSetup.run, /echo "GH_AW_AGENT_OUTPUT=\/tmp\/gh-aw\/agent_output.json" >> "\$GITHUB_OUTPUT"/);
      assert.equal(publisher.env.GH_AW_AGENT_OUTPUT, "/tmp/gh-aw/agent_output.json");
      for (const [key, value] of Object.entries({
        CAO_CAMPAIGN: campaignName, CAO_ROLE: "worker", CAO_WORKER: workerName,
        CAO_REVIEW_FINDING_LIMITS: config.env.CAO_REVIEW_FINDING_LIMITS,
      })) {
        assert.equal({ ...config.env, ...publisher.env }[key], value, `${lockName}: native publisher must inherit ${key}`);
      }
      const checkout = publisher.steps.find((step) => step.name === "Checkout review publisher at the workflow SHA");
      assert.equal(checkout.with.ref, "${{ github.workflow_sha }}");
      assert.equal(checkout.with["persist-credentials"], false);
      const original = publisher.steps.find((step) => step.name === "Restore original agent output");
      assert.equal(original.with.pattern, "{agent,agent-output-fallback}");
      assert.equal(original.with.path, "/tmp/gh-aw");
      assert.equal(original.with["merge-multiple"], true);
      assert.equal(original["continue-on-error"], undefined);
      for (const artifact of ["agent", "agent-output-fallback"]) {
        const upload = config.jobs.agent.steps.find((step) => step.with?.name === artifact);
        assert.ok(upload.with.path.split("\n").includes("/tmp/gh-aw/agent_output.json"),
          `${lockName}: ${artifact} must contain the immutable raw output at its gh-aw-relative path`);
      }
      const readyUpload = config.jobs.safe_outputs.steps.find((step) => step.with?.name === "cao-review-inbox-ready");
      assert.equal(readyUpload.with.path, "/tmp/gh-aw/review-inbox-ready.json");
      const readyDownload = publisher.steps.find((step) => step.with?.name === "cao-review-inbox-ready");
      assert.equal(readyDownload.with.path, "/tmp/gh-aw");
      const token = publisher.steps.find((step) => step.id === "cao_review_app_token");
      assert.equal(token.with.owner, "${{ steps.cao_review_scope.outputs.owner }}");
      assert.equal(token.with.repositories, "${{ steps.cao_review_scope.outputs.repository }}");
      assert.equal(token.with["permission-issues"], "write");
      assert.equal(token.with["permission-contents"], undefined);
      const publish = publisher.steps.at(-1);
      assert.match(publish.with["github-token"], /GH_AW_GITHUB_WRITE_PAT_REPOSITORIES/);
      assert.doesNotMatch(publish.with["github-token"], /READ_PAT|READ_APP|inputs.target_repo/);
      const expectedLimits = Object.fromEntries(["create-issue", "add-comment", "update-issue", "close-issue"]
        .flatMap((kind) => source["safe-outputs"][kind] ? [[kind.replaceAll("-", "_"), source["safe-outputs"][kind].max ?? 1]] : []));
      assert.deepEqual(JSON.parse(config.env.CAO_REVIEW_FINDING_LIMITS), expectedLimits);
    }
    for (const { lockName } of controlContracts.filter(({ role }) => role === "orchestrator")) {
      assert.equal(parse(workflow(lockName, generatedDirectory)).jobs.cao_review_inbox, undefined, "dispatch workers/actions remain untouched");
    }

    const generatedDependabotPlan = workflow("dependabot-update-planner.lock.yml", generatedDirectory);
    assert.match(generatedDependabotPlan, /create_issue/);
    assert.match(generatedDependabotPlan, /update_issue/);
    assert.match(generatedDependabotPlan, /add_comment/);
    assert.doesNotMatch(generatedDependabotPlan, /create_pull_request/);

    const advisoryMaintainer = workflow("uk-ai-advisory-campaign-maintainer.lock.yml", generatedDirectory);
    assert.match(advisoryMaintainer, /schedule:/);
    assert.match(advisoryMaintainer, /uk-ai-advisory\/implementation-status\.md/);
    assert.match(advisoryMaintainer, /copilot\/gpt-5\.4/);

    const craMaintainer = workflow("eu-cra-compliance-campaign-maintainer.lock.yml", generatedDirectory);
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

    const stagedSourcePath = join(generatedDirectory, "repo-assist-issue-triage.md");
    writeFileSync(stagedSourcePath, readFileSync(stagedSourcePath, "utf8").replace("safe-outputs:\n", "safe-outputs:\n  staged: true\n"));
    execFileSync("gh", ["aw", "compile", "repo-assist-issue-triage", "--strict", "--no-check-update",
      "--schedule-seed", "githubnext/gh-aw-cao"], { cwd: temporaryRoot, stdio: "pipe" });
    const stagedConfig = parse(workflow("repo-assist-issue-triage.lock.yml", generatedDirectory));
    assert.equal(stagedConfig.jobs.safe_outputs.env.GH_AW_SAFE_OUTPUTS_STAGED, "true");
    assert.ok(stagedConfig.jobs.safe_outputs.steps.find((step) => step.id === "cao_review_intercept"),
      "the pre-handler sees the compiler's staged job environment");
    assert.ok(stagedConfig.jobs.cao_review_inbox.steps.some((step) => step.with?.name === "cao-review-inbox-ready"),
      "the native publisher must restore the recorded staged flag rather than assuming an unstaged run");
  } finally {
    rmSync(temporaryRoot, { recursive: true, force: true });
  }
});
