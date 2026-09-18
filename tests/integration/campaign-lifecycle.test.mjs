import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { retryTransientCampaignInstall } from "../helpers/campaign-install-retry.mjs";

const campaignSource = process.env.CENTRAL_AGENTIC_OPS_CAMPAIGN_SOURCE
  || "githubnext/gh-aw-cao@main";
const campaignUpdateSource = "https://github.com/githubnext/gh-aw-cao";
const controlRuntimeFiles = [
  ".github/workflows/shared/control.mjs",
  ".github/workflows/shared/policy.mjs",
  ".github/workflows/shared/setup-github-apps.mjs",
];
const controlPlaneSkillFiles = [
  ".github/skills/add-cao-campaign/SKILL.md",
  ".github/skills/analyze-cao/SKILL.md",
  ".github/skills/cao-cli/SKILL.md",
  ".github/skills/create-cao-campaign/SKILL.md",
  ".github/skills/setup-cao/SKILL.md",
];
function focusedCampaignSource(slug, source = campaignSource) {
  const separator = source.lastIndexOf("@");
  assert.notEqual(separator, -1, "campaign source must include a ref");
  return `${source.slice(0, separator)}/${slug}${source.slice(separator)}`;
}
const ukAiAdvisoryCampaignSource = focusedCampaignSource("uk-ai-advisory");
const activityCampaignSource = focusedCampaignSource("activity");
const caoEvolutionCampaignSource = focusedCampaignSource("cao-evolution");
const craCampaignSource = focusedCampaignSource("eu-cra-compliance");
const dashboardCampaignSource = focusedCampaignSource("dashboard");
const dependabotUpdateSource = focusedCampaignSource("dependabot");
const dependabotCampaignUpdateSource = `${campaignUpdateSource}/dependabot`;
const selfCareCampaignSource = focusedCampaignSource("self-care");
const softwareDevelopmentPracticesCampaignSource = focusedCampaignSource("software-development-practices");
const activityExpectedFiles = [
  ".github/aw/activity/actions-context.mjs",
  ".github/aw/activity/actions-log.mjs",
  ".github/aw/activity/cao.mjs",
  ".github/aw/activity/collect-logs.sh",
  ".github/aw/activity/control-settings.mjs",
  ".github/aw/activity/debug.mjs",
  ".github/aw/activity/gh-aw-logs.mjs",
  ".github/aw/activity/inventory.mjs",
  ".github/aw/activity/inventory-sources.mjs",
  ".github/aw/activity/token-intervention-lifecycle.mjs",
  ".github/aw/activity/version.mjs",
  ".github/workflows/cao-activity.yml",
];
const caoEvolutionExpectedFiles = [
  ".github/aw/cao-evolution/graders/cao-evolution-failures-investigator-operational-value.sh",
  ".github/aw/cao-evolution/graders/cao-evolution-compiler-security-operational-value.sh",
  ".github/aw/dashboards/cao-evolution.json",
  ".github/workflows/graders/cao-evolution-failures-investigator-operational-value.sh",
  ".github/workflows/graders/cao-evolution-compiler-security-operational-value.sh",
  ".github/workflows/cao-evolution-failures-investigator.md",
  ".github/workflows/cao-evolution-compiler-security.md",
  ".github/workflows/cao-evolution-efficiency.md",
  ".github/workflows/cao-evolution-integrity.md",
  ".github/workflows/cao-evolution-reliability.md",
  ".github/workflows/cao-evolution.md",
  ".github/workflows/shared/activity-cache.md",
  ".github/workflows/shared/control.md",
];
const ukAiAdvisoryExpectedFiles = [
  ".github/aw/uk-ai-advisory/implementation-status.md",
  ".github/aw/dashboards/uk-ai-advisory.json",
  ".github/workflows/uk-ai-advisory-campaign-maintainer.md",
  ".github/workflows/uk-ai-advisory-operational-resilience.md",
  ".github/workflows/uk-ai-advisory.md",
  ".github/workflows/shared/control.md",
];
const craExpectedFiles = [
  ".github/aw/dashboards/eu-cra-compliance.json",
  ".github/aw/eu-cra-compliance/implementation-status.md",
  ".github/aw/eu-cra-compliance/eu-cra-report-operational-value-runtime.bash",
  ".github/aw/eu-cra-compliance/graders/eu-cra-compliance-article-14-reporting-readiness-operational-value.sh",
  ".github/aw/eu-cra-compliance/graders/eu-cra-compliance-conformity-release-evidence-operational-value.sh",
  ".github/aw/eu-cra-compliance/graders/eu-cra-compliance-campaign-maintainer-operational-value.sh",
  ".github/aw/eu-cra-compliance/graders/eu-cra-compliance-scope-classifier-operational-value.sh",
  ".github/aw/eu-cra-compliance/graders/eu-cra-compliance-security-requirements-auditor-operational-value.sh",
  ".github/aw/eu-cra-compliance/graders/eu-cra-compliance-supply-chain-sbom-auditor-operational-value.sh",
  ".github/aw/eu-cra-compliance/graders/eu-cra-compliance-vulnerability-handling-auditor-operational-value.sh",
  ".github/workflows/graders/eu-cra-compliance-article-14-reporting-readiness-operational-value.sh",
  ".github/workflows/graders/eu-cra-compliance-conformity-release-evidence-operational-value.sh",
  ".github/workflows/graders/eu-cra-compliance-scope-classifier-operational-value.sh",
  ".github/workflows/graders/eu-cra-compliance-security-requirements-auditor-operational-value.sh",
  ".github/workflows/graders/eu-cra-compliance-supply-chain-sbom-auditor-operational-value.sh",
  ".github/workflows/graders/eu-cra-compliance-vulnerability-handling-auditor-operational-value.sh",
  ".github/workflows/eu-cra-compliance-article-14-reporting-readiness.md",
  ".github/workflows/eu-cra-compliance-conformity-release-evidence.md",
  ".github/workflows/eu-cra-compliance-campaign-maintainer.md",
  ".github/workflows/eu-cra-compliance-scope-classifier.md",
  ".github/workflows/eu-cra-compliance-security-requirements-auditor.md",
  ".github/workflows/eu-cra-compliance-supply-chain-sbom-auditor.md",
  ".github/workflows/eu-cra-compliance-vulnerability-handling-auditor.md",
  ".github/workflows/eu-cra-compliance.md",
  ".github/workflows/graders/eu-cra-compliance-campaign-maintainer-operational-value.sh",
  ".github/workflows/shared/control.md",
];
const dashboardExpectedFiles = [
  ".github/workflows/cao-dashboard.yml",
  ...[...readFileSync(
    new URL("../../dashboard/aw.yml", import.meta.url),
    "utf8",
  ).matchAll(/^\s+destination: (.+)$/gm)].map((match) => match[1]),
];
const selfCareExpectedFiles = [
  ".github/aw/dashboards/self-care.json",
  ".github/aw/self-care/graders/self-care-docs-build-time-investigator-operational-value.sh",
  ".github/workflows/graders/self-care-docs-build-time-investigator-operational-value.sh",
  ".github/workflows/self-care-accessibility-checker.md",
  ".github/workflows/self-care-code-improvement.md",
  ".github/workflows/self-care-dashboard-data-schema.md",
  ".github/workflows/self-care-dashboard-debug-logging.md",
  ".github/workflows/self-care-dashboard-performance.md",
  ".github/workflows/self-care-data-acquisition-audit.md",
  ".github/workflows/self-care-dashboard-language-refactor.md",
  ".github/workflows/self-care-dashboard-review.md",
  ".github/workflows/self-care-experimental-views.md",
  ".github/workflows/self-care-docs-build-time-investigator.md",
  ".github/workflows/self-care-glossary.md",
  ".github/workflows/self-care-open-source-failures.md",
  ".github/workflows/self-care-pages-health.md",
  ".github/workflows/self-care-primer-brand-checker.md",
  ".github/workflows/self-care-reactive-ui-expert.md",
  ".github/workflows/self-care.md",
  ".github/workflows/shared/activity-cache.md",
  ".github/workflows/shared/control.md",
];
const softwareDevelopmentPracticesExpectedFiles = [
  ".github/aw/dashboards/software-development-practices.json",
  ".github/aw/software-development-practices/software-development-guidance-operational-value-runtime.bash",
  ".github/aw/software-development-practices/graders/software-development-practices-github-well-architected-operational-value.sh",
  ".github/aw/software-development-practices/graders/software-development-practices-nist-ssdf-operational-value.sh",
  ".github/workflows/graders/software-development-practices-github-well-architected-operational-value.sh",
  ".github/workflows/graders/software-development-practices-nist-ssdf-operational-value.sh",
  ".github/workflows/shared/control.md",
  ".github/workflows/software-development-practices-github-well-architected.md",
  ".github/workflows/software-development-practices-nist-ssdf.md",
  ".github/workflows/software-development-practices.md",
];
const repositoryOnlyFiles = [
  ".github/aw/e2e/run-canary.sh",
  ".github/aw/e2e/run-stress.sh",
  ".github/workflows/enterprise-canary.yml",
  ".github/workflows/enterprise-stress.yml",
  ".github/workflows/review-smoke.yml",
];

