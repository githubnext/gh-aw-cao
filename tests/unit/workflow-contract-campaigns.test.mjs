import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { parse } from "yaml";
import { escapedGhAwVersion, ghAwVersion, root, script, workflow, workflowsDirectory } from "./workflow-contract.helpers.mjs";

// Campaign manifest, bundle, and catalog ownership contracts.

function localJavaScriptDependencies(source) {
  const dependencies = [];
  const pattern = /(?:\bfrom\s+|\bimport\s*\(\s*|\bimport\s+|\bexport\s+(?:\*|\{[^}]*\})\s+from\s+)["'](\.{1,2}\/[^"']+\.(?:c|m)?js)["']/g;
  for (const match of source.matchAll(pattern)) dependencies.push(match[1]);
  return dependencies;
}

function JavaScriptFiles(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const candidate = join(directory, entry.name);
    if (entry.isDirectory()) {
      return ["test", "tests", "node_modules"].includes(entry.name) ? [] : JavaScriptFiles(candidate);
    }
    return /\.(?:c|m)?js$/.test(entry.name) ? [candidate] : [];
  });
}

function workflowConfig(name) {
  const frontmatter = /^---\r?\n([\s\S]*?)\r?\n---/.exec(workflow(name))?.[1];
  assert.ok(frontmatter, `${name} must have frontmatter`);
  return parse(frontmatter);
}

test("campaigns and repository workflows pin the supported gh-aw version", () => {
  const manifests = [
    "aw.yml",
    "activity/aw.yml",
    "uk-ai-advisory/aw.yml",
    "cao-evolution/aw.yml",
    "dashboard/aw.yml",
    "dependabot/aw.yml",
    "dreaming/aw.yml",
    "eslint-rules/aw.yml",
    "eu-cra-compliance/aw.yml",
    "optimization/aw.yml",
    "repo-assist/aw.yml",
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
  assert.match(activity, new RegExp(`setup-cli@[0-9a-f]{40} # ${escapedGhAwVersion}`));
  assert.match(activity, /version: \$\{\{ steps\.gh-aw-compiler\.outputs\.version \}\}/);
  const setupAction = readFileSync(join(root, ".github", "actions", "setup-gh-aw", "action.yml"), "utf8");
  assert.match(setupAction, /control\.mjs compiler-version \.github\/workflows\/cao\.json/);
  assert.match(setupAction, new RegExp(`setup-cli@[0-9a-f]{40} # ${escapedGhAwVersion}`));
  assert.match(setupAction, /version: \$\{\{ steps\.compiler\.outputs\.version \}\}/);
  assert.match(
    JSON.parse(readFileSync(join(root, "package.json"), "utf8")).scripts["install:gh-aw"],
    /control\.mjs compiler-version \.github\/workflows\/cao\.json/,
  );
});

test("catalog campaigns declare their current experimental maturity", () => {
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
    "dreaming/aw.yml",
    "eslint-rules/aw.yml",
    "eu-cra-compliance/aw.yml",
    "optimization/aw.yml",
    "repo-assist/aw.yml",
    "self-care/aw.yml",
    "software-development-practices/aw.yml",
  ];
  for (const manifest of manifests) {
    const metadata = parse(readFileSync(join(root, manifest), "utf8"));
    assert.equal(metadata.private ?? false, privateManifests.has(manifest), manifest);
    assert.equal(metadata.experimental, true, manifest);
  }
});

