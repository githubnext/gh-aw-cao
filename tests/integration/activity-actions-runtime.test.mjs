import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { prepareActivityTools, root, run, simulate } from "../helpers/actions-runtime/index.mjs";

const repository = "simulator/repo-00001";
const workflow = ".github/workflows/cao-activity.yml";

function activityFixture(workspace) {
  for (const name of ["activity", "dashboard/report", "dashboard/site/src", "dashboard/site/dashboard-fragments",
    "dashboard/site/package.json", "dashboard/site/dashboard.json",
    ".github/workflows/shared", ".github/actions/setup-cao-runtime", workflow, "package.json"]) {
    const destination = join(workspace, name);
    mkdirSync(join(destination, ".."), { recursive: true });
    cpSync(join(root, name), destination, { recursive: true });
  }
  cpSync(join(root, "tests/fixtures/actions-runtime/sample.md"), join(workspace, ".github/workflows/sample.md"));
  writeFileSync(join(workspace, ".github/workflows/sample.lock.yml"), `# gh-aw-metadata: {"compiler_version":"v0.93.1"}
name: Sample
on: workflow_dispatch
jobs:
  agent:
    runs-on: ubuntu-latest
    steps:
      - run: echo "Synthetic deterministic agent log"
`);
  const policy = JSON.parse(readFileSync(join(root, "tests/fixtures/actions-runtime/cao.json"), "utf8"));
  policy["control-plane"].activity = { repositories: [repository] };
  writeFileSync(join(workspace, ".github/workflows/cao.json"), JSON.stringify(policy));
  run("git", ["init", "--quiet", "--initial-branch=main"], { cwd: workspace });
  run("git", ["remote", "add", "origin", `https://github.com/${repository}.git`], { cwd: workspace });
  run("git", ["add", "."], { cwd: workspace });
  run("git", ["-c", "user.name=Actions simulator", "-c", "user.email=simulator@example.invalid",
    "commit", "--quiet", "--no-gpg-sign", "-m",
    "Synthetic Activity runtime\n\nCo-authored-by: Copilot App <223556219+Copilot@users.noreply.github.com>"], { cwd: workspace });
}

function records(database, store) {
  return database.prepare("SELECT value FROM __idb_records WHERE store_name = ? ORDER BY record_key")
    .all(store).map(row => JSON.parse(row.value));
}

function published(output) {
  const snapshot = join(output, "artifacts/cao-activity-index");
  const filename = join(snapshot, "gh-aw-logs.sqlite");
  const hashes = JSON.parse(readFileSync(join(snapshot, "payload-hashes.json"), "utf8"));
  assert.equal(hashes["gh-aw-logs.sqlite"], createHash("sha256").update(readFileSync(filename)).digest("hex"));
  const database = new DatabaseSync(filename, { readOnly: true });
  try {
    return Object.fromEntries(["dailyRunCounts", "runCountContributions", "dailyRunCountState", "runs"]
      .map(store => [store, records(database, store)]));
  } finally { database.close(); }
}

function health(filename) {
  return JSON.parse(run(process.execPath, [
    "activity/cao.mjs", "query", "workflow-runtime-health-summary", "--database", filename,
  ], { cwd: root })).rows;
}

