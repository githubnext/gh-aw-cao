import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  addCaoCampaign,
  ensureGhAwMinimumVersion,
  initializeCaoPolicy,
  setCaoCampaignMode,
  setCaoCampaignWorkflowsEnabled,
  setupCaoAuthentication,
  updateCaoCampaigns,
} from "../../activity/cao.mjs";

// gh-aw writes `gh aw version` output to stderr.
const versionResult = {
  status: 0,
  stdout: "",
  stderr: "gh aw version v0.89.17\n",
};
const repositoryLookup = ["repo", "view", "--json", "nameWithOwner", "--jq", ".nameWithOwner"];

// Answers init's gh-aw version and current-repository lookups.
function initExecutor(repositoryResult = { status: 0, stdout: "acme/control\n", stderr: "" }, calls = []) {
  return (command, arguments_) => {
    calls.push([command, arguments_]);
    assert.equal(command, "gh");
    if (arguments_.join(" ") === "aw version") return versionResult;
    assert.deepEqual(arguments_, repositoryLookup);
    return repositoryResult;
  };
}

test("cao init writes the minimal control-plane policy scoped to the current repository", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "cao-init-"));
  const previousDirectory = process.cwd();
  const policyPath = path.join(root, ".github", "workflows", "cao.json");
  const calls = [];
  try {
    await mkdir(path.dirname(policyPath), { recursive: true });
    process.chdir(root);
    const result = await initializeCaoPolicy({
      policyPath,
      execute: initExecutor({ status: 0, stdout: "Acme-Org/ops.tools\n", stderr: "" }, calls),
    });
    const policy = JSON.parse(await readFile(policyPath, "utf8"));
    assert.deepEqual(policy, {
      $schema: "https://raw.githubusercontent.com/githubnext/gh-aw-cao/main/.github/workflows/shared/cao.schema.json",
      version: 1,
      "gh-aw-version": "v0.89.17",
      "control-plane": {
        scope: { "allowed-owners": ["Acme-Org"], "allowed-repositories": ["Acme-Org/ops.tools"] },
        campaigns: {},
      },
    });
    assert.deepEqual(calls, [["gh", ["aw", "version"]], ["gh", repositoryLookup]]);
    assert.equal(result["gh-aw-version"], "v0.89.17");
  } finally {
    process.chdir(previousDirectory);
    await rm(root, { recursive: true, force: true });
  }
});

test("cao init does not overwrite an existing policy", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "cao-init-existing-"));
  const policyPath = path.join(root, "cao.json");
  const calls = [];
  await writeFile(policyPath, '{"version":1}\n');
  try {
    await assert.rejects(
      initializeCaoPolicy({ policyPath, execute: initExecutor(undefined, calls) }),
      /cao\.json already exists/,
    );
    assert.equal(await readFile(policyPath, "utf8"), '{"version":1}\n');
    assert.deepEqual(calls, []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("cao init supports a repository without installed package records", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "cao-init-empty-"));
  const previousDirectory = process.cwd();
  const policyPath = path.join(root, ".github", "workflows", "cao.json");
  try {
    process.chdir(root);
    await initializeCaoPolicy({ policyPath, execute: initExecutor() });
    assert.equal(JSON.parse(await readFile(policyPath, "utf8"))["gh-aw-version"], "v0.89.17");
  } finally {
    process.chdir(previousDirectory);
    await rm(root, { recursive: true, force: true });
  }
});

for (const [description, repositoryResult] of [
  ["gh repo view fails", { status: 1, stdout: "", stderr: "not a git repository\n" }],
  ["gh cannot start", { status: null, stdout: "", stderr: "", error: new Error("spawn gh ENOENT") }],
  ["the repository is empty", { status: 0, stdout: "\n", stderr: "" }],
  ["the repository is malformed", { status: 0, stdout: "acme\n", stderr: "" }],
  ["several repositories are returned", { status: 0, stdout: "acme/control\nacme/other\n", stderr: "" }],
]) {
  test(`cao init writes no policy when ${description}`, async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "cao-init-identity-"));
    const policyPath = path.join(root, ".github", "workflows", "cao.json");
    try {
      await assert.rejects(
        initializeCaoPolicy({ policyPath, execute: initExecutor(repositoryResult) }),
        /^Error: Unable to determine control repository: .*Run cao init from a GitHub repository checkout with a configured remote\.$/s,
      );
      await assert.rejects(readFile(policyPath, "utf8"), { code: "ENOENT" });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
}

