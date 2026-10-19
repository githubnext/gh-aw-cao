import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { runOperationalValueBenchmark } from "../../scripts/benchmark-operational-value.mjs";
import { corpus } from "../fixtures/operational-value-benchmark/corpus.mjs";

test("the operational-value corpus balances real workflow intents, non-gh-aw inputs and explicit design boundaries", () => {
  assert.equal(corpus.length, 10);
  assert.equal(new Set(corpus.map(item => item.id)).size, corpus.length);
  assert.equal(corpus.filter(item => item.source?.startsWith(".github/workflows/")).length, 6);
  assert.equal(corpus.filter(item => !item.source).length, 3);
  assert.equal(corpus.filter(item => item.disposition === "measurable").length, 7);
  for (const item of corpus) {
    if (item.source) {
      const source = readFileSync(path.resolve(import.meta.dirname, "../..", item.source), "utf8");
      assert.ok(source.includes(item.grounding), `${item.id} must retain its intent-source grounding`);
    }
    if (item.disposition !== "measurable") assert.ok(item.reason);
  }
});

test("the offline operational-value benchmark satisfies independent score and temporal oracles", async () => {
  const result = await runOperationalValueBenchmark();
  assert.equal(result.generativeTranslationEvaluated, false);
  assert.equal(result.totals.failed, 0, JSON.stringify(result.checks.filter(check => !check.passed), null, 2));
  assert.equal(result.totals.executableContracts, 7);
  assert.equal(result.totals.designOnlyCases, 3);
  assert.equal(result.categories["temporal-comparison"].total, 79);
  assert.equal(result.categories["value-review"].passed, 79);
  assert.equal(result.categories["mutation-probe"].passed, 5);
  assert.match(result.corpusFingerprint, /^[0-9a-f]{64}$/);
  const receipt = JSON.parse(readFileSync(path.resolve(import.meta.dirname,
    "../../docs/operational-value/benchmark-results.json"), "utf8"));
  assert.deepEqual(result.totals, receipt.totals, "refresh the paper's results receipt after changing the benchmark");
  assert.deepEqual(result.categories, receipt.categories);
  assert.equal(result.corpusFingerprint, receipt.corpusFingerprint, "the measured source fingerprints must match the paper's receipt");
});
