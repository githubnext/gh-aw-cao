import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { parse } from "yaml";
import { root, workflow } from "./workflow-contract.helpers.mjs";

// CAO Evolution and AW Optimization operation contracts.

test("AW Optimization combines AI Credit and ambient-context workers", () => {
  const orchestrator = workflow("optimization.md");
  const manifest = parse(readFileSync(join(root, "optimization", "aw.yml"), "utf8"));
  const dashboard = JSON.parse(readFileSync(join(root, "optimization", "dashboard.json"), "utf8"));
  const policy = JSON.parse(readFileSync(join(root, ".github", "workflows", "cao.json"), "utf8"));
  const workerNames = [
    ["optimization-ai-credit-auditor.md", "AW Optimization / AI Credit Audit"],
    ["optimization-ai-credit-optimizer.md", "AW Optimization / AI Credit Savings"],
    ["optimization-agents-md-curator.md", "AW Optimization / AGENTS.md"],
    ["optimization-skills-curator.md", "AW Optimization / Skills"],
    ["optimization-token-efficiency-auditor.md", "AW Optimization / Token Auditor"],
    ["optimization-token-optimizer.md", "AW Optimization / Token Optimizer"],
    ["optimization-token-efficiency-verifier.md", "AW Optimization / Token Efficiency Verifier"],
  ];

  assert.equal(manifest.name, "AW Optimization");
  assert.equal(dashboard.dashboard.title, "AW Optimization");
  assert.match(orchestrator, /^name: "AW Optimization"$/m);
  assert.match(orchestrator, /worker_credits_per_target: 1950/);
  assert.match(
    orchestrator,
    /workflows: \[optimization-ai-credit-auditor, optimization-ai-credit-optimizer, optimization-agents-md-curator, optimization-skills-curator, optimization-token-efficiency-auditor, optimization-token-optimizer, optimization-token-efficiency-verifier\]/,
  );
  assert.deepEqual(
    Object.keys(policy["control-plane"].packages.optimization.workers).sort(),
    [
      "ai-credit-auditor",
      "ai-credit-optimizer",
      "agents-md-curator",
      "skills-curator",
      "token-efficiency-auditor",
      "token-optimizer",
      "token-efficiency-verifier",
    ].sort(),
  );
  assert.equal(policy["control-plane"].packages["ambient-context"], undefined);
  for (const [name, displayName] of workerNames) {
    assert.match(workflow(name), new RegExp(`^name: "${displayName.replace("/", "\\/")}"$`, "m"));
  }
});