function installedManifestPath(consumer, manifestName) {
  return join(consumer, ".github", "aw", "packages", manifestName);
}

function installedManifests(consumer) {
  return readdirSync(join(consumer, ".github", "aw", "packages"));
}

function run(command, args, cwd) {
  return execFileSync(command, args, {
    cwd,
    encoding: "utf8",
    env: process.env,
    maxBuffer: 16 * 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
  });
}

async function installCampaign(source) {
  return retryTransientCampaignInstall(() => {
    const consumer = mkdtempSync(join(tmpdir(), "central-agentic-ops-campaign-"));
    try {
      run("git", ["init", "--quiet"], consumer);
      run("gh", [
        "aw",
        "add",
        source,
        "--force",
        "--no-security-scanner",
      ], consumer);
      return consumer;
    } catch (error) {
      rmSync(consumer, { recursive: true, force: true });
      throw error;
    }
  });
}

test("root campaign bootstraps an empty CAO and preserves resources during workflow update", { timeout: 240_000 }, async () => {
  const consumer = await installCampaign(campaignSource);
  try {
    assert.ok(existsSync(join(consumer, ".github", "aw", "default-AGENTS.md")));
    assert.equal(existsSync(join(consumer, ".github", "aw", "cao")), false);
    for (const relativePath of controlRuntimeFiles) {
      assert.ok(existsSync(join(consumer, relativePath)), `root campaign omitted control file ${relativePath}`);
    }
    for (const relativePath of controlPlaneSkillFiles) {
      assert.ok(existsSync(join(consumer, relativePath)), `root campaign omitted project skill ${relativePath}`);
    }
    const policyPath = join(consumer, ".github", "workflows", "cao.json");
    const policy = `${JSON.stringify({
      version: 1,
      "control-plane": {
        scope: {
          "allowed-owners": ["acme"],
          "allowed-repositories": ["acme/example"],
        },
        campaigns: {},
      },
    }, null, 2)}\n`;
    writeFileSync(policyPath, policy);
    assert.deepEqual(
      JSON.parse(readFileSync(join(consumer, ".github", "workflows", "aw.json"), "utf8")).auto_upgrade.options,
      ["--pre-releases"],
    );
    for (const relativePath of activityExpectedFiles) {
      assert.ok(existsSync(join(consumer, relativePath)), `root campaign omitted activity file ${relativePath}`);
    }
    for (const relativePath of dashboardExpectedFiles) {
      assert.ok(existsSync(join(consumer, relativePath)), `root campaign omitted dashboard file ${relativePath}`);
    }
    const campaignRecords = installedManifests(consumer);
    assert.equal(campaignRecords.length, 1, "expected one installed root campaign manifest");
    const installedCampaign = JSON.parse(readFileSync(
      installedManifestPath(consumer, campaignRecords[0]),
      "utf8",
    ));
    for (const { destination } of installedCampaign.files) {
      const workflowPath = join(consumer, destination);
      if (!destination.endsWith(".md") || !existsSync(workflowPath)) continue;
      const workflow = readFileSync(workflowPath, "utf8");
      writeFileSync(workflowPath, workflow.replace(/^source: .*$/m, `source: ${campaignSource}`));
    }

    const removedRuntime = controlRuntimeFiles[0];
    rmSync(join(consumer, removedRuntime));
    run("gh", [
      "aw",
      "update",
      campaignUpdateSource,
      "--force",
      "--no-merge",
      "--no-compile",
      "--no-security-scanner",
      "--cool-down",
      "0",
    ], consumer);

    assert.ok(existsSync(join(consumer, removedRuntime)), "gh aw update did not restore the control runtime");
    assert.equal(existsSync(join(consumer, ".github", "aw", "cao")), false);
    assert.equal(readFileSync(policyPath, "utf8"), policy, "gh aw update changed consumer-owned CAO policy");
  } finally {
    rmSync(consumer, { recursive: true, force: true });
  }
});

