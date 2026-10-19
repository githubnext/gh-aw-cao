import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import { lockPairGuard, parseGoTestEvidence } from "../../scripts/collect-gh-aw-operational-evidence.mjs";
import { createWorkflowValueFunction, measureCensus } from "../../scripts/measure-gh-aw-operational-value.mjs";
import { readCensusEvidence, readCensusJson, writeCensusEvidence, writeCensusJson } from "../../scripts/operational-value-census-io.mjs";

const data = path.resolve(import.meta.dirname, "../../docs/operational-value/gh-aw-census");
const read = file => file === "evidence.json" ? readCensusEvidence(path.join(data, `${file}.gz`))
  : readCensusJson(path.join(data, `${file}.gz`));
const event = (Action, Test) => ({ Action, Package: "example/unit", ...(Test ? { Test } : {}) });

test("the lock-pair instrument counts unpaired changes, not workflow execution or output volume", () => {
  const md = ".github/workflows/check.md";
  const lock = md.replace(".md", ".lock.yml");
  assert.deepEqual(lockPairGuard([md], [md, lock]), {
    count: 1, eligibleCount: 1, eligible: [md], violations: [md],
  });
  assert.equal(lockPairGuard([md, lock], [md, lock]).count, 0);
  assert.equal(lockPairGuard([md], [lock]).eligibleCount, 0);
  assert.equal(lockPairGuard([".github/workflows/shared/context.md"], []).count, 0);
  assert.equal(lockPairGuard([], [md, lock]).count, 0);
});

test("native Go assertion evidence distinguishes complete tests from unfinished and malformed events", () => {
  const serialize = events => events.map(JSON.stringify).join("\n");
  const complete = [
    event("start"), event("run", "TestGood"), event("pass", "TestGood"),
    event("run", "TestBad"), event("run", "TestBad/child"), event("fail", "TestBad/child"),
    event("fail", "TestBad"), event("run", "TestSkipped"), event("skip", "TestSkipped"), event("fail"),
  ];
  const result = parseGoTestEvidence(serialize(complete));
  assert.equal(result.coverageStatus, "complete");
  assert.equal(result.eligibleCount, 2);
  assert.equal(result.failedCount, 1);
  assert.equal(result.skippedCount, 1);
  assert.equal(result.testOutcomes.length, 3, "nested cases must not double-count top-level tests");
  assert.equal(parseGoTestEvidence(serialize([event("start"), event("run", "TestPending")])).coverageStatus, "partial");
  assert.equal(parseGoTestEvidence(serialize([event("start"), event("fail")])).coverageStatus, "partial");
  assert.throws(() => parseGoTestEvidence("{"), SyntaxError);
  assert.throws(() => parseGoTestEvidence(serialize([event("pass", "TestNoStart")])), /Unmatched terminal/);
});

test("every upstream source has a source-grounded contract record and every cutoff is explicitly assessed", () => {
  const manifest = read("contracts.json");
  const evidence = read("evidence.json");
  const result = measureCensus(manifest, evidence);
  assert.deepEqual(result, read("results.json"), "refresh the census receipt when its inputs or evaluator change");
  assert.equal(result.totals.workflows, 385);
  assert.equal(result.totals.agentic, 344);
  assert.equal(result.totals.native, 41);
  assert.equal(result.totals.observations, 1925);
  assert.equal(result.totals.agenticWorkflowsWithAnyNumericValue, 0);
  for (const workflow of result.workflows) {
    assert.equal(workflow.observations.length, 5);
    for (const observation of workflow.observations) {
      assert.ok(observation.value !== null || observation.reason);
    }
  }
  const broken = structuredClone(manifest);
  broken.contracts.pop();
  assert.throws(() => measureCensus(broken, evidence), /385-workflow/);
});

