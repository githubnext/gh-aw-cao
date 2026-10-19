import assert from "node:assert/strict";
import test from "node:test";
import { cacheFallbackRepairs, cacheStrategyFacts } from "../../scripts/native-cache-strategy-value.mjs";

const action = `actions/cache/restore@${"a".repeat(40)}`;
const source = "---\ntools:\n  cache-memory: true\n---\nGoal";
const compiled = (fallback = "") => `jobs:
  agent:
    runs-on: ubuntu-latest
    steps:
      - name: Restore memory
        uses: ${action}
        with:
          path: /tmp/gh-aw/cache-memory
          key: memory-\${{ github.workflow }}-\${{ github.run_id }}
${fallback ? `          restore-keys: ${JSON.stringify(fallback)}\n` : ""}`;
const facts = text => cacheStrategyFacts(source, text);
const assess = (before, after, actions = [action]) => cacheFallbackRepairs(facts(before), facts(after), actions);

test("adding an exact stable prefix repairs only the declared structural cache facet", () => {
  const result = assess(compiled(), compiled("memory-${{ github.workflow }}-"));
  assert.equal(result.accepted.length, 1);
  assert.equal(result.accepted[0].identity, "agent:Restore memory");
  assert.equal(result.accepted[0].restorePrefix, "memory-${{ github.workflow }}-");
});

test("existing last-one-wins fallback is not a cold-start misconfiguration", () => {
  const value = compiled("memory-${{ github.workflow }}-");
  const result = assess(value, value);
  assert.equal(result.accepted.length, 0);
  assert.equal(result.rejected[0].reason, "already-has-fallback");
});

test("empty, unrelated and still run-unique fallbacks do not repair the condition", () => {
  for (const value of ["", "unrelated-", "memory-${{ github.workflow }}-${{ github.run_id }}"]) {
    assert.equal(assess(compiled(), compiled(value)).accepted.length, 0);
  }
});

test("source eligibility and the actual cache-memory path are required", () => {
  const ineligible = cacheStrategyFacts(source.replace("cache-memory: true", "cache-memory: false"), compiled());
  assert.equal(cacheFallbackRepairs(ineligible, facts(compiled("memory-${{ github.workflow }}-")), [action]).applicable, false);
  const other = compiled().replace("/tmp/gh-aw/cache-memory", "/tmp/other");
  assert.equal(facts(other).restorations.length, 0);
});

test("unresolved mutable prefix expressions and multiple run tokens stay unsupported", () => {
  for (const expression of ["steps.compute.outputs.key", "env.UNKNOWN", "github.run_number"]) {
    const before = compiled().replace("github.workflow", expression);
    const after = compiled(`memory-\${{ ${expression} }}-`).replace("github.workflow", expression);
    assert.equal(assess(before, after).accepted.length, 0);
  }
  const before = compiled().replace("github.workflow", "github.run_id");
  assert.equal(assess(before, compiled("memory-")).accepted.length, 0);
});

test("changed key, path, action or execution conditions cannot masquerade as one fallback repair", () => {
  const after = compiled("memory-${{ github.workflow }}-");
  for (const changed of [
    after.replace("runs-on: ubuntu-latest", "runs-on: windows-latest"),
    after.replace("name: Restore memory", "name: Restore memory\n        if: false"),
    after.replace("key: memory-", "key: changed-memory-"),
    after.replace("/tmp/gh-aw/cache-memory", "/tmp/other"),
    after.replace("a".repeat(40), "b".repeat(40)),
  ]) assert.equal(assess(compiled(), changed).accepted.length, 0);
  assert.equal(assess(compiled(), after, []).accepted.length, 0);
});

test("invalid YAML, duplicate identities, aliases and unpinned action versions fail explicitly", () => {
  assert.throws(() => facts("jobs: [\n"), /Invalid native YAML/);
  assert.throws(() => facts(compiled().replace(action, "actions/cache/restore@v6")), /Unpinned cache action/);
  const duplicate = compiled() + compiled().split("    steps:\n")[1];
  assert.throws(() => facts(duplicate), /Ambiguous restoration identity/);
  assert.throws(() => facts(compiled() + "    extra: *unknown\n"));
});