test("cao setup-auth delegates private GitHub App setup options", () => {
  const calls = [];
  const result = setupCaoAuthentication("github-app", [
    "--repo", "acme/control",
    "--dry-run",
  ], {
    execute(command, arguments_, options) {
      calls.push([command, arguments_, options]);
      return { status: 0 };
    },
  });

  assert.deepEqual(calls, [[
    process.execPath,
    [
      path.join(".github", "workflows", "shared", "setup-github-apps.mjs"),
      "--repo", "acme/control",
      "--dry-run",
    ],
    { stdio: "inherit" },
  ]]);
  assert.deepEqual(result, { command: "setup-auth", profile: "github-app" });
});

test("cao setup-auth configures a consented fine-grained token through stdin", () => {
  const calls = [];
  const result = setupCaoAuthentication("token", [
    "--repo", "acme/control",
    "--acknowledge-token-risks",
  ], {
    execute(command, arguments_, options) {
      calls.push([command, arguments_, options]);
      return { status: 0, stdout: "", stderr: "" };
    },
  });

  assert.deepEqual(calls, [
    ["gh", ["auth", "status"], { encoding: "utf8" }],
    ["gh", ["secret", "set", "GH_AW_GITHUB_TOKEN", "--repo", "acme/control"], { stdio: "inherit" }],
  ]);
  assert.deepEqual(result, {
    command: "setup-auth",
    profile: "fine-grained-token",
    secret: "GH_AW_GITHUB_TOKEN",
    repo: "acme/control",
  });
});

test("cao setup-auth configures existing enterprise Apps without key arguments", () => {
  const calls = [];
  const result = setupCaoAuthentication("enterprise-app", [
    "--repo", "acme/control",
    "--read-client-id", "Iv1.read",
    "--write-client-id", "Iv1.write",
  ], {
    execute(command, arguments_, options) {
      calls.push([command, arguments_, options]);
      return { status: 0, stdout: "", stderr: "" };
    },
  });

  assert.deepEqual(calls, [
    ["gh", ["auth", "status"], { encoding: "utf8" }],
    ["gh", ["variable", "set", "GH_AW_GITHUB_READ_APP_ID", "--repo", "acme/control", "--body", "Iv1.read"], { encoding: "utf8" }],
    ["gh", ["secret", "set", "GH_AW_GITHUB_READ_APP_PRIVATE_KEY", "--repo", "acme/control"], { stdio: "inherit" }],
    ["gh", ["variable", "set", "GH_AW_GITHUB_WRITE_APP_ID", "--repo", "acme/control", "--body", "Iv1.write"], { encoding: "utf8" }],
    ["gh", ["secret", "set", "GH_AW_GITHUB_WRITE_APP_PRIVATE_KEY", "--repo", "acme/control"], { stdio: "inherit" }],
  ]);
  assert.deepEqual(result, {
    command: "setup-auth",
    profile: "enterprise-app",
    repo: "acme/control",
  });
  assert.equal(calls.flatMap(([, arguments_]) => arguments_).some((value) => /PRIVATE KEY/.test(value)), false);
});

test("cao setup-auth previews enterprise App credential configuration without GitHub calls", () => {
  const result = setupCaoAuthentication("enterprise-app", [
    "--repo", "acme/control",
    "--read-client-id", "Iv1.read",
    "--write-client-id", "Iv1.write",
    "--dry-run",
  ], {
    execute() {
      assert.fail("dry-run must not execute GitHub commands");
    },
  });

  assert.deepEqual(result, {
    command: "setup-auth",
    profile: "enterprise-app",
    repo: "acme/control",
    credentials: [
      {
        role: "read",
        clientId: "Iv1.read",
        variable: "GH_AW_GITHUB_READ_APP_ID",
        secret: "GH_AW_GITHUB_READ_APP_PRIVATE_KEY",
      },
      {
        role: "write",
        clientId: "Iv1.write",
        variable: "GH_AW_GITHUB_WRITE_APP_ID",
        secret: "GH_AW_GITHUB_WRITE_APP_PRIVATE_KEY",
      },
    ],
  });
});