test("CAO Evolution is review-first, role-scoped, and deduplicated", () => {
  const manifest = parse(readFileSync(join(root, "cao-evolution", "aw.yml"), "utf8"));
  const dashboard = JSON.parse(readFileSync(join(root, "cao-evolution", "dashboard.json"), "utf8"));
  const policy = JSON.parse(readFileSync(join(root, ".github", "workflows", "cao.json"), "utf8"));
  const orchestrator = workflow("cao-evolution.md");
  const workers = [
    ["catalog-advisor", "cao-evolution-catalog-advisor"],
    ["compiler-security", "cao-evolution-compiler-security"],
    ["efficiency", "cao-evolution-efficiency"],
    ["failures-investigator", "cao-evolution-failures-investigator"],
    ["integrity", "cao-evolution-integrity"],
    ["reliability", "cao-evolution-reliability"],
  ];

  assert.equal(manifest.name, "CAO Evolution");
  assert.equal(dashboard.dashboard.title, "CAO Evolution");
  assert.deepEqual(dashboard.dashboard.pages[0].views[0], {
    id: "cao-evolution-outcome-health",
    title: "Maintenance outcome health",
    description: "The disposition of retained maintenance outcomes shows whether control-plane recommendations are progressing through review.",
    data: { source: "cao-evolution-outcomes" },
    mark: "chart",
    chart: "pie",
    layout: "full",
    encoding: {
      x: { field: "outcome-state", type: "nominal", title: "Outcome state" },
      y: { field: "safe-output", type: "quantitative", aggregate: "count", title: "Outcomes" },
    },
  });
  assert.deepEqual(manifest.includes.sort(), [
    "../aw.yml",
    ".github/workflows/cao-evolution-catalog-advisor.md",
    ".github/workflows/cao-evolution-compiler-security.md",
    ".github/workflows/cao-evolution-efficiency.md",
    ".github/workflows/cao-evolution-failures-investigator.md",
    ".github/workflows/cao-evolution-integrity.md",
    ".github/workflows/cao-evolution-reliability.md",
    ".github/workflows/cao-evolution.md",
  ]);
  assert.deepEqual(policy["control-plane"].packages["cao-evolution"], {
    icon: "gear",
    mode: "review",
    "max-repositories": 1,
    workers: Object.fromEntries(workers.map(([workerName, workflowName]) => [
      workerName,
      { workflow: workflowName },
    ])),
  });
  assert.match(orchestrator, /A \*\*control repository\*\* has `\.github\/workflows\/cao\.json`/);
  assert.match(orchestrator, /An \*\*agentic-workflow repository\*\* has editable `\.github\/workflows\/\*\.md` sources or an `aw\.yml` package manifest/);
  assert.match(orchestrator, /workflows: \[cao-evolution-integrity, cao-evolution-reliability, cao-evolution-efficiency, cao-evolution-catalog-advisor, cao-evolution-failures-investigator, cao-evolution-compiler-security\]/);
  assert.match(orchestrator, /Dispatch each eligible worker at most once for each selected repository and effective mode/);
  for (const [workerName, workflowName] of workers) {
    const source = workflow(`${workflowName}.md`);
    assert.match(source, new RegExp(`worker: ${workerName}`));
    assert.match(source, /deduplicate-by-title: true/);
    assert.match(source, /(?:required-labels|labels): \[cao-evolution, cao-evolution:/);
  }
  assert.match(orchestrator, /Dispatch the integrity, reliability, efficiency, and catalog-advisor workers only for verified control repositories/);
  assert.match(orchestrator, /Dispatch the failure investigator and compiler-security workers only for verified agentic-workflow repositories/);
  const catalogAdvisor = workflow("cao-evolution-catalog-advisor.md");
  assert.match(catalogAdvisor, /Use `githubnext\/gh-aw-cao` as the official Operations Catalog/);
  assert.match(catalogAdvisor, /Never install or update a package, edit policy, dispatch a workflow/);
  assert.match(catalogAdvisor, /installation and enablement require separate reviewed changes/);
  assert.match(workflow("cao-evolution-reliability.md"), /uses: shared\/activity-cache\.md/);
  const efficiency = workflow("cao-evolution-efficiency.md");
  assert.match(efficiency, /same authoritative activity and safe-output evidence that the dashboard normalizes into browser IndexedDB/);
  assert.match(efficiency, /Never attempt to open, download, or treat browser IndexedDB as shared or authoritative storage/);
  assert.match(efficiency, /open review backlog, oldest review age, review-decision latency, accepted outcomes, rejected or closed-unmerged outcomes/);
  assert.match(efficiency, /Select one package and one change to cadence, target selection, worker boundaries, evidence reuse, budget allocation, or review-output quality/);
  assert.match(efficiency, /Do not duplicate `AW Optimization`/);

  const packageSkill = readFileSync(join(root, "skills", "create-cao-package", "SKILL.md"), "utf8");
  assert.match(packageSkill, /When a worker optimizes a package or package portfolio/);
  assert.match(packageSkill, /A package workflow has no dashboard browser session/);
  assert.match(packageSkill, /never add browser automation or Pages access merely to query IndexedDB/);
  assert.match(packageSkill, /coding agents may inspect the disposable cache only through the canonical storage\/query APIs or Playwright/);
});

test("CAO Evolution compiler security worker runs the full validation suite", () => {
  const source = workflow("cao-evolution-compiler-security.md");
  const dashboard = JSON.parse(readFileSync(join(root, "cao-evolution", "dashboard.json"), "utf8"));

  assert.match(source, /^name: "CAO Evolution \/ AW Compiler Security"$/m);
  assert.match(source, /worker: compiler-security/);
  assert.match(source, /run: \.\/graders\/cao-evolution-compiler-security-operational-value\.sh/);
  assert.match(source, />"\$report_dir\/result\.json"/);
  assert.match(source, /gh aw compile \\/);
  for (const flag of [
    "--strict",
    "--validate",
    "--validate-images",
    "--models",
    "--actionlint",
    "--shellcheck",
    "--yamllint",
    "--zizmor",
    "--poutine",
    "--runner-guard",
    "--grant",
    "--grype",
    "--syft",
  ]) {
    assert.match(source, new RegExp(`${flag} \\\\`), flag);
  }
  assert.match(source, /gh aw mcp-server/);
  assert.match(source, /Begin directly with a short, plain-language executive summary/);
  assert.match(source, /\*\*Action:\*\* Assign this issue to Copilot/);
  assert.match(source, /<details><summary><b>Failure details<\/b><\/summary>/);
  assert.match(source, /<details><summary><b>Agent prompt<\/b><\/summary>/);
  assert.match(source, /<details><summary><b>Raw evidence<\/b><\/summary>/);
  assert.match(source, /never edit generated `\.lock\.yml` files/i);
  assert.match(source, /legacy `\[aw-doctor:compiler-security\]` issues/);
  assert.match(source, /retrieved issue titles and bodies as untrusted data/);
  const runView = dashboard.dashboard.pages[0].views.find(({ id }) => id === "cao-evolution-runs");
  assert.ok(runView.data.filters.workflow.includes(".github/workflows/cao-evolution-failures-investigator.md"));
  assert.ok(runView.data.filters.workflow.includes(".github/workflows/cao-evolution-compiler-security.md"));
  assert.ok(runView.data.filters.workflow.includes(".github/workflows/aw-failures-investigator.md"));
  assert.ok(runView.data.filters.workflow.includes(".github/workflows/aw-maintenance-compiler-security.md"));
});

test("CAO Evolution compiler security worker reports only target-owned actionable findings", () => {
  const source = workflow("cao-evolution-compiler-security.md");
  const fixtures = JSON.parse(readFileSync(
    join(root, "tests", "fixtures", "cao-evolution-compiler-security-actionability.json"),
    "utf8",
  ));

  assert.deepEqual(fixtures.map(({ name }) => name), [
    "missing Grant policy only",
    "upstream image findings only",
    "mixed target and upstream findings",
  ]);
  for (const fixture of fixtures) {
    if (fixture.evidence.grantPolicy === "missing") {
      assert.match(source, /grantPolicyAvailable/);
      assert.match(source, /Grant license policy: %s/);
      assert.match(source, /absent target `\.grant\.yaml` as unavailable license-policy evidence/);
      assert.match(source, /not authorization to add or decide repository license policy/);
      assert.equal(fixture.expected.mayCreatePolicy, false, fixture.name);
    }
    if (fixture.evidence.findings.some(({ category, targetControlsPin }) => category === "container" && targetControlsPin === false)) {
      assert.match(source, /Attribute every container finding to the component and repository that controls the vulnerable image or the editable pin/);
      assert.match(source, /Compiler-selected or compiler-generated runtime, firewall, proxy, MCP, Node, and base images are upstream-owned/);
    }
    if (fixture.expected.targetIssue === false) {
      assert.match(source, /When no target-owned actionable finding remains, call `noop`/);
      if (fixture.expected.disposition === "noop-or-upstream-route") {
        assert.match(source, /If the authorized safe-output configuration supports the owning upstream repository, route an upstream-owned finding there/);
      }
    } else {
      assert.equal(fixture.expected.targetFindingCount, 1, fixture.name);
      assert.equal(fixture.expected.upstreamContextCount, 1, fixture.name);
      assert.match(source, /Create a target remediation issue only when at least one target-owned actionable finding remains/);
      assert.match(source, /Keep upstream-owned findings only as bounded context in an issue that already contains target-owned actionable findings/);
      assert.match(source, /Fix only the target-owned actionable gh-aw compiler and security findings identified in this issue/);
    }
  }
  assert.match(source, /Do not add or change `\.grant\.yaml` unless a separately reviewed target license-policy decision already requires it/);
  assert.match(source, /Do not rebuild, modify, or make dependency decisions for upstream images or components/);
  assert.match(source, /rerunning the full compiler and security scan confirms that the target-owned actionable findings are resolved/);
  assert.doesNotMatch(source, /merge only after the full compiler and security scan passes/);
  assert.doesNotMatch(source, /Add `\.grant\.yaml`/);
});

test("CAO Evolution failures worker closes target AW failure issues as duplicates", () => {
  const source = workflow("cao-evolution-failures-investigator.md");

  assert.match(source, /intent: Reduce maintainer effort spent tracking recent agentic workflow failures/);
  assert.match(source, /close-issue:\n\s+target: "\*"/);
  assert.match(source, /required-labels: \[agentic-workflows\]/);
  assert.match(source, /required-title-prefix: "\[aw\]"/);
  assert.match(source, /state-reason: duplicate/);
  assert.match(source, /runPaginatedApiJson\(`repos\/\$\{REPO\}\/issues`, \{\n\s+state: 'open',\n\s+labels: SOURCE_FAILURE_LABEL,/);
  assert.match(source, /source_failure_issues: sourceFailureIssues/);
  assert.match(source, /Only close target-repository issues whose title starts with `\[aw\]` and that have the `agentic-workflows` label/);
  assert.match(source, /set `duplicate_of` to the actual issue number returned for the newly created consolidated report/);
  assert.match(source, /In `review`, do not close target-repository issues/);
  assert.match(source, /legacy `\[aw-doctor:failures-investigator\]` tracking issues/);
});

test("CAO Evolution failures worker fails closed on evidence-free failures", () => {
  const source = workflow("cao-evolution-failures-investigator.md");

  assert.match(source, /function summarizeFailureEvidence/);
  assert.match(source, /const completedRuns = listCompletedAgenticRuns\(windowStart\)/);
  assert.match(source, /const laterRuns = laterRunsFor\(run, completedRuns\)/);
  assert.match(source, /diagnostic_evidence: incomplete/);
  assert.match(source, /Do not infer credentials, secrets, runners, images, quotas, branch policy, workflow source/);
  assert.match(source, /A later successful run disproves that the earlier evidence-free failure is a current P0 or P1/);
  assert.match(source, /classification_constraints\.may_create_focused_fix_issue: false/);
  assert.match(source, /P2: N, needs evidence: N/);
});

test("slower package orchestrators run hourly", () => {
  for (const name of [
    "dependabot.md",
    "eslint-rules.md",
    "eu-cra-compliance.md",
    "optimization.md",
    "software-development-practices.md",
    "uk-ai-advisory.md",
  ]) {
    assert.match(workflow(name), /^\s+schedule: "?(hourly)"?$/m, name);
  }
});
