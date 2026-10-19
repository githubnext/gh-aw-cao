import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import test from "node:test";
import { coreBehaviorProbes, normalizeConformanceReport, parseConformanceHostLog, scoreConformanceMetric } from "../../scripts/native-engine-conformance.mjs";
import { conformanceAttemptUrl, conformanceHostStepProof } from "../../scripts/collect-engine-conformance-evidence.mjs";
import { engineConformanceValueEvents } from "../../scripts/build-engine-conformance-value-events.mjs";
import { agyConformanceModule } from "../../scripts/native-agy-conformance.mjs";
import { readCensusJson } from "../../scripts/operational-value-census-io.mjs";

const report = (value = "passed") => ({ engine: "copilot", status: value,
  checks: [...coreBehaviorProbes, "fixtures", "agent-execution"].map(name => ({ name, status: value })) });
const evidence = value => ({ valid: true, observedValid: true,
  assessments: [{ id: "run:1", passed: Array(5).fill(value) }],
  observedAssessments: [{ id: "run:1", passed: Array(5).fill(value) }] });

test("native conformance counts the five protected behavior assertions, not execution status", () => {
  assert.equal(scoreConformanceMetric("core-conformance", evidence(true)), 100);
  assert.equal(scoreConformanceMetric("core-conformance", evidence(false)), 0);
  assert.equal(scoreConformanceMetric("verified-probes", evidence(false)), 5);
  assert.equal(scoreConformanceMetric("observed-core-passes", evidence(true)), 5);
  assert.equal(scoreConformanceMetric("observed-core-passes", { ...evidence(true), valid: false }), 5);
  assert.equal(scoreConformanceMetric("core-conformance", { ...evidence(true), valid: false }), null);
  assert.equal(scoreConformanceMetric("core-conformance", { valid: true, assessments: [] }), null);
  assert.equal(scoreConformanceMetric("core-conformance", { valid: true, assessments: [{ id: "run", passed: ["yes"] }] }), null);
});

test("host summaries require the actual complete probe set and reject conflicting or malformed facts", () => {
  const value = report();
  const log = ["## Engine conformance: copilot", "", "| Probe | Result |", "|---|---|",
    ...value.checks.map(check => `| ${check.name} | ${check.status} |`), "", "Overall: **PASSED**"].join("\n");
  assert.deepEqual(parseConformanceHostLog(log, "copilot"), value);
  assert.throws(() => parseConformanceHostLog(log + "\n" + log, "copilot"), /ambiguous/);
  assert.throws(() => normalizeConformanceReport({ ...value, checks: value.checks.slice(1) }, "copilot"), /Malformed/);
  assert.throws(() => normalizeConformanceReport({ ...value, checks: [...value.checks, value.checks[0]] }, "copilot"), /Malformed/);
  assert.throws(() => normalizeConformanceReport({ ...value, status: "failed" }, "copilot"), /Malformed/);
  const withPrivateError = report("failed"); withPrivateError.checks[0].error = "do not retain raw data";
  assert.equal("error" in normalizeConformanceReport(withPrivateError, "copilot").checks[0], false);
});

test("an exact protected checker conjunction is proof; generic job success and tolerated failures are not", () => {
  const run = 'independent checks; if (!passed) process.exitCode = 1;';
  const contract = { engine: "copilot", acceptedCheckerScripts: [createHash("sha256").update(run).digest("hex")] };
  const checker = { run, env: { CONFORMANCE_ENGINE: "copilot",
    CONFORMANCE_STATE: "${{ runner.temp }}/engine-conformance", CONFORMANCE_ROOT: "/tmp/gh-aw/agent/engine-conformance" } };
  const step = { name: "Assert engine conformance", status: "completed", conclusion: "success",
    started_at: "2026-10-17T00:00:00Z", completed_at: "2026-10-17T00:00:01Z" };
  assert.deepEqual(conformanceHostStepProof(checker, step, contract), report());
  for (const altered of [{ ...checker, run: run + " exit 0" }, { ...checker, "continue-on-error": true },
    { ...checker, env: { ...checker.env, CONFORMANCE_STATE: "/agent-writable" } }]) {
    assert.throws(() => conformanceHostStepProof(altered, step, contract), /No source-verified/);
  }
  for (const altered of [{ ...step, name: "Run agent" }, { ...step, conclusion: "failure" },
    { ...step, conclusion: "skipped" }, { ...step, status: "queued" },
    { ...step, completed_at: "invalid" }, { ...step, completed_at: "2026-10-16T00:00:00Z" }]) {
    assert.throws(() => conformanceHostStepProof(checker, altered, contract), /No source-verified/);
  }
});

test("execution links preserve the actual GitHub host and reject malformed or credential-bearing identities", () => {
  const run = { id: 42, html_url: "https://git.example.invalid/octo/api/actions/runs/42" };
  assert.equal(conformanceAttemptUrl(run, "octo/api", 2), `${run.html_url}/attempts/2`);
  for (const html_url of ["file:///octo/api/actions/runs/42", `${run.html_url}?token=private`,
    "https://user:private@git.example.invalid/octo/api/actions/runs/42",
    run.html_url.replace("/42", "/43")]) {
    assert.throws(() => conformanceAttemptUrl({ ...run, html_url }, "octo/api", 2), /Invalid/);
  }
  assert.throws(() => conformanceAttemptUrl(run, "octo/api", 0), /Invalid/);
});

test("all conformance plots replay protected native facts and leave evidence-blocked functions unmeasured", () => {
  const contracts = readCensusJson("docs/operational-value/proof/engine-conformance/contracts.json");
  let measured = 0, blocked = 0;
  for (const contract of contracts) {
    if (contract.engine === "agy") {
      const module = agyConformanceModule(contract);
      assert.match(module.definition.intent.goal, /native MCP/);
      assert.match(module.definition.intent.acceptance, /Partial facet/);
      assert.match(module.definition.intent.acceptance, /not established/);
      assert.throws(() => agyConformanceModule({ ...contract, agyModelSha256: "0".repeat(64) }), /Frozen/);
    }
    const archive = readCensusJson(`docs/operational-value/proof/engine-conformance/${contract.workflowId}-v2.json.gz`);
    for (const row of archive.observations.filter(row => row.status === "available")) {
      assert.deepEqual(row.report, normalizeConformanceReport(row.report, contract.engine));
      assert.ok(contract.acceptedCheckerScripts.includes(row.checkerScriptSha256));
    }
    const result = engineConformanceValueEvents(contract);
    const filename = `docs/operational-value/proof/reports/${contract.workflowId}-value-events.json`;
    if (result.ready) {
      measured++;
      assert.deepEqual(result.input, JSON.parse(readFileSync(filename, "utf8")));
      const independentlyObserved = archive.observations.filter(row => row.status === "available"
        && row.report.checks.some(check => check.name === "fixtures" && check.status === "passed"))
        .reduce((sum, row) => sum + row.report.checks.filter(check =>
          coreBehaviorProbes.includes(check.name) && check.status === "passed").length, 0);
      assert.equal(result.input.events.reduce((sum, row) => sum + row.value, 0), independentlyObserved);
      assert.equal(result.input.coverage.some(row => row.status === "missing"), result.input.nativeContext.unknownAssessments > 0);
    } else {
      blocked++;
      assert.equal(existsSync(filename), false);
      assert.equal(archive.observations.some(row => row.status === "available"), false);
    }
  }
  assert.ok(measured >= 6);
  assert.ok(blocked >= 7);
  assert.equal(measured + blocked, contracts.length);
});