test("cao setup-auth requires explicit token risk acknowledgement", () => {
  assert.throws(
    () => setupCaoAuthentication("token", ["--repo", "acme/control"]),
    /requires --acknowledge-token-risks/,
  );
});

test("cao setup-auth accepts the bounded workflow-token profile without secrets", () => {
  assert.deepEqual(setupCaoAuthentication("workflow-token"), {
    command: "setup-auth",
    profile: "workflow-token",
    configured: true,
    limitation: "Use only for control-repository work or bounded public-target review.",
  });
});

test("cao mode changes configured campaigns between live and preview atomically", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "cao-mode-"));
  const policyPath = path.join(root, ".github", "workflows", "cao.json");
  try {
    await mkdir(path.dirname(policyPath), { recursive: true });
    await writeFile(policyPath, `${JSON.stringify({
      version: 1,
      "gh-aw-version": "v0.89.17",
      "control-plane": {
        campaigns: {
          dependabot: { mode: "review", icon: "dependabot" },
          "repo-assist": { mode: "review", "max-repositories": 1 },
        },
      },
    }, null, 2)}\n`);

    const live = await setCaoCampaignMode("live", ["dependabot", "repo-assist"], { policyPath });
    let policy = JSON.parse(await readFile(policyPath, "utf8"));
    assert.equal(policy["control-plane"].campaigns.dependabot.mode, "live");
    assert.equal(policy["control-plane"].campaigns.dependabot.icon, "dependabot");
    assert.equal(policy["control-plane"].campaigns["repo-assist"].mode, "live");
    assert.deepEqual(live.campaigns, ["dependabot", "repo-assist"]);

    const preview = await setCaoCampaignMode("preview", ["dependabot"], { policyPath });
    policy = JSON.parse(await readFile(policyPath, "utf8"));
    assert.equal(policy["control-plane"].campaigns.dependabot.mode, "review");
    assert.equal(policy["control-plane"].campaigns["repo-assist"].mode, "live");
    assert.equal(preview.mode, "preview");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("cao mode validates every campaign before changing the policy", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "cao-mode-invalid-"));
  const policyPath = path.join(root, "cao.json");
  const original = '{"version":1,"gh-aw-version":"v0.89.17","control-plane":{"campaigns":{"dependabot":{"mode":"review"}}}}\n';
  try {
    await writeFile(policyPath, original);
    await assert.rejects(
      setCaoCampaignMode("live", ["dependabot", "missing-campaign"], { policyPath }),
      /Unknown CAO campaign: missing-campaign/,
    );
    assert.equal(await readFile(policyPath, "utf8"), original);

    await assert.rejects(
      setCaoCampaignMode("live", ["Not-A-Campaign"], { policyPath }),
      /Invalid CAO campaign name: Not-A-Campaign/,
    );
    await assert.rejects(
      setCaoCampaignMode("review", ["dependabot"], { policyPath }),
      /cao mode requires live or preview/,
    );
    await assert.rejects(
      setCaoCampaignMode("preview", [], { policyPath }),
      /requires at least one campaign/,
    );
    assert.equal(await readFile(policyPath, "utf8"), original);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("cao enable and disable update every workflow declared by installed campaigns", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "cao-workflow-state-"));
  const previousDirectory = process.cwd();
  const declarationDirectory = path.join(root, "repo-assist");
  const secondDeclarationDirectory = path.join(root, "dependabot");
  const calls = [];
  try {
    await mkdir(declarationDirectory, { recursive: true });
    await writeFile(path.join(declarationDirectory, "cao.json"), JSON.stringify({
      campaign: "repo-assist",
      orchestrator: "repo-assist",
      workers: {
        "issue-triage": "repo-assist-issue-triage",
        maintenance: "repo-assist-maintenance",
      },
    }));
    await mkdir(secondDeclarationDirectory, { recursive: true });
    await writeFile(path.join(secondDeclarationDirectory, "cao.json"), JSON.stringify({
      campaign: "dependabot",
      orchestrator: "dependabot",
      workers: {
        "update-planner": "dependabot-update-planner",
      },
    }));
    process.chdir(root);
    const execute = (command, arguments_) => {
      calls.push([command, arguments_]);
      return { status: 0, stdout: "", stderr: "" };
    };

    const enabled = await setCaoCampaignWorkflowsEnabled("enable", ["repo-assist", "dependabot"], { execute });
    const disabled = await setCaoCampaignWorkflowsEnabled("disable", ["repo-assist", "dependabot"], { execute });

    assert.deepEqual(calls, [
      ["gh", ["workflow", "enable", "repo-assist.lock.yml"]],
      ["gh", ["workflow", "enable", "repo-assist-issue-triage.lock.yml"]],
      ["gh", ["workflow", "enable", "repo-assist-maintenance.lock.yml"]],
      ["gh", ["workflow", "enable", "dependabot.lock.yml"]],
      ["gh", ["workflow", "enable", "dependabot-update-planner.lock.yml"]],
      ["gh", ["workflow", "disable", "repo-assist.lock.yml"]],
      ["gh", ["workflow", "disable", "repo-assist-issue-triage.lock.yml"]],
      ["gh", ["workflow", "disable", "repo-assist-maintenance.lock.yml"]],
      ["gh", ["workflow", "disable", "dependabot.lock.yml"]],
      ["gh", ["workflow", "disable", "dependabot-update-planner.lock.yml"]],
    ]);
    assert.deepEqual(enabled, {
      command: "enable",
      campaigns: ["repo-assist", "dependabot"],
      workflows: [
        "repo-assist",
        "repo-assist-issue-triage",
        "repo-assist-maintenance",
        "dependabot",
        "dependabot-update-planner",
      ],
    });
    assert.equal(disabled.command, "disable");
  } finally {
    process.chdir(previousDirectory);
    await rm(root, { recursive: true, force: true });
  }
});

