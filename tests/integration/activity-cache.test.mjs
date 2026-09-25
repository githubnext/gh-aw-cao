import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { appendFile, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { parse } from "yaml";

const cachePaths = [
  "${{ runner.temp }}/cao-activity/gh-aw-logs.sqlite",
  "${{ runner.temp }}/cao-activity/gh-aw-logs-shards",
  "${{ runner.temp }}/cao-activity/gh-aw-logs-runs",
  "${{ runner.temp }}/cao-activity/gh-aw-logs-records",
  "${{ runner.temp }}/cao-activity/payload-hashes.json",
  "${{ runner.temp }}/cao-activity/control-settings.json",
  "${{ runner.temp }}/cao-activity/inventory-sources.json",
  "${{ runner.temp }}/cao-activity/drain3_weights.json",
];

const legacyCachePaths = [
  "${{ runner.temp }}/cao-activity/gh-aw-logs.sqlite",
  "${{ runner.temp }}/cao-activity/gh-aw-logs-shards",
  "${{ runner.temp }}/cao-activity/gh-aw-logs-normalized",
  "${{ runner.temp }}/cao-activity/payload-hashes.json",
  "${{ runner.temp }}/cao-activity/control-settings.json",
  "${{ runner.temp }}/cao-activity/inventory-sources.json",
  "${{ runner.temp }}/cao-activity/drain3_weights.json",
];

function assertCachePathSets(workflow, expectedCount, expectedPaths = cachePaths) {
  const pathSets = [
    ...workflow.matchAll(
      /uses: actions\/cache\/(?:restore|save)@[^\n]+\n\s+with:\n\s+path: \|\n((?:\s+\$\{\{ runner\.temp \}\}\/[^\n]+\n)+)/g,
    ),
  ].map((match) => match[1].trim().split("\n").map((line) => line.trim()));

  assert.equal(pathSets.length, expectedCount);
  const expectedPathSets = Array.isArray(expectedPaths[0])
    ? expectedPaths
    : Array.from({ length: expectedCount }, () => expectedPaths);
  for (const [index, pathSet] of pathSets.entries()) {
    assert.deepEqual(pathSet, expectedPathSets[index]);
  }
}

test("activity workflow caches gh-aw logs and their SQLite projection", async () => {
  const workflow = await readFile(".github/workflows/cao-activity.yml", "utf8");
  const collector = await readFile("activity/collect-logs.sh", "utf8");
  const indexJob = workflow.match(/\n  index:\n([\s\S]*?)\n  cache:\n/)?.[1];
  const cacheJob = workflow.match(/\n  cache:\n([\s\S]*?)\n  notify-failure:\n/)?.[1];
  const notifyFailureJob = workflow.match(/\n  notify-failure:\n([\s\S]*)/)?.[1];

  assert.ok(indexJob);
  assert.ok(cacheJob);
  assert.ok(notifyFailureJob);
  assert.match(indexJob, /permissions:\n\s+actions: read\n\s+contents: read\n\s+issues: read/);
  assert.match(
    indexJob,
    /Generate GitHub App token for activity[\s\S]*?permission-actions: read[\s\S]*?permission-contents: read[\s\S]*?permission-issues: read/,
  );
  assert.doesNotMatch(indexJob, /actions\/cache\/save@/);
  assert.match(
    indexJob,
    /Upload activity snapshot[\s\S]*?actions\/upload-artifact@[0-9a-f]{40}[\s\S]*?name: cao-activity-index[\s\S]*?retention-days: 1/,
  );
  assert.match(cacheJob, /needs: index/);
  assert.match(cacheJob, /permissions:\n\s+actions: write\n\s+contents: none/);
  assert.match(
    cacheJob,
    /Download activity snapshot[\s\S]*?actions\/download-artifact@[0-9a-f]{40}[\s\S]*?name: cao-activity-index[\s\S]*?path: \$\{\{ runner\.temp \}\}\/cao-activity[\s\S]*?Verify activity snapshot[\s\S]*?Save activity cache/,
  );
  assert.match(notifyFailureJob, /needs: \[index, cache\]/);
  assert.match(notifyFailureJob, /permissions:\n\s+issues: write/);
  assert.match(notifyFailureJob, /CAO_ACTIVITY_INDEX_FAILED[\s\S]*?CAO_ACTIVITY_CACHE_FAILED/);
  assert.match(notifyFailureJob, /Assign this issue to an agent/);
  assert.match(notifyFailureJob, /GITHUB_WORKFLOW_SHA[\s\S]*?githubnext\/gh-aw-cao\/blob\/main\/skills\/debug-cao\/SKILL\.md/);
  assert.doesNotMatch(cacheJob, /actions\/checkout@|activity-app-token|gh aw logs|ingest-jsonl/);
  assert.match(
    workflow,
    /Collect dashboard inventory[\s\S]*?REPORT_INVENTORY_SOURCES: \$\{\{ runner\.temp \}\}\/cao-activity\/inventory-sources\.json[\s\S]*?core\.info\('Workflow discovery started'\)[\s\S]*?'discover-workflows'[\s\S]*?core\.info\('Workflow discovery completed'\)[\s\S]*?Download agentic workflow logs/,
  );
  assert.match(
    indexJob,
    /Download agentic workflow logs[\s\S]*?Ingest activity database/,
  );
  assert.match(
    workflow,
    /Download agentic workflow logs[\s\S]*?REPORT_CONTROL_SETTINGS:[\s\S]*?bash activity\/collect-logs\.sh/,
  );
  assert.match(collector, /jq -r '\.allowed_repositories\[\]\?'/);
  assert.match(collector, /--repo "\$target_repository"/);
  assert.match(collector, /--cached-jsonl "\$\{shard_prefix\}\*"/);
  assert.doesNotMatch(
    indexJob,
    /Download agentic workflow logs\n\s+continue-on-error:/,
  );
  assert.doesNotMatch(collector, /gh api|token-efficiency/);
  assert.doesNotMatch(workflow, /collect-token-efficiency\.sh/);
  assert.match(
    workflow,
    /Ingest activity database[\s\S]*?ingest-jsonl[\s\S]*?--database "\$ACTIVITY_DATABASE"[\s\S]*?--runs-dir "\$REPORT_GH_AW_LOGS_RUNS"[\s\S]*?--records-dir "\$REPORT_GH_AW_LOGS_RECORDS"/,
  );
  assert.match(
    workflow,
    /ingest-jsonl[\s\S]*?--runs-dir "\$REPORT_GH_AW_LOGS_RUNS"[\s\S]*?--records-dir "\$REPORT_GH_AW_LOGS_RECORDS"[\s\S]*?doctor[\s\S]*?--database "\$ACTIVITY_DATABASE"/,
  );
  assert.match(
    workflow,
    /Hash activity payloads[\s\S]*?REPORT_GH_AW_LOGS_RUNS: \$\{\{ runner\.temp \}\}\/cao-activity\/gh-aw-logs-runs[\s\S]*?REPORT_GH_AW_LOGS_RECORDS: \$\{\{ runner\.temp \}\}\/cao-activity\/gh-aw-logs-records[\s\S]*?hash-payloads[\s\S]*?--database "\$ACTIVITY_DATABASE"[\s\S]*?--shard-dir "\$REPORT_GH_AW_LOGS_SHARDS"[\s\S]*?--runs-dir "\$REPORT_GH_AW_LOGS_RUNS"[\s\S]*?--records-dir "\$REPORT_GH_AW_LOGS_RECORDS"[\s\S]*?--output "\$RUNNER_TEMP\/cao-activity\/payload-hashes\.json"/,
  );
  assert.match(
    cacheJob,
    /Save activity cache[\s\S]*?path: \|[\s\S]*?\$\{\{ runner\.temp \}\}\/cao-activity\/gh-aw-logs\.sqlite[\s\S]*?\$\{\{ runner\.temp \}\}\/cao-activity\/gh-aw-logs-shards[\s\S]*?\$\{\{ runner\.temp \}\}\/cao-activity\/drain3_weights\.json/,
  );
  assert.match(
    workflow,
    /Restore legacy activity cache layout[\s\S]*?\$\{\{ runner\.temp \}\}\/cao-activity\/drain3_weights\.json[\s\S]*?Download agentic workflow logs[\s\S]*?REPORT_DRAIN3_WEIGHTS: \$\{\{ runner\.temp \}\}\/cao-activity\/drain3_weights\.json[\s\S]*?bash activity\/collect-logs\.sh/,
  );
  assert.match(workflow, /Restore legacy activity cache layout\n\s+if: steps\.activity-cache\.outputs\.cache-matched-key == ''/);
  assert.match(collector, /if \[\[ -n "\$drain3_weights_path" && -f "\$drain3_weights_path" \]\]/);
  assert.match(collector, /drain3_args=\(--drain3-weights "\$drain3_weights_path"\)/);
  assert.equal((workflow.match(/path: \$\{\{ runner\.temp \}\}\/cao-activity\s*$/gm) || []).length, 1);
  assert.doesNotMatch(workflow, /Skip scheduled run|steps\.freshness/);
  assert.match(workflow, /ACTIVITY_DATABASE: \$\{\{ runner\.temp \}\}\/cao-activity\/gh-aw-logs\.sqlite/);
  assert.doesNotMatch(workflow, /Install SQLite|apt-get install.*sqlite3/);
  assert.match(workflow, /REPORT_RUN_LIMIT: "10000"/);
  assert.match(workflow, /REPORT_LOG_TIMEOUT: "15"/);
  assert.match(
    workflow,
    /ingest-jsonl[\s\S]*?--retention-days 30[\s\S]*?--run-retention-days 30[\s\S]*?doctor[\s\S]*?--ttl-days 30[\s\S]*?--run-ttl-days 30/,
  );
  assert.doesNotMatch(
    workflow,
    /run-activity\.mjs|REPORT_GH_AW_LOGS_STATE|REPORT_DEPLOYED_WORKFLOWS|REPORT_RECORDS/,
  );
  assertCachePathSets(workflow, 3, [cachePaths, legacyCachePaths, cachePaths]);
  const legacyPathBlock = workflow.match(
    /Restore legacy activity cache layout[\s\S]*?path: \|\n((?:\s+\$\{\{ runner\.temp \}\}\/[^\n]+\n)+)/,
  )?.[1];
  assert.ok(legacyPathBlock);
  assert.deepEqual(
    legacyPathBlock.trim().split("\n").map((line) => line.trim()),
    legacyCachePaths,
  );
});

test("activity cache consumers use the producer cache version paths", async () => {
  const [dashboardWorkflow, sharedCache] = await Promise.all([
    readFile(".github/workflows/cao-dashboard.yml", "utf8"),
    readFile(".github/workflows/shared/activity-cache.md", "utf8"),
  ]);

  assertCachePathSets(dashboardWorkflow, 1);
  assertCachePathSets(sharedCache, 2);
});

const execute = promisify(execFile);
const rateLimitRecord = `${JSON.stringify({
  schema_version: 2,
  kind: "github_api_rate_limit",
  rate_limit: {
    host: "github.com",
    start: { limit: 5000, remaining: 5000, reset: 1790374802, used: 0 },
    end: { limit: 5000, remaining: 5000, reset: 1790374804, used: 0 },
  },
})}\n`;

// Produces an Activity snapshot the way the index job does when collection
// discovers no agentic workflow runs: the only raw records are rate limits.
async function zeroRunSnapshot(t) {
  const runnerTemp = await mkdtemp(path.join(os.tmpdir(), "cao-activity-zero-run-"));
  t.after(() => rm(runnerTemp, { recursive: true, force: true }));
  const root = path.join(runnerTemp, "cao-activity");
  const shards = path.join(root, "gh-aw-logs-shards");
  const runs = path.join(root, "gh-aw-logs-runs");
  const records = path.join(root, "gh-aw-logs-records");
  const database = path.join(root, "gh-aw-logs.sqlite");
  const inventory = path.join(root, "inventory-sources.json");
  await mkdir(shards, { recursive: true });
  await writeFile(path.join(shards, "logs-1790371204-0000-d98491943277f167.jsonl"), rateLimitRecord);
  await writeFile(path.join(root, "control-settings.json"), '{"allowed_repositories":["junco-org/control"]}\n');
  await writeFile(inventory, '{"workflows":{"rows":[]}}\n');
  const phases = ["--shard-dir", shards, "--runs-dir", runs, "--records-dir", records, "--inventory", inventory];
  await execute(process.execPath, ["activity/cao.mjs", "hash-payloads", ...phases]);
  await execute(process.execPath, [
    "activity/cao.mjs", "ingest-jsonl", "--database", database, "--runs-dir", runs, "--records-dir", records,
    "--retention-days", "30", "--run-retention-days", "30",
  ]);
  await execute(process.execPath, [
    "activity/cao.mjs", "hash-payloads", "--database", database, ...phases,
    "--output", path.join(root, "payload-hashes.json"),
  ]);
  return { runnerTemp, root };
}

async function verifySnapshot(runnerTemp) {
  const workflow = parse(await readFile(".github/workflows/cao-activity.yml", "utf8"));
  const { run } = workflow.jobs.cache.steps.find(({ name }) => name === "Verify activity snapshot");
  try {
    await execute("bash", ["-e", "-c", run], { env: { ...process.env, RUNNER_TEMP: runnerTemp } });
    return { code: 0, stderr: "" };
  } catch (error) {
    return { code: error.code, stderr: error.stderr };
  }
}

test("a zero-run Activity snapshot publishes explicit empty phase shards and passes verification", async (t) => {
  const { runnerTemp, root } = await zeroRunSnapshot(t);
  const manifest = JSON.parse(await readFile(path.join(root, "payload-hashes.json"), "utf8"));
  for (const phase of ["runs", "records"]) {
    const names = Object.keys(manifest).filter((name) => name.startsWith(`gh-aw-logs-${phase}/`));
    assert.equal(names.length, 1, `${phase} phase is published explicitly`);
    const lines = (await readFile(path.join(root, names[0]), "utf8")).trim().split("\n").map((line) => JSON.parse(line));
    assert.deepEqual(lines.map(({ kind, phase: linePhase, records: count }) => [kind, linePhase, count]), [["metadata", phase, 0]]);
  }
  assert.deepEqual(await verifySnapshot(runnerTemp), { code: 0, stderr: "" });
});

test("Activity snapshot verification still rejects incomplete snapshots", async (t) => {
  const { runnerTemp, root } = await zeroRunSnapshot(t);
  const [runShard] = (await readdir(path.join(root, "gh-aw-logs-runs"))).filter((name) => name.endsWith(".jsonl"));
  await appendFile(
    path.join(root, "gh-aw-logs-runs", runShard),
    `${JSON.stringify({ kind: "record", collection: "runs", record: { id: "1" } })}\n`,
  );
  const withRuns = await verifySnapshot(runnerTemp);
  assert.equal(withRuns.code, 1);
  assert.match(withRuns.stderr, /Activity snapshot file is missing or empty: drain3_weights\.json/);

  await writeFile(path.join(root, "drain3_weights.json"), "{}\n");
  assert.equal((await verifySnapshot(runnerTemp)).code, 0);

  await rm(path.join(root, "gh-aw-logs-records"), { recursive: true });
  const withoutRecords = await verifySnapshot(runnerTemp);
  assert.equal(withoutRecords.code, 1);
  assert.match(withoutRecords.stderr, /Activity snapshot contains no records shards/);

  await rm(path.join(root, "control-settings.json"));
  assert.match((await verifySnapshot(runnerTemp)).stderr, /missing or empty: control-settings\.json/);
});
