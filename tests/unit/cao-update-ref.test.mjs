import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { runCli, updateCaoCampaigns } from "../../activity/cao.mjs";
import { USAGE } from "../../activity/cli-usage.mjs";

const oldCommit = "a".repeat(40);
const commit = "b".repeat(40);
const catalog = "githubnext/gh-aw-cao";
const ok = { status: 0, stdout: "", stderr: "" };

async function withInstallation(run) {
  const root = await mkdtemp(path.join(os.tmpdir(), "cao-update-ref-"));
  const previousDirectory = process.cwd();
  const records = path.join(root, ".github", "aw", "packages");
  const policyPath = path.join(root, ".github", "workflows", "cao.json");
  const policy = {
    version: 1,
    "gh-aw-version": "v0.89.22",
    "control-plane": {
      scope: { "allowed-repositories": ["acme/control"] },
      campaigns: {
        dependabot: {
          mode: "live",
          enabled: false,
          workers: { planner: { workflow: "old-planner", enabled: false, "max-mode": "review" } },
        },
      },
    },
  };
  const recordPaths = new Map();
  try {
    await mkdir(records, { recursive: true });
    await mkdir(path.dirname(policyPath), { recursive: true });
    await writeFile(policyPath, JSON.stringify(policy));
    for (const [name, packageName] of [
      ["root", catalog], ["dependabot", `${catalog}/dependabot`], ["unrelated", "acme/other"],
    ]) {
      const recordPath = path.join(records, `${name}.json`);
      recordPaths.set(packageName, recordPath);
      await writeFile(recordPath, JSON.stringify({
        schemaVersion: 1, package: packageName, source: `${packageName}@${oldCommit}`,
        resolvedCommit: oldCommit, files: [],
      }));
    }
    process.chdir(root);
    const calls = [];
    const execute = (command, args) => {
      calls.push([command, args]);
      if (command === "gh" && args.join(" ") === "aw version") {
        return { ...ok, stderr: "gh aw version v0.89.22\n" };
      }
      if (command === "gh" && args[0] === "api") {
        assert.deepEqual(args.slice(0, 3), ["api", "--hostname", "github.com"]);
        assert.match(args[3], /^\/repos\/githubnext\/gh-aw-cao\/commits\/(?:main|b{7,40})$/i);
        assert.deepEqual(args.slice(4), ["--jq", ".sha"]);
        return { ...ok, stdout: `${commit}\n` };
      }
      if (command === "gh" && args[0] === "aw" && args[1] === "add") {
        const packageName = args[2].split("@")[0];
        assert.ok(recordPaths.has(packageName));
        assert.equal(args[2], `${packageName}@${commit}`);
        assert.equal(args[3], "--force");
        const recordPath = recordPaths.get(packageName);
        const record = JSON.parse(readFileSync(recordPath, "utf8"));
        // The caller must not rewrite provenance to trick gh-aw into selecting a ref.
        assert.equal(record.source, `${packageName}@${oldCommit}`);
        writeFileSync(recordPath, JSON.stringify({
          ...record, source: `${packageName}@${commit}`, resolvedCommit: commit,
        }));
        return ok;
      }
      if (command === process.execPath) {
        assert.deepEqual(args.slice(0, 2), [
          path.join(".github", "workflows", "shared", "materialize-cao.mjs"), "materialize",
        ]);
        const packageName = args[2] === "root" ? catalog : `${catalog}/${args[2]}`;
        assert.equal(JSON.parse(readFileSync(recordPaths.get(packageName), "utf8")).resolvedCommit, commit);
        if (args[2] === "dependabot") {
          writeFileSync(path.join(root, "dependabot", "cao.json"), JSON.stringify({
            campaign: "dependabot", orchestrator: "dependabot", workers: { planner: "new-planner" },
          }));
        }
        return ok;
      }
      assert.fail(`Unexpected command: ${command} ${args.join(" ")}`);
    };
    await mkdir(path.join(root, "dependabot"));
    await run({ execute, calls, policy, policyPath, recordPaths });
  } finally {
    process.chdir(previousDirectory);
    await rm(root, { recursive: true, force: true });
  }
}

