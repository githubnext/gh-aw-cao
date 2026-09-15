import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import test from "node:test";
import { readGhAwLogShards } from "../../activity/gh-aw-logs.mjs";

const execFileAsync = promisify(execFile);

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "activity-logs-"));
  const workflowDirectory = path.join(root, ".github", "workflows");
  const bin = path.join(root, "bin");
  await mkdir(workflowDirectory, { recursive: true });
  await mkdir(bin);
  await writeFile(path.join(workflowDirectory, "sample.lock.yml"), "name: Sample\n");
  return {
    root,
    bin,
    logsPath: path.join(root, "cache", "gh-aw-logs-shards"),
    statePath: path.join(root, "cache", "gh-aw-logs-state.json"),
    outputPath: path.join(root, "cache", "gh-aw-logs"),
    argumentsPath: path.join(root, "arguments.json"),
    controlSettingsPath: path.join(root, "control-settings.json"),
    githubOutput: path.join(root, "github-output"),
  };
}

test("activity logs collects and consolidates owned runs from every configured repository", async () => {
  const item = await fixture();
  const ghPath = path.join(item.bin, "gh");
  await writeFile(ghPath, `#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
const args = process.argv.slice(2);
fs.appendFileSync(process.env.GH_ARGS_PATH, JSON.stringify(args) + "\\n");
const repository = args[args.indexOf("--repo") + 1];
const shardPattern = args[args.indexOf("--cached-logs") + 1];
const shardPath = shardPattern.replace(/\\*$/, "") + "fixture.jsonl";
fs.mkdirSync(path.dirname(shardPath), { recursive: true });
fs.writeFileSync(shardPath, JSON.stringify({ schema_version: 2, kind: "run", run: {
   database_id: repository === "githubnext/gh-aw-cao" ? 42 : 43,
   repository,
   workflow_path:".github/workflows/sample.lock.yml",
   status:"completed"
  } }) + "\\n");
process.stderr.write("Fetched 1 run\\n");
`);
  await chmod(ghPath, 0o755);
  await writeFile(item.controlSettingsPath, JSON.stringify({
    allowed_repositories: ["github/gh-aw", "githubnext/gh-aw-cao"]
  }));
  try {
    const env = {
      ...process.env,
      PATH: `${item.bin}:${process.env.PATH}`,
      GITHUB_REPOSITORY: "githubnext/gh-aw-cao",
      REPORT_ROOT: item.root,
      REPORT_GH_AW_LOGS_SHARDS: item.logsPath,
      REPORT_GH_AW_LOGS_STATE: item.statePath,
      REPORT_GH_AW_LOGS_EXIT_CODE: path.join(item.root, "cache", "gh-aw-logs-exit-code"),
      REPORT_AIC_CACHE: item.outputPath,
      REPORT_CONTROL_SETTINGS: item.controlSettingsPath,
      GH_ARGS_PATH: item.argumentsPath,
      GITHUB_OUTPUT: item.githubOutput,
    };
    const collection = await execFileAsync("bash", [path.resolve("activity/collect-logs.sh")], { env });
    const { stdout } = await execFileAsync(process.execPath, [path.resolve("activity/logs.mjs")], { env });
    const invocations = (await readFile(item.argumentsPath, "utf8")).trim().split("\n").map(JSON.parse);
    assert.equal(invocations.length, 2);
    const args = invocations[0];
    assert.deepEqual(args.slice(0, 3), ["aw", "logs", "--audit"]);
    assert.equal(args.includes("--json"), false);
    assert.deepEqual(args.slice(args.indexOf("--artifacts"), args.indexOf("--artifacts") + 2), [
      "--artifacts",
      "usage",
    ]);
    assert.equal(args.filter((value) => value === "--prune-older-runs").length, 1);
    const shardPrefix = path.join(item.root, "cache", "gh-aw-logs-shards", "github-gh-aw-logs-");
    assert.deepEqual(args.slice(args.indexOf("--cached-logs"), args.indexOf("--cached-logs") + 2), [
      "--cached-logs",
      `${shardPrefix}*`,
    ]);
    assert.equal(args.filter((value) => value === "logs").length, 1);
    assert.deepEqual(args.slice(args.indexOf("--count"), args.indexOf("--count") + 2), ["--count", "10"]);
    assert.deepEqual(args.slice(args.indexOf("--timeout"), args.indexOf("--timeout") + 2), ["--timeout", "10"]);
    assert.deepEqual(invocations.map((invocation) => invocation[invocation.indexOf("--repo") + 1]), [
      "github/gh-aw",
      "githubnext/gh-aw-cao",
    ]);
    const runs = await readGhAwLogShards(item.logsPath);
    assert.deepEqual(runs.map((run) => run.repository), [
      "github/gh-aw",
      "githubnext/gh-aw-cao",
    ]);
    const state = JSON.parse(await readFile(item.statePath, "utf8"));
    assert.equal(state.available, true);
    assert.equal(state.complete, true);
    assert.equal(Object.hasOwn(state, "jobDetails"), false);
    assert.equal(await readFile(item.githubOutput, "utf8"), "collection-outcome=success\n");
    assert.equal(collection.stderr.match(/Fetched 1 run/g)?.length, 2);
    assert.match(stdout, /Collected snapshot with 2 runs across 1 workflow/);
  } finally {
    await rm(item.root, { recursive: true, force: true });
  }
});

