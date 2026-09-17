import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { policyCases, userFacingScenarios } from "./workflow-contract.matrix.mjs";
import { controlPrecompute, generatedJobs, modes, resolvePolicy, root, stepBlock, transitivelyNeeds, workflow, workflowsDirectory } from "./workflow-contract.helpers.mjs";

// Central policy resolution, rollout limits, and activation contracts.

test("all scheduled configurations and manual selections route safely", () => {
  const cases = policyCases();
  const uniqueInputs = new Set(cases.map(({ id, ...values }) => JSON.stringify(values)));

  assert.equal(cases.length, 120);
  assert.equal(cases.filter(({ eventName }) => eventName === "schedule").length, 24);
  assert.equal(cases.filter(({ eventName }) => eventName === "workflow_dispatch").length, 96);
  assert.equal(uniqueInputs.size, cases.length, "matrix contains duplicate policy inputs");

  for (const scenario of cases) {
    const policy = resolvePolicy(scenario);
    const expectedMode = scenario.eventName === "workflow_dispatch"
      ? scenario.manualMode
      : scenario.configuredMode;
    const expectedReviewRepo = scenario.manualReviewRepo || "acme/control-plane";
    const percentageCap = scenario.rolloutPercent === 10 ? 3 : 25;

    assert.equal(policy.enabled, scenario.packageEnabled, scenario.id);
    assert.equal(policy.safeOutputMode, scenario.packageEnabled ? expectedMode : null, scenario.id);
    assert.equal(
      policy.safeOutputRepo,
      scenario.packageEnabled && expectedMode === "review" ? expectedReviewRepo : "",
      scenario.id,
    );
    assert.equal(
      policy.dispatchAllowed,
      scenario.packageEnabled,
      scenario.id,
    );
    assert.equal(
      policy.effectiveMaxRepos,
      scenario.packageEnabled
        ? (scenario.maxRepos ? Math.min(scenario.maxRepos, percentageCap) : percentageCap)
        : 0,
      scenario.id,
    );
  }
});

test("every checked user-facing scenario is backed by the exhaustive matrix", () => {
  const cases = policyCases();
  const groupCounts = Object.groupBy(userFacingScenarios, ({ group }) => group);

  assert.equal(userFacingScenarios.length, 22);
  assert.equal(new Set(userFacingScenarios.map(({ name }) => name)).size, 22);
  assert.equal(groupCounts["Scheduled modes"].length, 4);
  assert.equal(groupCounts["Manual runs"].length, 3);
  assert.equal(groupCounts["Review routing"].length, 4);
  assert.equal(groupCounts["Rollout limits"].length, 7);
  assert.equal(groupCounts["Kill switch"].length, 4);

  for (const scenario of userFacingScenarios) {
    const matrixCase = cases.find(({ id, totalRepositories, ...inputs }) =>
      Object.entries(scenario.inputs).every(([name, value]) => inputs[name] === value)
      && inputs.packageEnabled === (scenario.inputs.packageEnabled ?? true));

    assert.ok(matrixCase, `${scenario.name} is missing from the exhaustive matrix`);
    const policy = resolvePolicy(matrixCase);
    assert.equal(policy.enabled, scenario.inputs.packageEnabled ?? true, scenario.name);
    const { enabled, ...actual } = policy;
    assert.deepEqual(actual, scenario.expected, scenario.name);
  }
});

test("percentage rollout rejects invalid settings and handles an empty organization", () => {
  for (const maxRepos of [0, -1, 1.5, 1001, Number.NaN]) {
    assert.throws(
      () => resolvePolicy({ maxRepos, rolloutPercent: 100, totalRepositories: 10 }),
      RangeError,
    );
  }

  for (const rolloutPercent of [0, 101, 10.5, Number.NaN]) {
    assert.throws(
      () => resolvePolicy({ rolloutPercent, totalRepositories: 10 }),
      RangeError,
    );
  }

  assert.equal(resolvePolicy({ maxRepos: 1, rolloutPercent: 10, totalRepositories: 0 }).effectiveMaxRepos, 0);
  for (const configuredMode of ["unknown", "preview", "preview_only", "staged", "Review", "LIVE", "review "]) {
    assert.throws(() => resolvePolicy({
      eventName: "schedule",
      configuredMode,
      maxRepos: 1,
      rolloutPercent: 100,
      totalRepositories: 25,
    }), RangeError);
  }
  assert.deepEqual(resolvePolicy({
    eventName: "schedule",
    configuredMode: "invalid-but-disabled",
    packageEnabled: false,
    maxRepos: 0,
    rolloutPercent: 0,
    totalRepositories: 25,
  }), {
    enabled: false,
    safeOutputMode: null,
    safeOutputRepo: "",
    effectiveMaxRepos: 0,
    dispatchAllowed: false,
  });
  assert.equal(resolvePolicy({
    eventName: "schedule",
    configuredMode: "",
    maxRepos: 1,
    rolloutPercent: 100,
    totalRepositories: 25,
  }).safeOutputMode, "review");
  assert.equal(resolvePolicy({
    eventName: "workflow_dispatch",
    manualMode: "",
    maxRepos: 1,
    rolloutPercent: 100,
    totalRepositories: 25,
  }).safeOutputMode, "review");
});

