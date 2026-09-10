import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import test from "node:test";

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
    logsPath: path.join(root, "cache", "gh-aw-logs.jsonl"),
    statePath: path.join(root, "cache", "gh-aw-logs-state.json"),
    outputPath: path.join(root, "cache", "gh-aw-logs"),
    argumentsPath: path.join(root, "arguments.json"),
    githubOutput: path.join(root, "github-output"),
  };
}

test("activity logs uses one bounded gh aw logs invocation with compact usage artifacts", async () => {
  const item = await fixture();
  const ghPath = path.join(item.bin, "gh");
  await writeFile(ghPath, `#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2);
fs.writeFileSync(process.env.GH_ARGS_PATH, JSON.stringify(args));
fs.writeFileSync(args[args.indexOf("--cached-jsonl") + 1], JSON.stringify({ schema_version: 2, kind: "run", run: {
   database_id:42,
   repository:"githubnext/gh-aw-cao",
   workflow_path:".github/workflows/sample.lock.yml",
   status:"completed"
  } }) + "\\n");
process.stderr.write("Fetched 1 run\\n");
`);
  await chmod(ghPath, 0o755);
  try {
    const env = {
      ...process.env,
      PATH: `${item.bin}:${process.env.PATH}`,
      GITHUB_REPOSITORY: "githubnext/gh-aw-cao",
      REPORT_ROOT: item.root,
      REPORT_GH_AW_LOGS: item.logsPath,
      REPORT_GH_AW_LOGS_STATE: item.statePath,
      REPORT_GH_AW_LOGS_EXIT_CODE: path.join(item.root, "cache", "gh-aw-logs-exit-code"),
      REPORT_AIC_CACHE: item.outputPath,
      GH_ARGS_PATH: item.argumentsPath,
      GITHUB_OUTPUT: item.githubOutput,
    };
    const collection = await execFileAsync("bash", [path.resolve("activity/collect-logs.sh")], { env });
    const { stdout } = await execFileAsync(process.execPath, [path.resolve("activity/logs.mjs")], { env });
    const args = JSON.parse(await readFile(item.argumentsPath, "utf8"));
    assert.deepEqual(args.slice(0, 3), ["aw", "logs", "--audit"]);
    assert.equal(args.includes("--json"), false);
    assert.deepEqual(args.slice(args.indexOf("--artifacts"), args.indexOf("--artifacts") + 2), [
      "--artifacts",
      "usage",
    ]);
    assert.equal(args.filter((value) => value === "--prune-older-runs").length, 1);
    assert.deepEqual(args.slice(args.indexOf("--cached-jsonl"), args.indexOf("--cached-jsonl") + 2), [
      "--cached-jsonl",
      item.logsPath,
    ]);
    assert.equal(args.filter((value) => value === "logs").length, 1);
    assert.deepEqual(args.slice(args.indexOf("--count"), args.indexOf("--count") + 2), ["--count", "10"]);
    assert.deepEqual(args.slice(args.indexOf("--timeout"), args.indexOf("--timeout") + 2), ["--timeout", "10"]);
    assert.equal(args.at(-1), "githubnext/gh-aw-cao/.github/workflows/sample.lock.yml");
    assert.equal(JSON.parse(await readFile(item.logsPath, "utf8")).run.database_id, 42);
    const state = JSON.parse(await readFile(item.statePath, "utf8"));
    assert.equal(state.available, true);
    assert.equal(state.complete, true);
    assert.equal(Object.hasOwn(state, "jobDetails"), false);
    assert.equal(await readFile(item.githubOutput, "utf8"), "collection-outcome=success\n");
    assert.match(collection.stderr, /Fetched 1 run/);
    assert.match(stdout, /Collected snapshot with 1 run across 1 workflow/);
  } finally {
    await rm(item.root, { recursive: true, force: true });
  }
});

