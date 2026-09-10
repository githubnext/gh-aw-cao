import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

test("operational-value collection processes the shared gh-aw logs JSONL", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "dashboard-operational-values-"));
  const inventoryPath = path.join(root, "deployed-workflows.json");
  const logsPath = path.join(root, "gh-aw-logs.jsonl");
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
  await writeFile(logsPath, JSON.stringify({ schema_version: 2, kind: "run", run: {
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
  } }) + "\n");

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
    assert.equal(output.collectionMode, "logs-jsonl");
    assert.equal(output.complete, true);
    assert.equal(output.observedRuns, 1);
    assert.equal(output.records[0].runAttempt, 2);
    assert.equal(output.records[0].observationSource, "logs-jsonl");
    assert.equal(output.records[0].value, 0.8);
    assert.equal(output.definitions[0].operationalValue, "Ship a verified outcome.");
    assert.deepEqual(output.definitions[0].diagnosticMetrics, [{ id: "quality" }]);
    assert.deepEqual(JSON.parse(await readFile(cachePath, "utf8")), output);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("operational-value collection defaults its cache to the output path when REPORT_VALUE_CACHE is unset", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "dashboard-operational-values-"));
  const inventoryPath = path.join(root, "deployed-workflows.json");
  const logsPath = path.join(root, "gh-aw-logs.jsonl");
  const outputPath = path.join(root, "operational-values.json");
  const inventory = {
    runHealth: { windowStart: "2026-09-01T00:00:00Z" },
    workflows: [{
      repository: "githubnext/gh-aw-cao",
      path: ".github/workflows/example.lock.yml",
      operationalValue: true,
      runHealth: {
        runIds: [42],
        runRecords: [{ runId: 42, runAttempt: 1, createdAt: "2026-09-05T10:00:00Z" }],
      },
    }],
  };
  await writeFile(inventoryPath, JSON.stringify(inventory));
  await writeFile(logsPath, JSON.stringify({ schema_version: 2, kind: "run", run: {
      database_id: 42,
      graders: {
        results: [{
          id: "operational-value",
          source: "operational-value",
          status: "pass",
          value: 0.8,
          implementation: { digest: "digest", definition: {} },
          observation: { evidenceAt: "2026-09-06T10:00:00Z" },
        }],
      },
  } }) + "\n");

  const run = () => execFileAsync(process.execPath, [
    path.resolve("dashboard/report/operational-values.mjs"),
  ], {
    cwd: path.resolve("."),
    env: {
      ...process.env,
      REPORT_DEPLOYED_WORKFLOWS: inventoryPath,
      REPORT_GH_AW_LOGS: logsPath,
      REPORT_OPERATIONAL_VALUES: outputPath,
    },
  });

  try {
    await run();
    const firstOutput = JSON.parse(await readFile(outputPath, "utf8"));
    assert.equal(firstOutput.observedRuns, 1);

    // A second collection whose logs JSON is unreadable must not clear the
    // previously observed record, since REPORT_VALUE_CACHE was never set and
    // the output path itself must serve as the incremental cache.
    await writeFile(logsPath, "not-json");
    await run();
    const secondOutput = JSON.parse(await readFile(outputPath, "utf8"));
    assert.equal(secondOutput.observedRuns, 1);
    assert.equal(secondOutput.records[0].value, 0.8);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("operational-value collection treats non-array graders.results as no result", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "dashboard-operational-values-"));
  const inventoryPath = path.join(root, "deployed-workflows.json");
  const logsPath = path.join(root, "gh-aw-logs.jsonl");
  const outputPath = path.join(root, "operational-values.json");
  await writeFile(inventoryPath, JSON.stringify({
    runHealth: { windowStart: "2026-09-01T00:00:00Z" },
    workflows: [{
      repository: "githubnext/gh-aw-cao",
      path: ".github/workflows/example.lock.yml",
      operationalValue: true,
      runHealth: {
        runIds: [42],
        runRecords: [{ runId: 42, runAttempt: 1, createdAt: "2026-09-05T10:00:00Z" }],
      },
    }],
  }));
  await writeFile(logsPath, JSON.stringify({ schema_version: 2, kind: "run", run: {
      database_id: 42,
      // Simulates schema drift/partial data where graders.results is not an array.
      graders: { results: null },
  } }) + "\n");

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
      },
    });
    const output = JSON.parse(await readFile(outputPath, "utf8"));
    assert.equal(output.complete, false);
    assert.equal(output.records[0].status, "unavailable");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("operational-value collection ignores malformed diagnostics entries instead of crashing", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "dashboard-operational-values-"));
  const inventoryPath = path.join(root, "deployed-workflows.json");
  const logsPath = path.join(root, "gh-aw-logs.jsonl");
  const outputPath = path.join(root, "operational-values.json");
  await writeFile(inventoryPath, JSON.stringify({
    runHealth: { windowStart: "2026-09-01T00:00:00Z" },
    workflows: [{
      repository: "githubnext/gh-aw-cao",
      path: ".github/workflows/example.lock.yml",
      operationalValue: true,
      runHealth: {
        runIds: [42],
        runRecords: [{ runId: 42, runAttempt: 1, createdAt: "2026-09-05T10:00:00Z" }],
      },
    }],
  }));
  await writeFile(logsPath, JSON.stringify({ schema_version: 2, kind: "run", run: {
      database_id: 42,
      graders: {
        results: [{
          id: "operational-value",
          source: "operational-value",
          status: "pass",
          value: 0.8,
          implementation: {
            digest: "digest",
            // Simulates schema drift/external input where diagnostics entries
            // are not all well-formed objects with a `metric` property.
            definition: {
              operationalValue: "Ship a verified outcome.",
              baseline: { mode: "attainment-only" },
              diagnostics: [null, "unexpected-string", 5, { metric: { id: "quality" } }],
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
  } }) + "\n");

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
      },
    });
    const output = JSON.parse(await readFile(outputPath, "utf8"));
    assert.equal(output.records[0].status, "pass");
    assert.deepEqual(output.definitions[0].diagnosticMetrics, [{ id: "quality" }]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("operational-value collection degrades to an empty snapshot when the shared logs JSONL is unreadable", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "dashboard-operational-values-"));
  const inventoryPath = path.join(root, "deployed-workflows.json");
  const logsPath = path.join(root, "gh-aw-logs.jsonl");
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
        runRecords: [{ runId: 42, runAttempt: 1, createdAt: "2026-09-05T10:00:00Z" }],
      },
    }],
  }));
  // Malformed logs JSONL must not crash the collector
  // when a prior cache exists to drive output completeness.
  await writeFile(logsPath, JSON.stringify({ schema_version: 2, kind: "run", run: { notRuns: [] } }));
  await writeFile(cachePath, JSON.stringify({
    schemaVersion: 1,
    records: [{
      schemaVersion: 1,
      repository: "githubnext/gh-aw-cao",
      workflowId: "example",
      workflowPath: ".github/workflows/example.lock.yml",
      runId: 42,
      runAttempt: 1,
      status: "pass",
      value: 0.8,
      evaluatorDigest: "digest",
      observation: { evidenceAt: "2026-09-05T10:00:00Z", mature: true },
      observationSource: "logs-jsonl",
    }],
    definitions: [],
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
    assert.equal(output.records[0].value, 0.8);
    assert.equal(output.records[0].status, "pass");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
