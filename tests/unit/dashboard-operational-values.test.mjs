import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

test("operational-value collection processes the shared gh-aw logs JSON", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "dashboard-operational-values-"));
  const inventoryPath = path.join(root, "deployed-workflows.json");
  const logsPath = path.join(root, "gh-aw-logs.json");
  const outputPath = path.join(root, "operational-values.json");
  const cachePath = path.join(root, "observations.json");
  await writeFile(inventoryPath, JSON.stringify({
    runHealth: { windowStart: "2026-09-01T00:00:00Z" },
    workflows: [{
      repository: "githubnext/gh-aw-cao",
      path: ".github/workflows/example.lock.yml",
      operationalValue: true,
      runHealth: {
        runIds: [42],
        runRecords: [{ runId: 42, runAttempt: 2, createdAt: "2026-09-05T10:00:00Z" }],
      },
    }],
  }));
  await writeFile(logsPath, JSON.stringify({
    runs: [{
      database_id: 42,
      graders: {
        results: [{
          id: "operational-value",
          source: "operational-value",
          status: "pass",
          value: 0.8,
          implementation: {
            digest: "digest",
            definition: {
              operationalValue: "Ship a verified outcome.",
              baseline: { mode: "attainment-only" },
              diagnostics: [{ metric: { id: "quality" } }],
            },
          },
          observation: {
            evidenceAt: "2026-09-06T10:00:00Z",
            maturesAt: "2026-09-06T10:00:00Z",
            mature: true,
          },
          diagnostics: { quality: 0.8 },
        }],
      },
    }],
  }));

  try {
    await execFileAsync(process.execPath, [
      path.resolve("dashboard/report/operational-values.mjs"),
    ], {
      cwd: path.resolve("."),
      env: {
        ...process.env,
        REPORT_DEPLOYED_WORKFLOWS: inventoryPath,
        REPORT_GH_AW_LOGS: logsPath,
        REPORT_OPERATIONAL_VALUES: outputPath,
        REPORT_VALUE_CACHE: cachePath,
      },
    });
    const output = JSON.parse(await readFile(outputPath, "utf8"));
    assert.equal(output.collectionMode, "logs-json");
    assert.equal(output.complete, true);
    assert.equal(output.observedRuns, 1);
    assert.equal(output.records[0].runAttempt, 2);
    assert.equal(output.records[0].observationSource, "logs-json");
    assert.equal(output.records[0].value, 0.8);
    assert.equal(output.definitions[0].operationalValue, "Ship a verified outcome.");
    assert.deepEqual(output.definitions[0].diagnosticMetrics, [{ id: "quality" }]);
    assert.deepEqual(JSON.parse(await readFile(cachePath, "utf8")), output);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
