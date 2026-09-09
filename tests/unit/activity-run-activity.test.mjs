import assert from "node:assert/strict";
import { access, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
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
    assert.deepEqual(calls.map((call) => call.name), ["telemetry", "telemetry", "logs", "telemetry", "indexer"]);
    assert.equal(calls[0].args[0], "prepare");
    assert.equal(calls[1].args[0], "before");
    assert.equal(calls[3].args[0], "after");
    assert.equal(calls[3].args[2], "success");
  } finally {
    for (const key of Object.keys(process.env)) {
      if (!(key in originalEnv)) delete process.env[key];
    }
    Object.assign(process.env, originalEnv);
  }
});

test("runActivity removes cached agent directories before collecting logs", async () => {
  const item = await fixture();
  const originalEnv = { ...process.env };
  const cachePath = path.join(item.root, "gh-aw-logs");
  const agentPath = path.join(cachePath, "run-42", "agent");
  const agentFilePath = path.join(cachePath, "run-43", "agent");
  const retainedPath = path.join(cachePath, "run-42", "usage", "usage.json");
  const unrelatedPath = path.join(cachePath, "agent", "retained.json");
  await mkdir(agentPath, { recursive: true });
  await mkdir(path.dirname(agentFilePath), { recursive: true });
  await mkdir(path.dirname(retainedPath), { recursive: true });
  await mkdir(path.dirname(unrelatedPath), { recursive: true });
  await writeFile(path.join(agentPath, "events.jsonl"), '{"large":"entry"}\n');
  await writeFile(agentFilePath, "not a directory\n");
  await writeFile(retainedPath, '{"usage":1}\n');
  await writeFile(unrelatedPath, '{"retained":true}\n');
  await writeFile(item.logsPath, `
    export async function main(actions, args = []) {
      const fs = await import("node:fs/promises");
      await fs.access(${JSON.stringify(agentPath)}).then(
        () => { throw new Error("agent directory still exists"); },
        (error) => { if (error.code !== "ENOENT") throw error; },
      );
    }
  `);
  Object.assign(process.env, {
    ACTIVITY_LOGS: item.logsPath,
    GITHUB_TELEMETRY: item.telemetryPath,
    ACTIVITY_INDEXER: item.indexerPath,
    DASHBOARD_COLLECTION: "false",
    REPORT_AIC_CACHE: cachePath,
    RUNNER_TEMP: item.root,
  });
  delete process.env.DASHBOARD_REPORT_ROOT;
  const messages = [];
  const originalConsoleLog = console.log;
  console.log = (message) => messages.push(message);
  try {
    await runActivity({ core: { info: () => { throw new Error("core.info should not be called"); } } });
    await assert.rejects(access(agentPath), { code: "ENOENT" });
    assert.equal(await readFile(agentFilePath, "utf8"), "not a directory\n");
    assert.equal(await readFile(retainedPath, "utf8"), '{"usage":1}\n');
    assert.equal(await readFile(unrelatedPath, "utf8"), '{"retained":true}\n');
    assert.deepEqual(messages, ["Removed cached agent logs from run-42"]);
  } finally {
    console.log = originalConsoleLog;
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
      "telemetry",
      "telemetry",
      "logs",
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
    assert.deepEqual(calls.map((call) => call.name), ["telemetry", "telemetry", "logs", "telemetry", "indexer"]);
  } finally {
    for (const key of Object.keys(process.env)) {
      if (!(key in originalEnv)) delete process.env[key];
    }
    Object.assign(process.env, originalEnv);
  }
});
