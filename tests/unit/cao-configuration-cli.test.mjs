import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  addCaoPackage,
  initializeCaoPolicy,
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