test("gh aw add installs the focused activity campaign contract", { timeout: 180_000 }, async () => {
  const consumer = await installCampaign(activityCampaignSource);
  try {
    for (const relativePath of activityExpectedFiles) {
      assert.ok(existsSync(join(consumer, relativePath)), `activity campaign omitted ${relativePath}`);
    }
    const campaignManifests = installedManifests(consumer);
    assert.equal(campaignManifests.length, 1, "expected one installed activity campaign manifest");
    const installedManifest = JSON.parse(readFileSync(
      installedManifestPath(consumer, campaignManifests[0]),
      "utf8",
    ));
    assert.deepEqual(
      installedManifest.files.map(({ destination }) => destination).sort(),
      activityExpectedFiles.toSorted(),
      "activity campaign manifest must own its workflow and indexer",
    );
  } finally {
    rmSync(consumer, { recursive: true, force: true });
  }
});

test("gh aw add installs the focused EU CRA campaign contract", { timeout: 180_000 }, async () => {
  const consumer = await installCampaign(craCampaignSource);

  try {
    for (const relativePath of craExpectedFiles) {
      assert.ok(existsSync(join(consumer, relativePath)), `focused CRA campaign omitted ${relativePath}`);
    }
    assert.ok(
      !existsSync(join(consumer, ".github", "workflows", "dependabot.md")),
      "focused CRA campaign installed an unrelated orchestrator",
    );

    const campaignManifests = installedManifests(consumer);
    assert.equal(campaignManifests.length, 1, "expected one focused CRA campaign manifest");
    const installedManifest = JSON.parse(readFileSync(
      installedManifestPath(consumer, campaignManifests[0]),
      "utf8",
    ));
    assert.deepEqual(
      installedManifest.files.map(({ destination }) => destination).sort(),
      [
        ".github/aw/dashboards/eu-cra-compliance.json",
        ".github/aw/eu-cra-compliance/implementation-status.md",
        ".github/aw/eu-cra-compliance/eu-cra-report-operational-value-runtime.bash",
        ".github/aw/eu-cra-compliance/graders/eu-cra-compliance-article-14-reporting-readiness-operational-value.sh",
        ".github/aw/eu-cra-compliance/graders/eu-cra-compliance-conformity-release-evidence-operational-value.sh",
        ".github/aw/eu-cra-compliance/graders/eu-cra-compliance-campaign-maintainer-operational-value.sh",
        ".github/aw/eu-cra-compliance/graders/eu-cra-compliance-scope-classifier-operational-value.sh",
        ".github/aw/eu-cra-compliance/graders/eu-cra-compliance-security-requirements-auditor-operational-value.sh",
        ".github/aw/eu-cra-compliance/graders/eu-cra-compliance-supply-chain-sbom-auditor-operational-value.sh",
        ".github/aw/eu-cra-compliance/graders/eu-cra-compliance-vulnerability-handling-auditor-operational-value.sh",
        ".github/workflows/graders/eu-cra-compliance-article-14-reporting-readiness-operational-value.sh",
        ".github/workflows/graders/eu-cra-compliance-conformity-release-evidence-operational-value.sh",
        ".github/workflows/graders/eu-cra-compliance-scope-classifier-operational-value.sh",
        ".github/workflows/graders/eu-cra-compliance-security-requirements-auditor-operational-value.sh",
        ".github/workflows/graders/eu-cra-compliance-supply-chain-sbom-auditor-operational-value.sh",
        ".github/workflows/graders/eu-cra-compliance-vulnerability-handling-auditor-operational-value.sh",
        ".github/workflows/eu-cra-compliance-article-14-reporting-readiness.md",
        ".github/workflows/eu-cra-compliance-conformity-release-evidence.md",
        ".github/workflows/eu-cra-compliance-campaign-maintainer.md",
        ".github/workflows/eu-cra-compliance-scope-classifier.md",
        ".github/workflows/eu-cra-compliance-security-requirements-auditor.md",
        ".github/workflows/eu-cra-compliance-supply-chain-sbom-auditor.md",
        ".github/workflows/eu-cra-compliance-vulnerability-handling-auditor.md",
        ".github/workflows/eu-cra-compliance.md",
        ".github/workflows/graders/eu-cra-compliance-campaign-maintainer-operational-value.sh",
      ].sort(),
      "focused CRA campaign manifest must own its entry workflows, evaluator, and ledger",
    );
  } finally {
    rmSync(consumer, { recursive: true, force: true });
  }
});

