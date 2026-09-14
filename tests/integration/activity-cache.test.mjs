import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const cachePaths = [
  "${{ runner.temp }}/cao-activity/gh-aw-logs.jsonl",
  "${{ runner.temp }}/cao-activity/gh-aw-logs.sqlite",
  "${{ runner.temp }}/cao-activity/payload-hashes.json",
  "${{ runner.temp }}/cao-activity/control-settings.json",
  "${{ runner.temp }}/cao-activity/inventory-sources.json",
  "${{ runner.temp }}/cao-activity/drain3_weights.json",
];

function assertCachePathSets(workflow, expectedCount) {
  const pathSets = [
    ...workflow.matchAll(
      /uses: actions\/cache\/(?:restore|save)@[^\n]+\n\s+with:\n\s+path: \|\n((?:\s+\$\{\{ runner\.temp \}\}\/[^\n]+\n)+)/g,
    ),
  ].map((match) => match[1].trim().split("\n").map((line) => line.trim()));

  assert.equal(pathSets.length, expectedCount);
  for (const pathSet of pathSets) {
    assert.deepEqual(pathSet, cachePaths);
  }
}

test("activity workflow caches gh-aw logs and their SQLite projection", async () => {
  const workflow = await readFile(".github/workflows/activity.yml", "utf8");
  const indexJob = workflow.match(/\n  index:\n([\s\S]*?)\n  cache:\n/)?.[1];
  const cacheJob = workflow.match(/\n  cache:\n([\s\S]*)/)?.[1];

  assert.ok(indexJob);
  assert.ok(cacheJob);
  assert.match(indexJob, /permissions:\n\s+actions: read\n\s+contents: read/);
  assert.doesNotMatch(indexJob, /actions\/cache\/save@/);
  assert.match(
    indexJob,
    /Upload activity snapshot[\s\S]*?actions\/upload-artifact@[0-9a-f]{40}[\s\S]*?name: cao-activity-index[\s\S]*?retention-days: 1/,
  );
  assert.match(cacheJob, /needs: index/);
  assert.match(cacheJob, /permissions:\n\s+actions: write\n\s+contents: none/);
  assert.match(
    cacheJob,
    /Download activity snapshot[\s\S]*?actions\/download-artifact@[0-9a-f]{40}[\s\S]*?name: cao-activity-index[\s\S]*?path: \$\{\{ runner\.temp \}\}\/cao-activity[\s\S]*?Save activity cache/,
  );
  assert.doesNotMatch(cacheJob, /actions\/checkout@|activity-app-token|gh aw logs|ingest-jsonl/);
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
    /Hash activity payloads[\s\S]*?sha256sum gh-aw-logs\.jsonl[\s\S]*?sha256sum gh-aw-logs\.sqlite[\s\S]*?> payload-hashes\.json/,
  );
  assert.match(
    cacheJob,
    /Save activity cache[\s\S]*?path: \|[\s\S]*?\$\{\{ runner\.temp \}\}\/cao-activity\/gh-aw-logs\.jsonl[\s\S]*?\$\{\{ runner\.temp \}\}\/cao-activity\/gh-aw-logs\.sqlite[\s\S]*?\$\{\{ runner\.temp \}\}\/cao-activity\/drain3_weights\.json/,
  );
  assert.match(
    workflow,
    /Restore activity cache[\s\S]*?\$\{\{ runner\.temp \}\}\/cao-activity\/drain3_weights\.json[\s\S]*?if \[\[ -f "\$REPORT_DRAIN3_WEIGHTS" \]\][\s\S]*?--drain3-weights "\$REPORT_DRAIN3_WEIGHTS"[\s\S]*?mv "\$REPORT_AIC_CACHE\/drain3_weights\.json" "\$REPORT_DRAIN3_WEIGHTS"/,
  );
  assert.equal((workflow.match(/path: \$\{\{ runner\.temp \}\}\/cao-activity\s*$/gm) || []).length, 1);
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