test("cao enable and disable validate campaigns and report workflow failures", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "cao-workflow-state-errors-"));
  const previousDirectory = process.cwd();
  const declarationDirectory = path.join(root, "dependabot");
  try {
    await mkdir(declarationDirectory, { recursive: true });
    await writeFile(path.join(declarationDirectory, "cao.json"), JSON.stringify({
      campaign: "dependabot",
      orchestrator: "dependabot",
      workers: { planner: "dependabot-planner" },
    }));
    process.chdir(root);

    await assert.rejects(
      setCaoCampaignWorkflowsEnabled("enable", ["missing"]),
      /Campaign missing is not installed or does not declare CAO workflows/,
    );
    await assert.rejects(
      setCaoCampaignWorkflowsEnabled("disable", ["Not-A-Campaign"]),
      /Invalid CAO campaign name: Not-A-Campaign/,
    );
    await assert.rejects(
      setCaoCampaignWorkflowsEnabled("enable", ["dependabot"], {
        execute: (_command, arguments_) => arguments_.at(-1) === "dependabot-planner.lock.yml"
          ? { status: 1, stdout: "", stderr: "workflow unavailable" }
          : { status: 0, stdout: "", stderr: "" },
      }),
      /gh workflow enable failed for dependabot-planner: workflow unavailable/,
    );
    await assert.rejects(
      setCaoCampaignWorkflowsEnabled("enable", []),
      /cao enable requires at least one campaign/,
    );
  } finally {
    process.chdir(previousDirectory);
    await rm(root, { recursive: true, force: true });
  }
});