test("gh aw add installs the focused UK AI Advisory campaign contract", { timeout: 180_000 }, async () => {
  const consumer = await installCampaign(ukAiAdvisoryCampaignSource);

  try {
    for (const relativePath of ukAiAdvisoryExpectedFiles) {
      assert.ok(existsSync(join(consumer, relativePath)), `focused UK AI Advisory campaign omitted ${relativePath}`);
    }
    assert.ok(
      !existsSync(join(consumer, ".github", "workflows", "dependabot.md")),
      "focused UK AI Advisory campaign installed an unrelated orchestrator",
    );

    const campaignManifests = installedManifests(consumer);
    assert.equal(campaignManifests.length, 1, "expected one focused UK AI Advisory campaign manifest");
    const installedManifest = JSON.parse(readFileSync(
      installedManifestPath(consumer, campaignManifests[0]),
      "utf8",
    ));
    assert.deepEqual(
      installedManifest.files.map(({ destination }) => destination).sort(),
      [
        ".github/aw/uk-ai-advisory/implementation-status.md",
        ".github/aw/dashboards/uk-ai-advisory.json",
        ".github/workflows/uk-ai-advisory-campaign-maintainer.md",
        ".github/workflows/uk-ai-advisory.md",
      ].toSorted(),
      "focused UK AI Advisory campaign manifest must own its entry workflows and ledger",
    );
  } finally {
    rmSync(consumer, { recursive: true, force: true });
  }
});

