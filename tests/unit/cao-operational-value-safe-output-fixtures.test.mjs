import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { nativeSafeOutputFixtureModule, safeOutputFixtureEvidence } from "../../scripts/native-safe-output-fixture-value.mjs";
import { scoreSchemaUsage } from "../../scripts/native-schema-coverage-value.mjs";
import { censusDigest, readCensusJson } from "../../scripts/operational-value-census-io.mjs";

test("fixture coverage counts validated registered declarations, not config keys or invalid examples", () => {
  const state = { schema: "schema", registry: "registry", properties: ["create-issue", "add-comment"],
    examples: [{ blob: "valid", fact: "valid-proof" }, { blob: "invalid", fact: "invalid-proof" }] };
  const facts = new Map([
    ["valid-proof", { schema: "schema", blob: "valid", valid: true,
      safeOutputProperties: ["create-issue", "env", "staged"] }],
    ["invalid-proof", { schema: "schema", blob: "invalid", valid: false, safeOutputProperties: [] }],
  ]);
  const evidence = safeOutputFixtureEvidence(state, facts);
  assert.equal(scoreSchemaUsage("uncovered-properties", evidence), 1);
  assert.equal(scoreSchemaUsage("covered-properties", evidence), 1);
  assert.equal(scoreSchemaUsage("coverage-percent", evidence), 50);
  assert.equal(evidence.validExamples, 1);
  assert.equal(evidence.compilerTestAcceptance, "not-measured");
  assert.equal(evidence.runtimeExercise, "not-measured");
  assert.equal(evidence.workflowContribution, "not-measured");
  assert.throws(() => safeOutputFixtureEvidence(state, new Map()), /proof/);
  const malformed = new Map(facts);
  malformed.set("invalid-proof", { ...facts.get("invalid-proof"), safeOutputProperties: ["add-comment"] });
  assert.throws(() => safeOutputFixtureEvidence(state, malformed), /proof/);
});

test("same-revision historical fixture proofs independently reproduce the complete native series", () => {
  const directory = "docs/operational-value/proof/safe-output-fixtures";
  const index = readCensusJson(`${directory}/index.json.gz`);
  const facts = new Map(index.partitions.flatMap(part => {
    const rows = readCensusJson(`${directory}/${part.file}`);
    assert.equal(censusDigest(rows), part.sha256);
    assert.equal(rows.length, part.count);
    return rows.map(row => [row.id, row]);
  }));
  assert.equal(index.states.length, 32);
  assert.equal(facts.size, 6437);
  const [contract] = readCensusJson(`${directory}/contracts.json`);
  const module = nativeSafeOutputFixtureModule(contract);
  const timeline = JSON.parse(readFileSync(
    `docs/operational-value/proof/reports/github-gh-aw/${contract.workflowId}-timeline.json`, "utf8"));
  const replay = module.collectBatch(timeline.snapshots.map(snapshot => ({
    repository: contract.repository, windowStart: snapshot.window.startAt,
    windowEnd: snapshot.window.endAt, observedAt: snapshot.observedAt,
  })));
  for (const [position, snapshot] of timeline.snapshots.entries()) {
    const state = index.states.find(row => row.windowEnd === snapshot.window.endAt);
    assert.equal(state.excludedModes, 0);
    assert.ok(state.examples.every(source => /^pkg\/cli\/workflows\/test-[^/]+\.md$/.test(source.path)));
    const registry = new Set(state.registeredTools.map(name => name.replaceAll("_", "-")));
    assert.ok(state.properties.every(name => registry.has(name)));
    const declarations = new Set(state.examples.flatMap(source => {
      const fact = facts.get(source.fact);
      return fact.valid ? fact.safeOutputProperties : [];
    }));
    const covered = state.properties.filter(name => declarations.has(name)).length;
    assert.equal(snapshot.metrics["uncovered-properties"], state.properties.length - covered);
    assert.equal(snapshot.metrics["covered-properties"], covered);
    assert.equal(snapshot.metrics["coverage-percent"], 100 * covered / state.properties.length);
    assert.deepEqual(snapshot.evidence, replay[position].evidence);
  }
  assert.equal(timeline.snapshots[0].metrics["uncovered-properties"], 2);
  assert.equal(timeline.snapshots.at(-1).metrics["uncovered-properties"], 1);
  assert.equal(timeline.snapshots.at(-1).evidence.eligibleCount, 59);
  assert.equal(timeline.snapshots.at(-1).evidence.validExamples, 215);
});