test("cao add installs a campaign and merges its declaration safely", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "cao-add-"));
  const previousDirectory = process.cwd();
  const policyPath = path.join(root, ".github", "workflows", "cao.json");
  const declarationDirectory = path.join(root, "dependabot");
  const calls = [];
  try {
    await mkdir(declarationDirectory, { recursive: true });
    await writeFile(path.join(declarationDirectory, "cao.json"), JSON.stringify({
      campaign: "dependabot",
      orchestrator: "dependabot",
      workers: {
        "release-train-updater": "dependabot-release-train-updater",
      },
    }));
    await mkdir(path.dirname(policyPath), { recursive: true });
    await writeFile(policyPath, `${JSON.stringify({
      version: 1,
      "gh-aw-version": "v0.89.17",
      "control-plane": {
        scope: { "allowed-owners": ["acme"] },
        campaigns: {
          existing: { mode: "review" },
          dependabot: {
            mode: "review",
            workers: {
              "release-train-updater": {
                workflow: "old-workflow",
                enabled: false,
                "max-mode": "review",
              },
              stale: { workflow: "stale-worker" },
            },
          },
        },
      },
    }, null, 2)}\n`);
    process.chdir(root);
    const result = await addCaoCampaign(
      "githubnext/gh-aw-cao/dependabot@feature/config",
      ["--force", "--no-security-scanner"],
      {
        policyPath,
        execute(command, arguments_) {
          calls.push([command, arguments_]);
          return { status: 0, stdout: "", stderr: "" };
        },
      },
    );
    const policy = JSON.parse(await readFile(policyPath, "utf8"));
    assert.deepEqual(calls, [
      [
        "gh",
        ["aw", "add", "githubnext/gh-aw-cao/dependabot@feature/config", "--force", "--no-security-scanner"],
      ],
      [
        process.execPath,
        [path.join(".github", "workflows", "shared", "materialize-cao.mjs"), "materialize", "dependabot"],
      ],
    ]);
    assert.equal(policy["control-plane"].scope["allowed-owners"][0], "acme");
    assert.deepEqual(policy["control-plane"].campaigns.existing, { mode: "review" });
    assert.deepEqual(policy["control-plane"].campaigns.dependabot, {
      mode: "review",
      workers: {
        "release-train-updater": {
          workflow: "dependabot-release-train-updater",
          enabled: false,
          "max-mode": "review",
        },
      },
    });
    assert.equal(result.orchestrator, "dependabot");
  } finally {
    process.chdir(previousDirectory);
    await rm(root, { recursive: true, force: true });
  }
});

test("cao add without a policy initializes it for the current repository before merging", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "cao-add-new-policy-"));
  const previousDirectory = process.cwd();
  const policyPath = path.join(root, ".github", "workflows", "cao.json");
  const calls = [];
  try {
    await mkdir(path.join(root, "dependabot"), { recursive: true });
    await writeFile(path.join(root, "dependabot", "cao.json"), JSON.stringify({
      campaign: "dependabot",
      orchestrator: "dependabot",
      workers: { "release-train-updater": "dependabot-release-train-updater" },
    }));
    process.chdir(root);
    await addCaoCampaign("githubnext/gh-aw-cao/dependabot@v1", [], {
      policyPath,
      execute(command, arguments_) {
        calls.push([command, arguments_]);
        if (command === "gh" && arguments_.join(" ") === "aw version") return versionResult;
        if (command === "gh" && arguments_[0] === "repo") {
          assert.deepEqual(arguments_, repositoryLookup);
          return { status: 0, stdout: "acme/control\n", stderr: "" };
        }
        return { status: 0, stdout: "", stderr: "" };
      },
    });
    assert.deepEqual(calls.map(([command, arguments_]) => [command, arguments_[0]]), [
      ["gh", "aw"],
      [process.execPath, path.join(".github", "workflows", "shared", "materialize-cao.mjs")],
      ["gh", "aw"],
      ["gh", "repo"],
    ]);
    assert.deepEqual(JSON.parse(await readFile(policyPath, "utf8"))["control-plane"], {
      scope: { "allowed-owners": ["acme"], "allowed-repositories": ["acme/control"] },
      campaigns: {
        dependabot: { workers: { "release-train-updater": { workflow: "dependabot-release-train-updater" } } },
      },
    });
  } finally {
    process.chdir(previousDirectory);
    await rm(root, { recursive: true, force: true });
  }
});

