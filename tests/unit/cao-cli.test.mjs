import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import test from "node:test";

const executeFile = promisify(execFile);
const packageJsonUrl = new URL("../../package.json", import.meta.url);
const packageJson = JSON.parse(
  await readFile(packageJsonUrl, "utf8"),
);
const cao = fileURLToPath(new URL(packageJson.bin.cao, packageJsonUrl));

test("reports a missing cao add package without a stack trace", async () => {
  let error;
  try {
    await executeFile(process.execPath, [cao, "add"]);
  } catch (caught) {
    error = caught;
  }
  assert.ok(error);
  assert.equal(error.code, 1);
  assert.equal(error.stdout, "");
  assert.match(error.stderr, /^Error: cao add requires a package\n\n/);
  assert.match(error.stderr, /\n  cao add PACKAGE\b/);
  assert.doesNotMatch(error.stderr, /\n\s+at /);
});

test("reports a missing cao enable package without a stack trace", async () => {
  let error;
  try {
    await executeFile(process.execPath, [cao, "enable"]);
  } catch (caught) {
    error = caught;
  }
  assert.ok(error);
  assert.equal(error.code, 1);
  assert.equal(error.stdout, "");
  assert.match(error.stderr, /^Error: cao enable requires at least one package\n\n/);
  assert.match(error.stderr, /\n  cao enable PACKAGE\.\.\./);
  assert.doesNotMatch(error.stderr, /\n\s+at /);
});
