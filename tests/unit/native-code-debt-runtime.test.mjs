import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";
import { assertRuntimeParity, preservedRuntime } from "../../scripts/refresh-native-code-debt-runtime.mjs";

const directory = "docs/operational-value/proof/native-code-debt";
const read = file => JSON.parse(readFileSync(file));
const hash = bytes => createHash("sha256").update(bytes).digest("hex");

test("runtime refresh preserves the exact previous closure and every native acceptance dependency", () => {
  const files = preservedRuntime();
  const previous = JSON.parse(files.get(`${directory}/instrument-lock.json`));
  const current = read(`${directory}/instrument-lock.json`);
  assert.equal(hash(files.get(`${directory}/instrument-lock.json`)),
    current.runtimeRefresh.predecessorLockSha256);
  const permitted = new Set([...current.runtimeRefresh.changedHelpers, `${directory}/replay-baseline.json`]);
  assert.deepEqual(current.files.map(row => row.path), previous.files.map(row => row.path));
  for (const member of previous.files) {
    const actual = current.files.find(row => row.path === member.path);
    if (!permitted.has(member.path)) assert.deepEqual(actual, member);
    assert.equal(hash(readFileSync(member.path)), actual.sha256);
    if (files.has(member.path)) assert.equal(hash(files.get(member.path)), member.sha256);
  }
});

test("whole-timeline reconciliation permits identity refresh but rejects changed native facts or missingness", () => {
  const files = preservedRuntime(), lock = read(`${directory}/instrument-lock.json`);
  for (const slug of ["code-simplifier", "daily-code-debt-aider"]) {
    const file = `${directory}/reports/github-gh-aw/${slug}-timeline.json`;
    const previous = JSON.parse(files.get(file)), current = read(file);
    assertRuntimeParity(previous, current, lock);
    const changed = structuredClone(current);
    changed.snapshots[0].metrics["native-partial"] = 99;
    assert.throws(() => assertRuntimeParity(previous, changed, lock), /Native facts or timeline changed/);
    const foreignRuntime = structuredClone(current);
    foreignRuntime.valueFunction.definition.evidence.interpreterBindings.pop();
    assert.throws(() => assertRuntimeParity(previous, foreignRuntime, lock));
  }
});
