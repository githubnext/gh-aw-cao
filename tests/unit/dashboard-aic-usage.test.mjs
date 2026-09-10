import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import test from "node:test";
import { readRunTimeline } from "../../dashboard/report/aic-usage.mjs";

const execFileAsync = promisify(execFile);

test("AI Credit usage collection processes the shared logs snapshot without invoking gh", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "dashboard-aic-usage-"));
  const inventoryPath = path.join(root, "deployed-workflows.json");
  const outputPath = path.join(root, "aic-usage.json");
  const logsPath = path.join(root, "gh-aw-logs.jsonl");
  const cachePath = path.join(root, "cache");
  const runPath = path.join(cachePath, "repo-githubnext-gh-aw-cao", "workflow-data", "run-42");
  await mkdir(path.join(runPath, "evals"), { recursive: true });
  await mkdir(path.join(runPath, "sandbox", "firewall", "logs"), { recursive: true });
  await writeFile(path.join(runPath, "evals", "evals.jsonl"),
    `${JSON.stringify({ id: "quality", answer: "YES", runid: "42", timestamp: "2026-08-30T10:05:00Z" })}\n`);
  await writeFile(path.join(runPath, "sandbox", "firewall", "logs", "audit.jsonl"),
    `${JSON.stringify({ ts: 1788084300, host: "api.github.com:443", method: "CONNECT", status: 200, decision: "TCP_TUNNEL:HIER_DIRECT" })}\n`);
  await writeFile(path.join(runPath, "aw_info.json"), JSON.stringify({
    engine_id: "copilot",
    engine_name: "Copilot CLI",
    agent_version: "1.2.3",
    agent_runtime: "node20",
    model: "gpt-5",
    version: "0.89.1",
    cli_version: "0.89.1",
    awf_version: "0.28.12",
    awmg_version: "0.10.0",
    workflow_name: "Data",
  }));
  await writeFile(path.join(runPath, "audit.json"), JSON.stringify({
    metrics: { duration_ms: 12_000 },
  }));
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
  await writeFile(logsPath, JSON.stringify({ schema_version: 2, kind: "run", run: {
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
  } }) + "\n");

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
    assert.equal(usage.runs[0].engine, "copilot");
    assert.equal(usage.runs[0].resolvedModel, "gpt-5");
    assert.equal(usage.runs[0].ghAwVersion, "0.89.1");
    assert.deepEqual(usage.runs[0].data, { findings: [{ severity: "high", total: 3 }] });
    assert.equal(usage.securityRuns[0].logsPayload.database_id, 42);
    assert.equal(usage.securityRuns[0].security.agentInfo.agentVersion, "1.2.3");
    assert.deepEqual(usage.securityRuns[0].security.audit.metrics, { duration_ms: 12_000 });
    assert.deepEqual(usage.securityRuns[0].evals, [{
      id: "quality",
      answer: "YES",
      runId: "42",
      timestamp: "2026-08-30T10:05:00Z",
    }]);
    assert.deepEqual(usage.securityRuns[0].timeline.map((event) => [event.source, event.type]), [
      ["firewall", "net_allowed"],
    ]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("AI Credit timeline uses compact summary tool calls and skips checkout evidence", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "dashboard-aic-timeline-"));
  const runPath = path.join(root, "run-43");
  await mkdir(path.join(runPath, "base"), { recursive: true });
  await writeFile(path.join(runPath, "run_summary.json"), JSON.stringify({
    mcp_tool_usage: {
      tool_calls: [{
        timestamp: "2026-09-03T05:01:00Z",
        server_name: "github",
        tool_name: "get_file",
        status: "success",
      }],
    },
  }));
  await writeFile(path.join(runPath, "base", "gateway.jsonl"), "not evidence\n");
  try {
    const timeline = await readRunTimeline(root, 43, "session-43");
    assert.deepEqual(timeline.map((event) => ({
      source: event.source,
      type: event.type,
      summary: event.summary,
      status: event.status,
    })), [{
      source: "gateway",
      type: "tool_call",
      summary: "github/get_file",
      status: "success",
    }]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("AI Credit usage collection reports an unreadable shared snapshot as unavailable", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "dashboard-aic-usage-"));
  const inventoryPath = path.join(root, "deployed-workflows.json");
  const outputPath = path.join(root, "aic-usage.json");
  const statePath = path.join(root, "gh-aw-logs-state.json");
  await writeFile(inventoryPath, JSON.stringify({
    workflows: [{
      repository: "githubnext/gh-aw-cao",
      path: ".github/workflows/data.lock.yml",
      name: "Data",
      runHealth: { runIds: [42] },
    }],
  }));
  await writeFile(outputPath, JSON.stringify({
    schemaVersion: 5,
    firewallLastSuccessfulCollectionAt: "2026-09-05T12:00:00Z",
    runs: [],
    securityRuns: [],
  }));
  await writeFile(statePath, '{"available":false}\n');
  try {
    await execFileAsync(process.execPath, [path.resolve("dashboard/report/aic-usage.mjs")], {
      cwd: path.resolve("."),
      env: {
        ...process.env,
        REPORT_DEPLOYED_WORKFLOWS: inventoryPath,
        REPORT_AIC_USAGE: outputPath,
        REPORT_GH_AW_LOGS: path.join(root, "missing.json"),
        REPORT_GH_AW_LOGS_STATE: statePath,
      },
    });
    const usage = JSON.parse(await readFile(outputPath, "utf8"));
    assert.equal(usage.repositories[0].available, false);
    assert.equal(usage.firewallLastSuccessfulCollectionAt, "2026-09-05T12:00:00Z");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
