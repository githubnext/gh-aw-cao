import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { parse } from "yaml";
import { escapedGhAwVersion, ghAwVersion, root, script, workflow, workflowsDirectory } from "./workflow-contract.helpers.mjs";

// Package manifest, bundle, and catalog ownership contracts.

test("packages and repository workflows pin the supported gh-aw version", () => {
  const manifests = [
    "aw.yml",
    "activity/aw.yml",
    "uk-ai-advisory/aw.yml",
    "cao-evolution/aw.yml",
    "dashboard/aw.yml",
    "dependabot/aw.yml",
    "eu-cra-compliance/aw.yml",
    "optimization/aw.yml",
    "self-care/aw.yml",
    "software-development-practices/aw.yml",
  ];
  for (const manifest of manifests) {
    assert.equal(parse(readFileSync(join(root, manifest), "utf8"))["min-version"], ghAwVersion, manifest);
  }

  for (const name of ["copilot-setup-steps.yml", "release.lock.yml", "workflow-contracts.yml"]) {
    const source = workflow(name);
    assert.match(source, /uses: \.\/\.github\/actions\/setup-gh-aw/);
  }
  const activity = workflow("cao-activity.yml");
  assert.match(activity, /Resolve gh-aw compiler version[\s\S]*control\.mjs compiler-version \.github\/workflows\/cao\.json/);
  assert.match(activity, new RegExp(`setup-cli@[0-9a-f]{40} # ${escapedGhAwVersion} tag resolves to this commit`));
  assert.match(activity, /version: \$\{\{ steps\.gh-aw-compiler\.outputs\.version \}\}/);
  const setupAction = readFileSync(join(root, ".github", "actions", "setup-gh-aw", "action.yml"), "utf8");
  assert.match(setupAction, /control\.mjs compiler-version \.github\/workflows\/cao\.json/);
  assert.match(setupAction, new RegExp(`setup-cli@[0-9a-f]{40} # ${escapedGhAwVersion} tag resolves to this commit`));
  assert.match(setupAction, /version: \$\{\{ steps\.compiler\.outputs\.version \}\}/);
  assert.match(
    JSON.parse(readFileSync(join(root, "package.json"), "utf8")).scripts["install:gh-aw"],
    /control\.mjs compiler-version \.github\/workflows\/cao\.json/,
  );
});

test("catalog packages declare their current experimental maturity", () => {
  const privateManifests = new Set([
    "uk-ai-advisory/aw.yml",
    "eu-cra-compliance/aw.yml",
    "self-care/aw.yml",
    "software-development-practices/aw.yml",
  ]);
  const manifests = [
    "aw.yml",
    "activity/aw.yml",
    "uk-ai-advisory/aw.yml",
    "cao-evolution/aw.yml",
    "dashboard/aw.yml",
    "dependabot/aw.yml",
    "eu-cra-compliance/aw.yml",
    "optimization/aw.yml",
    "self-care/aw.yml",
    "software-development-practices/aw.yml",
  ];
  for (const manifest of manifests) {
    const metadata = parse(readFileSync(join(root, manifest), "utf8"));
    assert.equal(metadata.private ?? false, privateManifests.has(manifest), manifest);
    assert.equal(metadata.experimental, true, manifest);
  }
});

test("operational workflows use the transitive CAO package bundle", () => {
  const control = workflow("shared/control.md");
  assert.match(control, /dispatch_max:\n\s+type: number/);
  assert.match(control, /orchestrator_credits:\n\s+type: number/);
  assert.match(control, /worker_credits_per_target:\n\s+type: number/);
  assert.match(control, /footer-install: "<!-- -->"/);

  const operationWorkflows = readdirSync(workflowsDirectory)
    .filter((name) => name.endsWith(".md") && workflow(name).includes("uses: shared/control.md"));
  assert.equal(operationWorkflows.length, 42);
  assert.match(control, /name: Upload CAO admission artifact/);
  assert.match(control, /name: cao-admission/);
  assert.match(control, /path: \$\{\{ runner\.temp \}\}\/cao\/admission\.json/);
  assert.match(readFileSync(join(root, "activity", "aw.yml"), "utf8"), /source: gh-aw-logs\.mjs/);
});

