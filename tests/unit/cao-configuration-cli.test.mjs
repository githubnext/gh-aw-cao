import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  addCaoPackage,
  ensureGhAwMinimumVersion,
  initializeCaoPolicy,
  setCaoPackageMode,
  setCaoPackageWorkflowsEnabled,
  updateCaoPackages,
} from "../../activity/cao.mjs";

const versionResult = {
  status: 0,
  stdout: "gh aw version v0.89.15\n",
  stderr: "",
};

test("cao init writes the minimal control-plane policy", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "cao-init-"));
  const policyPath = path.join(root, ".github", "workflows", "cao.json");
  try {
    const result = await initializeCaoPolicy({
      policyPath,
      execute(command, arguments_) {
        assert.equal(command, "gh");
        assert.deepEqual(arguments_, ["aw", "version"]);
        return versionResult;
      },
    });
    const policy = JSON.parse(await readFile(policyPath, "utf8"));
    assert.deepEqual(policy, {
      $schema: "https://raw.githubusercontent.com/githubnext/gh-aw-cao/main/.github/workflows/shared/cao.schema.json",
      version: 1,
      "gh-aw-version": "v0.89.15",
      "control-plane": { packages: {} },
    });
    assert.equal(result["gh-aw-version"], "v0.89.15");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("cao init does not overwrite an existing policy", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "cao-init-existing-"));
  const policyPath = path.join(root, "cao.json");
  await writeFile(policyPath, '{"version":1}\n');
  try {
    await assert.rejects(
      initializeCaoPolicy({ policyPath, execute: () => versionResult }),
      /cao\.json already exists/,
    );
    assert.equal(await readFile(policyPath, "utf8"), '{"version":1}\n');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("cao mode changes configured packages between live and preview atomically", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "cao-mode-"));
  const policyPath = path.join(root, ".github", "workflows", "cao.json");
  try {
    await mkdir(path.dirname(policyPath), { recursive: true });
    await writeFile(policyPath, `${JSON.stringify({
      version: 1,
      "gh-aw-version": "v0.89.15",
      "control-plane": {
        packages: {
          dependabot: { mode: "review", icon: "dependabot" },
          "repo-assist": { mode: "review", "max-repositories": 1 },
        },
      },
    }, null, 2)}\n`);

    const live = await setCaoPackageMode("live", ["dependabot", "repo-assist"], { policyPath });
    let policy = JSON.parse(await readFile(policyPath, "utf8"));
    assert.equal(policy["control-plane"].packages.dependabot.mode, "live");
    assert.equal(policy["control-plane"].packages.dependabot.icon, "dependabot");
    assert.equal(policy["control-plane"].packages["repo-assist"].mode, "live");
    assert.deepEqual(live.packages, ["dependabot", "repo-assist"]);

    const preview = await setCaoPackageMode("preview", ["dependabot"], { policyPath });
    policy = JSON.parse(await readFile(policyPath, "utf8"));
    assert.equal(policy["control-plane"].packages.dependabot.mode, "review");
    assert.equal(policy["control-plane"].packages["repo-assist"].mode, "live");
    assert.equal(preview.mode, "preview");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("cao mode validates every package before changing the policy", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "cao-mode-invalid-"));
  const policyPath = path.join(root, "cao.json");
  const original = '{"version":1,"gh-aw-version":"v0.89.15","control-plane":{"packages":{"dependabot":{"mode":"review"}}}}\n';
  try {
    await writeFile(policyPath, original);
    await assert.rejects(
      setCaoPackageMode("live", ["dependabot", "missing-package"], { policyPath }),
      /Unknown CAO package: missing-package/,
    );
    assert.equal(await readFile(policyPath, "utf8"), original);

    await assert.rejects(
      setCaoPackageMode("live", ["Not-A-Package"], { policyPath }),
      /Invalid CAO package name: Not-A-Package/,
    );
    await assert.rejects(
      setCaoPackageMode("review", ["dependabot"], { policyPath }),
      /cao mode requires live or preview/,
    );
    await assert.rejects(
      setCaoPackageMode("preview", [], { policyPath }),
      /requires at least one package/,
    );
    assert.equal(await readFile(policyPath, "utf8"), original);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("cao enable and disable update every workflow declared by installed packages", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "cao-workflow-state-"));
  const previousDirectory = process.cwd();
  const declarationDirectory = path.join(root, ".github", "aw", "repo-assist");
  const secondDeclarationDirectory = path.join(root, ".github", "aw", "dependabot");
  const calls = [];
  try {
    await mkdir(declarationDirectory, { recursive: true });
    await writeFile(path.join(declarationDirectory, "cao.json"), JSON.stringify({
      package: "repo-assist",
      orchestrator: "repo-assist",
      workers: {
        "issue-triage": "repo-assist-issue-triage",
        maintenance: "repo-assist-maintenance",
      },
    }));
    await mkdir(secondDeclarationDirectory, { recursive: true });
    await writeFile(path.join(secondDeclarationDirectory, "cao.json"), JSON.stringify({
      package: "dependabot",
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

    const enabled = await setCaoPackageWorkflowsEnabled("enable", ["repo-assist", "dependabot"], { execute });
    const disabled = await setCaoPackageWorkflowsEnabled("disable", ["repo-assist", "dependabot"], { execute });

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
      packages: ["repo-assist", "dependabot"],
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

test("cao enable and disable validate packages and report workflow failures", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "cao-workflow-state-errors-"));
  const previousDirectory = process.cwd();
  const declarationDirectory = path.join(root, ".github", "aw", "dependabot");
  try {
    await mkdir(declarationDirectory, { recursive: true });
    await writeFile(path.join(declarationDirectory, "cao.json"), JSON.stringify({
      package: "dependabot",
      orchestrator: "dependabot",
      workers: { planner: "dependabot-planner" },
    }));
    process.chdir(root);

    await assert.rejects(
      setCaoPackageWorkflowsEnabled("enable", ["missing"]),
      /Package missing is not installed or does not declare CAO workflows/,
    );
    await assert.rejects(
      setCaoPackageWorkflowsEnabled("disable", ["Not-A-Package"]),
      /Invalid CAO package name: Not-A-Package/,
    );
    await assert.rejects(
      setCaoPackageWorkflowsEnabled("enable", ["dependabot"], {
        execute: (_command, arguments_) => arguments_.at(-1) === "dependabot-planner.lock.yml"
          ? { status: 1, stdout: "", stderr: "workflow unavailable" }
          : { status: 0, stdout: "", stderr: "" },
      }),
      /gh workflow enable failed for dependabot-planner: workflow unavailable/,
    );
    await assert.rejects(
      setCaoPackageWorkflowsEnabled("enable", []),
      /cao enable requires at least one package/,
    );
  } finally {
    process.chdir(previousDirectory);
    await rm(root, { recursive: true, force: true });
  }
});

test("cao add installs a package and merges its declaration safely", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "cao-add-"));
  const previousDirectory = process.cwd();
  const policyPath = path.join(root, ".github", "workflows", "cao.json");
  const declarationDirectory = path.join(root, ".github", "aw", "dependabot");
  const calls = [];
  try {
    await mkdir(declarationDirectory, { recursive: true });
    await writeFile(path.join(declarationDirectory, "cao.json"), JSON.stringify({
      package: "dependabot",
      orchestrator: "dependabot",
      workers: {
        "release-train-updater": "dependabot-release-train-updater",
      },
    }));
    await mkdir(path.dirname(policyPath), { recursive: true });
    await writeFile(policyPath, `${JSON.stringify({
      version: 1,
      "gh-aw-version": "v0.89.15",
      "control-plane": {
        scope: { "allowed-owners": ["acme"] },
        packages: {
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
    const result = await addCaoPackage(
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
    assert.deepEqual(calls, [[
      "gh",
      ["aw", "add", "githubnext/gh-aw-cao/dependabot@feature/config", "--force", "--no-security-scanner"],
    ]]);
    assert.equal(policy["control-plane"].scope["allowed-owners"][0], "acme");
    assert.deepEqual(policy["control-plane"].packages.existing, { mode: "review" });
    assert.deepEqual(policy["control-plane"].packages.dependabot, {
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

test("cao add leaves policy untouched when gh aw add fails", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "cao-add-failure-"));
  const policyPath = path.join(root, "cao.json");
  await writeFile(policyPath, '{"version":1}\n');
  try {
    await assert.rejects(
      addCaoPackage("githubnext/gh-aw-cao/dependabot@v1", [], {
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

test("cao update upgrades gh-aw, updates installed packages, and merges declarations", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "cao-update-"));
  const previousDirectory = process.cwd();
  const policyPath = path.join(root, ".github", "workflows", "cao.json");
  const packageRecords = path.join(root, ".github", "aw", "packages");
  const declarationDirectory = path.join(root, ".github", "aw", "dependabot");
  const calls = [];
  let versionCalls = 0;
  try {
    await mkdir(packageRecords, { recursive: true });
    await writeFile(path.join(packageRecords, "root.json"), JSON.stringify({
      package: "githubnext/gh-aw-cao",
      source: "githubnext/gh-aw-cao@v1",
    }));
    await writeFile(path.join(packageRecords, "dependabot.json"), JSON.stringify({
      package: "githubnext/gh-aw-cao/dependabot",
      source: "githubnext/gh-aw-cao/dependabot@v1",
    }));
    await mkdir(declarationDirectory, { recursive: true });
    await writeFile(path.join(declarationDirectory, "cao.json"), JSON.stringify({
      package: "dependabot",
      orchestrator: "dependabot",
      workers: {
        "release-train-updater": "dependabot-release-train-updater",
        "security-auditor": "dependabot-security-auditor",
      },
    }));
    await mkdir(path.dirname(policyPath), { recursive: true });
    await writeFile(policyPath, `${JSON.stringify({
      version: 1,
      "gh-aw-version": "v0.89.15",
      "control-plane": {
        packages: {
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
    const result = await updateCaoPackages(["--force"], {
      policyPath,
      execute(command, arguments_) {
        calls.push([command, arguments_]);
        if (command === "gh" && arguments_[0] === "aw" && arguments_[1] === "version") {
          versionCalls += 1;
          return {
            status: 0,
            stdout: versionCalls === 1 ? "gh aw version v0.88.0\n" : "gh aw version v0.89.15\n",
            stderr: "",
          };
        }
        return { status: 0, stdout: "", stderr: "" };
      },
    });
    const policy = JSON.parse(await readFile(policyPath, "utf8"));
    assert.deepEqual(calls, [
      ["gh", ["aw", "version"]],
      ["bash", ["-c", "curl --fail --silent --show-error --location https://raw.githubusercontent.com/github/gh-aw/main/install-gh-aw.sh | bash -s -- \"$1\"", "cao-gh-aw-install", "v0.89.15"]],
      ["gh", ["aw", "version"]],
      ["gh", ["aw", "update", "githubnext/gh-aw-cao", "--force"]],
      ["gh", ["aw", "update", "githubnext/gh-aw-cao/dependabot", "--force"]],
    ]);
    assert.deepEqual(result.packages, [
      "githubnext/gh-aw-cao",
      "githubnext/gh-aw-cao/dependabot",
    ]);
    assert.deepEqual(result.declarations, ["dependabot"]);
    assert.equal(result["gh-aw"].updated, true);
    assert.deepEqual(policy["control-plane"].packages.dependabot, {
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

test("cao update leaves current gh-aw versions that meet the minimum in place", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "cao-update-gh-aw-current-"));
  const policyPath = path.join(root, "cao.json");
  const calls = [];
  try {
    await writeFile(policyPath, '{"version":1,"gh-aw-version":"v0.89.15","control-plane":{"packages":{}}}\n');
    const result = await ensureGhAwMinimumVersion({
      policyPath,
      execute(command, arguments_) {
        calls.push([command, arguments_]);
        return { status: 0, stdout: "gh aw version v0.90.0\n", stderr: "" };
      },
    });
    assert.deepEqual(calls, [["gh", ["aw", "version"]]]);
    assert.deepEqual(result, {
      required: "v0.89.15",
      previous: "v0.90.0",
      current: "v0.90.0",
      updated: false,
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
