import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";

test("streams one million activity rows within a 32 MB JavaScript heap", () => {
  const script = `
    import { adaptCachedGhAwJsonlStream } from "./dashboard/site/src/data/adapters/gh-aw-logs.js";
    const row = JSON.stringify({
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
        created_at: "2026-01-01T00:00:00Z"
      }
    }) + "\\n";
    const chunk = new TextEncoder().encode(row.repeat(100));
    async function* rows() {
      for (let index = 0; index < 10_000; index += 1) yield chunk;
    }
    const result = await adaptCachedGhAwJsonlStream(rows());
    process.stdout.write(JSON.stringify({
      records: result.records,
      runs: result.agenticRuns,
      duplicates: result.duplicateAgenticRunObservations
    }));
  `;
  const result = spawnSync(process.execPath, [
    "--max-old-space-size=32",
    "--input-type=module",
    "-e",
    script,
  ], {
    cwd: process.cwd(),
    encoding: "utf8",
    timeout: 30_000,
  });

  assert.equal(result.signal, null, result.stderr);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), {
    records: 1_000_000,
    runs: 1,
    duplicates: 999_999,
  });
});