test("package manifests exclude repository-only tests", () => {
  for (const relativePath of ["aw.yml", join("uk-ai-advisory", "aw.yml"), join("cao-evolution", "aw.yml"), join("dashboard", "aw.yml"), join("dependabot", "aw.yml"), join("eu-cra-compliance", "aw.yml"), join("optimization", "aw.yml"), join("self-care", "aw.yml"), join("software-development-practices", "aw.yml")]) {
    const manifest = readFileSync(join(root, relativePath), "utf8");
    assert.doesNotMatch(manifest, /(?:review-smoke|enterprise-canary|enterprise-stress|tests\/e2e|\.github\/aw\/e2e)/, relativePath);
  }
});

test("focused package manifests do not cross-own package files", () => {
  const manifestPaths = readdirSync(root)
    .map((name) => join(name, "aw.yml"))
    .filter((relativePath) => relativePath !== "aw.yml" && existsSync(join(root, relativePath)))
    .sort();
  const destinations = new Map();

  for (const relativePath of manifestPaths) {
    const packageName = relativePath.split("/")[0];
    const manifest = parse(readFileSync(join(root, relativePath), "utf8"));
    const files = [
      ...(manifest.includes ?? []).filter((entry) => entry !== "../aw.yml").map((entry) => typeof entry === "string" ? {
        source: entry,
        destination: entry,
      } : entry),
      ...(manifest.resources ?? []),
    ];

    for (const file of files) {
      const owners = destinations.get(file.destination) ?? [];
      owners.push(`${packageName}:${file.source}`);
      destinations.set(file.destination, owners);
    }
  }

  const duplicateOwners = [...destinations.entries()]
    .filter(([, owners]) => owners.length > 1)
    .map(([destination, owners]) => `${destination} <= ${owners.join(", ")}`)
    .sort();
  assert.deepEqual(duplicateOwners, [], "package manifests must not declare the same destination from multiple packages");
});

test("root package keeps GitHub App setup opt-in", () => {
  const rootManifest = parse(readFileSync(join(root, "aw.yml"), "utf8"));

  assert.equal(rootManifest.config, undefined);
});

test("root package provides default control-repository agent context", () => {
  const rootManifest = readFileSync(join(root, "aw.yml"), "utf8");
  const agents = readFileSync(join(root, "AGENTS.md"), "utf8");
  const setupSkill = readFileSync(join(root, ".github", "skills", "setup-central-agentic-ops", "SKILL.md"), "utf8");

  assert.match(rootManifest, /source: AGENTS\.md\n\s+destination: \.github\/aw\/default-AGENTS\.md/);
  assert.match(agents, /Source-managed control repository:[\s\S]*Any repository may run workflows it maintains directly in-tree as a control plane/);
  assert.match(agents, /same repository is also a catalog[\s\S]*supported dogfood topology/);
  assert.match(agents, /Do not infer a role from the repository name or from catalog files alone/);
  assert.match(agents, /Control repository:[\s\S]*explicitly enrolled remote repositories/);
  assert.match(agents, /`review` is the default mode/);
  assert.match(agents, /Never edit them directly; change their Markdown sources and run `gh aw compile`/);
  assert.match(agents, /Treat dashboard IndexedDB as disposable, per-browser derived state/);
  assert.match(agents, /Operational workflows and package workers have no browser session and must not query it as a service or authority/);
  assert.match(agents, /inspect IndexedDB through the canonical storage and query APIs under `dashboard\/site\/src\/data\/` or through Playwright/);
  assert.match(agents, /authoritative input, adapter, normalization, canonical query, and view-payload stages/);
  assert.match(setupSkill, /no root `AGENTS\.md`[\s\S]*create `AGENTS\.md` with exactly that content/);
  assert.match(setupSkill, /preserve it unchanged unless the user explicitly approves a merge/);
});

