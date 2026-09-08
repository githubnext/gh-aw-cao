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
    logsPath: path.join(root, "cache", "gh-aw-logs.json"),
    statePath: path.join(root, "cache", "gh-aw-logs-state.json"),
    outputPath: path.join(root, "cache", "gh-aw-logs"),
    argumentsPath: path.join(root, "arguments.json"),
    githubOutput: path.join(root, "github-output"),
  };
}

test("activity logs uses one bounded gh aw logs invocation without heavy agent artifacts", async () => {
  const item = await fixture();
  const ghPath = path.join(item.bin, "gh");
  await writeFile(ghPath, `#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2);
if (args[0] === "aw") {
  fs.writeFileSync(process.env.GH_ARGS_PATH, JSON.stringify(args));
  process.stderr.write("Fetched 1 run\\n");
  process.stdout.write(JSON.stringify({runs:[{
   database_id:42,
   repository:"githubnext/gh-aw-cao",
   workflow_path:".github/workflows/sample.lock.yml",
   status:"completed"
  }]}));
} else {
  process.stdout.write(JSON.stringify({jobs:[{
   id:84,
   name:"agent",
   status:"completed",
   conclusion:"success",
   started_at:"2026-09-06T20:00:05Z",
   completed_at:"2026-09-06T20:00:55Z",
   runner_name:"GitHub Actions 2",
   runner_group_name:"GitHub Actions",
   labels:["ubuntu-latest"]
  }]}));
}
`);
  await chmod(ghPath, 0o755);
  try {
    const { stdout } = await execFileAsync(process.execPath, [path.resolve("activity/logs.mjs")], {
      env: {
        ...process.env,
        PATH: `${item.bin}:${process.env.PATH}`,
        GITHUB_REPOSITORY: "githubnext/gh-aw-cao",
        REPORT_ROOT: item.root,
        REPORT_GH_AW_LOGS: item.logsPath,
        REPORT_GH_AW_LOGS_STATE: item.statePath,
        REPORT_AIC_CACHE: item.outputPath,
        GH_ARGS_PATH: item.argumentsPath,
        GITHUB_OUTPUT: item.githubOutput,
      },
    });
    const args = JSON.parse(await readFile(item.argumentsPath, "utf8"));
    assert.deepEqual(args.slice(0, 4), ["aw", "logs", "--json", "--audit"]);
    assert.deepEqual(args.slice(args.indexOf("--artifacts"), args.indexOf("--artifacts") + 2), [
      "--artifacts",
      "usage,detection,evals,experiment,firewall,github-api,graders,mcp",
    ]);
    assert.equal(args.filter((value) => value === "--prune-older-runs").length, 1);
    assert.equal(args.filter((value) => value === "logs").length, 1);
    assert.equal(args.at(-1), "githubnext/gh-aw-cao/.github/workflows/sample.lock.yml");
    const snapshot = JSON.parse(await readFile(item.logsPath, "utf8"));
    assert.deepEqual(snapshot.runs[0].jobs, [{
      jobId: 84,
      name: "agent",
      status: "completed",
      conclusion: "success",
      startedAt: "2026-09-06T20:00:05Z",
      completedAt: "2026-09-06T20:00:55Z",
      runnerName: "GitHub Actions 2",
      runnerGroupName: "GitHub Actions",
      labels: ["ubuntu-latest"],
    }]);
    const state = JSON.parse(await readFile(item.statePath, "utf8"));
    assert.equal(state.available, true);
    assert.equal(state.complete, true);
    assert.equal(state.jobDetails.observedRuns, 1);
    assert.equal(await readFile(item.githubOutput, "utf8"), "collection-outcome=success\n");
    assert.ok(stdout.includes(`Calling gh aw logs with arguments: ${JSON.stringify(args.slice(2))}`));
    assert.match(stdout, /Fetched 1 run/);
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
  await writeFile(item.logsPath, '{"runs":[{"database_id":7}]}\n');
  await writeFile(item.statePath, '{"observedAt":"2026-09-06T20:00:00Z","available":true}\n');
  try {
    await execFileAsync(process.execPath, [path.resolve("activity/logs.mjs")], {
      env: {
        ...process.env,
        PATH: `${item.bin}:${process.env.PATH}`,
        GITHUB_REPOSITORY: "githubnext/gh-aw-cao",
        REPORT_ROOT: item.root,
        REPORT_GH_AW_LOGS: item.logsPath,
        REPORT_GH_AW_LOGS_STATE: item.statePath,
        REPORT_AIC_CACHE: item.outputPath,
        GITHUB_OUTPUT: item.githubOutput,
      },
    });

    assert.equal(JSON.parse(await readFile(item.logsPath, "utf8")).runs[0].database_id, 7);
    const state = JSON.parse(await readFile(item.statePath, "utf8"));
    assert.equal(state.available, false);
    assert.equal(state.fallback, true);
    assert.equal(state.snapshotObservedAt, "2026-09-06T20:00:00Z");
    assert.equal(await readFile(item.githubOutput, "utf8"), "collection-outcome=failure\n");
  } finally {
    await rm(item.root, { recursive: true, force: true });
  }
});

test("activity logs enriches cached runs from the Actions API when gh aw logs fails", async () => {
  const item = await fixture();
  const ghPath = path.join(item.bin, "gh");
  await writeFile(ghPath, `#!/usr/bin/env node
const args = process.argv.slice(2);
if (args[0] === "aw") {
  process.stderr.write("storage limit reached\\n");
  process.exit(1);
}
if (args.some((arg) => arg.endsWith("/jobs"))) {
  process.stdout.write(JSON.stringify({jobs:[{
    id:84,
    name:"agent",
    status:"completed",
    conclusion:"success",
    started_at:"2026-09-06T10:00:10Z",
    completed_at:"2026-09-06T10:02:50Z",
    runner_name:"GitHub Actions 2",
    runner_group_name:"GitHub Actions",
    labels:["ubuntu-latest"]
  }]}));
} else process.stdout.write(JSON.stringify({workflow_runs:[{
  id: 42,
  run_number: 9,
  run_attempt: 1,
  event: "schedule",
  status: "completed",
  conclusion: "success",
  created_at: "2026-09-06T10:00:00Z",
  run_started_at: "2026-09-06T10:00:02Z",
  updated_at: "2026-09-06T10:03:00Z",
  display_title: "Sample scheduled"
}]}));
`);
  await chmod(ghPath, 0o755);
  await mkdir(path.dirname(item.logsPath), { recursive: true });
  await writeFile(item.logsPath, '{"runs":[{"database_id":42,"failure_message":"cached detail"}]}\n');
  await writeFile(item.statePath, '{"observedAt":"2026-09-06T20:00:00Z","available":true}\n');
  try {
    await execFileAsync(process.execPath, [path.resolve("activity/logs.mjs")], {
      env: {
        ...process.env,
        PATH: `${item.bin}:${process.env.PATH}`,
        GITHUB_REPOSITORY: "githubnext/gh-aw-cao",
        REPORT_ROOT: item.root,
        REPORT_GH_AW_LOGS: item.logsPath,
        REPORT_GH_AW_LOGS_STATE: item.statePath,
        REPORT_AIC_CACHE: item.outputPath,
        GITHUB_OUTPUT: item.githubOutput,
      },
    });

    const snapshot = JSON.parse(await readFile(item.logsPath, "utf8"));
    assert.equal(snapshot.runs[0].workflow_path, ".github/workflows/sample.lock.yml");
    assert.equal(snapshot.runs[0].started_at, "2026-09-06T10:00:02Z");
    assert.equal(snapshot.runs[0].updated_at, "2026-09-06T10:03:00Z");
    assert.equal(snapshot.runs[0].failure_message, "cached detail");
    assert.equal(snapshot.runs[0].jobs[0].name, "agent");
    const state = JSON.parse(await readFile(item.statePath, "utf8"));
    assert.equal(state.available, true);
    assert.equal(state.complete, false);
    assert.equal(state.actionsEnrichment, true);
    assert.equal(state.actionsTargetsObserved, 1);
    assert.equal(await readFile(item.githubOutput, "utf8"), "collection-outcome=partial\n");
  } finally {
    await rm(item.root, { recursive: true, force: true });
  }
});

test("activity logs bounds concurrent Actions API enrichment", async () => {
  const item = await fixture();
  const ghPath = path.join(item.bin, "gh");
  const concurrencyPath = path.join(item.root, "concurrency");
  await mkdir(concurrencyPath);
  await Promise.all(Array.from({ length: 8 }, (_, index) => writeFile(
    path.join(item.root, ".github", "workflows", `sample-${index}.lock.yml`),
    `name: Sample ${index}\n`,
  )));
  await writeFile(ghPath, `#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
const args = process.argv.slice(2);
if (args[0] === "aw") process.exit(1);
const activeDirectory = path.join(process.env.CONCURRENCY_PATH, "active");
fs.mkdirSync(activeDirectory, { recursive: true });
const marker = path.join(activeDirectory, String(process.pid));
fs.writeFileSync(marker, "");
fs.appendFileSync(path.join(process.env.CONCURRENCY_PATH, "counts"), String(fs.readdirSync(activeDirectory).length) + "\\n");
setTimeout(() => {
  fs.unlinkSync(marker);
  process.stdout.write(JSON.stringify({ workflow_runs: [] }));
}, 100);
`);
  await chmod(ghPath, 0o755);
  try {
    await execFileAsync(process.execPath, [path.resolve("activity/logs.mjs")], {
      env: {
        ...process.env,
        PATH: `${item.bin}:${process.env.PATH}`,
        GITHUB_REPOSITORY: "githubnext/gh-aw-cao",
        REPORT_ROOT: item.root,
        REPORT_GH_AW_LOGS: item.logsPath,
        REPORT_GH_AW_LOGS_STATE: item.statePath,
        REPORT_AIC_CACHE: item.outputPath,
        GITHUB_OUTPUT: item.githubOutput,
        CONCURRENCY_PATH: concurrencyPath,
      },
    });

    const counts = (await readFile(path.join(concurrencyPath, "counts"), "utf8"))
      .trim().split("\n").map(Number);
    assert.ok(Math.max(...counts) > 1);
    assert.ok(Math.max(...counts) <= 4);
    assert.equal(JSON.parse(await readFile(item.statePath, "utf8")).actionsTargetsObserved, 9);
  } finally {
    await rm(item.root, { recursive: true, force: true });
  }
});

test("activity logs records a failure when workflow discovery is unavailable", async () => {
  const item = await fixture();
  await rm(path.join(item.root, ".github"), { recursive: true });
  await mkdir(path.dirname(item.logsPath), { recursive: true });
  await writeFile(item.logsPath, '{"runs":[{"database_id":7}]}\n');
  await writeFile(item.statePath, '{"observedAt":"2026-09-06T20:00:00Z","available":true}\n');
  try {
    await execFileAsync(process.execPath, [path.resolve("activity/logs.mjs")], {
      env: {
        ...process.env,
        GITHUB_REPOSITORY: "githubnext/gh-aw-cao",
        REPORT_ROOT: item.root,
        REPORT_GH_AW_LOGS: item.logsPath,
        REPORT_GH_AW_LOGS_STATE: item.statePath,
        REPORT_AIC_CACHE: item.outputPath,
        GITHUB_OUTPUT: item.githubOutput,
      },
    });
    const state = JSON.parse(await readFile(item.statePath, "utf8"));
    assert.equal(JSON.parse(await readFile(item.logsPath, "utf8")).runs[0].database_id, 7);
    assert.equal(state.available, false);
    assert.equal(state.targetCount, 0);
    assert.equal(state.fallback, true);
    assert.equal(await readFile(item.githubOutput, "utf8"), "collection-outcome=failure\n");
  } finally {
    await rm(item.root, { recursive: true, force: true });
  }
});
