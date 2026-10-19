import assert from "node:assert/strict";
import { test } from "node:test";
import {
  collectBatch, compareSteps, decodeWorkflows, definition, scoreMetric,
} from "../../docs/operational-value/proof/functions/step-name-alignment.mjs";

const yaml = (name, extra = "") => `name: Example
on: push
jobs:
  agent:
    runs-on: ubuntu-latest
    steps:
      - id: parse
        name: ${JSON.stringify(name)}
        run: echo unchanged
${extra}`;
const decode = content => {
  const [result] = decodeWorkflows([{ key: "native", content }]);
  assert.equal(result.error, undefined);
  return result.steps;
};
const compare = (before, after) => compareSteps(decode(before), decode(after));

test("schema-3 examples improve every native metric without normalization", () => {
  assert.equal(definition.schemaVersion, 3);
  assert.equal(definition.metrics.filter(metric => metric.role === "primary").length, 1);
  for (const metric of definition.metrics) {
    assert.ok(scoreMetric(metric.id, definition.validationExamples.targetAttained)
      > scoreMetric(metric.id, definition.validationExamples.targetMissed));
    assert.equal(scoreMetric(metric.id, definition.validationExamples.missing), null);
    assert.equal(scoreMetric(metric.id, definition.validationExamples.malformed), null);
    assert.equal(metric.presentation.transform, "identity");
  }
  assert.equal(scoreMetric("unknown", definition.validationExamples.targetAttained), null);
  assert.equal(definition.review, undefined);
});

test("native YAML spelling correction is grounded in unchanged actual execution", () => {
  const result = compare(yaml("Parse front matter"), yaml("Parse frontmatter"));
  assert.equal(result.repairs.length, 1);
  assert.deepEqual(result.repairs[0].rules, ["frontmatter"]);
  assert.equal(result.repairs[0].before, "Parse front matter");
  assert.equal(result.repairs[0].after, "Parse frontmatter");
  assert.equal(compare(yaml("Generate agent workflows"), yaml("Generate agentic workflows")).repairs.length, 1);
  assert.equal(compare(yaml("Generate agential workflow"), yaml("Generate agentic workflow")).repairs.length, 1);
});

test("one native occurrence applying two rules counts once, not a composite", () => {
  const pair = definition.validationExamples.targetAttained.nativePairs[0];
  const before = decode(yaml("Parse agent workflow front matter"));
  const after = decode(yaml("Parse agentic workflow frontmatter"));
  const evidence = {
    ...definition.validationExamples.targetAttained, nativePairs: [{ ...pair, before, after }],
  };
  assert.equal(scoreMetric("glossary-repairs", evidence), 1);
  assert.equal(scoreMetric("frontmatter-repairs", evidence), 1);
  assert.equal(scoreMetric("agentic-workflow-repairs", evidence), 1);
});

test("preferences, extra wording, deletions and changed intent never establish repair", () => {
  assert.equal(compare(yaml("Setup Scripts"), yaml("Set up scripts")).repairs.length, 0);
  assert.equal(compare(yaml("Parse front matter"), yaml("Carefully parse frontmatter")).repairs.length, 0);
  assert.equal(compare(yaml("Parse front matter"), yaml("Parse frontmatter").replace("echo unchanged", "echo changed")).repairs.length, 0);
  assert.equal(compare(yaml("Parse front matter"), yaml("Parse frontmatter").replace("ubuntu-latest", "windows-latest")).repairs.length, 0);
  assert.equal(compare(yaml("Parse front matter"), yaml("Parse frontmatter").replace("on: push", "on: pull_request")).repairs.length, 0);
  assert.equal(compare(yaml("Parse front matter"), yaml("Parse frontmatter").replace("id: parse", "id: other")).repairs.length, 0);
  assert.equal(compareSteps(decode(yaml("Parse front matter")), [] ).repairs.length, 0);
  assert.equal(compareSteps([], decode(yaml("Parse frontmatter"))).repairs.length, 0);
});

test("parsed name escaping, key ordering and moved unique steps are handled natively", () => {
  const before = yaml("Parse front matter");
  const after = `jobs:
  agent:
    steps:
      - name: Unrelated
        run: echo other
      - run: echo unchanged
        name: "Parse frontmatter"
        id: parse
    runs-on: ubuntu-latest
on: push
name: Another display name
`;
  const result = compare(before, after);
  assert.equal(result.repairs.length, 1);
  assert.equal(result.repairs[0].beforeIndex, 0);
  assert.equal(result.repairs[0].afterIndex, 1);
  assert.equal(compare(yaml("Parse front matter"), yaml("Parse frontmatter").replace('"Parse frontmatter"', '"Parse front\\u006datter"')).repairs.length, 1);
});

test("ambiguous duplicate unnamed execution contexts and dynamic names stay unaccepted", () => {
  const before = `jobs:
  agent:
    steps:
      - name: Parse front matter
        run: echo same
      - name: Another
        run: echo same
`;
  const result = compare(before, before.replace("Parse front matter", "Parse frontmatter"));
  assert.equal(result.repairs.length, 0);
  assert.equal(result.ambiguousSteps, 2);
  assert.equal(compare(yaml("Parse ${{ matrix.name }} front matter"), yaml("Parse ${{ matrix.name }} frontmatter")).repairs.length, 0);
});