test("cao add leaves policy untouched when gh aw add fails", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "cao-add-failure-"));
  const policyPath = path.join(root, "cao.json");
  await writeFile(policyPath, '{"version":1}\n');
  try {
    await assert.rejects(
      addCaoCampaign("githubnext/gh-aw-cao/dependabot@v1", [], {
        policyPath,
        execute: () => ({ status: 1, stdout: "", stderr: "installation failed" }),
      }),
      /gh aw add failed: installation failed/,
    );
    assert.equal(await readFile(policyPath, "utf8"), '{"version":1}\n');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("cao add rejects the root package before modifying gh-aw records", async () => {
  const calls = [];
  await assert.rejects(
    addCaoCampaign("githubnext/gh-aw-cao@v1", [], {
      execute(command, arguments_) {
        calls.push([command, arguments_]);
        return versionResult;
      },
    }),
    /cao add cannot install the CAO root package; use install\.sh/,
  );
  assert.deepEqual(calls, []);
});

test("cao update upgrades gh-aw, updates installed campaigns, and merges declarations", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "cao-update-"));
  const previousDirectory = process.cwd();
  const policyPath = path.join(root, ".github", "workflows", "cao.json");
  const campaignRecords = path.join(root, ".github", "aw", "packages");
  const declarationDirectory = path.join(root, "dependabot");
  const calls = [];
  let versionCalls = 0;
  try {
    await mkdir(campaignRecords, { recursive: true });
    await writeFile(path.join(campaignRecords, "root.json"), JSON.stringify({
      schemaVersion: 1,
      package: "githubnext/gh-aw-cao",
      source: "githubnext/gh-aw-cao@aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      resolvedCommit: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      files: [],
    }));
    await writeFile(path.join(campaignRecords, "dependabot.json"), JSON.stringify({
      schemaVersion: 1,
      package: "githubnext/gh-aw-cao/dependabot",
      source: "githubnext/gh-aw-cao/dependabot@aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      resolvedCommit: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      files: [
        { destination: ".github/workflows/cao-activity.yml", sha256: "old" },
        { destination: ".github/workflows/cao-dashboard.yml", sha256: "old" },
        { destination: ".github/workflows/dependabot.md", sha256: "old" },
      ],
    }));
    await mkdir(declarationDirectory, { recursive: true });
    await mkdir(path.join(root, ".github", "workflows"), { recursive: true });
    for (const workflow of ["activity", "dashboard"]) {
      await writeFile(
        path.join(root, ".github", "workflows", `cao-${workflow}.yml`),
        `jobs:\n  build:\n    steps:\n      - name: Checkout trusted ${workflow} source\n        uses: actions/checkout@0123456789012345678901234567890123456789\n        with:\n          ref: \${{ github.workflow_sha }}\n          persist-credentials: false\n      - name: Next step\n        run: true\n`,
      );
    }
    await writeFile(
      path.join(root, ".github", "workflows", "dependabot.md"),
      "---\nsource: githubnext/gh-aw-cao/dependabot@aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\n---\n\n# Dependabot\n",
    );
    await writeFile(path.join(declarationDirectory, "cao.json"), JSON.stringify({
      campaign: "dependabot",
      orchestrator: "dependabot",
      workers: {
        "release-train-updater": "dependabot-release-train-updater",
        "security-auditor": "dependabot-security-auditor",
      },
    }));
    await mkdir(path.dirname(policyPath), { recursive: true });
    await writeFile(policyPath, `${JSON.stringify({
      version: 1,
      "gh-aw-version": "v0.89.17",
      "control-plane": {
        campaigns: {
          dependabot: {
            mode: "live",
            workers: {
              "release-train-updater": {
                workflow: "old-release-train-updater",
                enabled: false,
                "max-mode": "review",
              },
              stale: { workflow: "stale-worker" },
            },
          },
        },
      },
    }, null, 2)}\n`);
    process.chdir(root);
    const result = await updateCaoCampaigns(["--force"], {
      policyPath,
      execute(command, arguments_) {
        calls.push([command, arguments_]);
        if (command === "gh" && arguments_[0] === "aw" && arguments_[1] === "version") {
          versionCalls += 1;
          return {
            status: 0,
            stdout: versionCalls === 1 ? "gh aw version v0.88.0\n" : "gh aw version v0.89.17\n",
            stderr: "",
          };
        }
        if (command === "gh" && arguments_[0] === "api") {
          if (arguments_[1] === "/repos/githubnext/gh-aw-cao/commits/v0.0.2") {
            return { status: 0, stdout: "1234567890abcdef1234567890abcdef12345678\n", stderr: "" };
          }
          if (arguments_[1] === "/repos/githubnext/gh-aw-cao/releases/tags/v0.0.1") {
            return { status: 0, stdout: "v0.0.1\n", stderr: "" };
          }
          return { status: 0, stdout: "v0.0.1\n", stderr: "" };
        }
        if (command === "gh" && arguments_[0] === "aw" && arguments_[1] === "update"
          && arguments_[2] === "https://github.com/githubnext/gh-aw-cao") {
          writeFileSync(path.join(campaignRecords, "root.json"), JSON.stringify({
            schemaVersion: 1,
            package: "githubnext/gh-aw-cao",
            source: "githubnext/gh-aw-cao@v0.0.2",
            resolvedCommit: "1234567890abcdef1234567890abcdef12345678",
            files: [
              { destination: ".github/workflows/cao-activity.yml", sha256: "old" },
              { destination: ".github/workflows/cao-dashboard.yml", sha256: "old" },
            ],
          }));
        }
        return { status: 0, stdout: "", stderr: "" };
      },
    });
    const policy = JSON.parse(await readFile(policyPath, "utf8"));
    assert.deepEqual(calls, [
      ["gh", ["aw", "version"]],
      ["bash", ["-c", "curl --fail --silent --show-error --location https://raw.githubusercontent.com/github/gh-aw/main/install-gh-aw.sh | bash -s -- \"$1\"", "cao-gh-aw-install", "v0.89.17"]],
      ["gh", ["aw", "version"]],
      ["gh", ["api", "--paginate", "/repos/githubnext/gh-aw-cao/tags", "--jq", ".[] | select(.commit.sha == \"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\") | .name"]],
      ["gh", ["api", "/repos/githubnext/gh-aw-cao/releases/tags/v0.0.1", "--jq", "select(.draft == false and .prerelease == false) | .tag_name"]],
      ["gh", ["aw", "update", "https://github.com/githubnext/gh-aw-cao", "--force"]],
      [process.execPath, [path.join(".github", "workflows", "shared", "materialize-cao.mjs"), "materialize", "root"]],
      ["gh", ["aw", "update", "https://github.com/githubnext/gh-aw-cao/dependabot", "--force"]],
      [process.execPath, [path.join(".github", "workflows", "shared", "materialize-cao.mjs"), "materialize", "dependabot"]],
    ]);
    assert.deepEqual(result.campaigns, [
      "githubnext/gh-aw-cao",
      "githubnext/gh-aw-cao/dependabot",
    ]);
    assert.deepEqual(result.declarations, ["dependabot"]);
    assert.equal(result["gh-aw"].updated, true);
    assert.match(
      await readFile(path.join(root, ".github", "workflows", "dependabot.md"), "utf8"),
      /source: githubnext\/gh-aw-cao\/dependabot@v0\.0\.1/,
    );
    assert.deepEqual(policy["control-plane"].campaigns.dependabot, {
      mode: "live",
      workers: {
        "release-train-updater": {
          workflow: "dependabot-release-train-updater",
          enabled: false,
          "max-mode": "review",
        },
        "security-auditor": {
          workflow: "dependabot-security-auditor",
        },
      },
    });
  } finally {
    process.chdir(previousDirectory);
    await rm(root, { recursive: true, force: true });
  }
});