test("every executable candidate preserves native units, missingness and deterministic scoring", () => {
  const manifest = read("contracts.json");
  const evidence = read("evidence.json");
  for (const contract of manifest.contracts.filter(row => row.designStatus === "candidate")) {
    const value = createWorkflowValueFunction(contract, manifest, evidence);
    const examples = value.definition.validationExamples;
    for (const name of ["targetAttained", "targetMissed"]) {
      assert.ok(Number.isFinite(value.scoreMetric("outcome", examples[name])), `${contract.path}: ${name}`);
      assert.equal(value.scoreMetric("outcome", examples[name]),
        value.scoreMetric("outcome", { ...examples[name], producedPullRequests: 1000, actor: "someone-else" }));
    }
    assert.equal(value.scoreMetric("outcome", examples.missing), null);
    assert.equal(value.scoreMetric("outcome", examples.malformed), null);
    assert.equal(value.scoreMetric("unknown", examples.targetAttained), null);
    assert.equal(value.scoreMetric("outcome", { ...examples.targetAttained, contractDigest: "changed" }), null);
    assert.equal(value.scoreMetric("outcome", { ...examples.targetAttained, coverageStatus: "partial" }), null);
  }
  const unresolved = manifest.contracts.find(row => row.designStatus === "needs-clarification");
  assert.throws(() => createWorkflowValueFunction(unresolved, manifest, evidence), /needs clarification/);
});

test("partial real test artifacts cannot become a successful complete regression score", () => {
  const manifest = read("contracts.json");
  const evidence = read("evidence.json");
  const contract = manifest.contracts.find(row => row.path === ".github/workflows/cgo.yml");
  const value = createWorkflowValueFunction(contract, manifest, evidence);
  const last = evidence.snapshots.at(-1);
  const request = {
    windowStart: new Date(Date.parse(last.windowEnd) - 7 * 86_400_000).toISOString(),
    windowEnd: last.windowEnd, observedAt: last.windowEnd,
  };
  const collected = value.collectBatch([request])[0];
  assert.equal(collected.evidence.coverageStatus, "partial");
  assert.equal(value.scoreMetric("outcome", collected.evidence), null);
  assert.match(collected.evidence.missingReason, /unfinished tests/);
});

test("all candidate modules pass the production schema-v3 verifier without remote collection", () => {
  const manifest = read("contracts.json");
  const root = path.resolve(import.meta.dirname, "../..");
  mkdirSync(path.join(root, ".tmp"), { recursive: true });
  const temporary = mkdtempSync(path.join(root, ".tmp", "gh-aw-census-verification-"));
  const factory = pathToFileURL(path.join(root, "scripts/measure-gh-aw-operational-value.mjs")).href;
  const verifier = path.join(root, ".github/skills/add-operational-value/scripts/verify-value-function.mjs");
  try {
    for (const contract of manifest.contracts.filter(row => row.designStatus === "candidate")) {
      const file = path.join(temporary, `${path.basename(contract.path)}.mjs`);
      writeFileSync(file, `import { createWorkflowValueFunction } from ${JSON.stringify(factory)};
const value = createWorkflowValueFunction(${JSON.stringify(contract)},
  ${JSON.stringify({ contractActivatedAt: manifest.contractActivatedAt })}, { snapshots: [] });
export const definition = value.definition;
export const collectBatch = value.collectBatch;
export const scoreMetric = value.scoreMetric;
`);
      const result = spawnSync(process.execPath, [verifier, "--collector", file], { encoding: "utf8" });
      if (result.error) throw result.error;
      assert.equal(result.status, 0, `${contract.path}: ${result.stderr || result.stdout}`);
    }
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
});

test("compressed normalized evidence fails closed on tampering and escaping references", () => {
  const root = path.resolve(import.meta.dirname, "../../.tmp");
  mkdirSync(root, { recursive: true });
  const temporary = mkdtempSync(path.join(root, "gh-aw-census-archive-"));
  try {
    const file = path.join(temporary, "evidence.json.gz");
    const source = { goUnitEvidence: [{ shards: [{
      artifactId: 42, testOutcomes: [{ id: "example/unit:TestGood", status: "pass" }],
    }] }] };
    writeCensusEvidence(file, source);
    const loaded = readCensusEvidence(file);
    assert.deepEqual(loaded.goUnitEvidence, source.goUnitEvidence);
    const index = readCensusJson(file);
    writeCensusJson(path.join(temporary, index.normalizedGoTests.file), {
      42: [{ id: "example/unit:TestGood", status: "fail" }],
    });
    assert.throws(() => readCensusEvidence(file), /digest mismatch/);
    index.normalizedGoTests.file = "../outside.json.gz";
    writeCensusJson(file, index);
    assert.throws(() => readCensusEvidence(file), /Invalid normalized evidence reference/);
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
});
