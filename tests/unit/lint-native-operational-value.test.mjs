import assert from "node:assert/strict";
import test from "node:test";
import { jsFacts, yamlFacts, lintEffect } from "../../scripts/lint-native-oracles.mjs";
import { radixFacts } from "../../scripts/eslint-radix-native.mjs";
import { scoreLintNative } from "../../scripts/lint-native-value.mjs";

test("trusted radix builtin detects only missing global radix arguments", () => {
  assert.equal(radixFacts("parseInt(x); Number.parseInt(x);").defects, 2);
  assert.equal(radixFacts("parseInt(x, 10); Number.parseInt(x, 16);").defects, 0);
  assert.equal(radixFacts("function f(parseInt) { return parseInt(x); }").defects, 0);
  assert.equal(radixFacts("const Number = {parseInt(x) {return x;}}; Number.parseInt(x);").defects, 0);
  assert.equal(radixFacts("parseInt(x, 0);").defects, 0);
  assert.equal(radixFacts("/* parseInt(x) */ const s = 'parseInt(x)';").defects, 0);
  assert.equal(radixFacts("const = ;").defects, null);
});

test("plain-object exploratory facet excludes JSON-RPC and never executes source", () => {
  assert.equal(jsFacts("throw {message: 'x'};").defects, 1);
  assert.equal(jsFacts("throw {code: -32602, message: 'x', data: {}};").defects, 0);
  assert.equal(jsFacts("throw {code: -32602, message: 'x', extra: true};").defects, 1);
  assert.equal(jsFacts("throw new Error('x');").defects, 0);
  assert.equal(jsFacts("throw {...data};").defects, 1);
  assert.equal(jsFacts("process.exit(1);").defects, 0);
  assert.equal(jsFacts("const = ;").defects, null);
});

test("trailing-spaces lexical facet handles tabs, blank lines, CRLF and block scalars", () => {
  assert.equal(yamlFacts("name: x  \n \nkey:\t\n").defects, 3);
  assert.equal(yamlFacts("name: x \r\nok: true\r\n").defects, 1);
  assert.equal(yamlFacts("value: |\n  text  \n").defects, 1);
  assert.equal(yamlFacts("name: x\n").defects, 0);
  assert.equal(yamlFacts("not valid: [  ").defects, 1);
  assert.equal(lintEffect(yamlFacts("x: y  \n"), yamlFacts("x: y\n")), 1);
  assert.equal(lintEffect(yamlFacts("x: y\n"), yamlFacts("x: y  \n")), -1);
  assert.equal(lintEffect(null, yamlFacts("x: y\n")), null);
  assert.equal(lintEffect({ defects: null }, { defects: 0 }), null);
});

test("native scoring preserves signs, unknowns, shared links and observed subtotals", () => {
  const evidence = { valid: true, linksComplete: true, knownAssessments: 2, knownLinkedAssessments: 1,
    events: [{ id: "a", linked: true, value: 3 }, { id: "b", linked: false, value: -1 },
      { id: "c", linked: false, value: null }] };
  assert.equal(scoreLintNative("native-net", evidence), null);
  assert.equal(scoreLintNative("observed-native-net", evidence), 2);
  assert.equal(scoreLintNative("linked-net", evidence), 3);
  assert.equal(scoreLintNative("observed-linked-net", { ...evidence, linksComplete: false }), null);
  assert.equal(scoreLintNative("native-net", { ...evidence, events: [...evidence.events, evidence.events[0]] }), null);
  assert.equal(scoreLintNative("native-net", { ...evidence, events: [{ id: "x", linked: true, value: NaN }] }), null);
  assert.equal(scoreLintNative("observed-native-net", { ...evidence, knownAssessments: 0,
    events: [{ id: "unknown", linked: false, value: null }] }), null);
  assert.equal(scoreLintNative("native-net", { ...evidence, events: [] }), 0);
});

test("retained production modules replay actual native evidence and reject invalid scope", async () => {
  for (const workflow of ["eslint-monster", "daily-yamllint-fixer"]) {
    const module = await import(`../../docs/operational-value/proof/functions/${workflow}.mjs`);
    const request = { windowStart: module.definition.adoption.adoptedAt,
      windowEnd: "2026-10-18T15:00:12Z", observedAt: "2026-10-18T15:00:12Z" };
    const [result] = module.collectBatch([request]);
    assert.ok(result.evidence.assessedFiles > 0);
    assert.ok(result.provenance.length >= 4);
    assert.equal(module.scoreMetric("observed-native-net", result.evidence), workflow === "eslint-monster" ? 5 : 11);
    assert.equal(module.scoreMetric("observed-linked-net", result.evidence), workflow === "eslint-monster" ? 5 : 0);
    assert.equal(module.scoreMetric("native-net", result.evidence), null);
    assert.throws(() => module.collectBatch([{ ...request, repository: "other/repo" }]), /scope/);
    assert.throws(() => module.collectBatch([{ ...request, windowStart: "not-a-date" }]), /window/);
    const [outside] = module.collectBatch([{ ...request, windowEnd: "2026-10-19T00:00:00Z",
      observedAt: "2026-10-19T00:00:00Z" }]);
    assert.equal(module.scoreMetric("native-net", outside.evidence), null);
    const middle = "2026-08-01T00:00:00Z";
    const [first, second] = module.collectBatch([{ ...request, windowEnd: middle },
      { ...request, windowStart: middle }]);
    assert.equal(module.scoreMetric("observed-native-net", first.evidence)
      + module.scoreMetric("observed-native-net", second.evidence),
    module.scoreMetric("observed-native-net", result.evidence));
  }
});