test("cao update uses current package records and validates the release commit", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "cao-update-package-record-"));
  const previousDirectory = process.cwd();
  const policyPath = path.join(root, ".github", "workflows", "cao.json");
  const packageRecords = path.join(root, ".github", "aw", "packages");
  try {
    await mkdir(packageRecords, { recursive: true });
    await writeFile(path.join(packageRecords, "root.json"), JSON.stringify({
      schemaVersion: 1,
      package: "githubnext/gh-aw-cao",
      source: "githubnext/gh-aw-cao@v1",
      resolvedCommit: "not-a-commit",
      files: [],
    }));
    await mkdir(path.dirname(policyPath), { recursive: true });
    await writeFile(policyPath, '{"version":1,"gh-aw-version":"v0.89.17","control-plane":{"campaigns":{}}}\n');
    process.chdir(root);

    await assert.rejects(
      updateCaoCampaigns([], {
        policyPath,
        execute: () => versionResult,
      }),
      /must contain a full resolvedCommit SHA: not-a-commit/,
    );
  } finally {
    process.chdir(previousDirectory);
    await rm(root, { recursive: true, force: true });
  }
});

test("cao update rejects legacy campaign records without immutable provenance", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "cao-update-legacy-record-"));
  const previousDirectory = process.cwd();
  const policyPath = path.join(root, ".github", "workflows", "cao.json");
  const campaignRecords = path.join(root, ".github", "aw", "campaigns");
  const installedCommit = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
  try {
    await mkdir(campaignRecords, { recursive: true });
    await writeFile(path.join(campaignRecords, "root.json"), JSON.stringify({
      campaign: "githubnext/gh-aw-cao",
      source: `githubnext/gh-aw-cao@${installedCommit}`,
      files: [],
    }));
    await mkdir(path.dirname(policyPath), { recursive: true });
    await writeFile(policyPath, '{"version":1,"gh-aw-version":"v0.89.17","control-plane":{"campaigns":{}}}\n');
    process.chdir(root);

    await assert.rejects(
      updateCaoCampaigns([], {
        policyPath,
        execute: () => versionResult,
      }),
      /must contain a full resolvedCommit SHA: \(missing\)/,
    );
  } finally {
    process.chdir(previousDirectory);
    await rm(root, { recursive: true, force: true });
  }
});

