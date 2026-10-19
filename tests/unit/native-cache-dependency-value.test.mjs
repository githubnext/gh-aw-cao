import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { readJsonArchive } from "../../.github/skills/add-operational-value/scripts/json-archive.mjs";
import { analyzeCacheCompiler, verifyCacheDependencyWitness } from "../../scripts/native-cache-dependency-value.mjs";
import { definition, collectBatch, scoreMetric } from "../../docs/operational-value/proof/functions/daily-cache-strategy-analyzer.mjs";

const directory = new URL("../../docs/operational-value/proof/native-cache-strategy/", import.meta.url);
const index = readJsonArchive(new URL("index.json.gz", directory).pathname);
const nativeSource = (phase, suffix) => {
  const row = index.nativeSources.find(row => row.number === 40882 && row.phase === phase && row.label.endsWith(suffix));
  const packet = readJsonArchive(new URL(index.receipts[row.label].file, directory).pathname);
  return Buffer.from(JSON.parse(packet.body).content, "base64").toString("utf8");
};
const before = nativeSource("before", "detection"), after = nativeSource("after", "detection");
const metric = definition.metrics[0].id;

test("real native AST proves precisely one compiler control-flow repair", () => {
  assert.equal(analyzeCacheCompiler(before, after).nativeUnits, 1);
  assert.equal(analyzeCacheCompiler(before, before).nativeUnits, 0);
  assert.equal(definition.nativeAssessment.native.targetCodeExecuted, false);
  assert.equal(definition.nativeAssessment.native.otherFunctionChanges, false);
});

test("native AST rejects changed guardrails, unrelated body edits and invalid source", () => {
  for (const changed of [
    after.replace('BuildStringLiteral("skipped")', 'BuildStringLiteral("failure")'),
    after.replace("jobConditionNode := BuildAnd(alwaysFunc, agentNotSkipped)", "jobConditionNode := alwaysFunc"),
    after.replace("jobConditionNode := BuildAnd(alwaysFunc, agentNotSkipped)", "jobConditionNode := BuildAnd(alwaysFunc, agentNotSkipped)\n panic(\"changed\")"),
    "package broken\nfunc {",
  ]) assert.throws(() => analyzeCacheCompiler(before, changed));
});

test("real production witness preserves all consumer guards and restores one conditional case, not two tool labels", () => {
  const result = verifyCacheDependencyWitness(nativeSource("before", "witness-source"), nativeSource("after", "witness-source"),
    nativeSource("before", "witness-runtime"), nativeSource("after", "witness-runtime"));
  assert.equal(result.cases.length, 12);
  assert.equal(result.restored.length, 1);
  assert.equal(result.restored[0].agentResult, "success");
  assert.equal(result.restored[0].outputTypes, "");
  assert.equal(result.restored[0].hasPatch, false);
  assert.ok(result.cases.filter(row => row.agentResult !== "success").every(row => !row.conditionalCacheSaveAfter));
});

test("compiled witness rejects weakened save requirements and unrelated production changes", () => {
  const original = nativeSource("before", "witness-runtime"), repaired = nativeSource("after", "witness-runtime");
  const source = nativeSource("before", "witness-source");
  for (const changed of [
    repaired.replace("needs.detection.result == 'success' && needs.agent.result == 'success'", "needs.agent.result == 'success'"),
    repaired.replace("steps.check_cache_default.outputs.has_content == 'true'", "always()"),
    repaired.replace("always() && needs.agent.result != 'skipped'", "always()"),
  ]) assert.throws(() => verifyCacheDependencyWitness(source, source, original, changed));
  assert.throws(() => verifyCacheDependencyWitness(source, `${source}\nChanged`, original, repaired));
});

test("actual collector allocates one immutable delivery, not snapshot stock, with unknown other periods", async () => {
  const requests = [
    { windowStart: "2026-06-16T04:45:23Z", windowEnd: "2026-06-23T04:45:23Z", observedAt: "2026-10-18T15:00:12Z" },
    { windowStart: "2026-06-23T04:45:23Z", windowEnd: "2026-06-30T04:45:23Z", observedAt: "2026-10-18T15:00:12Z" },
    { windowStart: "2026-06-30T04:45:23Z", windowEnd: "2026-07-07T04:45:23Z", observedAt: "2026-10-18T15:00:12Z" },
  ];
  const rows = await collectBatch(requests);
  assert.deepEqual(rows.map(row => scoreMetric(metric, row.evidence)), [null, 1, null]);
  assert.equal(rows[1].evidence.identities.length, 1);
  assert.equal(rows[1].evidence.fullGoalAcceptance, null);
  assert.equal(rows[1].evidence.workflowContribution, null);
  assert.equal(rows[1].evidence.costs, null);
  assert.deepEqual(await collectBatch(requests), rows);
});

test("collector rejects duplicate/overlapping periods, unsupported scope and post-cutoff windows", () => {
  const request = { windowStart: "2026-06-23T04:45:23Z", windowEnd: "2026-06-30T04:45:23Z", observedAt: "2026-10-18T15:00:12Z" };
  assert.throws(() => collectBatch([request, request]), /Overlapping/);
  assert.throws(() => collectBatch([{ ...request, repository: "other/repository" }]), /Wrong repository/);
  assert.throws(() => collectBatch([{ ...request, windowEnd: "2026-10-20T00:00:00Z", observedAt: "2026-10-20T00:00:00Z" }]), /frozen cutoff/);
  assert.throws(() => collectBatch([{ ...request, windowStart: "invalid" }]));
  assert.throws(() => collectBatch([{ ...request, observedAt: "2026-02-30T00:00:00Z" }]), /Invalid cache observation/);
  assert.equal(scoreMetric(metric, { accepted: true, score: 100 }), null);
  assert.equal(scoreMetric(metric, { schemaVersion: 1, native: 2 }), null);
});

test("millisecond boundaries preserve half-open delivery and cannot escape the frozen cutoff", async () => {
  const [row] = await collectBatch([{ windowStart: "2026-06-23T04:45:22.500Z",
    windowEnd: "2026-06-23T04:45:23.500Z", observedAt: "2026-10-18T15:00:12Z" }]);
  assert.equal(scoreMetric(metric, row.evidence), 1);
  assert.throws(() => collectBatch([{ windowStart: "2026-10-18T14:00:00Z",
    windowEnd: "2026-10-18T15:00:12.500Z", observedAt: "2026-10-18T15:00:13Z" }]), /frozen cutoff/);
});

test("source-informed predecessor and retrospective corrections remain explicit", () => {
  const original = JSON.parse(readFileSync(new URL("frozen-contract-v1.json", directory)));
  assert.match(original.authoring.basis, /before candidate descriptions/);
  assert.match(definition.assessmentPolicy, /outcome-informed retrospective/);
  assert.equal(definition.nativeAssessment.fullGoalAcceptance, null);
  assert.equal(definition.nativeAssessment.workflowContribution, null);
  assert.match(definition.limitations.join(" "), /cache-hit.*exact primary-key/);
  assert.match(definition.limitations.join(" "), /Do not equate every noop/);
});