test("cao-activity collects simulator runs and publishes replay-safe daily counts through the Actions runtime", { timeout: 600_000 }, () => {
  const parent = join(root, ".tmp/actions-runtime");
  mkdirSync(parent, { recursive: true });
  const directory = mkdtempSync(join(parent, "activity-"));
  const workspace = join(directory, "workspace");
  activityFixture(workspace);
  const tools = prepareActivityTools(parent);
  const event = {
    repository: {
      id: 1001, name: "repo-00001", full_name: repository, default_branch: "main",
      private: false, visibility: "public", owner: { id: 42, login: "simulator", type: "Organization" },
    },
    sender: { id: 7, login: "developer", type: "User" },
    inputs: { fast: false, "force-recycle": false, "recycle-only": false },
  };
  const asOf = new Date(new Date().setUTCHours(0, 0, 0, 0) - 12 * 3600_000).toISOString();
  const output = join(directory, "initial");
  const report = simulate({ workspace, workflow, event, eventName: "workflow_dispatch", output, tools, activity: { asOf } });
  for (const id of ["plan", "collect", "index", "cache"]) assert.equal(report.jobs[id].result, "success", id);
  assert.equal(report.jobs["notify-failure"].result, "skipped");
  assert.deepEqual(report.unhandled, []);
  assert.ok(report.requests.every(request => request.method === "GET"));
  assert.ok(report.requests.some(request => request.path.endsWith("/actions/workflows/7/runs")));
  assert.ok(report.requests.some(request => request.path.startsWith("/archives/")));
  assert.ok(report.requests.some(request => request.path.startsWith("/usage/")));
  const initial = published(output);
  // The pinned collector emits executed/pending runs, not cancelled or
  // action-required runs. Counts describe that admitted evidence, not all API rows.
  assert.deepEqual(initial.runs.map(row => row.githubRunId).sort(), ["1", "11", "2", "3", "5", "7", "8", "9"]);
  assert.equal(initial.runCountContributions.length, 8);
  assert.equal(initial.dailyRunCountState[0].status, "ready");
  for (const row of initial.dailyRunCounts) {
    assert.equal(row.owner, "simulator");
    assert.equal(row.repository, "repo-00001");
    assert.equal(row.workflowPath, ".github/workflows/sample.md");
    assert.equal(row.total, row.successful + row.failed + row.approval + row.pending + row.other);
  }
  const expected = [{
    organization: "simulator", repository: "repo-00001", workflow: ".github/workflows/sample.md",
    total: 8, successful: 2, failed: 4, approval: 0, pending: 2, other: 0,
  }];
  const snapshotDatabase = join(output, "artifacts/cao-activity-index/gh-aw-logs.sqlite");
  assert.deepEqual(health(snapshotDatabase), expected);
  assert.ok(readdirSync(join(output, "cache")).some(name => name.startsWith("cao-activity-v5-")));

  const replayOutput = join(directory, "replay");
  simulate({ workspace, workflow, event, eventName: "workflow_dispatch", output: replayOutput, tools,
    cacheSeed: join(output, "cache"), activity: { asOf, runId: 2 } });
  assert.deepEqual(published(replayOutput).dailyRunCounts, initial.dailyRunCounts);
  assert.equal(published(replayOutput).runCountContributions.length, 8);

  const correctedOutput = join(directory, "corrected");
  simulate({ workspace, workflow, event, eventName: "workflow_dispatch", output: correctedOutput, tools,
    cacheSeed: join(replayOutput, "cache"), activity: { asOf, runId: 3, correction: true } });
  const corrected = published(correctedOutput);
  assert.equal(corrected.runCountContributions.length, 8);
  assert.equal(corrected.runCountContributions.find(row => row.run.id.endsWith(":2")).run.attempt, 2);
  const correctedHealth = [{ ...expected[0], successful: 3, failed: 3 }];
  assert.deepEqual(health(join(correctedOutput, "artifacts/cao-activity-index/gh-aw-logs.sqlite")), correctedHealth);

  const recycleOutput = join(directory, "recycle");
  const recycledReport = simulate({ workspace, workflow,
    event: { ...event, inputs: { ...event.inputs, "recycle-only": true } }, eventName: "workflow_dispatch",
    output: recycleOutput, tools, cacheSeed: join(correctedOutput, "cache"),
    activity: { asOf, runId: 4, correction: true } });
  assert.equal(recycledReport.jobs.collect.result, "skipped");
  assert.equal(recycledReport.jobs.cache.result, "success");
  assert.deepEqual(recycledReport.requests, []);
  assert.deepEqual(published(recycleOutput).dailyRunCounts, corrected.dailyRunCounts);
  assert.deepEqual(health(join(recycleOutput, "artifacts/cao-activity-index/gh-aw-logs.sqlite")), correctedHealth);

  const repairedDatabase = join(directory, "repaired.sqlite");
  cpSync(snapshotDatabase, repairedDatabase);
  const repaired = JSON.parse(run(process.execPath, ["activity/cao.mjs", "repair-database",
    "--database", repairedDatabase, "--ttl-days", "1", "--run-ttl-days", "1"], { cwd: root }));
  assert.equal(repaired.healthy, true);
  assert.ok(repaired.after.counts.runs < initial.runs.length);
  assert.deepEqual(health(repairedDatabase), expected);
  rmSync(directory, { recursive: true, force: true });
});