test("cao update advances a prerelease without forwarding its CAO flag", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "cao-update-prerelease-"));
  const previousDirectory = process.cwd();
  const policyPath = path.join(root, ".github", "workflows", "cao.json");
  const packageRecords = path.join(root, ".github", "aw", "packages");
  const calls = [];
  try {
    await mkdir(packageRecords, { recursive: true });
    await writeFile(path.join(packageRecords, "root.json"), JSON.stringify({
      schemaVersion: 1,
      package: "githubnext/gh-aw-cao",
      source: "githubnext/gh-aw-cao@v0.0.2-rc.1",
      resolvedCommit: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
      files: [],
    }));
    await mkdir(path.dirname(policyPath), { recursive: true });
    await writeFile(policyPath, '{"version":1,"gh-aw-version":"v0.89.17","control-plane":{"campaigns":{}}}\n');
    process.chdir(root);
    let preparedSource;

    await updateCaoCampaigns(["--pre-releases", "--force"], {
      policyPath,
      execute(command, arguments_) {
        calls.push([command, arguments_]);
        if (arguments_[0] === "aw" && arguments_[1] === "version") return versionResult;
        if (arguments_[2] === "/repos/githubnext/gh-aw-cao/releases?per_page=100") {
          return { status: 0, stdout: "v0.0.2-rc.1\nv0.0.2-rc.2\nv1.0.0-rc.1\n", stderr: "" };
        }
        if (arguments_[0] === "aw" && arguments_[1] === "update") {
          preparedSource = JSON.parse(readFileSync(path.join(packageRecords, "root.json"), "utf8")).source;
        }
        if (arguments_[1] === "/repos/githubnext/gh-aw-cao/commits/v0.0.2-rc.1") {
          return { status: 0, stdout: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb\n", stderr: "" };
        }
        return { status: 0, stdout: "", stderr: "" };
      },
    });

    assert.deepEqual(calls.find(([, arguments_]) => arguments_[0] === "aw" && arguments_[1] === "update"), [
      "gh",
      ["aw", "update", "https://github.com/githubnext/gh-aw-cao", "--force"],
    ]);
    assert.equal(preparedSource, "githubnext/gh-aw-cao@v0.0.2-rc.2");
  } finally {
    process.chdir(previousDirectory);
    await rm(root, { recursive: true, force: true });
  }
});

test("cao update leaves current gh-aw versions that meet the minimum in place", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "cao-update-gh-aw-current-"));
  const policyPath = path.join(root, "cao.json");
  const calls = [];
  try {
    await writeFile(policyPath, '{"version":1,"gh-aw-version":"v0.89.17","control-plane":{"campaigns":{}}}\n');
    const result = await ensureGhAwMinimumVersion({
      policyPath,
      execute(command, arguments_) {
        calls.push([command, arguments_]);
        return { status: 0, stdout: "gh aw version v0.90.0\n", stderr: "" };
      },
    });
    assert.deepEqual(calls, [["gh", ["aw", "version"]]]);
    assert.deepEqual(result, {
      required: "v0.89.17",
      previous: "v0.90.0",
      current: "v0.90.0",
      updated: false,
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