test("operational workflows use the transitive CAO campaign bundle", () => {
  const control = workflow("shared/control.md");
  const policyCampaigns = JSON.parse(
    readFileSync(join(root, ".github", "workflows", "cao.json"), "utf8"),
  )["control-plane"].campaigns;
  const declaredOperationWorkflows = Object.keys(policyCampaigns).flatMap((campaignName) => {
    const descriptorPath = join(root, campaignName, "cao.json");
    if (!existsSync(descriptorPath)) {
      return [];
    }
    const descriptor = JSON.parse(readFileSync(descriptorPath, "utf8"));
    const manifest = parse(readFileSync(join(root, campaignName, "aw.yml"), "utf8"));
    const declaredWorkflowIds = [descriptor.orchestrator, ...Object.values(descriptor.workers)].sort();
    const declaredWorkflowPaths = declaredWorkflowIds
      .map((workflowId) => `.github/workflows/${workflowId}.md`)
      .sort();
    const includedWorkflowPaths = manifest.includes
      .filter((include) => typeof include === "string")
      .filter((include) => include.endsWith(".md"))
      .sort();

    assert.equal(descriptor.campaign, campaignName, descriptorPath);
    if (!manifest.private) {
      assert.deepEqual(
        includedWorkflowPaths,
        declaredWorkflowPaths,
        `${campaignName} public campaign manifest must include its complete workflow inventory`,
      );
    } else {
      const includedControlledWorkflowPaths = includedWorkflowPaths.filter((includePath) => {
        assert.match(includePath, /^\.github\/workflows\/[^/]+\.md$/, `${campaignName} manifest workflow path`);
        assert.ok(existsSync(join(root, includePath)), `${campaignName} manifest source ${includePath}`);
        const sourceName = includePath.replace(".github/workflows/", "");
        return workflowConfig(sourceName).imports?.some((entry) => entry.uses === "shared/control.md");
      });
      assert.deepEqual(
        includedControlledWorkflowPaths.filter((includePath) => !declaredWorkflowPaths.includes(includePath)),
        [],
        `${campaignName} private campaign manifest must not include undeclared operation workflows`,
      );
    }
    return declaredWorkflowIds.map((workflowId) => `.github/workflows/${workflowId}.md`);
  }).sort();

  assert.match(control, /dispatch_max:\r?\n\s+type: number/);
  assert.match(control, /orchestrator_credits:\r?\n\s+type: number/);
  assert.match(control, /worker_credits_per_target:\r?\n\s+type: number/);
  assert.match(control, /footer-install: "<!-- -->"/);

  const operationWorkflows = readdirSync(workflowsDirectory)
    .filter((name) =>
      name.endsWith(".md")
      && workflowConfig(name).imports?.some((entry) =>
        entry.uses === "shared/control.md"
        && existsSync(join(root, entry.with.campaign, "cao.json"))))
    .sort();
  assert.deepEqual(operationWorkflows.map((name) => `.github/workflows/${name}`), declaredOperationWorkflows);
  assert.match(control, /name: Upload CAO admission artifact/);
  assert.match(control, /name: cao-admission/);
  assert.match(control, /path: \$\{\{ runner\.temp \}\}\/cao\/admission\.json/);
  assert.ok(existsSync(join(root, "activity", "gh-aw-logs.mjs")));
  assert.match(
    readFileSync(join(root, ".github", "workflows", "shared", "materialize-cao.mjs"), "utf8"),
    /rootResources = \[[\s\S]*?'activity'/,
  );
});

test("campaign manifests exclude repository-only tests", () => {
  for (const relativePath of ["aw.yml", join("uk-ai-advisory", "aw.yml"), join("cao-evolution", "aw.yml"), join("dashboard", "aw.yml"), join("dependabot", "aw.yml"), join("dreaming", "aw.yml"), join("eslint-rules", "aw.yml"), join("eu-cra-compliance", "aw.yml"), join("optimization", "aw.yml"), join("repo-assist", "aw.yml"), join("self-care", "aw.yml"), join("software-development-practices", "aw.yml")]) {
    const manifest = readFileSync(join(root, relativePath), "utf8");
    assert.doesNotMatch(manifest, /(?:review-smoke|enterprise-canary|enterprise-stress|tests\/e2e|\.github\/aw\/e2e)/, relativePath);
  }
});

test("activity and dashboard campaigns include every local JavaScript dependency", () => {
  const bundled = new Set(["activity", "dashboard"].flatMap((directory) => JavaScriptFiles(join(root, directory))));

  const pending = [...bundled];
  const visited = new Set();
  while (pending.length > 0) {
    const source = pending.pop();
    if (visited.has(source)) continue;
    visited.add(source);

    const contents = readFileSync(source, "utf8");
    for (const dependency of localJavaScriptDependencies(contents)) {
      const resolved = realpathSync(join(source, "..", dependency));
      assert.ok(bundled.has(resolved), `${source} depends on unbundled JavaScript resource ${resolved}`);
      pending.push(resolved);
    }
  }
});

test("focused campaign manifests do not cross-own campaign files", () => {
  const manifestPaths = readdirSync(root)
    .map((name) => join(name, "aw.yml"))
    .filter((relativePath) => relativePath !== "aw.yml" && existsSync(join(root, relativePath)))
    .sort();
  const destinations = new Map();

  for (const relativePath of manifestPaths) {
    const campaignName = relativePath.split("/")[0];
    const manifest = parse(readFileSync(join(root, relativePath), "utf8"));
    const files = [
      ...(manifest.includes ?? []).filter((entry) => entry !== "../aw.yml").map((entry) => typeof entry === "string" ? {
        source: entry,
        destination: entry.startsWith(".github/workflows/") ? entry : `${campaignName}/${entry}`,
      } : entry),
      ...(manifest.resources ?? []),
    ];

    for (const file of files) {
      const owners = destinations.get(file.destination) ?? [];
      owners.push(`${campaignName}:${file.source}`);
      destinations.set(file.destination, owners);
    }
  }

  const duplicateOwners = [...destinations.entries()]
    .filter(([, owners]) => owners.length > 1)
    .map(([destination, owners]) => `${destination} <= ${owners.join(", ")}`)
    .sort();
  assert.deepEqual(duplicateOwners, [], "campaign manifests must not declare the same destination from multiple campaigns");
});

test("operational campaigns install declarations matching their workflow identities", () => {
  const campaignNames = [
    "cao-evolution",
    "dependabot",
    "dreaming",
    "eslint-rules",
    "eu-cra-compliance",
    "optimization",
    "repo-assist",
    "self-care",
    "software-development-practices",
    "uk-ai-advisory",
  ];

  for (const campaignName of campaignNames) {
    const declaration = JSON.parse(readFileSync(join(root, campaignName, "cao.json"), "utf8"));
    const manifest = parse(readFileSync(join(root, campaignName, "aw.yml"), "utf8"));
    assert.equal(declaration.campaign, campaignName);
    assert.equal(manifest.resources, undefined, campaignName);
    assert.ok(existsSync(join(root, campaignName, "cao.json")), campaignName);

    const orchestrator = workflow(`${declaration.orchestrator}.md`);
    assert.match(orchestrator, new RegExp(`campaign: ${campaignName}\\r?\\n\\s+role: orchestrator`), campaignName);
    for (const [worker, workflowName] of Object.entries(declaration.workers)) {
      const source = workflow(`${workflowName}.md`);
      assert.match(
        source,
        new RegExp(`campaign: ${campaignName}\\r?\\n\\s+role: worker\\r?\\n\\s+worker: ${worker}`),
        `${campaignName}/${worker}`,
      );
    }
  }
});

test("root campaign keeps GitHub App setup opt-in", () => {
  const rootManifest = parse(readFileSync(join(root, "aw.yml"), "utf8"));

  assert.equal(rootManifest.config, undefined);
});

test("root campaign provides default control-repository agent context", () => {
  const rootManifestSource = readFileSync(join(root, "aw.yml"), "utf8");
  const rootManifest = parse(rootManifestSource);
  const agents = readFileSync(join(root, "AGENTS.md"), "utf8");
  const setupSkill = readFileSync(join(root, "skills", "setup-cao", "SKILL.md"), "utf8");
  const debugSkill = readFileSync(join(root, "skills", "debug-cao", "SKILL.md"), "utf8");

  assert.doesNotMatch(rootManifestSource, /source: AGENTS\.md|default-AGENTS\.md/);
  assert.equal(rootManifest.resources.some(({ destination }) => destination.startsWith(".github/skills/")), false);
  assert.equal(rootManifest.skills, undefined);
  assert.match(debugSkill, /^---\r?\nname: debug-cao\r?\n/);
  for (const skill of ["setup-cao", "add-cao-campaign", "create-cao-campaign", "analyze-cao", "cao-cli"]) {
    const portableSkill = join(root, "skills", skill);
    assert.equal(lstatSync(portableSkill).isDirectory(), true);
    assert.equal(existsSync(join(root, ".github", "skills", skill)), false);
    assert.match(
      readFileSync(join(portableSkill, "SKILL.md"), "utf8"),
      new RegExp(`^---\\r?\\nname: ${skill}\\r?\\n`),
    );
  }
  assert.match(agents, /Source-managed control repository:[\s\S]*Any repository may run workflows it maintains directly in-tree as a control plane/);
  assert.match(agents, /same repository is also a catalog[\s\S]*supported dogfood topology/);
  assert.match(agents, /Do not infer a role from the repository name or from catalog files alone/);
  assert.match(agents, /Control repository:[\s\S]*explicitly enrolled remote repositories/);
  assert.match(agents, /`review` is the default mode/);
  assert.match(agents, /Never edit them directly; change their Markdown sources and run `gh aw compile`/);
  assert.match(agents, /Treat dashboard IndexedDB as disposable, per-browser derived state/);
  assert.match(agents, /Operational workflows and campaign workers have no browser session and must not query it as a service or authority/);
  assert.match(agents, /inspect IndexedDB through the canonical storage and query APIs under `dashboard\/site\/src\/data\/` or through Playwright/);
  assert.match(agents, /authoritative input, adapter, normalization, canonical query, and view-payload stages/);
  assert.match(setupSkill, /Preserve consumer-owned root `AGENTS\.md` instructions/);
  assert.match(setupSkill, /Preserve any root `AGENTS\.md` unchanged/);
});

test("root campaign installs the CAO CLI helper", () => {
  const rootManifest = parse(readFileSync(join(root, "aw.yml"), "utf8"));
  const helper = readFileSync(join(root, "cao.sh"), "utf8");
  const materializer = readFileSync(join(root, ".github", "workflows", "shared", "materialize-cao.mjs"), "utf8");

  assert.equal(rootManifest.resources.some(({ source }) => source === "cao.sh"), false);
  assert.match(materializer, /'cao\.sh'/);
  assert.match(helper, /^#!\/bin\/sh/);
  assert.match(helper, /activity\/cao\.mjs/);
  assert.doesNotMatch(helper, /\.github\/aw\//);
});

test("root campaign resolves the single CAO bootstrap runtime", () => {
  const rootManifest = readFileSync(join(root, "aw.yml"), "utf8");
  const setupSkill = readFileSync(join(root, "skills", "setup-cao", "SKILL.md"), "utf8");
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
      CAO_CAMPAIGN: "dependabot",
      CAO_ROLE: "orchestrator",
      GITHUB_REPOSITORY: "githubnext/gh-aw-cao",
    },
  }));

  assert.equal(policy.authorized, true);
  assert.equal(policy.campaign, "dependabot");
  assert.doesNotMatch(rootManifest, /\.github\/aw\/cao\//);
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
  assert.match(activity, /node activity\/control-settings\.mjs \\\n\s+\.github\/workflows\/shared\/control\.mjs/);
  assert.doesNotMatch(activity, /Checkout installed CAO control source|\.cao-runtime/);
  assert.doesNotMatch(setupSkill, /cao_checkout|sparse-checkout/);
  assert.match(quickstart, /setup-cao/);
  assert.match(quickstart, /raw\.githubusercontent\.com\/githubnext\/gh-aw-cao\/main\/install\.sh/);
  assert.match(quickstart, /Rerunning it after those files are installed makes no changes/);
  assert.doesNotMatch(quickstart, /githubnext\/gh-aw-cao@main|commits\/main|full commit SHA/);
  assert.doesNotMatch(quickstart, /base64 -d|contents\/\.github\/cao/);
  assert.match(updateSection, /\.\/cao\.sh update --major --cool-down 0/);
  assert.match(updateSection, /upgrades `gh-aw` to the minimum version declared by `\.github\/workflows\/cao\.json`/);
  assert.match(updateSection, /resolves published GitHub releases[\s\S]*?updates each installed CAO campaign to its latest compatible release/);
  assert.match(updateSection, /Do not point updates at `main`, fetch control files separately, or copy them with a script/);
  assert.match(updateSection, /predate the campaign-owned `\.github\/workflows\/shared\/` runtime[\s\S]*?fails closed/);
  assert.doesNotMatch(updateSection, /gh extension (?:install|upgrade)|gh aw add|--create-pull-request/);
  assert.doesNotMatch(updateSection, /base64 -d|contents\/\.github\/cao/);
  assert.match(authentication, /node \.github\/workflows\/shared\/setup-github-apps\.mjs --repo acme\/central-agentic-ops/);
  assert.doesNotMatch(authentication, /CAO_REF=|contents\/\.github\/workflows\/shared\/setup-github-apps\.mjs/);
  assert.match(admission, /Bash installer installs the root CAO campaign and creates the consumer-owned policy/i);
});

