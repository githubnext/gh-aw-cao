import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { schemaReferenceProbes } from "../../scripts/collect-schema-reference-history.mjs";
import { scanSchemaReferences, scoreSchemaReferences } from "../../scripts/native-schema-reference-value.mjs";
import { censusDigest, readCensusJson } from "../../scripts/operational-value-census-io.mjs";
import { parsePublicLfsPointer, verifyPublicGitBlob } from "../../scripts/immutable-public-git-source.mjs";

const directory = "docs/operational-value/proof/schema-references";
const hash = bytes => createHash("sha256").update(bytes).digest("hex");
const native = { known: true, definitions: ["used", "unused"], usedDefinitions: ["used"],
  unusedDefinitions: ["unused"], referenceCount: 1, unresolvedReferences: [], schemaNodes: 4 };

test("native schema quantities retain distinct native units without inventing optional-field defects", () => {
  const evidence = { valid: true, native };
  assert.equal(scoreSchemaReferences("unused-root-definitions", evidence), 1);
  assert.equal(scoreSchemaReferences("unresolved-local-references", evidence), 0);
  assert.equal(scanSchemaReferences(evidence).definitions, 2);
  assert.equal(scanSchemaReferences(evidence).references, 1);
  assert.throws(() => scoreSchemaReferences("objects-without-required", evidence), /Unknown/);
});

test("schema scoring refuses incomplete or contradictory native receipts", () => {
  for (const evidence of [{ valid: false, native }, { valid: true, native: { known: false } },
    { valid: true, native: { ...native, definitions: ["used", "used"] } },
    { valid: true, native: { ...native, usedDefinitions: ["other"] } },
    { valid: true, native: { ...native, unusedDefinitions: ["used"] } },
    { valid: true, native: { ...native, referenceCount: "one" } },
    { valid: true, native: { ...native, referenceCount: 0, unresolvedReferences: [{ at: "#", reference: "#/missing" }] } }]) {
    assert.equal(scoreSchemaReferences("unused-root-definitions", evidence), null);
    assert.equal(scoreSchemaReferences("unresolved-local-references", evidence), null);
  }
});

test("retained native probes cover escaped pointers, cycles, annotations, ref siblings and refused scopes", () => {
  const probe = readCensusJson(`${directory}/probe.json.gz`), index = readCensusJson(`${directory}/index.json`);
  assert.deepEqual(probe.inputs, schemaReferenceProbes);
  assert.equal(censusDigest(probe), index.probeSha256);
  assert.equal(probe.oracleSha256, hash(readFileSync("scripts/operational-value-schema-references.py")));
  assert.equal(probe.toolSha256, censusDigest(readCensusJson(`${directory}/tool.json.gz`)));
  assert.equal(probe.response.facts.length, 15);
  for (const [i, fact] of probe.response.facts.entries()) {
    const input = probe.inputs[i];
    assert.equal(fact.id, input.id);
    if (input.expected === null) {
      assert.equal(fact.known, false);
      assert.ok(fact.reason);
    } else {
      assert.equal(fact.known, true);
      assert.deepEqual([fact.unusedDefinitions.length, fact.unresolvedReferences.length], input.expected);
      assert.equal(scoreSchemaReferences("unused-root-definitions", { valid: true, native: fact }), input.expected[0]);
      assert.equal(scoreSchemaReferences("unresolved-local-references", { valid: true, native: fact }), input.expected[1]);
    }
  }
});

test("shared schema acquisition retains byte-verified source closure and separate goal contracts", async () => {
  const contracts = readCensusJson(`${directory}/contracts.json`), index = readCensusJson(`${directory}/index.json`);
  const facts = readCensusJson(`${directory}/facts.json.gz`);
  assert.equal(censusDigest(facts), index.factsSha256);
  assert.deepEqual(contracts.map(censusDigest), index.contracts);
  assert.equal(index.producer.sha256, hash(readFileSync(index.producer.path)));
  const originals = new Set();
  for (const source of index.sources) {
    const raw = readCensusJson(`${directory}/sources/${source.gitBlob}.json.gz`);
    assert.equal(censusDigest(raw), source.sha256);
    const git = Buffer.from(raw.native, "base64"), bytes = Buffer.from(raw.content, "base64");
    verifyPublicGitBlob(git, source.gitBlob);
    assert.deepEqual(parsePublicLfsPointer(git), raw.lfs);
    assert.equal(hash(bytes), raw.sha256);
    if (raw.lfs) {
      assert.equal(bytes.length, raw.lfs.size);
      assert.equal(hash(bytes), raw.lfs.oid);
    } else assert.ok(git.equals(bytes));
    originals.add(source.gitBlob);
  }
  assert.ok(facts.features.every(fact => originals.has(fact.id)));
  assert.ok(facts.states.every(state => state.schemaGitBlob === null || originals.has(state.schemaGitBlob)));
  assert.ok(facts.states.length > 50);
  assert.equal(new Set(contracts.map(contract => contract.primaryMetric)).size, 2);
  for (const contract of contracts) {
    assert.ok(originals.has(contract.sourceGitBlob));
    const { definition, collectBatch } = await import(`../../docs/operational-value/proof/functions/${contract.workflowId}.mjs`);
    const states = facts.states.filter(state => state.windowEnd >= contract.adoption.adoptedAt);
    const rows = collectBatch(states.map(state => ({ windowEnd: state.windowEnd })));
    assert.ok(rows.length > 10);
    assert.ok(rows.some(row => row.evidence.coverageStatus === "complete"));
    assert.ok(rows.some(row => Number.isFinite(scoreSchemaReferences(contract.primaryMetric, row.evidence))));
    assert.equal(definition.metrics.find(metric => metric.role === "primary").id, contract.primaryMetric);
    assert.equal(rows.at(-1).evidence.requiredFieldCorrectness, "not-measured");
    assert.equal(rows.at(-1).evidence.workflowCausation, "not-measured");
    assert.equal(rows.at(-1).evidence.fullGoalAcceptance, "not-measured");
  }
});
