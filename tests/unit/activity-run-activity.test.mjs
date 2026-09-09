import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { runActivity } from "../../activity/run-activity.mjs";

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "activity-run-"));
  const reportRoot = path.join(root, "report");
  await mkdir(reportRoot, { recursive: true });

  const calls = [];
  const logsPath = path.join(root, "logs.mjs");
  const telemetryPath = path.join(root, "telemetry.mjs");
  const indexerPath = path.join(root, "indexer.mjs");
  const controlSettingsPath = path.join(reportRoot, "control-settings.mjs");
  const inventoryPath = path.join(reportRoot, "inventory.mjs");
  const collectorsPath = path.join(reportRoot, "activity-collectors.mjs");
  const callsPath = path.join(root, "calls.json");

  const record = (name) => `
    const fs = await import("node:fs/promises");
    const existing = JSON.parse(await fs.readFile(${JSON.stringify(callsPath)}, "utf8").catch(() => "[]"));
    existing.push({ name: ${JSON.stringify(name)}, args });
    await fs.writeFile(${JSON.stringify(callsPath)}, JSON.stringify(existing));
  `;

  await writeFile(callsPath, "[]");
  await writeFile(logsPath, `
    export async function main(actions, args = []) {
      ${record("logs")}
      return "success";
    }
  `);
  await writeFile(telemetryPath, `
    export async function main(actions, args = []) {
      ${record("telemetry")}
      if (args[0] === "after" && process.env.CAO_TELEMETRY_SHOULD_FAIL === "true") {
        throw new Error("telemetry failure");
      }
    }
  `);
  await writeFile(indexerPath, `
    export async function main(actions, args = []) {
      ${record("indexer")}
    }
  `);
  await writeFile(controlSettingsPath, `
    export async function main(actions, args = []) {
      ${record("control-settings")}
    }
  `);
  await writeFile(inventoryPath, `
    export async function main(actions, args = []) {
      ${record("inventory")}
    }
  `);
  await writeFile(collectorsPath, `
    export async function main(actions, args = []) {
      ${record("activity-collectors")}
    }
  `);

  return { root, reportRoot, logsPath, telemetryPath, indexerPath, callsPath };
}

async function readCalls(callsPath) {
  const fs = await import("node:fs/promises");
  return JSON.parse(await fs.readFile(callsPath, "utf8"));
}

test("runActivity requires the logs, telemetry, and indexer module paths", async () => {
  await assert.rejects(
    () => runActivity({}),
    /ACTIVITY_LOGS, GITHUB_TELEMETRY, ACTIVITY_INDEXER are required/,
  );
});

test("runActivity skips dashboard-only steps when collection is disabled", async () => {
  const item = await fixture();
  const originalEnv = { ...process.env };
  Object.assign(process.env, {
    ACTIVITY_LOGS: item.logsPath,
    GITHUB_TELEMETRY: item.telemetryPath,
    ACTIVITY_INDEXER: item.indexerPath,
    DASHBOARD_COLLECTION: "false",
    RUNNER_TEMP: item.root,
  });
  delete process.env.DASHBOARD_REPORT_ROOT;
  try {
    await runActivity({});
    const calls = await readCalls(item.callsPath);
    assert.deepEqual(calls.map((call) => call.name), ["logs", "telemetry", "telemetry", "indexer"]);
    assert.equal(calls[1].args[0], "prepare");
    assert.equal(calls[2].args[0], "after");
    assert.equal(calls[2].args[2], "success");
  } finally {
    for (const key of Object.keys(process.env)) {
      if (!(key in originalEnv)) delete process.env[key];
    }
    Object.assign(process.env, originalEnv);
  }
});

test("runActivity runs dashboard collection steps in order when enabled", async () => {
  const item = await fixture();
  const originalEnv = { ...process.env };
  Object.assign(process.env, {
    ACTIVITY_LOGS: item.logsPath,
    GITHUB_TELEMETRY: item.telemetryPath,
    ACTIVITY_INDEXER: item.indexerPath,
    DASHBOARD_REPORT_ROOT: item.reportRoot,
    DASHBOARD_COLLECTION: "true",
    RUNNER_TEMP: item.root,
  });
  try {
    await runActivity({});
    const calls = await readCalls(item.callsPath);
    assert.deepEqual(calls.map((call) => call.name), [
      "logs",
      "telemetry",
      "telemetry",
      "control-settings",
      "inventory",
      "indexer",
      "activity-collectors",
    ]);
  } finally {
    for (const key of Object.keys(process.env)) {
      if (!(key in originalEnv)) delete process.env[key];
    }
    Object.assign(process.env, originalEnv);
  }
});

test("runActivity swallows telemetry recording failures without stopping the run", async () => {
  const item = await fixture();
  const originalEnv = { ...process.env };
  Object.assign(process.env, {
    ACTIVITY_LOGS: item.logsPath,
    GITHUB_TELEMETRY: item.telemetryPath,
    ACTIVITY_INDEXER: item.indexerPath,
    DASHBOARD_COLLECTION: "false",
    CAO_TELEMETRY_SHOULD_FAIL: "true",
    RUNNER_TEMP: item.root,
  });
  delete process.env.DASHBOARD_REPORT_ROOT;
  try {
    await runActivity({});
    const calls = await readCalls(item.callsPath);
    assert.deepEqual(calls.map((call) => call.name), ["logs", "telemetry", "telemetry", "indexer"]);
  } finally {
    for (const key of Object.keys(process.env)) {
      if (!(key in originalEnv)) delete process.env[key];
    }
    Object.assign(process.env, originalEnv);
  }
});
