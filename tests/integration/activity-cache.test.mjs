import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const cachePaths = [
  "${{ runner.temp }}/cao-activity/gh-aw-logs.jsonl",
  "${{ runner.temp }}/cao-activity/gh-aw-logs.sqlite",
  "${{ runner.temp }}/cao-activity/control-settings.json",
  "${{ runner.temp }}/cao-activity/inventory-sources.json",
  "${{ runner.temp }}/cao-gh-aw-logs/drain3_weights.json",
];

function assertCachePathSets(workflow, expectedCount) {
  for (const cachePath of cachePaths) {
    assert.equal(
      workflow.split(cachePath).length - 1,
      expectedCount,
      `${cachePath} must be present in every cache operation`,
    );
  }
}

test("activity workflow caches gh-aw logs and their SQLite projection", async () => {
  const workflow = await readFile(".github/workflows/activity.yml", "utf8");

  assert.match(
    workflow,
    /Collect dashboard inventory[\s\S]*?REPORT_INVENTORY_SOURCES: \$\{\{ runner\.temp \}\}\/cao-activity\/inventory-sources\.json[\s\S]*?Download agentic workflow logs/,
  );
  assert.match(workflow, /--cached-jsonl "\$REPORT_GH_AW_LOGS"/);
  assert.match(
    workflow,
    /Ingest activity database[\s\S]*?ingest-jsonl[\s\S]*?--database "\$ACTIVITY_DATABASE"[\s\S]*?--input "\$REPORT_GH_AW_LOGS"/,
  );
  assert.match(
    workflow,
    /ingest-jsonl[\s\S]*?--input "\$REPORT_GH_AW_LOGS"[\s\S]*?doctor[\s\S]*?--database "\$ACTIVITY_DATABASE"/,
  );
  assert.match(
    workflow,
    /Save activity cache[\s\S]*?path: \|[\s\S]*?\$\{\{ runner\.temp \}\}\/cao-activity\/gh-aw-logs\.jsonl[\s\S]*?\$\{\{ runner\.temp \}\}\/cao-activity\/gh-aw-logs\.sqlite[\s\S]*?\$\{\{ runner\.temp \}\}\/cao-gh-aw-logs\/drain3_weights\.json/,
  );
  assert.match(
    workflow,
    /Restore activity cache[\s\S]*?\$\{\{ runner\.temp \}\}\/cao-gh-aw-logs\/drain3_weights\.json[\s\S]*?if \[\[ -f "\$REPORT_AIC_CACHE\/drain3_weights\.json" \]\][\s\S]*?--drain3-weights "\$REPORT_AIC_CACHE\/drain3_weights\.json"/,
  );
  assert.doesNotMatch(workflow, /path: \$\{\{ runner\.temp \}\}\/cao-activity\s*$/m);
  assert.doesNotMatch(workflow, /Skip scheduled run|steps\.freshness/);
  assert.match(workflow, /ACTIVITY_DATABASE: \$\{\{ runner\.temp \}\}\/cao-activity\/gh-aw-logs\.sqlite/);
  assert.doesNotMatch(workflow, /Install SQLite|apt-get install.*sqlite3/);
  assert.match(workflow, /--count 1000/);
  assert.match(workflow, /--timeout 15/);
  assert.match(workflow, /ingest-jsonl[\s\S]*?--run-retention-days all[\s\S]*?doctor[\s\S]*?--run-ttl-days all/);
  assert.doesNotMatch(
    workflow,
    /github-script|run-activity\.mjs|REPORT_GH_AW_LOGS_STATE|REPORT_DEPLOYED_WORKFLOWS|REPORT_RECORDS/,
  );
  assertCachePathSets(workflow, 2);
});

test("activity cache consumers use the producer cache version paths", async () => {
  const [dashboardWorkflow, sharedCache] = await Promise.all([
    readFile(".github/workflows/cao-dashboard.yml", "utf8"),
    readFile(".github/workflows/shared/activity-cache.md", "utf8"),
  ]);

  assertCachePathSets(dashboardWorkflow, 1);
  assertCachePathSets(sharedCache, 2);
});
