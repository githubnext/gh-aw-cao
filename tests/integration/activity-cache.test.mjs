import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("activity workflow caches only the gh-aw logs JSONL", async () => {
  const workflow = await readFile(".github/workflows/activity.yml", "utf8");

  assert.match(workflow, /--cached-jsonl "\$REPORT_GH_AW_LOGS"/);
  assert.match(
    workflow,
    /Save activity cache[\s\S]*?path: \$\{\{ runner\.temp \}\}\/cao-activity\/gh-aw-logs\.jsonl/,
  );
  assert.doesNotMatch(
    workflow,
    /github-script|run-activity\.mjs|REPORT_GH_AW_LOGS_STATE|REPORT_DEPLOYED_WORKFLOWS|REPORT_RECORDS/,
  );
});
