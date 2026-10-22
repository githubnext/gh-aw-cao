import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { readFile, readdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import test from "node:test";
import { commandHandlers } from "../../activity/commands/index.mjs";
import * as caoApi from "../../activity/cao.mjs";

const executeFile = promisify(execFile);
const campaignJsonUrl = new URL("../../package.json", import.meta.url);
const campaignJson = JSON.parse(
  await readFile(campaignJsonUrl, "utf8"),
);
const cao = fileURLToPath(new URL(campaignJson.bin.cao, campaignJsonUrl));

test("preserves CAO public exports from their focused implementation modules", async () => {
  const exportsByModule = {
    "cli/activity-stats": ["activityWorkflowStats"],
    "cli/dashboard": ["discoverWorkflows", "pruneDashboardFile", "analyzeDashboardComplexityFile"],
    "cli/download": ["downloadDeployedDashboardData"],
    "cli/ingestion": ["ingestGhAwLogDirectory"],
    "cli/issue-status": ["issueStatusQuery", "updateIssueStatuses"],
    "cli/jsonl": ["compactJsonlShards"],
    "cli/queries": ["queryCanonicalData", "queryGhData"],
    "cli/run": ["runCli"],
  };
  assert.deepEqual(Object.keys(caoApi).sort(), Object.values(exportsByModule).flat().sort());
  await Promise.all(Object.entries(exportsByModule).map(async ([module, names]) => {
    const implementation = await import(`../../activity/${module}.mjs`);
    for (const name of names) {
      assert.equal(typeof caoApi[name], "function");
      assert.equal(caoApi[name], implementation[name], `${name} must be re-exported without a wrapper`);
    }
  }));
});

test("keeps the executable entry point small and implementation modules independent of it", async () => {
  const source = await readFile(cao, "utf8");
  assert.ok(source.split("\n").length <= 150, "cao.mjs must remain a thin executable entry point");
  const cliUrl = new URL("../../activity/cli/", import.meta.url);
  const modules = (await readdir(cliUrl)).filter((file) => file.endsWith(".mjs"));
  assert.ok(modules.length > 0);
  await Promise.all(modules.map(async (module) => {
    const implementation = await readFile(new URL(module, cliUrl), "utf8");
    assert.doesNotMatch(implementation, /(?:from\s*|import\s*\()\s*['"][^'"]*\/cao\.mjs['"]/);
  }));
});

test("importing the CAO entry point does not execute the CLI", async () => {
  const { stdout, stderr } = await executeFile(process.execPath, [
    "--input-type=module", "-e", `await import(${JSON.stringify(cao)})`,
  ]);
  assert.equal(stdout, "");
  assert.equal(stderr, "");
});

test("keeps every CAO command in its own command module", async () => {
  const commandsUrl = new URL("../../activity/commands/", import.meta.url);
  const moduleNames = (await readdir(commandsUrl))
    .filter((file) => file !== "index.mjs")
    .map((file) => file.replace(/\.mjs$/, ""))
    .sort();
  assert.deepEqual(moduleNames, [...commandHandlers.keys()].sort());
});

test("quickstart is not registered or advertised by the Node CLI", async () => {
  assert.equal(commandHandlers.has("quickstart"), false);
  assert.doesNotMatch(await caoApi.runCli(["--help"]), /quickstart/i);
  for (const args of [
    ["quickstart"], ["quickstart", "--help"], ["quickstart", "--json"],
    ["quickstart", "--step", "run"], ["quickstart", "--step", "collect"],
    ["quickstart", "--step", "dashboard"], ["quickstart", "--target", "owner/repo"],
    ["quickstart", "--wait", "--target", "owner/repo"],
  ]) {
    await assert.rejects(executeFile(process.execPath, [cao, ...args]), (error) => {
      assert.equal(error.code, 1);
      assert.equal(error.stdout, "");
      assert.equal(error.stderr, "Error: Unknown command: quickstart\n");
      return true;
    });
  }
});

test("reports retired cao add without a stack trace", async () => {
  let error;
  try {
    await executeFile(process.execPath, [cao, "add"]);
  } catch (caught) {
    error = caught;
  }
  assert.ok(error);
  assert.equal(error.code, 1);
  assert.equal(error.stdout, "");
  assert.equal(error.stderr, "Error: Node cao add has been retired; use gh cao campaigns add CAMPAIGN (repository enrollment: gh cao repos add OWNER/REPO)\n");
  assert.doesNotMatch(error.stderr, /\n\s+at /);
});

test("reports retired cao enable without a stack trace", async () => {
  let error;
  try {
    await executeFile(process.execPath, [cao, "enable"]);
  } catch (caught) {
    error = caught;
  }
  assert.ok(error);
  assert.equal(error.code, 1);
  assert.equal(error.stdout, "");
  assert.equal(error.stderr, "Error: Node cao enable has been retired; use gh cao campaigns enable\n");
  assert.doesNotMatch(error.stderr, /\n\s+at /);
});

test("prints help only when requested", async () => {
  const { stdout, stderr } = await executeFile(process.execPath, [cao, "--help"]);
  assert.match(stdout, /^Usage:\n/);
  assert.match(stdout, /\n  cao ingest-jsonl\b/);
  assert.equal(stderr, "");
});

test("reports a runtime failure without appending help", async () => {
  await assert.rejects(
    executeFile(process.execPath, [cao, "download", "--url", "file:///cao.json"]),
    (error) => {
      assert.equal(error.code, 1);
      assert.equal(error.stdout, "");
      assert.match(error.stderr, /Dashboard data URL must use HTTP or HTTPS/);
      assert.doesNotMatch(error.stderr, /Usage:|cao init/);
      assert.doesNotMatch(error.stderr, /\n\s+at /);
      return true;
    },
  );
});