test("manual requests run independently of scheduled configuration", () => {
  for (const manualMode of modes) {
    const policy = resolvePolicy({
      eventName: "workflow_dispatch",
      configuredMode: manualMode === "review" ? "live" : "review",
      manualMode,
      manualReviewRepo: manualMode === "review" ? "acme/manual-review" : "",
      maxRepos: 1,
      rolloutPercent: 100,
      totalRepositories: 25,
    });

    assert.equal(policy.enabled, true, manualMode);
    assert.equal(policy.safeOutputMode, manualMode, manualMode);
    assert.equal(policy.dispatchAllowed, true, manualMode);
  }
});

test("enterprise-scale limits remain bounded across inventory sizes", () => {
  const inventorySizes = [0, 1, 2, 10, 99, 100, 999, 1000, 10_000, 1_000_000];
  const rolloutPercents = [1, 2, 10, 33, 50, 99, 100];
  const absoluteCaps = [1, 10, 50, 1000];

  for (const totalRepositories of inventorySizes) {
    for (const rolloutPercent of rolloutPercents) {
      for (const maxRepos of absoluteCaps) {
        const policy = resolvePolicy({
          eventName: "schedule",
          configuredMode: "live",
          maxRepos,
          rolloutPercent,
          totalRepositories,
          dispatchMax: 50,
          eligibleWorkers: 1,
        });
        const percentageCap = totalRepositories === 0
          ? 0
          : Math.max(1, Math.ceil(totalRepositories * rolloutPercent / 100));

        assert.equal(policy.effectiveMaxRepos, Math.min(maxRepos, percentageCap, 50));
        assert.ok(policy.effectiveMaxRepos <= 50);
      }
    }
  }

  assert.equal(resolvePolicy({
    eventName: "schedule",
    configuredMode: "live",
    maxRepos: 1000,
    rolloutPercent: 100,
    totalRepositories: 1_000_000,
    dispatchMax: 20,
    eligibleWorkers: 4,
  }).effectiveMaxRepos, 5, "four workers share the optimization dispatch budget");
  assert.equal(resolvePolicy({
    eventName: "schedule",
    configuredMode: "live",
    maxRepos: 1000,
    rolloutPercent: 100,
    totalRepositories: 1_000_000,
    dispatchMax: 20,
    eligibleWorkers: 0,
  }).effectiveMaxRepos, 0, "disabled workers form a worker-level kill switch");
});

