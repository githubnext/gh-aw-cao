import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import test from "node:test";

const executeFile = promisify(execFile);
const campaignJsonUrl = new URL("../../package.json", import.meta.url);
const campaignJson = JSON.parse(
  await readFile(campaignJsonUrl, "utf8"),
);
const cao = fileURLToPath(new URL(campaignJson.bin.cao, campaignJsonUrl));

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
  assert.match(error.stderr, /^Error: cao add requires a campaign\n\n/);
  assert.match(error.stderr, /\n  cao add CAMPAIGN\b/);
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
  assert.match(error.stderr, /^Error: cao enable requires at least one campaign\n\n/);
  assert.match(error.stderr, /\n  cao enable CAMPAIGN\.\.\./);
  assert.doesNotMatch(error.stderr, /\n\s+at /);
});