test("root package resolves the single CAO bootstrap runtime", () => {
  const rootManifest = readFileSync(join(root, "aw.yml"), "utf8");
  const setupSkill = readFileSync(join(root, ".github", "skills", "setup-central-agentic-ops", "SKILL.md"), "utf8");
  const quickstart = readFileSync(join(root, "docs", "getting-started.md"), "utf8");
  const operations = readFileSync(join(root, "docs", "operations.md"), "utf8");
  const authentication = readFileSync(join(root, "docs", "authentication.md"), "utf8");
  const admission = readFileSync(join(root, "docs", "admission.md"), "utf8");
  const control = readFileSync(join(root, ".github", "workflows", "shared", "control.md"), "utf8");
  const activity = readFileSync(join(root, ".github", "workflows", "cao-activity.yml"), "utf8");
  const updateSection = operations.match(/## Update CAO[\s\S]*?(?=\n## |\n### Catalog Release Revocation)/)?.[0] ?? "";
  const policy = JSON.parse(execFileSync(process.execPath, [
    join(root, ".github", "workflows", "shared", "control.mjs"),
    "resolve-policy",
    join(root, ".github", "workflows", "cao.json"),
  ], {
    encoding: "utf8",
    env: {
      ...process.env,
      CAO_PACKAGE: "dependabot",
      CAO_ROLE: "orchestrator",
      GITHUB_REPOSITORY: "githubnext/gh-aw-cao",
    },
  }));

  assert.equal(policy.authorized, true);
  assert.equal(policy.package, "dependabot");
  assert.doesNotMatch(rootManifest, /\.github\/aw\/cao/);
  for (const path of ["control.mjs", "policy.mjs", "setup-github-apps.mjs"]) {
    assert.match(
      rootManifest,
      new RegExp(`source: \\.github/workflows/shared/${path.replace(".", "\\.")}[\\s\\S]*?destination: \\.github/workflows/shared/${path.replace(".", "\\.")}`),
    );
  }
  for (const path of ["cao.schema.json", "setup-github-apps.mjs", "control.mjs", "policy.mjs"]) {
    assert.ok(existsSync(join(root, ".github", "workflows", "shared", path)));
  }
  assert.match(control, /runtime="\$GITHUB_WORKSPACE\/\.cao\/\.github\/workflows\/shared\/control\.mjs"/);
  assert.doesNotMatch(control, /\.cao-runtime|Checkout installed CAO control source|# Source: /);
  assert.match(activity, /control-settings\.mjs" \\\n\s+\.github\/workflows\/shared\/control\.mjs/);
  assert.doesNotMatch(activity, /Checkout installed CAO control source|\.cao-runtime/);
  assert.doesNotMatch(setupSkill, /cao_checkout|sparse-checkout/);
  assert.match(quickstart, /setup-central-agentic-ops/);
  assert.match(quickstart, /CAO_RELEASE=\$\(gh release view --repo githubnext\/gh-aw-cao --json tagName --jq '\.tagName'\)/);
  assert.match(quickstart, /gh aw add "githubnext\/gh-aw-cao@\$\{CAO_RELEASE\}"/);
  assert.doesNotMatch(quickstart, /@main|commits\/main|full commit SHA/);
  assert.doesNotMatch(quickstart, /base64 -d|contents\/\.github\/cao/);
  assert.match(updateSection, /gh aw update https:\/\/github\.com\/githubnext\/gh-aw-cao --major --cool-down 0 --create-pull-request/);
  assert.match(updateSection, /resolves published GitHub releases[\s\S]*?latest compatible release/);
  assert.match(updateSection, /Do not point updates at `main`, fetch control files separately, or copy them with a script/);
  assert.match(updateSection, /predate the package-owned `\.github\/workflows\/shared\/` runtime[\s\S]*?fails closed/);
  assert.doesNotMatch(updateSection, /gh extension (?:install|upgrade)|gh aw add/);
  assert.doesNotMatch(updateSection, /base64 -d|contents\/\.github\/cao/);
  assert.match(authentication, /node \.github\/workflows\/shared\/setup-github-apps\.mjs --repo acme\/central-agentic-ops/);
  assert.doesNotMatch(authentication, /CAO_REF=|contents\/\.github\/workflows\/shared\/setup-github-apps\.mjs/);
  assert.match(admission, /root CAO package installs one runtime copy under `\.github\/workflows\/shared\/`/i);
});

test("root package composes its operational packages through manifests", () => {
  const rootManifest = parse(readFileSync(join(root, "aw.yml"), "utf8"));

  assert.deepEqual(rootManifest.includes, [
    ".github/workflows/aw.json",
    "activity/aw.yml",
    "dashboard/aw.yml",
  ]);
  const project = JSON.parse(readFileSync(join(root, ".github", "workflows", "aw.json"), "utf8"));
  assert.deepEqual(project.auto_upgrade.options, ["--pre-releases"]);
});

test("compiled workflow locks are not ignored", () => {
  const gitignore = readFileSync(join(root, ".gitignore"), "utf8");
  assert.doesNotMatch(gitignore, /\.lock\.yml/, "compiled workflow locks must not be ignored");

  const workflowIds = readdirSync(workflowsDirectory)
    .filter((name) => name.endsWith(".md"))
    .map((name) => name.replace(/\.md$/, ""));
  for (const workflowId of workflowIds) {
    const lockPath = `.github/workflows/${workflowId}.lock.yml`;
    assert.ok(existsSync(join(root, lockPath)), `${lockPath} must be compiled`);
  }
});

test("Agent customizations preserve deterministic core package boundaries", () => {
  const agent = readFileSync(join(root, ".github", "agents", "agentic-workflows.md"), "utf8");
  const agenticWorkflowsSkill = readFileSync(join(root, ".github", "skills", "agentic-workflows", "SKILL.md"), "utf8");
  const packageSkill = readFileSync(join(root, "skills", "create-ops-package", "SKILL.md"), "utf8");
  const repositoryInstructions = readFileSync(join(root, ".github", "aw", "instructions.md"), "utf8");

  assert.match(agent, /\.github\/aw\/instructions\.md/);
  assert.match(agenticWorkflowsSkill, /\.github\/aw\/instructions\.md/);
  assert.match(packageSkill, /## Deterministic Add-on Exception/);
  assert.match(packageSkill, /\.github\/aw\/create-agentic-workflow\.md/);
  assert.match(packageSkill, /Workflow creation is an agent workflow/);
  assert.match(packageSkill, /upstream `github\/gh-aw` `\.github\/skills\/operational-value-designer\/SKILL\.md`/);
  assert.match(packageSkill, /Adopt a measurable worker and its evaluator together in one commit/);
  assert.doesNotMatch(packageSkill, /Evaluator design remains a separate post-adoption maintenance task/);
  assert.match(packageSkill, /core activity cache/);
  assert.match(packageSkill, /unified builder and publisher/);
  assert.match(packageSkill, /complete workflow `name` at 32 characters or fewer/);
  assert.match(packageSkill, /omitting redundant role words/);
  assert.match(repositoryInstructions, /Keep `\.github\/workflows\/cao-dashboard\.yml` as the single dashboard builder and optional Pages publisher/);
  assert.match(repositoryInstructions, /upload the reusable dashboard artifact/);
  assert.match(repositoryInstructions, /must not add a schedule or another enable variable/);
  assert.match(repositoryInstructions, /Keep data collection and cache publication out of operational packages and dashboard build jobs/);
  assert.match(repositoryInstructions, /follow `skills\/create-ops-package\/SKILL\.md`/);
  assert.match(repositoryInstructions, /apply `skills\/create-ops-package\/SKILL\.md`/);
  assert.match(repositoryInstructions, /required `\.github\/workflows\/shared\/control\.md` imports/);
  assert.doesNotMatch(repositoryInstructions, /operational-value-designer\/SKILL\.md/);
});

test("README routes zero-to-CAO requests to the setup skill", () => {
  const readme = readFileSync(join(root, "README.md"), "utf8");
  const setupSkillPath = join(root, ".github", "skills", "setup-central-agentic-ops", "SKILL.md");
  const setupSkill = readFileSync(setupSkillPath, "utf8");
  const createPackageSkill = readFileSync(join(root, "skills", "create-ops-package", "SKILL.md"), "utf8");
  const readmeEntry = ".github/skills/setup-central-agentic-ops/SKILL.md";

  assert.ok(readme.split("\n").slice(0, 20).some((line) => line.includes(readmeEntry)));
  assert.ok(existsSync(setupSkillPath));
  assert.match(setupSkill, /^---\nname: setup-central-agentic-ops\n/);
  assert.match(setupSkill, /safe_output_mode=review/);
  assert.match(setupSkill, /Ask these two package questions separately/);
  assert.match(setupSkill, /What do you want CAO to do with the catalog operations installed by the root package/);
  assert.match(setupSkill, /immutable root package installs its core catalog workflows as one unit/);
  assert.match(setupSkill, /Do you also want to create an operation package of your own/);
  assert.match(setupSkill, /plan an explicit handoff to `.github\/skills\/create-ops-package\/SKILL\.md` after step 14/);
  assert.match(setupSkill, /Never silently default the package to Dependabot/);
  assert.match(setupSkill, /read the control repository's `.github\/workflows\/cao\.json` and the current dashboard state/);
  assert.match(setupSkill, /If the policy and the live dashboard disagree, raise the drift to the user on the dashboard/);
  assert.match(createPackageSkill, /When invoked from `.github\/skills\/setup-central-agentic-ops\/SKILL\.md`/);
  assert.match(createPackageSkill, /accept the recorded desired outcome and target-repository description/);
  assert.match(createPackageSkill, /compare the intended package state with the current `.github\/workflows\/cao\.json` and the dashboard's live control-plane view/);
  assert.match(createPackageSkill, /raise the mismatch to the user on the dashboard before proceeding/);
  assert.match(createPackageSkill, /Do not repeat the custom-package yes\/no question or restart control-plane setup/);
  assert.match(setupSkill, /Ask which repository the first review run should target/);
  assert.match(setupSkill, /Offer `<organization>\/<control-repository>` as the default/);
  assert.match(setupSkill, /target_repo="<target-owner>\/<target-repository>"/);
  assert.doesNotMatch(setupSkill, /Always target the control repository itself for the first run/);
  assert.match(setupSkill, /^1\. Install or verify the `gh-aw` CLI before any other setup work/m);
  assert.match(setupSkill, /install-gh-aw\.sh \| bash/);
  assert.match(setupSkill, /github\/gh-aw\/blob\/main\/install\.md/);
  assert.match(setupSkill, /gh aw add githubnext\/gh-aw-cao/);
  assert.match(setupSkill, /gh-aw resolves the latest published release, retries transient package-install failures/);
  assert.doesNotMatch(setupSkill, /gh release view|cao_release=|cao-ref|cao-release/);
  assert.doesNotMatch(setupSkill, /commits\/main|githubnext\/gh-aw-cao@main|full commit SHA/);
  assert.doesNotMatch(setupSkill, /cao_checkout|sparse-checkout/);
  assert.match(setupSkill, /gh aw doctor --repo <organization>\/<control-repository> --dir \./);
  assert.match(setupSkill, /Run `gh aw version`\. Compare it with `min-version` in the root CAO `aw\.yml`/);
  assert.match(setupSkill, /Do not require the catalog maintainer's current local version when the package supports an older release/);
  assert.match(setupSkill, /gh api orgs\/<organization>\/copilot\/billing/);
  assert.match(setupSkill, /Require confirmed organization billing for Copilot inference/);
  assert.match(setupSkill, /`total_seats: 0`[\s\S]*?HTTP 403/);
  assert.match(setupSkill, /GitHub App or `GH_AW_GITHUB_TOKEN` for target access does not authenticate Copilot inference/);
  assert.match(setupSkill, /every installed Copilot-backed source declares `copilot-requests: write`/);
  assert.match(setupSkill, /no generated lock declares `\$\{\{ secrets\.COPILOT_GITHUB_TOKEN \}\}`/);
  assert.match(setupSkill, /do not replace `auto` with an explicit model/);
  assert.match(setupSkill, /Do not add release-resolution scripts/);
  assert.match(setupSkill, /package cannot install this file because it is consumer-owned rollout policy/);
  assert.match(setupSkill, /Replace `<gh-aw-version>`[\s\S]*?both occurrences of `<target-owner>`[\s\S]*?one occurrence of `<target-repository>`/);
  assert.match(setupSkill, /Do not put `control-owner` or `control-repository` into this policy unless the selected target is the control repository/);
  assert.match(setupSkill, /if \(\/<\[\^>\]\+>\/\.test\(source\)\) throw new Error\('unresolved policy placeholder'\)/);
  const policyTemplate = setupSkill.match(/```json\n([\s\S]*?)\n\s*```/)?.[1];
  assert.ok(policyTemplate, "setup skill must contain a JSON policy template");
  const initialPolicy = JSON.parse(policyTemplate
    .replaceAll("<gh-aw-version>", ghAwVersion)
    .replaceAll("<target-owner>", "acme")
    .replaceAll("<target-repository>", "service")
    .replaceAll("<package-slug>", "dependabot")
    .replaceAll("<worker-slug>", "release-train-updater")
    .replaceAll("<worker-workflow-slug>", "dependabot-release-train-updater"));
  assert.deepEqual(initialPolicy, {
    version: 1,
    "gh-aw-version": ghAwVersion,
    "control-plane": {
      scope: {
        "allowed-owners": ["acme"],
        "allowed-repositories": ["acme/service"],
      },
      packages: {
        dependabot: {
          workers: {
            "release-train-updater": {
              workflow: "dependabot-release-train-updater",
            },
          },
        },
      },
    },
  });
  assert.match(setupSkill, /"allowed-owners": \["<target-owner>"\]/);
  assert.match(setupSkill, /"allowed-repositories": \["<target-owner>\/<target-repository>"\]/);
  assert.match(setupSkill, /"<package-slug>": \{\s+"workers": \{/);
  assert.match(setupSkill, /resolver loads this mapping directly from policy/);
  assert.match(setupSkill, /gh aw run <orchestrator-workflow>/);
  assert.match(setupSkill, /Public and private control repositories are supported/);
  assert.match(setupSkill, /policy, workflow runs, operational metadata, and review safe outputs are public/);
  assert.doesNotMatch(setupSkill, /the control repository is public;/);
  assert.match(setupSkill, /Control-repository visibility does not determine target access/);
  assert.match(setupSkill, /use `GITHUB_TOKEN` for control-repository self-review or an exact public target in `review`/);
  assert.match(setupSkill, /require separate least-privilege read-only and write-capable GitHub Apps/);
  assert.match(setupSkill, /node \.github\/workflows\/shared\/setup-github-apps\.mjs --repo <organization>\/<control-repository>/);
  assert.doesNotMatch(setupSkill, /contents\/\.github\/workflows\/shared\/setup-github-apps\.mjs|setup_dir=\$\(mktemp -d\)/);
  assert.match(setupSkill, /helper mirrors gh-aw's App manifest conversion flow without changing package delivery/);
  assert.match(setupSkill, /sends private keys to repository secrets through standard input/);
  assert.match(setupSkill, /read App has no write permission/);
  assert.match(setupSkill, /Do not place private target evidence in a public control repository/);
  assert.match(setupSkill, /offer a fine-grained PAT only when an App cannot be obtained[\s\S]*?user explicitly consents/);
  assert.match(setupSkill, /A PAT cannot grant access the user does not already have/);
  assert.match(setupSkill, /source-managed control topology for any repository that maintains the workflows it will execute in-tree/);
  assert.match(setupSkill, /Never infer control-plane operation from workflow sources, catalog files, or the repository name alone/);
  assert.match(setupSkill, /also a catalog[\s\S]*supported dogfood repository/);
});