test("gh aw add installs the focused SelfCare campaign contract", { timeout: 180_000 }, async () => {
  const consumer = await installCampaign(selfCareCampaignSource);

  try {
    for (const relativePath of selfCareExpectedFiles) {
      assert.ok(existsSync(join(consumer, relativePath)), `focused SelfCare campaign omitted ${relativePath}`);
    }
  } finally {
    rmSync(consumer, { recursive: true, force: true });
  }
});

test("gh aw add installs the focused CAO Evolution campaign contract", { timeout: 180_000 }, async () => {
  const consumer = await installCampaign(caoEvolutionCampaignSource);
  try {
    for (const relativePath of caoEvolutionExpectedFiles) {
      assert.ok(existsSync(join(consumer, relativePath)), `focused CAO Evolution campaign omitted ${relativePath}`);
    }
  } finally {
    rmSync(consumer, { recursive: true, force: true });
  }
});

test("gh aw add installs the focused Software Development Practices campaign contract", { timeout: 180_000 }, async () => {
  const consumer = await installCampaign(softwareDevelopmentPracticesCampaignSource);

  try {
    for (const relativePath of softwareDevelopmentPracticesExpectedFiles) {
      assert.ok(
        existsSync(join(consumer, relativePath)),
        `focused Software Development Practices campaign omitted ${relativePath}`,
      );
    }
    assert.ok(
      !existsSync(join(consumer, ".github", "workflows", "dependabot.md")),
      "focused Software Development Practices campaign installed an unrelated orchestrator",
    );

    const campaignManifests = installedManifests(consumer);
    assert.equal(campaignManifests.length, 1, "expected one focused Software Development Practices campaign manifest");
    const installedManifest = JSON.parse(readFileSync(
      installedManifestPath(consumer, campaignManifests[0]),
      "utf8",
    ));
    assert.deepEqual(
      installedManifest.files.map(({ destination }) => destination).sort(),
      [
        ".github/aw/dashboards/software-development-practices.json",
        ".github/aw/software-development-practices/graders/software-development-practices-github-well-architected-operational-value.sh",
        ".github/aw/software-development-practices/graders/software-development-practices-nist-ssdf-operational-value.sh",
        ".github/aw/software-development-practices/software-development-guidance-operational-value-runtime.bash",
        ".github/workflows/graders/software-development-practices-github-well-architected-operational-value.sh",
        ".github/workflows/graders/software-development-practices-nist-ssdf-operational-value.sh",
        ".github/workflows/software-development-practices-github-well-architected.md",
        ".github/workflows/software-development-practices-nist-ssdf.md",
        ".github/workflows/software-development-practices.md",
      ],
      "focused Software Development Practices campaign manifest must own its entry workflows, evaluators, runtime, and dashboard",
    );
  } finally {
    rmSync(consumer, { recursive: true, force: true });
  }
});