test("activity logs preserves cached runs and records collection failure", async () => {
  const item = await fixture();
  const ghPath = path.join(item.bin, "gh");
  await writeFile(ghPath, "#!/usr/bin/env node\nprocess.stderr.write('download failed\\n');process.exit(1);\n");
  await chmod(ghPath, 0o755);
  await mkdir(path.dirname(item.logsPath), { recursive: true });
  await writeFile(item.logsPath, '{"schema_version":2,"kind":"run","run":{"database_id":7}}\n');
  await writeFile(item.statePath, '{"observedAt":"2026-09-06T20:00:00Z","available":true}\n');
  await writeFile(path.join(item.root, "cache", "gh-aw-logs-exit-code"), "1\n");
  try {
    await execFileAsync(process.execPath, [path.resolve("activity/logs.mjs")], {
      env: {
        ...process.env,
        PATH: `${item.bin}:${process.env.PATH}`,
        GITHUB_REPOSITORY: "githubnext/gh-aw-cao",
        REPORT_ROOT: item.root,
        REPORT_GH_AW_LOGS: item.logsPath,
        REPORT_GH_AW_LOGS_STATE: item.statePath,
        REPORT_GH_AW_LOGS_EXIT_CODE: path.join(item.root, "cache", "gh-aw-logs-exit-code"),
        REPORT_AIC_CACHE: item.outputPath,
        GITHUB_OUTPUT: item.githubOutput,
      },
    });

    assert.equal(JSON.parse(await readFile(item.logsPath, "utf8")).run.database_id, 7);
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
  await mkdir(path.dirname(item.logsPath), { recursive: true });
  await writeFile(item.logsPath, '{"schema_version":2,"kind":"run","run":{"database_id":42,"failure_message":"cached detail"}}\n');
  await writeFile(item.statePath, '{"observedAt":"2026-09-06T20:00:00Z","available":true}\n');
  await writeFile(path.join(item.root, "cache", "gh-aw-logs-exit-code"), "1\n");
  try {
    await execFileAsync(process.execPath, [path.resolve("activity/logs.mjs")], {
      env: {
        ...process.env,
        PATH: `${item.bin}:${process.env.PATH}`,
        GITHUB_REPOSITORY: "githubnext/gh-aw-cao",
        REPORT_ROOT: item.root,
        REPORT_GH_AW_LOGS: item.logsPath,
        REPORT_GH_AW_LOGS_STATE: item.statePath,
        REPORT_GH_AW_LOGS_EXIT_CODE: path.join(item.root, "cache", "gh-aw-logs-exit-code"),
        REPORT_AIC_CACHE: item.outputPath,
        GITHUB_OUTPUT: item.githubOutput,
        GH_INVOCATION_PATH: invocationPath,
      },
    });

    assert.equal(JSON.parse(await readFile(item.logsPath, "utf8")).run.failure_message, "cached detail");
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
  await mkdir(path.dirname(item.logsPath), { recursive: true });
  await writeFile(item.logsPath, '{"schema_version":2,"kind":"run","run":{"database_id":7}}\n');
  await writeFile(item.statePath, '{"observedAt":"2026-09-06T20:00:00Z","available":true}\n');
  await writeFile(path.join(item.root, "cache", "gh-aw-logs-exit-code"), "1\n");
  try {
    await execFileAsync(process.execPath, [path.resolve("activity/logs.mjs")], {
      env: {
        ...process.env,
        GITHUB_REPOSITORY: "githubnext/gh-aw-cao",
        REPORT_ROOT: item.root,
        REPORT_GH_AW_LOGS: item.logsPath,
        REPORT_GH_AW_LOGS_STATE: item.statePath,
        REPORT_GH_AW_LOGS_EXIT_CODE: path.join(item.root, "cache", "gh-aw-logs-exit-code"),
        REPORT_AIC_CACHE: item.outputPath,
        GITHUB_OUTPUT: item.githubOutput,
      },
    });
    const state = JSON.parse(await readFile(item.statePath, "utf8"));
    assert.equal(JSON.parse(await readFile(item.logsPath, "utf8")).run.database_id, 7);
    assert.equal(state.available, false);
    assert.equal(state.targetCount, 0);
    assert.equal(state.fallback, true);
    assert.equal(await readFile(item.githubOutput, "utf8"), "collection-outcome=failure\n");
  } finally {
    await rm(item.root, { recursive: true, force: true });
  }
});