test("malformed YAML, aliases, merges, duplicate keys and unsupported structures fail closed", () => {
  const invalid = [
    "jobs: [",
    "jobs: {}\n---\njobs: {}\n",
    "jobs:\n  test: &test\n    steps: []\n  other: *test\n",
    "jobs:\n  test:\n    steps: []\n    steps: []\n",
    "jobs:\n  test:\n    <<: {}\n    steps: []\n",
    "jobs:\n  test:\n    steps:\n      - run: echo x\n        uses: actions/checkout@v4\n",
    "jobs:\n  test:\n    steps:\n      - run: echo x\n        name: 42\n",
    "jobs:\n  test:\n    steps:\n      - id: same\n        run: echo x\n      - id: same\n        run: echo y\n",
  ];
  for (const content of invalid) {
    const [result] = decodeWorkflows([{ key: "bad", content }]);
    assert.equal(typeof result.error, "string");
    assert.equal(result.steps, undefined);
  }
  assert.throws(() => decodeWorkflows([{ key: "bad", content: null }]), /Invalid bounded/);
});

test("reverse lexical transitions remain regressions, not positive delivery", () => {
  const result = compare(yaml("Parse frontmatter"), yaml("Parse front matter"));
  assert.equal(result.repairs.length, 0);
  assert.equal(result.regressions.length, 1);
});

test("score validates independent glossary, unique lineage and exclusive period boundaries", () => {
  const base = structuredClone(definition.validationExamples.targetAttained);
  for (const evidence of [
    { ...base, glossary: {} },
    { ...base, nativePairs: [...base.nativePairs, base.nativePairs[0]] },
    { ...base, nativePairs: [{ ...base.nativePairs[0], at: base.windowEnd }] },
    { ...base, nativePairs: [{ ...base.nativePairs[0], at: "2026-09-01T00:00:00Z" }] },
    { ...base, nativePairs: [{ ...base.nativePairs[0], path: ".github/workflows/not-a-lock.yml" }] },
    { ...base, nativePairs: [{ ...base.nativePairs[0], before: [{ ...base.nativePairs[0].before[0], intentDigest: "guessed" }] }] },
    { ...base, coverageStatus: "missing" },
    { accepted: true, improved: true, issueClosed: true, merged: true },
  ]) assert.equal(scoreMetric("glossary-repairs", evidence), null);
  assert.equal(scoreMetric("glossary-repairs", { ...base, coverageStatus: "partial" }), 2);
});

test("actual batch preserves frozen gaps, all lineage and separate readiness", async () => {
  const windows = [
    { windowStart: "2026-01-13T14:26:57Z", windowEnd: "2026-01-20T14:26:57Z", observedAt: "2026-01-20T14:26:57Z" },
    { windowStart: "2026-10-11T15:00:12Z", windowEnd: "2026-10-18T15:00:12Z", observedAt: "2026-10-18T15:00:12Z" },
    { windowStart: "2026-10-18T15:00:12Z", windowEnd: "2026-10-25T15:00:12Z", observedAt: "2026-10-25T15:00:12Z" },
    { windowStart: "2026-09-27T15:00:12Z", windowEnd: "2026-10-04T15:00:12Z", observedAt: "2026-10-04T15:00:12Z" },
  ];
  const results = await collectBatch(windows);
  assert.equal(results.length, 4);
  assert.equal(results[0].evidence.windowEnd, windows[0].windowEnd);
  assert.equal(scoreMetric("glossary-repairs", results[0].evidence), null);
  assert.equal(scoreMetric("glossary-repairs", results[2].evidence), null);
  assert.equal(results[1].evidence.lineage.originalMarkerCandidates, 134);
  assert.equal(results[1].evidence.lineage.selectedEntities, 2733);
  for (const { evidence, provenance } of results) {
    assert.equal(evidence.fullSemanticQuality.value, null);
    assert.equal(evidence.workflowContribution.value, null);
    assert.equal(evidence.eligibleCount, null);
    assert.equal(evidence.readiness.producerDecoding, true);
    assert.equal(evidence.readiness.fullFunction, false);
    assert.ok(provenance.every(row => row.repository === "github/gh-aw" && row.ref));
  }
  assert.ok(results[1].evidence.examinedFileTransitions > 0);
  assert.equal(results[1].evidence.coverageStatus, "partial");
  assert.equal(results[1].evidence.completePeriodRepairTotal, null);
  assert.equal(typeof scoreMetric("glossary-repairs", results[3].evidence), "number");
  assert.equal(results[3].evidence.coverageStatus, "partial");
  assert.equal(results[3].evidence.completePeriodRepairTotal, null);
  const again = await collectBatch([windows[1]]);
  assert.deepEqual(again[0], results[1]);
  assert.deepEqual(await collectBatch([]), []);
  await assert.rejects(() => collectBatch([{ ...windows[1], repository: "other/repository" }]), /Invalid bounded/);
  await assert.rejects(() => collectBatch([{ ...windows[1], windowStart: windows[1].windowEnd }]), /Invalid bounded/);
});