test("gh aw add installs the dashboard campaign contract", { timeout: 180_000 }, async () => {
  const consumer = await installCampaign(dashboardCampaignSource);

  try {
    for (const relativePath of dashboardExpectedFiles) {
      assert.ok(existsSync(join(consumer, relativePath)), `dashboard campaign omitted ${relativePath}`);
    }

    const campaignManifests = installedManifests(consumer);
    assert.equal(campaignManifests.length, 1, "expected one installed dashboard campaign manifest");
    const installedManifest = JSON.parse(readFileSync(
      installedManifestPath(consumer, campaignManifests[0]),
      "utf8",
    ));
    assert.deepEqual(
      installedManifest.files.map(({ destination }) => destination).sort(),
      dashboardExpectedFiles.toSorted(),
      "dashboard campaign manifest must own its workflow and every report module",
    );

    const dashboardWorkflow = readFileSync(join(consumer, ".github", "workflows", "cao-dashboard.yml"), "utf8");
    assert.doesNotMatch(dashboardWorkflow, /workflow_call:|cao-dashboard-build|dispatch-workflow/);
    assert.match(dashboardWorkflow, /workflow_dispatch:/);
    assert.match(dashboardWorkflow, /actions\/upload-artifact@[0-9a-f]{40}/);
    assert.match(dashboardWorkflow, /actions\/cache\/save@[0-9a-f]{40}/);
    assert.match(dashboardWorkflow, /actions\/(?:upload-pages-artifact|deploy-pages)@[0-9a-f]{40}/);
    assert.match(dashboardWorkflow, /name: CAO Dashboard/);
    assert.match(dashboardWorkflow, /enablement: false/);
    assert.match(dashboardWorkflow, /deploy: \$\{\{ steps\.deployment-policy\.outputs\.deploy \}\}/);
    assert.match(dashboardWorkflow, /if: needs\.build\.outputs\.deploy == 'true'/);
    assert.doesNotMatch(dashboardWorkflow, /^\s+run:/m);
    assert.doesNotMatch(dashboardWorkflow, /actions\/github-script@(?![0-9a-f]{40}\b)/);
    assert.match(dashboardWorkflow, /Standalone Pages deployment:[\s\S]*?Dashboard artifact assembly completed/);
    assert.doesNotMatch(dashboardWorkflow, /schedule:/);
    assert.match(dashboardWorkflow, /push:[\s\S]*?\.github\/aw\/dashboard\/\*\*[\s\S]*?\.github\/workflows\/cao\.json/);
    assert.match(dashboardWorkflow, /\.github\/aw\/dashboards\/\*\*/);
    assert.match(dashboardWorkflow, /"\*\/dashboard\.json"/);
    assert.match(dashboardWorkflow, /github\.ref_name == github\.event\.repository\.default_branch/);

    const dashboardSite = join(consumer, ".github", "aw", "dashboard", "site");
    const dashboardOutput = join(consumer, "dashboard-output");
    const controlSettings = join(consumer, "control-settings.json");
    run("gh", ["aw", "add", activityCampaignSource, "--force", "--no-security-scanner"], consumer);
    writeFileSync(controlSettings, "{}\n");
    run("npm", ["ci", "--ignore-scripts"], dashboardSite);
    run("npm", ["run", "build", "--", dashboardOutput, controlSettings], dashboardSite);
    for (const asset of ["src/main.js", "src/main.js.map", "src/data-worker.js", "src/data-worker.js.map", "smells.svg"]) {
      assert.ok(existsSync(join(dashboardOutput, asset)), `dashboard build omitted ${asset}`);
    }
  } finally {
    rmSync(consumer, { recursive: true, force: true });
  }
});