test("enterprise defaults, budgets, timeouts, and concurrency are finite", () => {
  const expected = {
    "uk-ai-advisory.md": { credits: 250, timeout: 15, dispatchMax: 50, workers: 1 },
    "uk-ai-advisory-package-maintainer.md": { credits: 200, timeout: 20 },
    "uk-ai-advisory-operational-resilience.md": { credits: 600, timeout: 30 },
    "cao-evolution.md": { credits: 250, timeout: 15, dispatchMax: 6, workers: 6 },
    "cao-evolution-catalog-advisor.md": { credits: 400, timeout: 40 },
    "cao-evolution-efficiency.md": { credits: 450, timeout: 40 },
    "cao-evolution-integrity.md": { credits: 400, timeout: 35 },
    "cao-evolution-reliability.md": { credits: 450, timeout: 40 },
    "dependabot.md": { credits: 250, timeout: 15, dispatchMax: 50, workers: 1 },
    "eslint-rules.md": { credits: 250, timeout: 15, dispatchMax: 5, workers: 5 },
    "eslint-rules-inventory.md": { credits: 200, timeout: 20 },
    "eslint-rules-miner.md": { credits: 450, timeout: 30 },
    "eslint-rules-refiner.md": { credits: 450, timeout: 30 },
    "eslint-rules-applier.md": { credits: 350, timeout: 25 },
    "eslint-rules-librarian.md": { credits: 300, timeout: 25 },
    "eu-cra-compliance.md": { credits: 200, timeout: 15, dispatchMax: 48, workers: 6 },
    "eu-cra-compliance-package-maintainer.md": { credits: 200, timeout: 20 },
    "optimization.md": { credits: 250, timeout: 15, dispatchMax: 20, workers: 5 },
    "self-care.md": { credits: 200, timeout: 15, dispatchMax: 15, workers: 15 },
    "optimization-agents-md-curator.md": { credits: 400, timeout: 25 },
    "optimization-skills-curator.md": { credits: 400, timeout: 20 },
    "cao-evolution-failures-investigator.md": { credits: 500, timeout: 30 },
    "cao-evolution-compiler-security.md": { credits: 500, timeout: 45 },
    "dependabot-release-train-updater.md": { credits: 600, timeout: 60 },
    "eu-cra-compliance-article-14-reporting-readiness.md": { credits: 100, timeout: 30 },
    "eu-cra-compliance-conformity-release-evidence.md": { credits: 100, timeout: 30 },
    "eu-cra-compliance-scope-classifier.md": { credits: 100, timeout: 25 },
    "eu-cra-compliance-security-requirements-auditor.md": { credits: 100, timeout: 30 },
    "eu-cra-compliance-supply-chain-sbom-auditor.md": { credits: 100, timeout: 30 },
    "eu-cra-compliance-vulnerability-handling-auditor.md": { credits: 100, timeout: 30 },
    "optimization-ai-credit-auditor.md": { credits: 350, timeout: 35 },
    "optimization-ai-credit-optimizer.md": { credits: 500, timeout: 30 },
    "optimization-token-optimizer.md": { credits: 300, timeout: 20 },
    "software-development-practices.md": { credits: 250, timeout: 15, dispatchMax: 20, workers: 2 },
    "software-development-practices-github-well-architected.md": { credits: 400, timeout: 30 },
    "software-development-practices-nist-ssdf.md": { credits: 400, timeout: 30 },
    "self-care-accessibility-checker.md": { credits: 400, timeout: 30 },
    "self-care-code-improvement.md": { credits: 400, timeout: 30 },
    "self-care-dashboard-data-schema.md": { credits: 100, timeout: 15 },
    "self-care-dashboard-debug-logging.md": { credits: 350, timeout: 40 },
    "self-care-dashboard-performance.md": { credits: 400, timeout: 30 },
    "self-care-data-acquisition-audit.md": { credits: 300, timeout: 20 },
    "self-care-dashboard-language-refactor.md": { credits: 400, timeout: 30 },
    "self-care-dashboard-review.md": { credits: 400, timeout: 30 },
    "self-care-experimental-views.md": { credits: 600, timeout: 120 },
    "self-care-docs-build-time-investigator.md": { credits: 400, timeout: 30 },
    "self-care-glossary.md": { credits: 400, timeout: 30 },
    "self-care-open-source-failures.md": { credits: 500, timeout: 30 },
    "self-care-pages-health.md": { credits: 400, timeout: 120 },
    "self-care-primer-brand-checker.md": { credits: 400, timeout: 25 },
    "self-care-reactive-ui-expert.md": { credits: 500, timeout: 45 },
  };

  for (const [name, limits] of Object.entries(expected)) {
    const source = workflow(name);
    assert.match(source, new RegExp(`max-ai-credits: ${limits.credits}`), name);
    assert.match(source, new RegExp(`timeout-minutes: ${limits.timeout}`), name);
    assert.match(source, /concurrency:\n\s+group:.*\n\s+job-discriminator: \$\{\{ github\.run_id \}\}\n\s+cancel-in-progress: true/, name);
    assert.doesNotMatch(source, /^\s+(contents|actions|issues|pull-requests): write$/m, name);
    if (limits.dispatchMax) {
      assert.match(source, new RegExp(`dispatch_max: ${limits.dispatchMax}`), name);
      assert.match(source, new RegExp(`dispatch-workflow:[\\s\\S]*?max: ${limits.dispatchMax}`), name);
      assert.match(source, new RegExp(`orchestrator_credits: ${limits.credits}`), name);
    }
  }

  const control = workflow("shared/control.md");
  const precompute = controlPrecompute();
  assert.match(control, /package:\n\s+type: string\n\s+required: true/);
  assert.match(control, /role:\n\s+type: choice\n\s+options: \[orchestrator, worker\]/);
  assert.match(control, /worker:\n\s+type: string\n\s+default: "__none__"/);
  assert.match(precompute, /join\(admissionDirectory\(\), "effective-policy\.json"\)/);
  assert.doesNotMatch(control, /^steps:/m);
  assert.match(precompute, /max_repos must be an integer from 1 through 1000/);
  assert.match(precompute, /max_scan_repos must be an integer from 1 through 100000/);
  assert.match(precompute, /assertUniqueStrings\(scope\["allowed-repositories"\], "control-plane\.scope\.allowed-repositories"/);
  assert.match(precompute, /source: "allowed_repos"/);
  assert.match(precompute, /inventory_version/);
  assert.match(precompute, /batch_id/);
  assert.match(precompute, /id % cellCount/);
  assert.match(precompute, /dispatch_max must be an integer from 1 through 1000/);
  assert.match(precompute, /Math\.floor\(context\.dispatchMaximum \/ eligibleWorkers\)/);
  assert.doesNotMatch(precompute, /monthly_credit_budget must be a non-negative integer/);
  assert.doesNotMatch(precompute, /gh", \["aw", "logs"/);
  assert.doesNotMatch(precompute, /--paginate/);
  assert.doesNotMatch(`${control}\n${precompute}`, /vars\.CENTRAL_AGENTIC_OPS_|repositories: \["\*"\]/);
});

test("control workflows deny before activation through one shared admission contract", () => {
  const sharedControl = workflow("shared/control.md");
  const controlled = readdirSync(workflowsDirectory)
    .filter((name) => name.endsWith(".md") && !name.endsWith(".lock.md"))
    .map((name) => [name, workflow(name)])
    .filter(([, source]) => /^\s+- uses: shared\/control\.md$/m.test(source));

  assert.equal(controlled.length, 56, "unexpected shared control workflow count");
  assert.equal(
    [...sharedControl.matchAll(/^\s+- name: Evaluate Central Agentic Ops admission$/gm)].length,
    1,
  );
  assert.match(sharedControl, /^\s+id: cao_admission$/m);
  assert.match(sharedControl, /Generate CAO pre-activation GitHub App token/);
  assert.match(sharedControl, /actions\/create-github-app-token@v3\.2\.0/);
  assert.match(sharedControl, /permission-actions: read[\s\S]*?permission-contents: read/);
  assert.match(sharedControl, /CAO_API_TOKEN: \$\{\{ steps\.cao_pre_activation_app_token\.outputs\.token \|\| secrets\.GH_AW_GITHUB_TOKEN \|\| github\.token \}\}/);
  assert.match(sharedControl, /name: Checkout CAO control modules/);
  assert.match(sharedControl, /actions\/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7\.0\.1/);
  assert.match(sharedControl, /ref: \$\{\{ github\.workflow_sha \}\}/);
  assert.match(sharedControl, /path: \.cao\n/);
  assert.match(sharedControl, /sparse-checkout: \.github/);
  assert.match(sharedControl, /sparse-checkout-cone-mode: true/);
  assert.match(sharedControl, /fetch-depth: 1/);
  assert.doesNotMatch(sharedControl, /gh api --method GET "repos\/\$\{GITHUB_REPOSITORY\}\/contents\/\.github\/cao\/src/);
  assert.doesNotMatch(sharedControl, /base64\s+(?:-d|--decode)/);
  assert.match(stepBlock(sharedControl, "Evaluate Central Agentic Ops admission"), /uses: actions\/github-script@v9(?:\.0\.0)?/);
  assert.match(stepBlock(sharedControl, "Evaluate Central Agentic Ops admission"), /await control\.main\(\{ core, github, context, exec, io, getOctokit \}, \['admit'\]\)/);
  assert.match(stepBlock(sharedControl, "Run CAO control precompute"), /uses: actions\/github-script@v9(?:\.0\.0)?/);
  assert.match(stepBlock(sharedControl, "Run CAO control precompute"), /await control\.main\(\{ core, github, context, exec, io, getOctokit \}, \['precompute'\]\)/);
  assert.doesNotMatch(sharedControl, /permission-actions: write/);
  assert.doesNotMatch(sharedControl, /CAO_GITHUB_API_GATE|persist-api-gate|gate_writer_token/);
  assert.match(sharedControl, /CAO admission blocked: GitHub API limited until \$\{\{ steps\.cao_admission\.outputs\.github_api_reset_at \}\}/);
  assert.match(sharedControl, /reason == 'github-api-capacity-insufficient'/);
  assert.match(sharedControl, /^\s+id: cao_precompute$/m);
  assert.match(sharedControl, /CAO precompute blocked: GitHub API limited until \$\{\{ steps\.cao_precompute\.outputs\.github_api_reset_at \}\}/);
  assert.match(stepBlock(sharedControl, "\"CAO precompute blocked: GitHub API limited until ${{ steps.cao_precompute.outputs.github_api_reset_at }}\""), /::warning title=CAO precompute blocked by GitHub API capacity/);
  assert.doesNotMatch(stepBlock(sharedControl, "\"CAO precompute blocked: GitHub API limited until ${{ steps.cao_precompute.outputs.github_api_reset_at }}\""), /^\s+exit 1$/m);
  assert.match(stepBlock(sharedControl, "\"CAO precompute blocked: GitHub API capacity unavailable\""), /::warning title=CAO precompute could not verify GitHub API capacity/);
  assert.doesNotMatch(stepBlock(sharedControl, "\"CAO precompute blocked: GitHub API capacity unavailable\""), /^\s+exit 1$/m);
  assert.match(sharedControl, /name: Validate CAO control precompute artifact\n\s+if: \$\{\{ steps\.cao_admission\.outputs\.authorized == 'true' && steps\.cao_precompute\.outputs\.authorized != 'false' \}\}/);
  assert.match(sharedControl, /name: Upload CAO control precompute artifact\n\s+if: \$\{\{ steps\.cao_admission\.outputs\.authorized == 'true' && steps\.cao_precompute\.outputs\.authorized != 'false' \}\}/);
  assert.match(sharedControl, /const reason = 'cannot read or execute the CAO control modules at github\.workflow_sha'/);
  for (const [name, source] of controlled) {
    assert.equal(
      [...source.matchAll(/^\s+- name: Evaluate Central Agentic Ops admission$/gm)].length,
      0,
      name,
    );
    assert.match(
      source,
      /on:[\s\S]*?permissions:\n\s+(?:actions: read\n\s+contents: read|contents: read\n\s+actions: read)/,
      name,
    );
    assert.match(source, /jobs:\n  pre-activation:\n    outputs:\n      cao_authorized: \$\{\{ steps\.cao_admission\.outputs\.authorized == 'true' && steps\.cao_precompute\.outputs\.authorized != 'false' \}\}/, name);
    assert.match(source, /^if: needs\.pre_activation\.outputs\.cao_authorized == 'true'$/m, name);

    const generatedName = name.replace(/\.md$/, ".lock.yml");
    const generated = workflow(generatedName);
    const jobs = generatedJobs(generated);
    const preActivation = jobs.get("pre_activation")?.block ?? "";
    const activation = jobs.get("activation")?.block ?? "";

    assert.match(preActivation, /cao_authorized: \$\{\{ steps\.cao_admission\.outputs\.authorized == 'true' && steps\.cao_precompute\.outputs\.authorized != 'false' \}\}/, generatedName);
    assert.match(preActivation, /Evaluate Central Agentic Ops admission/, generatedName);
    assert.match(preActivation, /Generate CAO pre-activation GitHub App token/, generatedName);
    assert.doesNotMatch(preActivation, /github\/gh-aw-actions\/setup-cli@/, generatedName);
    assert.match(preActivation, /CAO admission blocked: GitHub API limited until/, generatedName);
    assert.match(preActivation, /CAO precompute blocked: GitHub API limited until/, generatedName);
    assert.match(stepBlock(preActivation, "\"CAO precompute blocked: GitHub API capacity unavailable\""), /::warning title=CAO precompute could not verify GitHub API capacity/);
    assert.doesNotMatch(stepBlock(preActivation, "\"CAO precompute blocked: GitHub API capacity unavailable\""), /^\s+exit 1$/m);
    assert.match(preActivation, /Validate CAO control precompute artifact[\s\S]*?if: \$\{\{ steps\.cao_admission\.outputs\.authorized == 'true' && steps\.cao_precompute\.outputs\.authorized != 'false' \}\}/, generatedName);
    assert.match(preActivation, /Upload CAO control precompute artifact[\s\S]*?if: \$\{\{ steps\.cao_admission\.outputs\.authorized == 'true' && steps\.cao_precompute\.outputs\.authorized != 'false' \}\}/, generatedName);
    assert.match(activation, /needs\.pre_activation\.outputs\.cao_authorized == 'true'/, generatedName);
    assert.ok(transitivelyNeeds(jobs, "agent", "activation"), `${generatedName}: agent must depend on activation`);
  }
});

test("live workers use central policy as the activation authority", () => {
  const control = workflow("shared/control.md");
  const precompute = controlPrecompute();

  assert.match(control, /package:\n\s+type: string\n\s+required: true/);
  assert.doesNotMatch(precompute, /validateLiveAuthority|target_authority_source|target default branch/);
  assert.match(precompute, /validateWorkerDispatch\(context\)[\s\S]*writeWorkerPrecompute\(context\)/);

  for (const [name, bundle] of [
    ["uk-ai-advisory.md", "uk-ai-advisory"],
    ["uk-ai-advisory-operational-resilience.md", "uk-ai-advisory"],
    ["optimization-agents-md-curator.md", "optimization"],
    ["optimization-skills-curator.md", "optimization"],
    ["cao-evolution-failures-investigator.md", "cao-evolution"],
    ["cao-evolution.md", "cao-evolution"],
    ["cao-evolution-efficiency.md", "cao-evolution"],
    ["cao-evolution-integrity.md", "cao-evolution"],
    ["cao-evolution-reliability.md", "cao-evolution"],
    ["cao-evolution-compiler-security.md", "cao-evolution"],
    ["dependabot.md", "dependabot"],
    ["dependabot-release-train-updater.md", "dependabot"],
    ["eslint-rules.md", "eslint-rules"],
    ["eslint-rules-inventory.md", "eslint-rules"],
    ["eslint-rules-miner.md", "eslint-rules"],
    ["eslint-rules-refiner.md", "eslint-rules"],
    ["eslint-rules-applier.md", "eslint-rules"],
    ["eslint-rules-librarian.md", "eslint-rules"],
    ["eu-cra-compliance.md", "eu-cra-compliance"],
    ["eu-cra-compliance-article-14-reporting-readiness.md", "eu-cra-compliance"],
    ["eu-cra-compliance-conformity-release-evidence.md", "eu-cra-compliance"],
    ["eu-cra-compliance-scope-classifier.md", "eu-cra-compliance"],
    ["eu-cra-compliance-security-requirements-auditor.md", "eu-cra-compliance"],
    ["eu-cra-compliance-supply-chain-sbom-auditor.md", "eu-cra-compliance"],
    ["eu-cra-compliance-vulnerability-handling-auditor.md", "eu-cra-compliance"],
    ["optimization.md", "optimization"],
    ["optimization-ai-credit-auditor.md", "optimization"],
    ["optimization-ai-credit-optimizer.md", "optimization"],
    ["optimization-token-optimizer.md", "optimization"],
    ["software-development-practices.md", "software-development-practices"],
    ["software-development-practices-github-well-architected.md", "software-development-practices"],
    ["software-development-practices-nist-ssdf.md", "software-development-practices"],
    ["self-care.md", "self-care"],
    ["self-care-accessibility-checker.md", "self-care"],
    ["self-care-code-improvement.md", "self-care"],
    ["self-care-dashboard-data-schema.md", "self-care"],
    ["self-care-dashboard-debug-logging.md", "self-care"],
    ["self-care-dashboard-performance.md", "self-care"],
    ["self-care-data-acquisition-audit.md", "self-care"],
    ["self-care-dashboard-language-refactor.md", "self-care"],
    ["self-care-dashboard-review.md", "self-care"],
    ["self-care-experimental-views.md", "self-care"],
    ["self-care-docs-build-time-investigator.md", "self-care"],
    ["self-care-glossary.md", "self-care"],
    ["self-care-open-source-failures.md", "self-care"],
    ["self-care-pages-health.md", "self-care"],
    ["self-care-primer-brand-checker.md", "self-care"],
    ["self-care-reactive-ui-expert.md", "self-care"],
  ]) {
    assert.match(workflow(name), new RegExp(`package: ${bundle}`));
  }
});

test("orchestrators use checked-in policy with independent manual narrowing", () => {
  for (const [name, packageName] of [
    ["uk-ai-advisory.md", "uk-ai-advisory"],
    ["cao-evolution.md", "cao-evolution"],
    ["dependabot.md", "dependabot"],
    ["eslint-rules.md", "eslint-rules"],
    ["eu-cra-compliance.md", "eu-cra-compliance"],
    ["optimization.md", "optimization"],
    ["repo-assist.md", "repo-assist"],
    ["software-development-practices.md", "software-development-practices"],
    ["self-care.md", "self-care"],
  ]) {
    const source = workflow(name);

    assert.match(source, /rollout_percent:\n\s+default: 100\n\s+type: number/);
    assert.match(source, /max_repos:\n\s+default: 1\n\s+type: number/);
    assert.match(source, /safe_output_mode:\n\s+default: "review"\n\s+type: choice/);
    assert.match(source, new RegExp(`package: ${packageName}`));
    assert.match(source, /role: orchestrator/);
    assert.doesNotMatch(source, /vars\.CENTRAL_AGENTIC_OPS_|cell_count:|cell_index:|batch_size:|batch_index:/);
  }
});

test("operation workflows optionally load per-operation markdown steering", () => {
  const packageSkill = readFileSync(join(root, "skills", "create-cao-package", "SKILL.md"), "utf8");

  assert.match(packageSkill, /Every orchestrator and worker prompt must include[\s\S]*at the bottom of the Markdown body/);
  assert.match(packageSkill, /Never place the runtime import at the top of the Markdown body/);
  assert.match(packageSkill, /\{\{#runtime-import\? \.github\/cao\/<package-slug>\.md\}\}/);

  for (const [name, operation] of [
    ["uk-ai-advisory.md", "uk-ai-advisory"],
    ["uk-ai-advisory-operational-resilience.md", "uk-ai-advisory"],
    ["optimization-agents-md-curator.md", "optimization"],
    ["optimization-skills-curator.md", "optimization"],
    ["cao-evolution-failures-investigator.md", "cao-evolution"],
    ["cao-evolution-compiler-security.md", "cao-evolution"],
    ["dependabot.md", "dependabot"],
    ["dependabot-release-train-updater.md", "dependabot"],
    ["eslint-rules.md", "eslint-rules"],
    ["eslint-rules-inventory.md", "eslint-rules"],
    ["eslint-rules-miner.md", "eslint-rules"],
    ["eslint-rules-refiner.md", "eslint-rules"],
    ["eslint-rules-applier.md", "eslint-rules"],
    ["eslint-rules-librarian.md", "eslint-rules"],
    ["eu-cra-compliance.md", "eu-cra-compliance"],
    ["eu-cra-compliance-article-14-reporting-readiness.md", "eu-cra-compliance"],
    ["eu-cra-compliance-conformity-release-evidence.md", "eu-cra-compliance"],
    ["eu-cra-compliance-scope-classifier.md", "eu-cra-compliance"],
    ["eu-cra-compliance-security-requirements-auditor.md", "eu-cra-compliance"],
    ["eu-cra-compliance-supply-chain-sbom-auditor.md", "eu-cra-compliance"],
    ["eu-cra-compliance-vulnerability-handling-auditor.md", "eu-cra-compliance"],
    ["optimization.md", "optimization"],
    ["optimization-ai-credit-auditor.md", "optimization"],
    ["optimization-ai-credit-optimizer.md", "optimization"],
    ["optimization-token-optimizer.md", "optimization"],
    ["repo-assist.md", "repo-assist"],
    ["repo-assist-issue-fix.md", "repo-assist"],
    ["repo-assist-issue-triage.md", "repo-assist"],
    ["repo-assist-maintenance.md", "repo-assist"],
    ["repo-assist-pr-upkeep.md", "repo-assist"],
    ["software-development-practices.md", "software-development-practices"],
    ["software-development-practices-github-well-architected.md", "software-development-practices"],
    ["software-development-practices-nist-ssdf.md", "software-development-practices"],
    ["self-care.md", "self-care"],
    ["self-care-accessibility-checker.md", "self-care"],
    ["self-care-code-improvement.md", "self-care"],
    ["self-care-dashboard-data-schema.md", "self-care"],
    ["self-care-dashboard-debug-logging.md", "self-care"],
    ["self-care-dashboard-performance.md", "self-care"],
    ["self-care-data-acquisition-audit.md", "self-care"],
    ["self-care-dashboard-language-refactor.md", "self-care"],
    ["self-care-dashboard-review.md", "self-care"],
    ["self-care-experimental-views.md", "self-care"],
    ["self-care-docs-build-time-investigator.md", "self-care"],
    ["self-care-glossary.md", "self-care"],
    ["self-care-open-source-failures.md", "self-care"],
    ["self-care-pages-health.md", "self-care"],
    ["self-care-primer-brand-checker.md", "self-care"],
    ["self-care-reactive-ui-expert.md", "self-care"],
  ]) {
    assert.match(
      workflow(name),
      new RegExp(`\\{\\{#runtime-import\\? \\.github/cao/${operation}\\.md\\}\\}\\s*$`),
    );
  }
});

test("review destinations allow control self-review and isolate other targets", () => {
  const precompute = controlPrecompute();

  assert.match(precompute, /validateOutputDestination/);
  assert.match(precompute, /repositoryEqual\(safeOutputRepository, targetRepository\)[\s\S]*!repositoryEqual\(safeOutputRepository, controlRepository\)/);
  assert.match(precompute, /review safe_output_repo must differ from target_repo/);
  assert.match(precompute, /live worker safe_output_repo must equal target_repo/);
  assert.match(precompute, /repositoryEqual\(safeOutputRepository, controlRepository\)\) return/);
  assert.match(precompute, /ghApi\(`repos\/\$\{safeOutputRepository\}`\)/);
  assert.match(precompute, /review safe_output_repo must be accessible/);
  assert.match(precompute, /non-central review safe_output_repo must be private/);
});

test("safe-output modes are review and live with a separate package kill switch", () => {
  const control = workflow("shared/control.md");
  const precompute = controlPrecompute();

  assert.match(precompute, /typeof policy\.authorized !== "boolean"/);
  assert.match(precompute, /if \(!policy\.authorized\)/);
  assert.match(precompute, /type: "noop"/);
  assert.doesNotMatch(`${control}\n${precompute}`, /preview_only|\bstaged\b/);
});

test("exact package target modes flow through candidate dispatch and reporting", () => {
  const control = workflow("shared/control.md");
  const precompute = controlPrecompute();

  assert.match(precompute, /targetRepository: environment\("CAO_TARGET_REPOSITORY"\)/);
  assert.match(precompute, /target_policies\?\.\[repository\.full_name\.toLowerCase\(\)\]\?\.mode \?\? context\.mode/);
  assert.match(precompute, /worker_policies\?\.\[configured\]/);
  assert.match(precompute, /worker disabled by control-plane policy/);
  assert.match(precompute, /resolvedCandidates = candidates\.map/);
  assert.match(control, /treat each candidate's `safe_output_mode` as authoritative for that target/);
  assert.match(control, /start `effective_safe_output_mode` at the selected candidate's `safe_output_mode`/);
  assert.match(control, /when the worker's `max_mode` is `review`, set `effective_safe_output_mode` to `review`/);
  assert.match(control, /never use a worker ceiling to widen a review candidate/);
  assert.match(control, /when `effective_safe_output_mode` is `live`, set `effective_safe_output_repo` to the selected target repository/);
  assert.match(control, /`safe_output_mode`: `effective_safe_output_mode`/);
  assert.match(control, /Selected target modes: <target-to-mode list or none>/);
  assert.match(control, /const effectiveMode = dispatchModes\.size === 0[\s\S]*?: 'mixed';/);
});

test("shared control keeps manual and scheduled routing event-scoped", () => {
  const control = workflow("shared/control.md");
  const precompute = controlPrecompute();

  for (const name of ["uk-ai-advisory.md", "cao-evolution.md", "dependabot.md", "eslint-rules.md", "eu-cra-compliance.md", "optimization.md", "repo-assist.md", "self-care.md", "software-development-practices.md"]) {
    const orchestrator = workflow(name);
    assert.match(orchestrator, /GH_AW_SAFE_OUTPUT_MODE:.*inputs\.safe_output_mode.*\|\| 'review'/);
    assert.match(orchestrator, /REVIEW_OUTPUT_REPO:.*inputs\.safe_output_repo \|\| github\.repository/);
    assert.match(orchestrator, /SAFE_OUTPUT_REPO:.*== 'review'/);
    assert.doesNotMatch(orchestrator, /vars\.CENTRAL_AGENTIC_OPS_/);
  }
  assert.match(control, /CAO_REQUESTED_MODE: \$\{\{ inputs\.safe_output_mode \|\| '' \}\}/);
  assert.match(control, /CAO_SAFE_OUTPUT_REPOSITORY: \$\{\{ \(inputs\.safe_output_mode/);
  assert.doesNotMatch(control, /review_repo/);
  assert.match(control, /CAO_REQUESTED_ROLLOUT_PERCENT: \$\{\{ inputs\.rollout_percent \|\| '' \}\}/);
  assert.match(control, /select no more than `effective_max_repos` repositories/);

  assert.match(precompute, /rollout_percent must be an integer from 1 through 100/);
  assert.match(precompute, /effective_max_repos:/);
  assert.match(precompute, /Math\.ceil\(resolvedCandidates\.length \* context\.policy\.rollout_percent \/ 100\)/);
  assert.doesNotMatch(precompute, /ROLLOUT_PERCENT.*(?:eval|curl|gh api)/);
});

test("blank manual runs preserve an empty target for allowlisted discovery", () => {
  const control = workflow("shared/control.md");

  assert.match(
    control,
    /CAO_TARGET_REPOSITORY: \$\{\{ inputs\.target_repo \|\| '' \}\}/,
  );
  assert.doesNotMatch(control, /target_repo:.*github\.repository/);
});

test("workers reject disabled, malformed, or over-ceiling dispatches before execution", () => {
  const control = workflow("shared/control.md");
  const precompute = controlPrecompute();

  for (const input of ["worker", "correlation_id", "central_repo", "control_plane_run_url"]) {
    assert.match(control, new RegExp(input));
    assert.match(precompute, new RegExp(`${input}:`));
  }
  assert.match(precompute, /join\(admissionDirectory\(\), "effective-policy\.json"\)/);
  assert.match(control, /Evaluate Central Agentic Ops admission/);
  assert.match(precompute, /validateWorkerDispatch\(context\)[\s\S]*writeWorkerPrecompute\(context\)/);
  assert.match(precompute, /must be review or live/);
  assert.match(precompute, /central_repo must identify the current control repository/);
  assert.match(precompute, /control_plane_run_url must match correlation_id and central_repo/);
  assert.doesNotMatch(`${control}\n${precompute}`, /vars\.CENTRAL_AGENTIC_OPS_/);
});
