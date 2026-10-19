import assert from "node:assert/strict";
import { test } from "node:test";
import { smokeBehaviorProofs, smokeAttemptUrl, verifySmokeEnvironment } from "../../scripts/collect-smoke-native-evidence.mjs";
import { smokeCases, smokeDigest, smokeRead, smokeScore } from "../../scripts/native-smoke-value.mjs";
import { parse } from "yaml";

const success = { status: "completed", conclusion: "success", started_at: "2026-10-17T00:00:00Z", completed_at: "2026-10-17T00:01:00Z" };
const failed = { ...success, conclusion: "failure" };
const coreName = "Assert engine conformance";
const nativeName = "Assert native Agy MCP transport and inference accounting";
test("Agy native gate is separate; a failed gate never invents failed constituent cases", () => {
  const partial = smokeBehaviorProofs("smoke-agy", { [coreName]: success, [nativeName]: failed });
  assert.equal(partial.cases.filter(item => item.passed === true).length, 6);
  assert.equal(partial.cases.filter(item => item.passed === null).length, 4);
  assert.equal(partial.fullAcceptance, null);
  const inverse = smokeBehaviorProofs("smoke-agy", { [coreName]: failed, [nativeName]: success });
  assert.equal(inverse.cases.filter(item => item.passed === true).length, 4);
  assert.equal(inverse.fullAcceptance, null);
  const all = smokeBehaviorProofs("smoke-agy", { [coreName]: success, [nativeName]: success });
  assert.equal(all.cases.filter(item => item.passed === true).length, 10);
  assert.equal(all.fullAcceptance, true);
});
test("Aider host conjunction proves precisely two partial facets, never full acceptance", () => {
  const proven = smokeBehaviorProofs("smoke-aider", { "Verify Aider smoke test evidence": success });
  assert.deepEqual(proven.cases, smokeCases["smoke-aider"].map(name => ({ name, passed: true })));
  assert.equal(proven.fullAcceptance, null);
  assert.ok(smokeBehaviorProofs("smoke-aider", { "Verify Aider smoke test evidence": failed }).cases.every(item => item.passed === null));
});
test("Claude unpredictable receipt and exact post-tool echo require the actual protected gate", () => {
  assert.equal(smokeBehaviorProofs("smoke-claude-copilot", {}).fullAcceptance, null);
  assert.equal(smokeBehaviorProofs("smoke-claude-copilot", { "Assert Claude Copilot inference evidence": success }).fullAcceptance, true);
});
test("Native subtotal remains available through unknown acceptance and missing peers", () => {
  const proof = smokeBehaviorProofs("smoke-agy", { [coreName]: success });
  const evidence = { valid: true, workflowId: "smoke-agy", assessments: [{ id: "one", ...proof }] };
  assert.equal(smokeScore("proven-behaviors", evidence), 6);
  assert.equal(smokeScore("full-acceptance", evidence), null);
  assert.equal(smokeScore("proven-behaviors", { ...evidence, valid: false }), null);
  assert.equal(smokeScore("proven-behaviors", { ...evidence, assessments: [...evidence.assessments, ...evidence.assessments] }), null);
  assert.equal(smokeScore("proven-behaviors", { ...evidence, assessments: [{ id: "x", cases: [{ name: "not-a-case", passed: true }], fullAcceptance: null }] }), null);
});
test("Retained individual host reports allow actual failed cases only with fixture admission", () => {
  const names = ["agent-execution", "fixtures", ...smokeCases["smoke-agy"].slice(0, 6)];
  const report = { engine: "agy", status: "failed", checks: names.map(name => ({ name, status: name === "inference" ? "failed" : "passed" })) };
  const proof = smokeBehaviorProofs("smoke-agy", {}, report);
  assert.equal(proof.cases.find(item => item.name === "inference").passed, false);
  assert.equal(proof.cases.filter(item => item.passed === true).length, 5);
  report.checks.find(item => item.name === "fixtures").status = "failed";
  assert.ok(smokeBehaviorProofs("smoke-agy", {}, report).cases.every(item => item.passed === null));
  assert.throws(() => smokeBehaviorProofs("smoke-agy", {}, { ...report, checks: report.checks.slice(1) }), /Malformed/);
});
test("Execution URLs preserve the API host and reject forged path/credentials", () => {
  const run = { id: 23, html_url: "https://example.test/github/gh-aw/actions/runs/23" };
  assert.equal(smokeAttemptUrl(run, "github/gh-aw", 2), `${run.html_url}/attempts/2`);
  assert.throws(() => smokeAttemptUrl({ ...run, id: 24 }, "github/gh-aw", 1), /Invalid/);
  assert.throws(() => smokeAttemptUrl({ ...run, html_url: "https://user@example.test/github/gh-aw/actions/runs/23" }, "github/gh-aw", 1), /Invalid/);
});
test("Frozen source receipts validate checker environment and reject tolerated or substituted scripts", () => {
  const contracts = smokeRead("docs/operational-value/proof/smoke-native/contracts.json");
  for (const contract of contracts) {
    const receipt = smokeRead(`docs/operational-value/proof/smoke-native/${contract.workflowId}-sources.json.gz`);
    const lock = receipt.sources.find(item => item.path.endsWith(".lock.yml"));
    const document = parse(lock.text);
    assert.ok(verifySmokeEnvironment(document, contract));
    const changed = structuredClone(document);
    changed.jobs.agent.steps.find(item => item.name === contract.protectedSteps.at(-1).name).env = {};
    assert.throws(() => verifySmokeEnvironment(changed, contract), /checker\/environment/);
    document.jobs.agent["continue-on-error"] = true;
    assert.throws(() => verifySmokeEnvironment(document, contract), /Untrusted/);
    assert.equal(receipt.parentSourceAbsent, true);
    assert.ok(receipt.adoptionSources.some(item => item.path.endsWith(".md")));
    assert.equal(smokeDigest(contract.protectedSteps), smokeDigest(receipt.protectedSteps));
  }
});
test("All three schema-v3 functions replay real historical native evidence without online calls", async () => {
  const expected = { "smoke-agy": 20, "smoke-aider": 10, "smoke-claude-copilot": null };
  for (const [workflowId, value] of Object.entries(expected)) {
    const module = await import(`../../docs/operational-value/proof/functions/${workflowId}.mjs`);
    const [result] = await module.collectBatch([{ repository: "github/gh-aw",
      windowStart: module.definition.adoption.adoptedAt, windowEnd: "2026-10-18T15:00:12Z",
      observedAt: "2026-10-18T15:00:12Z" }]);
    assert.equal(module.definition.schemaVersion, 3);
    assert.equal(module.scoreMetric("proven-behaviors", result.evidence), value);
    assert.equal(module.scoreMetric("full-acceptance", result.evidence), null);
    assert.equal(result.evidence.coverageStatus, "partial");
    assert.equal(result.evidence.costs, "not-measured");
    assert.equal(result.provenance[0].kind, "immutable-workflow-source");
  }
});
