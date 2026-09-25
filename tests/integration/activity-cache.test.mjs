import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

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
  assert.match(notifyFailureJob, /GITHUB_WORKFLOW_SHA[\s\S]*?debug-cao/);
  assert.match(
    cacheJob,
    /Verify activity snapshot[\s\S]*?for file in gh-aw-logs\.sqlite payload-hashes\.json control-settings\.json inventory-sources\.json drain3_weights\.json[\s\S]*?-s "\$snapshot_root\/\$file"[\s\S]*?Activity snapshot contains no JSONL shards[\s\S]*?exit 1/,
  );
  assert.match(cacheJob, /for phase in runs records/);
  assert.match(cacheJob, /gh-aw-logs-\$phase" -maxdepth 1 -type f -name '\*\.jsonl'/);
  assert.doesNotMatch(cacheJob, /for phase in runs events/);
  assert.doesNotMatch(cacheJob, /Activity run and record shard sets do not match/);
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