test("gh aw add --force restores dashboard workflows, producers, and renderer assets", { timeout: 180_000 }, async () => {
  const consumer = await installCampaign(dashboardCampaignSource);

  try {
    const deployPath = join(consumer, ".github", "workflows", "cao-dashboard.yml");
    const deployWorkflow = readFileSync(deployPath, "utf8");
    writeFileSync(deployPath, `${deployWorkflow}\n# local integration-test change\n`);

    const removedFiles = [
      ".github/aw/dashboard/report/records.mjs",
      ".github/aw/dashboard/site/index.html",
      ".github/aw/dashboard/site/scripts/build.mjs",
    ];
    for (const relativePath of removedFiles) {
      rmSync(join(consumer, relativePath));
    }

    run("gh", [
      "aw",
      "add",
      dashboardCampaignSource,
      "--force",
      "--no-security-scanner",
    ], consumer);

    assert.ok(
      !readFileSync(deployPath, "utf8").includes("# local integration-test change"),
      "gh aw add --force retained a local dashboard workflow modification",
    );
    for (const relativePath of removedFiles) {
      assert.ok(existsSync(join(consumer, relativePath)), `gh aw add --force did not restore ${relativePath}`);
    }
  } finally {
    rmSync(consumer, { recursive: true, force: true });
  }
});

test("gh aw update replaces workflows and restores campaign-owned assets", { timeout: 180_000 }, async () => {
  const consumer = await installCampaign(dependabotUpdateSource);

  try {
    assert.ok(
      existsSync(join(consumer, ".github", "aw", "dependabot", "graders", "dependabot-update-planner-operational-value.sh")),
      "Dependabot campaign omitted its campaign-owned operational-value grader",
    );
    assert.ok(
      existsSync(join(consumer, ".github", "workflows", "graders", "dependabot-update-planner-operational-value.sh")),
      "Dependabot campaign omitted its operational-value grader",
    );
    const orchestratorPath = join(consumer, ".github", "workflows", "dependabot.md");
    const orchestrator = readFileSync(orchestratorPath, "utf8");
    writeFileSync(orchestratorPath, `${orchestrator}\n# local integration-test change\n`);

    const removedFiles = [
      ".github/aw/dependabot/graders/dependabot-update-planner-operational-value.sh",
      ".github/workflows/dependabot-update-planner.md",
      ".github/workflows/graders/dependabot-update-planner-operational-value.sh",
      ".github/workflows/shared/control.md",
    ];
    for (const relativePath of removedFiles) {
      rmSync(join(consumer, relativePath));
    }

    run("gh", [
      "aw",
      "update",
      dependabotCampaignUpdateSource,
      "--force",
      "--no-merge",
      "--no-compile",
      "--no-security-scanner",
      "--cool-down",
      "0",
    ], consumer);

    const updatedOrchestrator = readFileSync(orchestratorPath, "utf8");
    assert.ok(
      !updatedOrchestrator.includes("# local integration-test change"),
      "gh aw update retained a local campaign workflow modification",
    );
    for (const relativePath of removedFiles) {
      assert.ok(existsSync(join(consumer, relativePath)), `gh aw update did not restore ${relativePath}`);
    }
  } finally {
    rmSync(consumer, { recursive: true, force: true });
  }
});