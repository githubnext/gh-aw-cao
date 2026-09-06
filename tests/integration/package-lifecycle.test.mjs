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

const packageSource = process.env.CENTRAL_AGENTIC_OPS_PACKAGE_SOURCE
  || "githubnext/gh-aw-cao@main";
function focusedPackageSource(slug, source = packageSource) {
  const separator = source.lastIndexOf("@");
  assert.notEqual(separator, -1, "package source must include a ref");
  return `${source.slice(0, separator)}/${slug}${source.slice(separator)}`;
}
const ukAiAdvisoryPackageSource = focusedPackageSource("uk-ai-advisory");
const activityPackageSource = focusedPackageSource("activity");
const awDoctorPackageSource = focusedPackageSource("aw-doctor");
const craPackageSource = focusedPackageSource("eu-cra-compliance");
const dashboardPackageSource = focusedPackageSource("dashboard");
const dependabotUpdateSource = focusedPackageSource("dependabot");
const selfCarePackageSource = focusedPackageSource("self-care");
const softwareDevelopmentPracticesPackageSource = focusedPackageSource("software-development-practices");
const activityExpectedFiles = [
  ".github/aw/activity/admission-evidence.mjs",
  ".github/aw/activity/actions-log.mjs",
  ".github/aw/activity/failure-evidence.mjs",
  ".github/aw/activity/github-telemetry.mjs",
  ".github/aw/activity/index.mjs",
  ".github/aw/activity/logs.mjs",
  ".github/aw/activity/run-health-snapshot.mjs",
  ".github/aw/activity/version.mjs",
  ".github/workflows/activity.yml",
  ".github/workflows/cao-maintenance.yml",
];
const awDoctorExpectedFiles = [
  ".github/aw/dashboards/aw-doctor.json",
  ".github/graders/aw-failures-investigator-operational-value.sh",
  ".github/graders/aw-maintenance-compiler-security-operational-value.sh",
  ".github/workflows/aw-failures-investigator.md",
  ".github/workflows/aw-maintenance-compiler-security.md",
  ".github/workflows/aw-maintenance-upgrade.md",
  ".github/workflows/aw-doctor.md",
  ".github/workflows/shared/activity-cache.md",
  ".github/workflows/shared/control.md",
];
const ukAiAdvisoryExpectedFiles = [
  ".github/aw/uk-ai-advisory/implementation-status.md",
  ".github/aw/dashboards/uk-ai-advisory.json",
  ".github/workflows/uk-ai-advisory-package-maintainer.md",
  ".github/workflows/uk-ai-advisory-operational-resilience.md",
  ".github/workflows/uk-ai-advisory.md",
  ".github/workflows/shared/control.md",
];
const craExpectedFiles = [
  ".github/aw/dashboards/eu-cra-compliance.json",
  ".github/aw/eu-cra-compliance/implementation-status.md",
  ".github/aw/eu-cra-compliance/eu-cra-report-operational-value-runtime.bash",
  ".github/graders/eu-cra-compliance-article-14-reporting-readiness-operational-value.sh",
  ".github/graders/eu-cra-compliance-conformity-release-evidence-operational-value.sh",
  ".github/graders/eu-cra-compliance-scope-classifier-operational-value.sh",
  ".github/graders/eu-cra-compliance-security-requirements-auditor-operational-value.sh",
  ".github/graders/eu-cra-compliance-supply-chain-sbom-auditor-operational-value.sh",
  ".github/graders/eu-cra-compliance-vulnerability-handling-auditor-operational-value.sh",
  ".github/workflows/control.md",
  ".github/workflows/eu-cra-compliance-article-14-reporting-readiness.md",
  ".github/workflows/eu-cra-compliance-conformity-release-evidence.md",
  ".github/workflows/eu-cra-compliance-package-maintainer.md",
  ".github/workflows/eu-cra-compliance-scope-classifier.md",
  ".github/workflows/eu-cra-compliance-security-requirements-auditor.md",
  ".github/workflows/eu-cra-compliance-supply-chain-sbom-auditor.md",
  ".github/workflows/eu-cra-compliance-vulnerability-handling-auditor.md",
  ".github/workflows/eu-cra-compliance.md",
  ".github/workflows/graders/eu-cra-compliance-package-maintainer-operational-value.sh",
  ".github/workflows/shared/control.md",
];
const dashboardExpectedFiles = [
  ".github/workflows/dashboard-build.yml",
  ...[...readFileSync(
    new URL("../../dashboard/aw.yml", import.meta.url),
    "utf8",
  ).matchAll(/^\s+destination: (.+)$/gm)].map((match) => match[1]),
];
const selfCareExpectedFiles = [
  ".github/aw/dashboards/self-care.json",
  ".github/graders/self-care-docs-build-time-investigator-operational-value.sh",
  ".github/workflows/self-care-accessibility-checker.md",
  ".github/workflows/self-care-code-improvement.md",
  ".github/workflows/self-care-dashboard-performance.md",
  ".github/workflows/self-care-data-acquisition-audit.md",
  ".github/workflows/self-care-dashboard-language-refactor.md",
  ".github/workflows/self-care-dashboard-review.md",
  ".github/workflows/self-care-docs-build-time-investigator.md",
  ".github/workflows/self-care-glossary.md",
  ".github/workflows/self-care-open-source-failures.md",
  ".github/workflows/self-care-primer-brand-checker.md",
  ".github/workflows/self-care.md",
  ".github/workflows/shared/activity-cache.md",
  ".github/workflows/shared/control.md",
];
const softwareDevelopmentPracticesExpectedFiles = [
  ".github/aw/dashboards/software-development-practices.json",
  ".github/aw/software-development-practices/software-development-guidance-operational-value-runtime.bash",
  ".github/graders/software-development-practices-github-well-architected-operational-value.sh",
  ".github/graders/software-development-practices-nist-ssdf-operational-value.sh",
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

function run(command, args, cwd) {
  return execFileSync(command, args, {
    cwd,
    encoding: "utf8",
    env: process.env,
    maxBuffer: 16 * 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
  });
}

function workflowBody(content) {
  const frontmatterEnd = content.indexOf("\n---\n", 4);
  assert.notEqual(frontmatterEnd, -1, "workflow is missing closing frontmatter");
  return content.slice(frontmatterEnd + 5).trimEnd();
}

function installPackage(source) {
  const consumer = mkdtempSync(join(tmpdir(), "central-agentic-ops-package-"));
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
}

test("gh aw add installs the root package without rewriting Copilot authentication", { timeout: 180_000 }, () => {
  const consumer = installPackage(packageSource);
  try {
    assert.ok(existsSync(join(consumer, ".github", "aw", "default-AGENTS.md")));
    assert.deepEqual(
      JSON.parse(readFileSync(join(consumer, ".github", "workflows", "aw.json"), "utf8")).auto_upgrade.options,
      ["--pre-releases"],
    );
    for (const relativePath of activityExpectedFiles) {
      assert.ok(existsSync(join(consumer, relativePath)), `root package omitted activity file ${relativePath}`);
    }
    for (const relativePath of dashboardExpectedFiles) {
      assert.ok(existsSync(join(consumer, relativePath)), `root package omitted dashboard file ${relativePath}`);
    }
    for (const workflowId of [
      "aw-doctor",
      "dependabot",
      "optimization",
    ]) {
      const source = readFileSync(join(consumer, ".github", "workflows", `${workflowId}.md`), "utf8");
      const lock = readFileSync(join(consumer, ".github", "workflows", `${workflowId}.lock.yml`), "utf8");
      assert.match(source, /copilot-requests: write/);
      assert.match(lock, /COPILOT_GITHUB_TOKEN: \$\{\{ github\.token \}\}/);
      assert.doesNotMatch(lock, /secrets\.COPILOT_GITHUB_TOKEN/);
    }
  } finally {
    rmSync(consumer, { recursive: true, force: true });
  }
});

test("gh aw add installs the focused activity package contract", { timeout: 180_000 }, () => {
  const consumer = installPackage(activityPackageSource);
  try {
    for (const relativePath of activityExpectedFiles) {
      assert.ok(existsSync(join(consumer, relativePath)), `activity package omitted ${relativePath}`);
    }
    const packageManifests = readdirSync(join(consumer, ".github", "aw", "packages"));
    assert.equal(packageManifests.length, 1, "expected one installed activity package manifest");
    const installedManifest = JSON.parse(readFileSync(
      join(consumer, ".github", "aw", "packages", packageManifests[0]),
      "utf8",
    ));
    assert.deepEqual(
      installedManifest.files.map(({ destination }) => destination).sort(),
      activityExpectedFiles.toSorted(),
      "activity package manifest must own its workflow and indexer",
    );
  } finally {
    rmSync(consumer, { recursive: true, force: true });
  }
});

test("gh aw add installs the focused EU CRA package contract", { timeout: 180_000 }, () => {
  const consumer = installPackage(craPackageSource);

  try {
    for (const relativePath of craExpectedFiles) {
      assert.ok(existsSync(join(consumer, relativePath)), `focused CRA package omitted ${relativePath}`);
    }
    assert.ok(
      !existsSync(join(consumer, ".github", "workflows", "dependabot.md")),
      "focused CRA package installed an unrelated orchestrator",
    );

    const packageManifests = readdirSync(join(consumer, ".github", "aw", "packages"));
    assert.equal(packageManifests.length, 1, "expected one focused CRA package manifest");
    const installedManifest = JSON.parse(readFileSync(
      join(consumer, ".github", "aw", "packages", packageManifests[0]),
      "utf8",
    ));
    assert.deepEqual(
      installedManifest.files.map(({ destination }) => destination).sort(),
      [
        ".github/aw/dashboards/eu-cra-compliance.json",
        ".github/aw/eu-cra-compliance/implementation-status.md",
        ".github/aw/eu-cra-compliance/eu-cra-report-operational-value-runtime.bash",
        ".github/graders/eu-cra-compliance-article-14-reporting-readiness-operational-value.sh",
        ".github/graders/eu-cra-compliance-conformity-release-evidence-operational-value.sh",
        ".github/graders/eu-cra-compliance-scope-classifier-operational-value.sh",
        ".github/graders/eu-cra-compliance-security-requirements-auditor-operational-value.sh",
        ".github/graders/eu-cra-compliance-supply-chain-sbom-auditor-operational-value.sh",
        ".github/graders/eu-cra-compliance-vulnerability-handling-auditor-operational-value.sh",
        ".github/workflows/control.md",
        ".github/workflows/eu-cra-compliance-article-14-reporting-readiness.md",
        ".github/workflows/eu-cra-compliance-conformity-release-evidence.md",
        ".github/workflows/eu-cra-compliance-package-maintainer.md",
        ".github/workflows/eu-cra-compliance-scope-classifier.md",
        ".github/workflows/eu-cra-compliance-security-requirements-auditor.md",
        ".github/workflows/eu-cra-compliance-supply-chain-sbom-auditor.md",
        ".github/workflows/eu-cra-compliance-vulnerability-handling-auditor.md",
        ".github/workflows/eu-cra-compliance.md",
        ".github/workflows/graders/eu-cra-compliance-package-maintainer-operational-value.sh",
      ].sort(),
      "focused CRA package manifest must own its entry workflows, evaluator, and ledger",
    );
  } finally {
    rmSync(consumer, { recursive: true, force: true });
  }
});

test("gh aw add installs the focused UK AI Advisory package contract", { timeout: 180_000 }, () => {
  const consumer = installPackage(ukAiAdvisoryPackageSource);

  try {
    for (const relativePath of ukAiAdvisoryExpectedFiles) {
      assert.ok(existsSync(join(consumer, relativePath)), `focused UK AI Advisory package omitted ${relativePath}`);
    }
    assert.ok(
      !existsSync(join(consumer, ".github", "workflows", "dependabot.md")),
      "focused UK AI Advisory package installed an unrelated orchestrator",
    );

    const packageManifests = readdirSync(join(consumer, ".github", "aw", "packages"));
    assert.equal(packageManifests.length, 1, "expected one focused UK AI Advisory package manifest");
    const installedManifest = JSON.parse(readFileSync(
      join(consumer, ".github", "aw", "packages", packageManifests[0]),
      "utf8",
    ));
    assert.deepEqual(
      installedManifest.files.map(({ destination }) => destination).sort(),
      [
        ".github/aw/uk-ai-advisory/implementation-status.md",
        ".github/aw/dashboards/uk-ai-advisory.json",
        ".github/workflows/uk-ai-advisory-package-maintainer.md",
        ".github/workflows/control.md",
        ".github/workflows/uk-ai-advisory.md",
      ].toSorted(),
      "focused UK AI Advisory package manifest must own its entry workflows and ledger",
    );
  } finally {
    rmSync(consumer, { recursive: true, force: true });
  }
});

test("gh aw add installs the focused SelfCare package contract", { timeout: 180_000 }, () => {
  const consumer = installPackage(selfCarePackageSource);

  try {
    for (const relativePath of selfCareExpectedFiles) {
      assert.ok(existsSync(join(consumer, relativePath)), `focused SelfCare package omitted ${relativePath}`);
    }
  } finally {
    rmSync(consumer, { recursive: true, force: true });
  }
});

test("gh aw add installs the focused AW Doctor package contract", { timeout: 180_000 }, () => {
  const consumer = installPackage(awDoctorPackageSource);
  try {
    for (const relativePath of awDoctorExpectedFiles) {
      assert.ok(existsSync(join(consumer, relativePath)), `focused AW Doctor package omitted ${relativePath}`);
    }
  } finally {
    rmSync(consumer, { recursive: true, force: true });
  }
});

test("gh aw add installs the focused Software Development Practices package contract", { timeout: 180_000 }, () => {
  const consumer = installPackage(softwareDevelopmentPracticesPackageSource);

  try {
    for (const relativePath of softwareDevelopmentPracticesExpectedFiles) {
      assert.ok(
        existsSync(join(consumer, relativePath)),
        `focused Software Development Practices package omitted ${relativePath}`,
      );
    }
    assert.ok(
      !existsSync(join(consumer, ".github", "workflows", "dependabot.md")),
      "focused Software Development Practices package installed an unrelated orchestrator",
    );

    const packageManifests = readdirSync(join(consumer, ".github", "aw", "packages"));
    assert.equal(packageManifests.length, 1, "expected one focused Software Development Practices package manifest");
    const installedManifest = JSON.parse(readFileSync(
      join(consumer, ".github", "aw", "packages", packageManifests[0]),
      "utf8",
    ));
    assert.deepEqual(
      installedManifest.files.map(({ destination }) => destination).sort(),
      [
        ".github/aw/dashboards/software-development-practices.json",
        ".github/aw/software-development-practices/software-development-guidance-operational-value-runtime.bash",
        ".github/graders/software-development-practices-github-well-architected-operational-value.sh",
        ".github/graders/software-development-practices-nist-ssdf-operational-value.sh",
        ".github/workflows/control.md",
        ".github/workflows/software-development-practices-github-well-architected.md",
        ".github/workflows/software-development-practices-nist-ssdf.md",
        ".github/workflows/software-development-practices.md",
      ],
      "focused Software Development Practices package manifest must own its entry workflows, evaluators, runtime, and dashboard",
    );
  } finally {
    rmSync(consumer, { recursive: true, force: true });
  }
});

test("gh aw add installs the dashboard package contract", { timeout: 180_000 }, () => {
  const consumer = installPackage(dashboardPackageSource);

  try {
    for (const relativePath of dashboardExpectedFiles) {
      assert.ok(existsSync(join(consumer, relativePath)), `dashboard package omitted ${relativePath}`);
    }

    const packageManifests = readdirSync(join(consumer, ".github", "aw", "packages"));
    assert.equal(packageManifests.length, 1, "expected one installed dashboard package manifest");
    const installedManifest = JSON.parse(readFileSync(
      join(consumer, ".github", "aw", "packages", packageManifests[0]),
      "utf8",
    ));
    assert.deepEqual(
      installedManifest.files.map(({ destination }) => destination).sort(),
      dashboardExpectedFiles.toSorted(),
      "dashboard package manifest must own both workflows and every report module",
    );

    const buildWorkflow = readFileSync(join(consumer, ".github", "workflows", "dashboard-build.yml"), "utf8");
    const deployWorkflow = readFileSync(join(consumer, ".github", "workflows", "dashboard.yml"), "utf8");
    assert.doesNotMatch(buildWorkflow, /workflow_call:/);
    assert.match(buildWorkflow, /workflow_dispatch:[\s\S]*?site-path:[\s\S]*?request-id:/);
    assert.match(buildWorkflow, /actions\/upload-artifact@[0-9a-f]{40}/);
    assert.doesNotMatch(buildWorkflow, /actions\/(?:upload-pages-artifact|deploy-pages)@/);
    assert.match(deployWorkflow, /enablement: false/);
    assert.doesNotMatch(deployWorkflow, /schedule:/);
  } finally {
    rmSync(consumer, { recursive: true, force: true });
  }
});

test("gh aw add --force restores dashboard workflows, producers, and renderer assets", { timeout: 180_000 }, () => {
  const consumer = installPackage(dashboardPackageSource);

  try {
    const deployPath = join(consumer, ".github", "workflows", "dashboard.yml");
    const deployWorkflow = readFileSync(deployPath, "utf8");
    writeFileSync(deployPath, `${deployWorkflow}\n# local integration-test change\n`);

    const removedFiles = [
      ".github/aw/dashboard/report/records.mjs",
      ".github/aw/dashboard/site/index.html",
      ".github/workflows/dashboard-build.yml",
    ];
    for (const relativePath of removedFiles) {
      rmSync(join(consumer, relativePath));
    }

    run("gh", [
      "aw",
      "add",
      dashboardPackageSource,
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

test("gh aw update replaces workflows and restores package-owned assets", { timeout: 180_000 }, () => {
  const consumer = installPackage(dependabotUpdateSource);

  try {
    const orchestratorPath = join(consumer, ".github", "workflows", "dependabot.md");
    const orchestrator = readFileSync(orchestratorPath, "utf8");
    writeFileSync(orchestratorPath, `${orchestrator}\n# local integration-test change\n`);

    const removedFiles = [
      ".github/workflows/dependabot-release-train-updater.md",
      ".github/workflows/shared/control.md",
    ];
    for (const relativePath of removedFiles) {
      rmSync(join(consumer, relativePath));
    }

    run("gh", [
      "aw",
      "update",
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
      "gh aw update retained a local package workflow modification",
    );
    assert.equal(workflowBody(updatedOrchestrator), workflowBody(orchestrator));
    for (const relativePath of removedFiles) {
      assert.ok(existsSync(join(consumer, relativePath)), `gh aw update did not restore ${relativePath}`);
    }
  } finally {
    rmSync(consumer, { recursive: true, force: true });
  }
});