for (const ref of ["main", commit, commit.slice(0, 7).toUpperCase()]) {
  test(`cao update ${ref} reapplies only installed CAO packages at one immutable revision`, async () => {
    await withInstallation(async ({ execute, calls, policy, policyPath, recordPaths }) => {
      const options = [ref, "--engine", "copilot", "--dir=.github/workflows"];
      const result = await updateCaoCampaigns(options, { execute });
      assert.equal(result.ref, ref);
      assert.equal(result.resolvedCommit, commit);
      assert.deepEqual(result.campaigns, [catalog, `${catalog}/dependabot`]);
      assert.deepEqual(result.declarations, ["dependabot"]);
      assert.equal(calls.filter(([, args]) => args[0] === "api").length, 1);
      assert.deepEqual(calls.map(([command, args]) => command === "gh" ? args[1] : args[2]),
        ["version", "--hostname", "add", "root", "add", "dependabot"]);
      for (const [, args] of calls.filter(([, args]) => args[1] === "add")) {
        assert.deepEqual(args.slice(4), args[2] === `${catalog}@${commit}`
          ? ["--no-security-scanner", ...options.slice(1)]
          : options.slice(1));
      }
      policy["control-plane"].campaigns.dependabot.workers.planner.workflow = "new-planner";
      assert.deepEqual(JSON.parse(await readFile(policyPath, "utf8")), policy);
      assert.equal(JSON.parse(await readFile(recordPaths.get("acme/other"), "utf8")).resolvedCommit, oldCommit);
      assert.equal(options[0], ref);
    });
  });
}

for (const args of [
  ["develop"], ["abc123"], ["b".repeat(41)], ["../main"],
  ["main", "--pre-releases"], ["main", "--major"], ["main", "--cool-down", "0"],
  ["main", "acme/other"], ["main", "--dir"], ["main", "--engine", "--force"],
]) {
  test(`cao update rejects ${args.join(" ")} before any side effects`, async () => {
    await assert.rejects(updateCaoCampaigns(args, {
      execute() { assert.fail("must reject before executing commands"); },
    }), /cao update requires|Unsupported option|requires a value/);
  });
}

for (const [name, ref, result, message] of [
  ["API failure", "main", { status: 1, stderr: "not found" }, /Unable to resolve CAO ref main: not found/],
  ["invalid API SHA", "main", { ...ok, stdout: "main\n" }, /expected a matching full commit SHA/],
  ["different commit", commit, { ...ok, stdout: oldCommit }, /expected a matching full commit SHA/],
]) {
  test(`cao update stops before replacing packages on ${name}`, async () => {
    await withInstallation(async ({ execute, calls, policy, policyPath }) => {
      await assert.rejects(updateCaoCampaigns([ref], {
        execute(command, args) {
          return args[0] === "api" ? result : execute(command, args);
        },
      }), message);
      assert.equal(calls.length, 1);
      assert.deepEqual(JSON.parse(await readFile(policyPath, "utf8")), policy);
    });
  });
}

for (const [name, result, message] of [
  ["failed add", { status: 1, stderr: "install failed" }, /gh aw add failed.*install failed/],
  ["stale ownership record", ok, /did not record requested commit.*refusing to materialize/],
]) {
  test(`cao update refuses materialization after ${name}`, async () => {
    await withInstallation(async ({ execute, calls, policy, policyPath }) => {
      await assert.rejects(updateCaoCampaigns(["main"], {
        execute(command, args) {
          return args[1] === "add" ? result : execute(command, args);
        },
      }), message);
      assert.equal(calls.length, 2);
      assert.deepEqual(JSON.parse(await readFile(policyPath, "utf8")), policy);
    });
  });
}

test("cao CLI forwards the update ref to validation and advertises it in help", async () => {
  await assert.rejects(runCli(["update", "not-a-ref"]), /cao update requires main or a commit SHA/);
  assert.match(USAGE, /cao update \(main\|COMMIT_SHA\)/);
});
