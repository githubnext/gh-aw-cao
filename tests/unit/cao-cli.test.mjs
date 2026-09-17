import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";

const executeFile = promisify(execFile);
const packageJson = JSON.parse(
  await readFile(new URL("../../package.json", import.meta.url), "utf8"),
);
const cao = path.resolve(packageJson.bin.cao);

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
