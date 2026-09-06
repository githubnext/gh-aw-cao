import assert from "node:assert/strict";
import { chmod, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import test from "node:test";
import { buildDashboardLanguageSources } from "../../dashboard/report/dashboard-language-sources.mjs";

const execFileAsync = promisify(execFile);

test("AI Credit usage collection preserves workflow data payloads", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "dashboard-aic-usage-"));
  const bin = path.join(root, "bin");
  const inventoryPath = path.join(root, "deployed-workflows.json");
  const outputPath = path.join(root, "aic-usage.json");
  const cachePath = path.join(root, "cache");
  const argumentsPath = path.join(root, "gh-arguments.json");
  const invocationsPath = path.join(root, "gh-invocations.jsonl");
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
    }, {
      repository: "githubnext/gh-aw-cao",
      path: ".github/workflows/other.lock.yml",
      name: "Other",
      runHealth: {
        runIds: [43],
        runRecords: [{ runId: 43, conclusion: "success" }],
      },
    }],
  }));
  const ghPath = path.join(bin, "gh");
  await writeFile(ghPath, `#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
const args = process.argv.slice(2);
fs.writeFileSync(process.env.GH_ARGS_PATH, JSON.stringify(args));
fs.appendFileSync(process.env.GH_INVOCATIONS_PATH, JSON.stringify(args) + "\\n");
const output = args[args.indexOf("--output") + 1];
fs.mkdirSync(path.join(output, "run-42", "evals"), { recursive: true });
fs.writeFileSync(path.join(output, "run-42", "evals", "evals.jsonl"),
  JSON.stringify({ id: "quality", answer: "YES", runid: "42", timestamp: "2026-08-30T10:05:00Z" }) + "\\n");
process.stdout.write(JSON.stringify({
  runs: [{
    run_id: 42,
    workflow_name: "Data from logs",
    created_at: "2026-08-30T10:00:00Z",
    engine: "copilot",
    engine_version: "0.87.9",
    requested_model: "gpt-5",
    resolved_model: "gpt-5-mini",
    agent_runtime: "gvisor",
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
    },
    conversation: {
      turns: [
        { role: "user", content: "Review the repository." },
        { role: "assistant", content: "Review complete.", tool_calls: [{ name: "search", arguments: { query: "TODO" } }] }
      ]
    },
    future_field: { retained: true }
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
        GH_INVOCATIONS_PATH: invocationsPath,
      },
    });
    const usage = JSON.parse(await readFile(outputPath, "utf8"));
    assert.equal(usage.schemaVersion, 5);
    const argumentsList = JSON.parse(await readFile(argumentsPath, "utf8"));
    const invocations = (await readFile(invocationsPath, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
    assert.equal(invocations.length, 1);
    assert.ok(argumentsList.includes("githubnext/gh-aw-cao/.github/workflows/data.lock.yml"));
    assert.ok(argumentsList.includes("githubnext/gh-aw-cao/.github/workflows/other.lock.yml"));
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
    const expectedLogsPayload = {
      run_id: 42,
      workflow_name: "Data from logs",
      created_at: "2026-08-30T10:00:00Z",
      engine: "copilot",
      engine_version: "0.87.9",
      requested_model: "gpt-5",
      resolved_model: "gpt-5-mini",
      agent_runtime: "gvisor",
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
      experiments: {
        assignments: { prompt: "candidate" },
        cumulative_counts: { prompt: { control: 2, candidate: 3 } },
      },
      graders: {
        results: [{ id: "quality", name: "Quality", status: "pass", value: 0.9, direction: "maximize", threshold: 0.8 }],
      },
      conversation: {
        turns: [
          { role: "user", content: "Review the repository." },
          { role: "assistant", content: "Review complete.", tool_calls: [{ name: "search", arguments: { query: "TODO" } }] },
        ],
      },
      future_field: { retained: true },
    };
    assert.deepEqual(usage.runs[0].logsPayload, expectedLogsPayload);
    assert.deepEqual(usage.securityRuns[0].logsPayload, expectedLogsPayload);
    assert.deepEqual({
      workflowName: usage.runs[0].workflowName,
      createdAt: usage.runs[0].createdAt,
      engine: usage.runs[0].engine,
      engineVersion: usage.runs[0].engineVersion,
      requestedModel: usage.runs[0].requestedModel,
      resolvedModel: usage.runs[0].resolvedModel,
      agentRuntime: usage.runs[0].agentRuntime,
      aic: usage.runs[0].aic,
    }, {
      workflowName: "Data from logs",
      createdAt: "2026-08-30T10:00:00Z",
      engine: "copilot",
      engineVersion: "0.87.9",
      requestedModel: "gpt-5",
      resolvedModel: "gpt-5-mini",
      agentRuntime: "gvisor",
      aic: 2.5,
    });
    const sources = buildDashboardLanguageSources({
      deployed: {
        generatedAt: "2026-08-30T11:00:00Z",
        discovery: { complete: true },
        runHealth: { available: true, complete: true, windowHours: 24 },
        bundles: [],
        workflows: [{
          repository: "githubnext/gh-aw-cao",
          path: ".github/workflows/data.lock.yml",
          name: "Data",
          state: "active",
          runHealth: { runRecords: [{
            runId: 42,
            status: "completed",
            conclusion: "success",
            startedAt: "2026-08-30T10:00:00Z",
            updatedAt: "2026-08-30T10:05:00Z",
          }] },
        }],
      },
      usage,
      operationalValues: { records: [], complete: true },
      report: { generatedAt: "2026-08-30T11:00:00Z", records: [] },
    });
    assert.deepEqual(sources.runs.rows[0]["logs-payload"], expectedLogsPayload);
    assert.deepEqual(sources.runs.rows[0].data, expectedLogsPayload.data);
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

test("dashboard specification declares every interpreted gh aw logs run member", async () => {
  const specification = await readFile(
    path.resolve("docs/dashboard-language-specification.md"),
    "utf8",
  );
  const schemaSection = specification.match(
    /The following schema identifies every `gh aw logs --json` run member[\s\S]*?(?=\n- \*\*DLS-SEM-029:)/,
  )?.[0];
  assert.ok(schemaSection, "dashboard log schema section is present");

  const documentedPaths = [...schemaSection.matchAll(/\| [^|\n]+ \| ((?:`[^`]+`(?:, )?)+) \|/g)]
    .flatMap(([, paths]) => [...paths.matchAll(/`([^`]+)`/g)].map(([, member]) => member));
  assert.deepEqual(documentedPaths, [
    "database_id", "run_id", "id",
    "workflow_name", "workflow",
    "created_at", "started_at",
    "engine", "agentic_engine", "agent_engine",
    "engine_version", "agentic_engine_version", "agent_engine_version", "agent_version",
    "requested_model", "requestedModel", "model", "model_name",
    "resolved_model", "resolvedModel", "model_resolved", "model",
    "agent_runtime", "agentRuntime",
    "aic",
    "safe_items_count",
    "noop_count",
    "missing_data_count",
    "missing_tool_count",
    "report_incomplete_count",
    "data",
    "token_usage_summary.total_input_tokens",
    "token_usage_summary.total_output_tokens",
    "token_usage_summary.total_cache_read_tokens",
    "token_usage_summary.total_cache_write_tokens",
    "token_usage_summary.by_model.*.reasoning_tokens",
    "experiments.assignments",
    "graders.results",
  ]);
});