test("activity logs preserves cached runs and records collection failure", async () => {
  const item = await fixture();
  const ghPath = path.join(item.bin, "gh");
  await writeFile(ghPath, "#!/usr/bin/env node\nprocess.stderr.write('download failed\\n');process.exit(1);\n");
  await chmod(ghPath, 0o755);
  await mkdir(item.logsPath, { recursive: true });
  await writeFile(path.join(item.logsPath, "fixture.jsonl"), '{"schema_version":2,"kind":"run","run":{"database_id":7}}\n');
  await writeFile(item.statePath, '{"observedAt":"2026-09-06T20:00:00Z","available":true}\n');
  await writeFile(path.join(item.root, "cache", "gh-aw-logs-exit-code"), "1\n");
  try {
    await execFileAsync(process.execPath, [path.resolve("activity/logs.mjs")], {
      env: {
        ...process.env,
        PATH: `${item.bin}:${process.env.PATH}`,
        GITHUB_REPOSITORY: "githubnext/gh-aw-cao",
        REPORT_ROOT: item.root,
        REPORT_GH_AW_LOGS_SHARDS: item.logsPath,
        REPORT_GH_AW_LOGS_STATE: item.statePath,
        REPORT_GH_AW_LOGS_EXIT_CODE: path.join(item.root, "cache", "gh-aw-logs-exit-code"),
        REPORT_AIC_CACHE: item.outputPath,
        GITHUB_OUTPUT: item.githubOutput,
      },
    });

    assert.equal((await readGhAwLogShards(item.logsPath))[0].database_id, 7);
    const state = JSON.parse(await readFile(item.statePath, "utf8"));
    assert.equal(state.available, false);
    assert.equal(state.fallback, true);
    assert.equal(state.snapshotObservedAt, "2026-09-06T20:00:00Z");
    assert.equal(await readFile(item.githubOutput, "utf8"), "collection-outcome=failure\n");
  } finally {
    await rm(item.root, { recursive: true, force: true });
  }
});

test("activity logs does not invoke the GitHub API when gh aw logs fails", async () => {
  const item = await fixture();
  const ghPath = path.join(item.bin, "gh");
  const invocationPath = path.join(item.root, "unexpected-gh-invocation");
  await writeFile(ghPath, `#!/usr/bin/env node
require("node:fs").writeFileSync(process.env.GH_INVOCATION_PATH, process.argv.slice(2).join(" "));
process.exit(99);
`);
  await chmod(ghPath, 0o755);
  await mkdir(item.logsPath, { recursive: true });
  await writeFile(path.join(item.logsPath, "fixture.jsonl"), '{"schema_version":2,"kind":"run","run":{"database_id":42,"failure_message":"cached detail"}}\n');
  await writeFile(item.statePath, '{"observedAt":"2026-09-06T20:00:00Z","available":true}\n');
  await writeFile(path.join(item.root, "cache", "gh-aw-logs-exit-code"), "1\n");
  try {
    await execFileAsync(process.execPath, [path.resolve("activity/logs.mjs")], {
      env: {
        ...process.env,
        PATH: `${item.bin}:${process.env.PATH}`,
        GITHUB_REPOSITORY: "githubnext/gh-aw-cao",
        REPORT_ROOT: item.root,
        REPORT_GH_AW_LOGS_SHARDS: item.logsPath,
        REPORT_GH_AW_LOGS_STATE: item.statePath,
        REPORT_GH_AW_LOGS_EXIT_CODE: path.join(item.root, "cache", "gh-aw-logs-exit-code"),
        REPORT_AIC_CACHE: item.outputPath,
        GITHUB_OUTPUT: item.githubOutput,
        GH_INVOCATION_PATH: invocationPath,
      },
    });

    assert.equal((await readGhAwLogShards(item.logsPath))[0].failure_message, "cached detail");
    const state = JSON.parse(await readFile(item.statePath, "utf8"));
    assert.equal(state.available, false);
    assert.equal(state.complete, false);
    assert.equal(Object.hasOwn(state, "actionsEnrichment"), false);
    await assert.rejects(readFile(invocationPath), { code: "ENOENT" });
    assert.equal(await readFile(item.githubOutput, "utf8"), "collection-outcome=failure\n");
  } finally {
    await rm(item.root, { recursive: true, force: true });
  }
});

test("activity logs records a failure when workflow discovery is unavailable", async () => {
  const item = await fixture();
  await rm(path.join(item.root, ".github"), { recursive: true });
  await mkdir(item.logsPath, { recursive: true });
  await writeFile(path.join(item.logsPath, "fixture.jsonl"), '{"schema_version":2,"kind":"run","run":{"database_id":7}}\n');
  await writeFile(item.statePath, '{"observedAt":"2026-09-06T20:00:00Z","available":true}\n');
  await writeFile(path.join(item.root, "cache", "gh-aw-logs-exit-code"), "1\n");
  try {
    await execFileAsync(process.execPath, [path.resolve("activity/logs.mjs")], {
      env: {
        ...process.env,
        GITHUB_REPOSITORY: "githubnext/gh-aw-cao",
        REPORT_ROOT: item.root,
        REPORT_GH_AW_LOGS_SHARDS: item.logsPath,
        REPORT_GH_AW_LOGS_STATE: item.statePath,
        REPORT_GH_AW_LOGS_EXIT_CODE: path.join(item.root, "cache", "gh-aw-logs-exit-code"),
        REPORT_AIC_CACHE: item.outputPath,
        GITHUB_OUTPUT: item.githubOutput,
      },
    });
    const state = JSON.parse(await readFile(item.statePath, "utf8"));
    assert.equal((await readGhAwLogShards(item.logsPath))[0].database_id, 7);
    assert.equal(state.available, false);
    assert.equal(state.targetCount, 0);
    assert.equal(state.fallback, true);
    assert.equal(await readFile(item.githubOutput, "utf8"), "collection-outcome=failure\n");
  } finally {
    await rm(item.root, { recursive: true, force: true });
  }
});
