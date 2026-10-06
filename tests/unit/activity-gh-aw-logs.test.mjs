import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  iterateGhAwLogShards,
  parseGhAwLogsJsonl,
  readGhAwLogShards,
  serializeGhAwLogsJsonl,
} from "../../activity/gh-aw-logs.mjs";

test("Activity run readers retain schema-v2 and schema-v4 runs in mixed shards", async () => {
  const runs = [{ run_id: 303 }, { run_id: 404 }];
  const content = [
    { schema_version: 2, kind: "run", run: runs[0] },
    { schema_version: 4, kind: "workflow_runs", payload: [] },
    { schema_version: 4, kind: "run", run: runs[1] },
    { schema_version: 5, kind: "run", run: { run_id: 505 } },
  ].map((envelope) => JSON.stringify(envelope)).join("\n") + "\n";
  assert.deepEqual(parseGhAwLogsJsonl(content), runs);
  assert.deepEqual(parseGhAwLogsJsonl(serializeGhAwLogsJsonl(runs)), runs);
  const root = await mkdtemp(path.join(os.tmpdir(), "activity-gh-aw-logs-"));
  try {
    await writeFile(path.join(root, "mixed.jsonl"), content);
    assert.deepEqual(await readGhAwLogShards(root), runs);
    const streamed = [];
    for await (const run of iterateGhAwLogShards(root)) streamed.push(run);
    assert.deepEqual(streamed, runs);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
