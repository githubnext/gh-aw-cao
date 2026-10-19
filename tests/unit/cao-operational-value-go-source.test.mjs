import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { goBlockerEffect, nativeGoSourceModule, scoreGoSourceMetric } from "../../scripts/native-go-source-value.mjs";
import { goSourceValueEvents } from "../../scripts/build-go-source-value-events.mjs";
import { readGoHistory } from "../../scripts/measure-go-native-history.mjs";
import { readCensusJson } from "../../scripts/operational-value-census-io.mjs";

const fact = (lines, extra = {}) => ({ lines, syntaxValid: true, generated: false, ...extra });
test("structural progress uses the actual >1000 boundary and cannot hide a moved blocker", () => {
  assert.equal(goBlockerEffect(fact(1001), fact(1000), 1000), 1);
  assert.equal(goBlockerEffect(fact(1000), fact(999), 1000), 0);
  assert.equal(goBlockerEffect(fact(1000), fact(1001), 1000), -1);
  assert.equal(goBlockerEffect(fact(1200), null, 1000) + goBlockerEffect(null, fact(1200), 1000), 0);
  assert.equal(goBlockerEffect(fact(1200), fact(900, { generated: true }), 1000), 0);
  assert.equal(goBlockerEffect(fact(1200), fact(900, { syntaxValid: false }), 1000), 1);
  assert.throws(() => goBlockerEffect(fact("1200"), fact(900), 1000), /Malformed/);
  assert.throws(() => goBlockerEffect(fact(1200), fact(900), 0), /threshold/);
});

test("source scoring preserves known native work without pretending unknown source effects are zero", () => {
  const evidence = { valid: true, linksComplete: true,
    events: [{ id: "known", value: 2, linked: true }, { id: "unknown", value: null, linked: true }] };
  assert.equal(scoreGoSourceMetric("native-net", evidence), null);
  assert.equal(scoreGoSourceMetric("corroborated-net", evidence), null);
  assert.equal(scoreGoSourceMetric("observed-native-net", evidence), 2);
  assert.equal(scoreGoSourceMetric("observed-linked-net", evidence), 2);
  const onlyUnknown = { ...evidence, events: evidence.events.slice(1) };
  assert.equal(scoreGoSourceMetric("observed-native-net", onlyUnknown), null);
  assert.equal(scoreGoSourceMetric("observed-native-net", { ...onlyUnknown, knownFileAssessments: 1 }), 0);
  assert.equal(scoreGoSourceMetric("native-net", { ...evidence, valid: false }), null);
  assert.equal(scoreGoSourceMetric("native-net", { ...evidence, events: [evidence.events[0], evidence.events[0]] }), null);
  assert.equal(scoreGoSourceMetric("native-net", { ...evidence, events: [{ id: "bad", value: "2", linked: true }] }), null);
  assert.equal(scoreGoSourceMetric("corroborated-net", { valid: true, linksComplete: false, events: [] }), null);
});

test("lifetime native functions start at verified source additions, not a shallow Git boundary", () => {
  const contracts = readCensusJson("docs/operational-value/proof/go-source-lifetime/contracts.json");
  assert.equal(contracts.find(row => row.workflowId === "tidy").adoption.adoptedAt, "2025-09-26T11:14:38Z");
  assert.equal(contracts.find(row => row.workflowId === "architecture-guardian").adoption.adoptedAt, "2026-04-08T17:05:30Z");
  for (const contract of contracts) {
    assert.notEqual(contract.adoption.commit, "870215a79912f85171230e5ffac272a2e0d406d6");
    assert.throws(() => nativeGoSourceModule({ ...contract, nativeModelSha256: "0".repeat(64) }), /Frozen/);
  }
});

test("both source evaluations replay shared immutable facts and publish the same native ledgers", () => {
  const native = readGoHistory("docs/operational-value/proof/go-source-lifetime");
  const facts = new Map(native.features.map(row => [row.id, row]));
  for (const contract of readCensusJson("docs/operational-value/proof/go-source-lifetime/contracts.json")) {
    const module = nativeGoSourceModule(contract);
    const input = goSourceValueEvents(contract);
    const [{ evidence }] = module.collectBatch([{ repository: contract.repository,
      windowStart: contract.adoption.adoptedAt, windowEnd: contract.until, observedAt: input.observedAt }]);
    const history = native.evaluated.filter(row => row.at >= contract.adoption.adoptedAt && row.at < contract.until);
    let independentlyObserved = 0;
    for (const commit of history) for (const file of commit.files) {
      if (contract.facet === "exact-gofmt") independentlyObserved += file.formatting?.value ?? 0;
      else if (!file.path.endsWith("_test.go")
        && [file.beforeMode, file.afterMode].every(mode => ["000000", "100644", "100755"].includes(mode))) {
        const before = facts.get(file.beforeBlob), after = facts.get(file.afterBlob);
        if (before?.generated || after?.generated) continue;
        independentlyObserved += Number(Boolean(before && before.lines > 1000)) - Number(Boolean(after && after.lines > 1000));
      }
    }
    assert.equal(module.scoreMetric("observed-native-net", evidence), independentlyObserved);
    assert.equal(input.nativeContext.observedRepositoryNet, independentlyObserved);
    assert.deepEqual(input, JSON.parse(readFileSync(
      `docs/operational-value/proof/reports/${contract.workflowId}-value-events.json`, "utf8")));
    assert.equal(input.events.reduce((sum, row) => sum + row.value, 0), module.scoreMetric("observed-linked-net", evidence));
  }
});
