import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createWriteStream } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { finished } from "node:stream/promises";
import test from "node:test";

test("cao ingests one million cached JSONL rows within a 32 MB JavaScript heap", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "cao-jsonl-load-"));
  const input = path.join(directory, "gh-aw-logs.jsonl");
  const database = path.join(directory, "gh-aw-logs.sqlite");
  const output = createWriteStream(input);
  const row = `${JSON.stringify({
    schema_version: 2,
    kind: "run",
    run: {
      run_id: 1,
      run_attempt: 1,
      organization: "githubnext",
      repository: "gh-aw-cao",
      workflow_name: "Stress",
      workflow_path: ".github/workflows/stress.md",
      status: "completed",
      created_at: "2026-01-01T00:00:00Z",
    },
  })}\n`;
  const chunk = row.repeat(100);
  for (let index = 0; index < 10_000; index += 1) {
    if (!output.write(chunk)) await new Promise((resolve) => output.once("drain", resolve));
  }
  output.end();
  await finished(output);

  try {
    const result = spawnSync(process.execPath, [
      "--max-old-space-size=32",
      "activity/cao.mjs",
      "ingest-jsonl",
      "--database",
      database,
      "--input",
      input,
      "--run-retention-days",
      "all",
    ], {
      cwd: process.cwd(),
      encoding: "utf8",
      timeout: 30_000,
    });

    assert.equal(result.signal, null, result.stderr);
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout).result, {
      updated: true,
      committedBatches: 0,
      committedRecords: 3,
      records: 1_000_000,
      rawPayloadRecords: 0,
      rawRuns: 0,
      agenticRunRecords: 1_000_000,
      agenticRuns: 1,
      duplicateRawRunObservations: 0,
      duplicateAgenticRunObservations: 999_999,
      unenrichedRuns: 0,
      sessions: 1,
      events: 3,
      rateLimits: 0,
      mappedRateLimits: 0,
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
