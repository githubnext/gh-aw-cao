import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { schemaExampleFacts } from "../../scripts/collect-schema-usage-history.mjs";
import { nativeSchemaCoverageModule, schemaUsageEvidence, scoreSchemaUsage } from "../../scripts/native-schema-coverage-value.mjs";
import { censusDigest, readCensusJson } from "../../scripts/operational-value-census-io.mjs";

test("schema examples use real root frontmatter rather than prose or nested/fenced key mentions", () => {
  const fact = schemaExampleFacts({ id: "example", content: "---\non: push\nmetadata:\n  private: true\n---\n```yaml\nengine: fake\n```" });
  assert.equal(fact.status, "parsed");
  assert.deepEqual(Object.keys(fact.data).sort(), ["metadata", "on"]);
  assert.equal(schemaExampleFacts({ id: "body", content: "# Document\non: push\nengine: fake" }).status, "no-frontmatter");
  assert.equal(schemaExampleFacts({ id: "bad", content: "---\non: push\non: pull_request\n---\n" }).status, "invalid-yaml");
  assert.throws(() => schemaExampleFacts({ id: "nan", content: "---\nmax-turns: .inf\n---\n" }), /Non-JSON/);
});

test("only independent schema-valid usages supply native property credit", () => {
  const state = { schema: "schema", properties: ["on", "engine", "private"], examples: [
    { path: "valid.md", blob: "valid", fact: "proof-valid" },
    { path: "invalid.md", blob: "invalid", fact: "proof-invalid" },
    { path: "copy.md", blob: "valid", fact: "proof-valid" },
  ] };
  const facts = new Map([
    ["proof-valid", { schema: "schema", blob: "valid", valid: true, properties: ["on", "engine"] }],
    ["proof-invalid", { schema: "schema", blob: "invalid", valid: false, properties: [] }],
  ]);
  const evidence = schemaUsageEvidence(state, facts);
  assert.equal(evidence.validExamples, 2);
  assert.equal(evidence.examplesChecked, 3);
  assert.equal(scoreSchemaUsage("uncovered-properties", evidence), 1);
  assert.equal(scoreSchemaUsage("covered-properties", evidence), 2);
  assert.equal(scoreSchemaUsage("coverage-percent", evidence), 200 / 3);
  assert.throws(() => schemaUsageEvidence(state, new Map()), /proof/);
  const malformed = new Map(facts);
  malformed.set("proof-invalid", { ...facts.get("proof-invalid"), properties: ["private"] });
  assert.throws(() => schemaUsageEvidence(state, malformed), /proof/);
});

test("schema counts reject impossible, missing and malformed native outcomes", () => {
  const evidence = { valid: true, eligibleCount: 3, coveredProperties: 2, uncoveredProperties: 1,
    examplesChecked: 2, validExamples: 1 };
  assert.equal(scoreSchemaUsage("uncovered-properties", evidence), 1);
  assert.equal(scoreSchemaUsage("uncovered-properties", { ...evidence, coveredProperties: 3 }), null);
  assert.equal(scoreSchemaUsage("uncovered-properties", { ...evidence, validExamples: 0 }), null);
  assert.equal(scoreSchemaUsage("covered-properties", { ...evidence, valid: false }), null);
  assert.equal(scoreSchemaUsage("covered-properties", { ...evidence, eligibleCount: 0 }), null);
});

test("retained historical schema proofs independently reproduce every native observation", () => {
  const directory = "docs/operational-value/proof/schema-usage";
  const index = readCensusJson(`${directory}/index.json.gz`);
  const facts = new Map(index.partitions.flatMap(part => {
    const rows = readCensusJson(`${directory}/${part.file}`);
    assert.equal(censusDigest(rows), part.sha256);
    assert.equal(rows.length, part.count);
    return rows.map(row => [row.id, row]);
  }));
  assert.equal(index.states.length, 32);
  assert.equal(facts.size, 12188);
  const [contract] = readCensusJson(`${directory}/contracts.json`);
  const module = nativeSchemaCoverageModule(contract);
  const timeline = JSON.parse(readFileSync(
    `docs/operational-value/proof/reports/github-gh-aw/${contract.workflowId}-timeline.json`, "utf8"));
  const replay = module.collectBatch(timeline.snapshots.map(snapshot => ({
    repository: contract.repository, windowStart: snapshot.window.startAt,
    windowEnd: snapshot.window.endAt, observedAt: snapshot.observedAt,
  })));
  for (const [position, snapshot] of timeline.snapshots.entries()) {
    const state = index.states.find(row => row.windowEnd === snapshot.window.endAt);
    assert.equal(state.excludedModes, 0);
    const properties = new Set(state.examples.flatMap(source =>
      facts.get(source.fact).valid ? facts.get(source.fact).properties : []));
    assert.equal(snapshot.metrics["uncovered-properties"], state.properties.length - properties.size);
    assert.equal(snapshot.metrics["covered-properties"], properties.size);
    assert.equal(snapshot.metrics["coverage-percent"], 100 * properties.size / state.properties.length);
    assert.deepEqual(snapshot.evidence, replay[position].evidence);
  }
  assert.equal(timeline.snapshots[0].metrics["uncovered-properties"], 19);
  assert.equal(timeline.snapshots.at(-1).metrics["uncovered-properties"], 6);
  assert.equal(timeline.snapshots.at(-1).evidence.examplesChecked, 515);
});