test("root campaign CAO helper stays portable across POSIX-family shells", {
  skip: process.platform === "win32",
}, () => {
  const helper = readFileSync(join(root, "cao.sh"), "utf8");
  assert.match(helper, /^#!\/bin\/sh/);
  assert.doesNotMatch(helper, /\bBASH_SOURCE\b|\[\[|pipefail/);

  const temporaryRoot = mkdtempSync(join(tmpdir(), "cao-helper-shell-"));
  try {
    const helperPath = join(temporaryRoot, "cao.sh");
    const activityDirectory = join(temporaryRoot, "activity");
    const binDirectory = join(temporaryRoot, "bin");
    const nodeArgsPath = join(temporaryRoot, "node-args.txt");
    mkdirSync(activityDirectory);
    mkdirSync(binDirectory);
    writeFileSync(helperPath, helper);
    chmodSync(helperPath, 0o755);
    writeFileSync(join(activityDirectory, "cao.mjs"), "");
    writeFileSync(join(binDirectory, "node"), `#!/bin/sh
: "\${CAO_NODE_ARGS:?}"
printf '%s\\n' "$@" > "$CAO_NODE_ARGS"
`);
    chmodSync(join(binDirectory, "node"), 0o755);

    const shells = ["sh", "bash", "zsh"].flatMap((shell) => {
      try {
        const shellPath = execFileSync("sh", ["-c", "command -v \"$1\"", "shell-probe", shell], {
          encoding: "utf8",
        }).trim();
        return shellPath === "" ? [] : [{ name: shell, path: shellPath }];
      } catch {
        return [];
      }
    });
    assert.ok(shells.some(({ name }) => name === "sh"), "sh must be available for the POSIX portability contract");

    const runHelper = (command, args, expectedCli, label) => {
      writeFileSync(nodeArgsPath, "");
      execFileSync(command, args, {
        cwd: temporaryRoot,
        env: {
          ...process.env,
          CAO_NODE_ARGS: nodeArgsPath,
          PATH: `${binDirectory}:${process.env.PATH}`,
        },
      });
      assert.deepEqual(
        readFileSync(nodeArgsPath, "utf8").trimEnd().split("\n"),
        [expectedCli, "status", "with spaces"],
        label,
      );
    };

    const sourceCli = join(realpathSync(temporaryRoot), "activity", "cao.mjs");
    runHelper(helperPath, ["status", "with spaces"], sourceCli, "shebang");
    for (const shell of shells) {
      runHelper(shell.path, [helperPath, "status", "with spaces"], sourceCli, shell.name);
    }

  } finally {
    rmSync(temporaryRoot, { force: true, recursive: true });
  }
});

test("root campaign composes its operational campaigns through manifests", () => {
  const rootManifest = parse(readFileSync(join(root, "aw.yml"), "utf8"));

  assert.deepEqual(rootManifest.includes, [
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

test("Agent customizations preserve deterministic core campaign boundaries", () => {
  const agent = readFileSync(join(root, ".github", "agents", "agentic-workflows.md"), "utf8");
  const agenticWorkflowsSkill = readFileSync(join(root, ".github", "skills", "agentic-workflows", "SKILL.md"), "utf8");
  const campaignSkill = readFileSync(join(root, "skills", "create-cao-campaign", "SKILL.md"), "utf8");
  const repositoryInstructions = readFileSync(join(root, ".github", "cao", "instructions.md"), "utf8");

  assert.match(agent, /\.github\/aw\/instructions\.md/);
  assert.match(agenticWorkflowsSkill, /\.github\/aw\/instructions\.md/);
  assert.match(campaignSkill, /## Deterministic Add-on Exception/);
  assert.match(campaignSkill, /\.github\/aw\/create-agentic-workflow\.md/);
  assert.match(campaignSkill, /Workflow creation is an agent workflow/);
  assert.match(campaignSkill, /upstream `github\/gh-aw` `\.github\/skills\/operational-value-designer\/SKILL\.md`/);
  assert.match(campaignSkill, /Adopt a measurable worker and its evaluator together in one commit/);
  assert.doesNotMatch(campaignSkill, /Evaluator design remains a separate post-adoption maintenance task/);
  assert.match(campaignSkill, /core activity cache/);
  assert.match(campaignSkill, /unified builder and publisher/);
  assert.match(campaignSkill, /complete workflow `name` at 32 characters or fewer/);
  assert.match(campaignSkill, /omitting redundant role words/);
  assert.match(repositoryInstructions, /Keep `\.github\/workflows\/cao-dashboard\.yml` as the single dashboard builder and optional Pages publisher/);
  assert.match(repositoryInstructions, /upload the reusable dashboard artifact/);
  assert.match(repositoryInstructions, /must not add a schedule or another enable variable/);
  assert.match(repositoryInstructions, /Keep data collection and cache publication out of operational campaigns and dashboard build jobs/);
  assert.match(repositoryInstructions, /follow `skills\/create-cao-campaign\/SKILL\.md`/);
  assert.match(repositoryInstructions, /apply `skills\/create-cao-campaign\/SKILL\.md`/);
  assert.match(repositoryInstructions, /required `\.github\/workflows\/shared\/control\.md` imports/);
  assert.doesNotMatch(repositoryInstructions, /operational-value-designer\/SKILL\.md/);
});

test("campaign creation guidance defines optional package problem clustering", () => {
  const campaignSkill = readFileSync(join(root, "skills", "create-cao-campaign", "SKILL.md"), "utf8");

  assert.match(campaignSkill, /<campaign-slug>\/problem-clustering\.mjs/);
  assert.match(campaignSkill, /Emit a JSONL sequence: zero or more newline-delimited JSON objects/);
  assert.match(campaignSkill, /an actionable `fixPrompt` that an agent can follow/);
  assert.match(campaignSkill, /do not add campaign-specific clustering steps to the Activity workflow/);
  assert.match(campaignSkill, /fault-isolated, timed, cancelable subprocess/);
});

test("README routes zero-to-CAO requests to the setup skill", () => {
  const readme = readFileSync(join(root, "README.md"), "utf8");
  const setupSkillPath = join(root, "skills", "setup-cao", "SKILL.md");
  const setupSkill = readFileSync(setupSkillPath, "utf8");
  const localCreateCampaignSkillPath = join(root, "skills", "create-cao-campaign", "SKILL.md");
  const localCreateCampaignSkill = readFileSync(localCreateCampaignSkillPath, "utf8");
  const createCampaignSkill = readFileSync(join(root, "skills", "create-cao-campaign", "SKILL.md"), "utf8");
  const readmeEntry = "skills/setup-cao/SKILL.md";

  assert.ok(readme.split("\n").slice(0, 20).some((line) => line.includes(readmeEntry)));
  assert.ok(existsSync(setupSkillPath));
  assert.ok(existsSync(localCreateCampaignSkillPath));
  assert.match(localCreateCampaignSkill, /^---\r?\nname: create-cao-campaign\r?\n/);
  assert.match(setupSkill, /^---\r?\nname: setup-cao\r?\n/);
  assert.match(setupSkill, /safe_output_mode=review/);
  assert.match(setupSkill, /Ask these two campaign questions separately/);
  assert.match(setupSkill, /What do you want CAO to do with the catalog operations installed by the root campaign/);
  assert.match(setupSkill, /immutable root campaign installs its core catalog workflows as one unit/);
  assert.match(setupSkill, /Do you also want to create an operation campaign of your own/);
  assert.match(setupSkill, /plan an explicit handoff to the `create-cao-campaign` skill after step 14/);
  assert.match(setupSkill, /Never silently default the campaign to Dependabot/);
  assert.match(setupSkill, /read the control repository's `.github\/workflows\/cao\.json` and the current dashboard state/);
  assert.match(setupSkill, /If the policy and the live dashboard disagree, raise the drift to the user on the dashboard/);
  assert.match(createCampaignSkill, /When invoked from the `setup-cao` skill/);
  assert.match(createCampaignSkill, /accept the recorded desired outcome and target-repository description/);
  assert.match(createCampaignSkill, /compare the intended campaign state with the current `.github\/workflows\/cao\.json` and the dashboard's live control-plane view/);
  assert.match(createCampaignSkill, /raise the mismatch to the user on the dashboard before proceeding/);
  assert.match(createCampaignSkill, /Do not repeat the custom-campaign yes\/no question or restart control-plane setup/);
  assert.match(setupSkill, /Ask which repository the first review run should target/);
  assert.match(setupSkill, /Offer `<organization>\/<control-repository>` as the default/);
  assert.match(setupSkill, /target_repo="<target-owner>\/<target-repository>"/);
  assert.doesNotMatch(setupSkill, /Always target the control repository itself for the first run/);
  assert.match(setupSkill, /^1\. Verify GitHub CLI before any other setup work/m);
  assert.match(setupSkill, /raw\.githubusercontent\.com\/githubnext\/gh-aw-cao\/main\/install\.sh/);
  assert.match(setupSkill, /installer verifies or installs gh-aw, adds the latest published root campaign, and creates a minimal review-safe/);
  assert.doesNotMatch(setupSkill, /gh release view|cao_release=|cao-ref|cao-release/);
  assert.doesNotMatch(setupSkill, /commits\/main|githubnext\/gh-aw-cao@main|full commit SHA/);
  assert.doesNotMatch(setupSkill, /cao_checkout|sparse-checkout/);
  assert.match(setupSkill, /gh aw doctor --repo <organization>\/<control-repository> --dir \./);
  assert.match(setupSkill, /gh api orgs\/<organization>\/copilot\/billing/);
  assert.match(setupSkill, /Organization billing is optional for CAO installation, but required to run the bundled Copilot-backed workflows/);
  assert.match(setupSkill, /Checking Copilot organization billing is completely optional/);
  assert.match(setupSkill, /token usually cannot read organization billing/);
  assert.match(setupSkill, /If the command fails, is forbidden, or is inconclusive, say so once and continue/);
  assert.match(setupSkill, /explicitly author and compile a workflow using another supported engine\/provider/);
  assert.match(setupSkill, /`total_seats: 0`[\s\S]*?HTTP 403/);
  assert.match(setupSkill, /GitHub App or `GH_AW_GITHUB_TOKEN` for target access does not authenticate model inference/);
  assert.match(setupSkill, /every installed Copilot-backed source declares `copilot-requests: write`/);
  assert.match(setupSkill, /no generated lock declares `\$\{\{ secrets\.COPILOT_GITHUB_TOKEN \}\}`/);
  assert.match(setupSkill, /Do not replace `auto` with an explicit model/);
  assert.match(setupSkill, /\.\/cao\.sh add githubnext\/gh-aw-cao\/<campaign-slug>/);
  assert.match(setupSkill, /consumer-owned policy/);
  assert.match(setupSkill, /if \(\/<\[\^>\]\+>\/\.test\(source\)\) throw new Error\('unresolved policy placeholder'\)/);
  assert.doesNotMatch(setupSkill, /```json\n[\s\S]*?"workers"/);
  assert.match(setupSkill, /campaign-owned orchestrator and worker identities are merged/);
  assert.match(setupSkill, /gh aw run <orchestrator-workflow>/);
  assert.match(setupSkill, /Public and private control repositories are supported/);
  assert.match(setupSkill, /policy, workflow runs, operational metadata, and review safe outputs are public/);
  assert.doesNotMatch(setupSkill, /the control repository is public;/);
  assert.match(setupSkill, /Control-repository visibility does not determine target access/);
  assert.match(setupSkill, /use `GITHUB_TOKEN` for control-repository self-review or an exact public target in `review`/);
  assert.match(setupSkill, /require separate least-privilege read-only and write-capable GitHub Apps/);
  assert.match(setupSkill, /node \.github\/workflows\/shared\/setup-github-apps\.mjs --repo <organization>\/<control-repository>/);
  assert.doesNotMatch(setupSkill, /contents\/\.github\/workflows\/shared\/setup-github-apps\.mjs|setup_dir=\$\(mktemp -d\)/);
  assert.match(setupSkill, /helper mirrors gh-aw's App manifest conversion flow without changing campaign delivery/);
  assert.match(setupSkill, /sends private keys to repository secrets through standard input/);
  assert.match(setupSkill, /read App has no write permission/);
  assert.match(setupSkill, /Do not place private target evidence in a public control repository/);
  assert.match(setupSkill, /offer a fine-grained PAT only when an App cannot be obtained[\s\S]*?user explicitly consents/);
  assert.match(setupSkill, /A PAT cannot grant access the user does not already have/);
  assert.match(setupSkill, /source-managed control topology for any repository that maintains the workflows it will execute in-tree/);
  assert.match(setupSkill, /Never infer control-plane operation from workflow sources, catalog files, or the repository name alone/);
  assert.match(setupSkill, /also a catalog[\s\S]*supported dogfood repository/);
});

test("README routes CAO failures to the debug skill", () => {
  const readme = readFileSync(join(root, "README.md"), "utf8");
  const skill = readFileSync(join(root, "skills", "debug-cao", "SKILL.md"), "utf8");

  assert.ok(readme.split("\n").slice(0, 20).some((line) =>
    line.includes("skills/debug-cao/SKILL.md")
  ));
  assert.match(skill, /^---\r?\nname: debug-cao\r?\n/);
  assert.match(skill, /resolvedCommit/);
  assert.match(skill, /GITHUB_WORKFLOW_SHA/);
  assert.match(skill, /Redaction statement/);
  assert.match(skill, /first broken boundary/);
});
