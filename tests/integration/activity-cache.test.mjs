import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

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
    /Save activity cache[\s\S]*?path: \|[\s\S]*?\$\{\{ runner\.temp \}\}\/cao-activity\/gh-aw-logs\.jsonl[\s\S]*?\$\{\{ runner\.temp \}\}\/cao-activity\/gh-aw-logs\.sqlite/,
  );
  assert.doesNotMatch(workflow, /path: \$\{\{ runner\.temp \}\}\/cao-activity\s*$/m);
  assert.doesNotMatch(workflow, /Skip scheduled run|steps\.freshness/);
  assert.match(workflow, /ACTIVITY_DATABASE: \$\{\{ runner\.temp \}\}\/cao-activity\/gh-aw-logs\.sqlite/);
  assert.doesNotMatch(workflow, /Install SQLite|apt-get install.*sqlite3/);
  assert.match(workflow, /--count 1000/);
  assert.match(workflow, /--timeout 5/);
  assert.match(workflow, /ingest-jsonl[\s\S]*?--run-retention-days all[\s\S]*?doctor[\s\S]*?--run-ttl-days all/);
  assert.doesNotMatch(
    workflow,
    /github-script|run-activity\.mjs|REPORT_GH_AW_LOGS_STATE|REPORT_DEPLOYED_WORKFLOWS|REPORT_RECORDS/,
  );
});
