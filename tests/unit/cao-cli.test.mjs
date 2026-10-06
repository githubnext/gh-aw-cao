import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { readFile, readdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import test from "node:test";
import { commandHandlers } from "../../activity/commands/index.mjs";

const executeFile = promisify(execFile);
const campaignJsonUrl = new URL("../../package.json", import.meta.url);
const campaignJson = JSON.parse(
  await readFile(campaignJsonUrl, "utf8"),
);
const cao = fileURLToPath(new URL(campaignJson.bin.cao, campaignJsonUrl));

test("keeps every CAO command in its own command module", async () => {
  const commandsUrl = new URL("../../activity/commands/", import.meta.url);
  const moduleNames = (await readdir(commandsUrl))
    .filter((file) => file !== "index.mjs")
    .map((file) => file.replace(/\.mjs$/, ""))
    .sort();
  assert.deepEqual(moduleNames, [...commandHandlers.keys()].sort());
});

test("reports a missing cao add campaign without a stack trace", async () => {
  let error;
  try {
    await executeFile(process.execPath, [cao, "add"]);
  } catch (caught) {
    error = caught;
  }
  assert.ok(error);
  assert.equal(error.code, 1);
  assert.equal(error.stdout, "");
  assert.equal(error.stderr, "Error: cao add requires a campaign\n");
  assert.doesNotMatch(error.stderr, /\n\s+at /);
});

test("reports a missing cao enable campaign without a stack trace", async () => {
  let error;
  try {
    await executeFile(process.execPath, [cao, "enable"]);
  } catch (caught) {
    error = caught;
  }
  assert.ok(error);
  assert.equal(error.code, 1);
  assert.equal(error.stdout, "");
  assert.equal(error.stderr, "Error: cao enable requires at least one campaign\n");
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
      return true;
    },
  );
});
