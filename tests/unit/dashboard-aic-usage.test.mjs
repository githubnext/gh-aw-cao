import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import test from "node:test";

const execFileAsync = promisify(execFile);

test("AI Credit usage collection processes the shared logs snapshot without invoking gh", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "dashboard-aic-usage-"));
  const inventoryPath = path.join(root, "deployed-workflows.json");
  const outputPath = path.join(root, "aic-usage.json");
  const logsPath = path.join(root, "gh-aw-logs.json");
  const cachePath = path.join(root, "cache");
  await mkdir(path.join(cachePath, "run-42", "evals"), { recursive: true });
  await writeFile(path.join(cachePath, "run-42", "evals", "evals.jsonl"),
    `${JSON.stringify({ id: "quality", answer: "YES", runid: "42", timestamp: "2026-08-30T10:05:00Z" })}\n`);
  await writeFile(inventoryPath, JSON.stringify({
    runHealth: { windowHours: 24 },
    workflows: [{
      repository: "githubnext/gh-aw-cao",
      path: ".github/workflows/data.lock.yml",
      name: "Data",
      runHealth: {
        runIds: [42],
        runRecords: [{ runId: 42, conclusion: "success" }],
      },
    }],
  }));
  await writeFile(logsPath, JSON.stringify({
    runs: [{
      database_id: 42,
      aic: 2.5,
      safe_items_count: 4,
      noop_count: 1,
      missing_data_count: 2,
      missing_tool_count: 3,
      report_incomplete_count: 1,
      data: { findings: [{ severity: "high", total: 3 }] },
      token_usage_summary: {
        total_input_tokens: 100,
        total_output_tokens: 20,
        total_cache_read_tokens: 50,
        total_cache_write_tokens: 10,
        by_model: { "gpt-5": { reasoning_tokens: 7 } },
      },
    }],
  }));

  try {
    await execFileAsync(process.execPath, [path.resolve("dashboard/report/aic-usage.mjs")], {
      cwd: path.resolve("."),
      env: {
        ...process.env,
        PATH: root,
        REPORT_DEPLOYED_WORKFLOWS: inventoryPath,
        REPORT_AIC_USAGE: outputPath,
        REPORT_AIC_CACHE: cachePath,
        REPORT_GH_AW_LOGS: logsPath,
      },
    });
    const usage = JSON.parse(await readFile(outputPath, "utf8"));
    assert.equal(usage.schemaVersion, 5);
    assert.equal(usage.runs[0].aic, 2.5);
    assert.deepEqual(usage.runs[0].data, { findings: [{ severity: "high", total: 3 }] });
    assert.equal(usage.securityRuns[0].logsPayload.database_id, 42);
    assert.deepEqual(usage.securityRuns[0].evals, [{
      id: "quality",
      answer: "YES",
      runId: "42",
      timestamp: "2026-08-30T10:05:00Z",
    }]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("AI Credit usage collection reports an unreadable shared snapshot as unavailable", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "dashboard-aic-usage-"));
  const inventoryPath = path.join(root, "deployed-workflows.json");
  const outputPath = path.join(root, "aic-usage.json");
  await writeFile(inventoryPath, JSON.stringify({
    workflows: [{
      repository: "githubnext/gh-aw-cao",
      path: ".github/workflows/data.lock.yml",
      name: "Data",
      runHealth: { runIds: [42] },
    }],
  }));
  try {
    await execFileAsync(process.execPath, [path.resolve("dashboard/report/aic-usage.mjs")], {
      cwd: path.resolve("."),
      env: {
        ...process.env,
        REPORT_DEPLOYED_WORKFLOWS: inventoryPath,
        REPORT_AIC_USAGE: outputPath,
        REPORT_GH_AW_LOGS: path.join(root, "missing.json"),
      },
    });
    const usage = JSON.parse(await readFile(outputPath, "utf8"));
    assert.equal(usage.repositories[0].available, false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
