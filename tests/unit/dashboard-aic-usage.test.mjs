import assert from "node:assert/strict";
import { chmod, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import test from "node:test";

const execFileAsync = promisify(execFile);

test("AI Credit usage collection preserves workflow data payloads", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "dashboard-aic-usage-"));
  const bin = path.join(root, "bin");
  const inventoryPath = path.join(root, "deployed-workflows.json");
  const outputPath = path.join(root, "aic-usage.json");
  const cachePath = path.join(root, "cache");
  const argumentsPath = path.join(root, "gh-arguments.json");
  await mkdir(bin);
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
  const ghPath = path.join(bin, "gh");
  await writeFile(ghPath, `#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
const args = process.argv.slice(2);
fs.writeFileSync(process.env.GH_ARGS_PATH, JSON.stringify(args));
const output = args[args.indexOf("--output") + 1];
fs.mkdirSync(path.join(output, "run-42", "evals"), { recursive: true });
fs.writeFileSync(path.join(output, "run-42", "evals", "evals.jsonl"),
  JSON.stringify({ id: "quality", answer: "YES", runid: "42", timestamp: "2026-08-30T10:05:00Z" }) + "\\n");
process.stdout.write(JSON.stringify({
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
      by_model: { "gpt-5": { reasoning_tokens: 7 } }
    },
    experiments: {
      assignments: { prompt: "candidate" },
      cumulative_counts: { prompt: { control: 2, candidate: 3 } }
    },
    graders: {
      results: [{ id: "quality", name: "Quality", status: "pass", value: 0.9, direction: "maximize", threshold: 0.8 }]
    }
  }]
}));
`);
  await chmod(ghPath, 0o755);

  try {
    await execFileAsync(process.execPath, [
      path.resolve("dashboard/report/aic-usage.mjs"),
    ], {
      cwd: path.resolve("."),
      env: {
        ...process.env,
        PATH: `${bin}:${process.env.PATH}`,
        REPORT_DEPLOYED_WORKFLOWS: inventoryPath,
        REPORT_AIC_USAGE: outputPath,
        REPORT_AIC_CACHE: cachePath,
        GH_ARGS_PATH: argumentsPath,
      },
    });
    const usage = JSON.parse(await readFile(outputPath, "utf8"));
    assert.equal(usage.schemaVersion, 5);
    const argumentsList = JSON.parse(await readFile(argumentsPath, "utf8"));
    assert.deepEqual(argumentsList.slice(argumentsList.indexOf("--artifacts"), argumentsList.indexOf("--artifacts") + 2), [
      "--artifacts",
      "usage,agent,detection,evals,experiment,firewall,graders,mcp",
    ]);
    assert.deepEqual(argumentsList.slice(argumentsList.indexOf("--start-date"), argumentsList.indexOf("--start-date") + 2), [
      "--start-date",
      "-30d",
    ]);
    assert.equal(
      Date.parse(usage.firewallRequestedHorizonEnd) - Date.parse(usage.firewallRequestedHorizonStart),
      30 * 24 * 60 * 60 * 1000,
    );
    assert.deepEqual(usage.runs[0].data, {
      findings: [{ severity: "high", total: 3 }],
    });
    assert.equal(usage.securityRuns[0].logsPayload.run_id, undefined);
    assert.equal(usage.securityRuns[0].logsPayload.database_id, 42);
    assert.deepEqual(usage.runs[0].tokenUsage, {
      inputTokens: 100,
      outputTokens: 20,
      cacheReadTokens: 50,
      cacheWriteTokens: 10,
      reasoningTokens: 7,
    });
    assert.deepEqual(usage.securityRuns[0].evals, [{
      id: "quality",
      answer: "YES",
      runId: "42",
      timestamp: "2026-08-30T10:05:00Z",
    }]);
    assert.deepEqual({
      safeItemsCount: usage.runs[0].safeItemsCount,
      noopCount: usage.runs[0].noopCount,
      missingDataCount: usage.runs[0].missingDataCount,
      missingToolCount: usage.runs[0].missingToolCount,
      reportIncompleteCount: usage.runs[0].reportIncompleteCount,
    }, {
      safeItemsCount: 4,
      noopCount: 1,
      missingDataCount: 2,
      missingToolCount: 3,
      reportIncompleteCount: 1,
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
