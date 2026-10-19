import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import { gunzipSync, gzipSync } from "node:zlib";
import { readJson } from "../../.github/skills/add-operational-value/scripts/common.mjs";
import { operationalValuePeriod } from "../../.github/skills/add-operational-value/scripts/measurement-period.mjs";
import { operationalValuePeriod as canonicalPeriod } from "../../dashboard/site/src/data/model/schema.js";

const root = path.resolve(import.meta.dirname, "../..");
const scripts = path.join(root, ".github/skills/add-operational-value/scripts");
const readContract = () => [
  "SKILL.md", "references/module-contract.md",
].map(file => readFileSync(path.join(scripts, "..", file), "utf8")).join("\n").replace(/\s+/g, " ");

test("authoring distinguishes effective execution, exact tool conformance and independent operation effects", () => {
  const contract = readContract();
  assert.match(contract, /effective executor first/);
  assert.match(contract, /samples runner can bypass the agent prompt/);
  assert.match(contract, /native Python filesystem read is not a `read_file` invocation/);
  assert.match(contract, /Console-derived tool-shaped entries do not prove native arguments or returned bytes/);
  assert.match(contract, /tool listing is not agent-usable MCP/);
  assert.match(contract, /Version historical source-era predicates separately/);
});

test("outcome exposure includes discovery prose before immutable native inspection", () => {
  const contract = readContract();
  assert.match(contract, /Candidate descriptions are already outcome exposure/);
  assert.match(contract, /after reading PR bodies or result summaries is outcome-informed retrospective authoring/);
  assert.match(contract, /even before inspecting immutable before\/after bytes/);
  assert.match(contract, /the original frozen contract and any rejected observations/);
  assert.match(contract, /do not claim blind or ex-ante acceptance/);
});

test("portable period validation preserves the canonical CAO adapter contract", () => {
  const period = { windowStart: "2026-09-01T00:00:00Z", windowEnd: "2026-09-02T00:00:00Z",
    measurementKind: "interval", coverageStatus: "partial" };
  const cases = [{}, period, { ...period, measurementKind: "snapshot", coverageStatus: "missing",
    eligibleCount: 0, evidenceDigest: "a".repeat(64), populationDigest: "b".repeat(64), missingReason: " unknown " },
  { ...period, windowStart: "2024-02-29T00:00:00+01:00" },
  ...[
    { windowStart: "2026-02-29T00:00:00Z" }, { windowStart: "0000-01-01T00:00:00Z" },
    { windowEnd: period.windowStart }, { windowEnd: "2027-01-01T00:00:00Z" },
    { windowStart: undefined }, { measurementKind: "event" }, { coverageStatus: "assumed" },
    { populationDigest: "A".repeat(64) }, { evidenceDigest: "not-a-digest" },
    { eligibleCount: -1 }, { eligibleCount: 0.5 }, { eligibleCount: Number.MAX_SAFE_INTEGER + 1 },
    { missingReason: "" }, { missingReason: null },
  ].map(change => ({ ...period, ...change }))];
  for (const record of cases) {
    let expected;
    try {
      expected = canonicalPeriod(record, "2026-10-18T15:00:12Z", "record");
    } catch (error) {
      assert.throws(() => operationalValuePeriod(record, "2026-10-18T15:00:12Z", "record"),
        { name: error.name, message: error.message });
      continue;
    }
    assert.deepEqual(operationalValuePeriod(record, "2026-10-18T15:00:12Z", "record"), expected);
  }
});

test("workflow-first paths, listing and wiring require no campaign or CAO policy", (t) => {
  const temporary = mkdtempSync(path.join(root, ".aw-value-standalone-test."));
  t.after(() => rmSync(temporary, { recursive: true, force: true }));
  const run = (script, args = []) => execFileSync(process.execPath, [
    path.join(scripts, script), ...args,
  ], { cwd: temporary, encoding: "utf8", stdio: "pipe" });
  assert.equal(run("value-function-path.mjs", ["octo/api", "example"]),
    ".github/operational-value/example.mjs\n");
  assert.equal(run("value-function-path.mjs", ["octo/api", "example", "campaign"]),
    "campaign/operational-value/example.mjs\n");
  for (const args of [["octo/api", "../example"], ["octo/api", "example", "../campaign"]]) {
    assert.throws(() => run("value-function-path.mjs", args), /slug/);
  }
  mkdirSync(path.join(temporary, ".github/workflows"), { recursive: true });
  mkdirSync(path.join(temporary, ".github/operational-value"), { recursive: true });
  writeFileSync(path.join(temporary, ".github/workflows/example.md"), "---\nname: Example\n---\nInspect repository outcomes.\n");
  assert.equal(run("list-workflows.mjs"), "example\n");
  const wire = ["example", "--root", temporary];
  assert.throws(() => run("wire-workflow.mjs", wire), /value module not found/);
  writeFileSync(path.join(temporary, ".github/operational-value/example.mjs"), "export const definition = {};\n");
  run("wire-workflow.mjs", wire);
  const adapter = path.join(temporary, ".github/operational-value.mjs");
  const standard = readFileSync(adapter, "utf8");
  run("wire-workflow.mjs", wire);
  assert.equal(readFileSync(adapter, "utf8"), standard);
  assert.equal(existsSync(path.join(temporary, "aw.yml")), false);
  assert.equal(existsSync(path.join(temporary, ".github/workflows/cao.json")), false);
  writeFileSync(adapter, "custom adapter\n");
  assert.throws(() => run("wire-workflow.mjs", wire), /not the standard adapter/);
  assert.equal(readFileSync(adapter, "utf8"), "custom adapter\n");
});

test("intent discovery accepts prose and arbitrary source documents without a workflow or remote access", (t) => {
  const temporary = mkdtempSync(path.join(root, ".aw-value-intent-test."));
  t.after(() => rmSync(temporary, { recursive: true, force: true }));
  const checkout = path.join(temporary, "checkout");
  mkdirSync(path.join(checkout, ".github/workflows"), { recursive: true });
  writeFileSync(path.join(checkout, "README.md"), "# Goal\nResolve confirmed defects without regressions.\n");
  writeFileSync(path.join(checkout, ".github/workflows/triage.yaml"), "name: Triage\n");
  writeFileSync(path.join(checkout, ".github/workflows/triage.lock.yml"), "generated\n");
  const run = (...args) => JSON.parse(execFileSync(process.execPath, [
    path.join(scripts, "discover-intent.mjs"), "--root", checkout, ...args,
  ], { encoding: "utf8", stdio: "pipe" }));
  const listing = run();
  assert.deepEqual(listing.candidates, [".github/workflows/triage.yaml", "README.md"]);
  assert.equal(listing.truncated, false);
  const discovered = run("--source", "README.md", "--goal", "Resolve bugs, not just PRs");
  assert.match(discovered.document.text, /confirmed defects/);
  assert.match(discovered.document.sha256, /^[0-9a-f]{64}$/);
  assert.equal(discovered.goal, "Resolve bugs, not just PRs");
  assert.match(discovered.trust, /untrusted/);
  assert.equal(run("--goal", "Keep builds reliable").document, undefined);
  writeFileSync(path.join(temporary, "outside.md"), "fixture");
  symlinkSync(path.join(temporary, "outside.md"), path.join(checkout, "escape.md"));
  assert.throws(() => run("--source", "escape.md"), /must stay inside/);
  assert.throws(() => run("--source", "../outside.md"), /must stay inside/);
  writeFileSync(path.join(checkout, "large.md"), "x".repeat(65_537));
  assert.throws(() => run("--source", "large.md"), /65536 bytes/);
  assert.throws(() => run("--goal", "x".repeat(16_385)), /16384 characters/);
});

test("a prose-only goal verifies, evaluates over time and reuses evidence without gh-aw or CAO", (t) => {
  const temporary = mkdtempSync(path.join(os.tmpdir(), "aw-value-portable-test-"));
  t.after(() => rmSync(temporary, { recursive: true, force: true }));
  const portable = path.join(temporary, "standalone-skill");
  cpSync(path.dirname(scripts), portable, { recursive: true,
    filter: source => path.basename(source) !== "node_modules" });
  const portableScripts = path.join(portable, "scripts");
  for (const file of readdirSync(portableScripts)) {
    if (file.endsWith(".mjs")) chmodSync(path.join(portableScripts, file), 0o644);
  }
  const valueModule = path.join(temporary, ".github/operational-value/example.mjs");
  const calls = path.join(temporary, "calls.jsonl");
  const facts = path.join(temporary, "facts.json");
  writeFileSync(facts, JSON.stringify({ eligible: 2, accepted: 2 }));
  mkdirSync(path.dirname(valueModule), { recursive: true });
  writeFileSync(valueModule, `
import { appendFileSync, readFileSync } from "node:fs";
export const definition = {
  schemaVersion: 3, slug: "example", repository: "octo/api",
  workflowName: "Resolve confirmed bugs", sourcePath: ".github/operational-value/example.mjs",
  intent: { goal: "Resolve confirmed bugs without regressions",
    acceptance: "Eligible confirmed bugs resolved with passing regression checks",
    temporalAnchor: "contract-activation" },
  adoption: { commit: "${"a".repeat(40)}", adoptedAt: "2026-09-15T00:00:00Z",
    baselineCommit: null, baselineAt: null },
  evaluation: { mode: "attainment-only" },
  evidence: { key: "confirmed-bug-resolution", repositories: ["octo/api"],
    opportunity: "Confirmed bugs in the declared cohort", filters: ["Require passing regression checks"],
    collection: "Preserved accepted defect assessments", measurementKind: "interval",
    window: { durationDays: 1, cadenceDays: 1, maturationDays: 0 } },
  model: { architecture: "Accepted defect outcomes", recommendation: "Track accepted resolution",
    presentation: { label: "Bug resolution", betterLabel: "More accepted resolutions are better" } },
  summary: { nativeLabel: "Confirmed bugs resolved with regression checks" },
  metrics: [{ id: "resolution", name: "Accepted resolution", role: "primary",
    formula: "accepted * 100 / eligible", direction: "increase", unit: "percent",
    presentation: { name: "Accepted resolution", legendLabel: "Resolution", transform: "identity" } }],
  validationExamples: { targetAttained: { eligible: 2, accepted: 2 },
    targetMissed: { eligible: 2, accepted: 0 }, missing: {}, malformed: { eligible: "two" } }
};
export function collectBatch(requests) {
  appendFileSync(${JSON.stringify(calls)}, JSON.stringify(requests) + "\\n");
  return requests.map(request => {
    if (Date.parse(request.windowStart) < Date.parse(definition.adoption.adoptedAt)) {
      throw new Error("attainment collector requested pre-adoption evidence");
    }
    return {
      evidence: { ...JSON.parse(readFileSync(${JSON.stringify(facts)}, "utf8")), coverageStatus: "complete" },
      provenance: [{ repository: definition.repository, kind: "immutable-fixture", ref: definition.adoption.commit }]
    };
  });
}
export function scoreMetric(id, evidence) {
  if (id !== "resolution" || !Number.isInteger(evidence?.eligible) || evidence.eligible <= 0
    || !Number.isInteger(evidence?.accepted) || evidence.accepted < 0 || evidence.accepted > evidence.eligible) return null;
  return evidence.accepted * 100 / evidence.eligible;
}
`);
  const run = (script, args) => execFileSync(process.execPath, [path.join(portableScripts, script), ...args],
    { cwd: temporary, encoding: "utf8", stdio: "pipe" });
  assert.equal(existsSync(path.join(temporary, "dashboard")), false);
  assert.equal(existsSync(path.join(portable, "node_modules")), false);
  mkdirSync(path.join(temporary, ".github/workflows"), { recursive: true });
  writeFileSync(path.join(temporary, ".github/workflows/example.md"), "# Example\n");
  assert.equal(run("list-workflows.mjs", []), "example\n");
  assert.equal(JSON.parse(run("discover-intent.mjs", ["--goal", "Resolve confirmed bugs"])).goal,
    "Resolve confirmed bugs");
  assert.match(run("verify-value-function.mjs", ["--collector", valueModule]), /^verified/);
  assert.equal(existsSync(path.join(temporary, ".github/operational-value.mjs")), false);
  run("wire-workflow.mjs", ["example"]);
  const assessments = execFileSync(process.execPath,
    [path.join(temporary, ".github/operational-value.mjs")], {
      input: JSON.stringify({ schemaVersion: 1, timestamp: "2026-09-24T00:00:00Z", repositories: ["octo/api"] }),
      encoding: "utf8", stdio: ["pipe", "pipe", "pipe"],
    }).trim().split("\n").map(JSON.parse);
  assert.equal(Object.hasOwn(assessments.find(row => row.valueId), "adoptionAt"), false);
  assert.match(run("verify-value-function.mjs", [
    "--collector", "--cao-adapter", path.join(temporary, ".github/operational-value.mjs"), valueModule,
  ]), /^verified/);
  const args = ["--end", "2026-09-24T00:00:00Z", "octo/api", "example"];
  run("evaluate.mjs", args);
  const count = readFileSync(calls, "utf8").trim().split("\n").length;
  run("evaluate.mjs", args);
  assert.equal(readFileSync(calls, "utf8").trim().split("\n").length, count);
  const prefix = path.join(temporary, "docs/operational-value/reports/octo-api/example");
  assert.match(readFileSync(`${prefix}-pulse.html`, "utf8"), /<!doctype html>/);
  const pulse = JSON.parse(readFileSync(`${prefix}-pulse.json`, "utf8"));
  assert.equal(pulse.signal.basis, "repository-outcome");
  assert.equal(pulse.signal.status, "steady");
  assert.equal(pulse.signal.unit, "percent");
  const archive = JSON.parse(readFileSync(`${prefix}-evidence-archive.json`, "utf8"));
  assert.equal(Object.keys(archive.functions).length, 1);
  assert.ok(Object.values(archive.functions)[0].snapshots.length > 0);
  const report = readFileSync(`${prefix}-definitions.md`, "utf8");
  assert.match(report, /measurement contract was activated/);
  assert.match(report, /not a workflow adoption date/);
  assert.match(report, /Goal:\*\* Resolve confirmed bugs without regressions/);
  assert.throws(() => run("evaluate.mjs", ["--runs", ...args]), /requires a workflow source/);
  const timeline = JSON.parse(readFileSync(`${prefix}-timeline.json`, "utf8"));
  assert.equal(readFileSync(`${prefix}-timeline.json`, "utf8"), `${JSON.stringify(timeline)}\n`);
  assert.deepEqual(timeline.runs, []);
  assert.equal(timeline.metricReview.metrics[0].currentValue, 100);
  assert.equal(timeline.metricReview.metrics[0].recentComparison.status, "available");
  assert.match(timeline.evidenceCoverage.reason, /Prospective goal contract/);
  archive.retentionFixture = "preserved native history ".repeat(15_000);
  writeFileSync(`${prefix}-evidence-archive.json`, JSON.stringify(archive));
  run("evaluate.mjs", args);
  assert.equal(existsSync(`${prefix}-evidence-archive.json`), false);
  const compressedArchive = `${prefix}-evidence-archive.json.gz`;
  assert.deepEqual(JSON.parse(gunzipSync(readFileSync(compressedArchive)).toString("utf8")), archive);
  run("evaluate.mjs", args);
  assert.equal(readFileSync(calls, "utf8").trim().split("\n").length, count);
  archive.retentionFixture = randomBytes(400000).toString("hex");
  writeFileSync(compressedArchive, gzipSync(JSON.stringify(archive)));
  run("evaluate.mjs", args);
  assert.equal(JSON.parse(gunzipSync(readFileSync(compressedArchive))).kind, "partitioned-census-json");
  assert.deepEqual(readJson(compressedArchive), archive);
  run("evaluate.mjs", args);
  assert.deepEqual(readJson(compressedArchive), archive);
  assert.equal(readFileSync(calls, "utf8").trim().split("\n").length, count);
  const offCadence = [...args];
  offCadence[1] = "2026-09-24T12:00:00Z";
  run("evaluate.mjs", offCadence);
  const offCadencePulse = JSON.parse(readFileSync(`${prefix}-pulse.json`, "utf8"));
  assert.equal(offCadencePulse.signal.status, "steady");
  assert.equal(offCadencePulse.metrics[0].previousWindow.endAt, offCadencePulse.metrics[0].currentWindow.startAt);
  const beforeRefresh = readFileSync(calls, "utf8").trim().split("\n").length;
  run("evaluate.mjs", ["--refresh", ...offCadence]);
  assert.equal(readFileSync(calls, "utf8").trim().split("\n").length, beforeRefresh + 1);
  assert.equal(JSON.parse(readFileSync(`${prefix}-pulse.json`, "utf8")).signal.status, "steady");
  const frozenFunction = readFileSync(valueModule, "utf8");
  writeFileSync(facts, JSON.stringify({ eligible: 2, accepted: 1 }));
  run("evaluate.mjs", ["--end", "2026-09-25T00:00:00Z", "octo/api", "example"]);
  assert.equal(JSON.parse(readFileSync(`${prefix}-timeline.json`, "utf8")).metricReview.metrics[0].currentValue, 50);
  assert.equal(readFileSync(valueModule, "utf8"), frozenFunction);
  writeFileSync(compressedArchive, "corrupt preserved archive");
  assert.throws(() => run("evaluate.mjs", args), /cannot read preserved evidence archive/);
  assert.equal(readFileSync(compressedArchive, "utf8"), "corrupt preserved archive");
});

test("skill uses query-first evidence without limiting history to source retention", () => {
  const skill = readContract();
  assert.match(skill, /Use a declarative query over canonical CAO data/);
  assert.match(skill, /temporary checkout of the target repository at the immutable cutoff/);
  assert.match(skill, /Query retention is a source limitation, not the operational-value history window/);
  assert.match(skill, /contemporaneous accepted snapshot was preserved/);
});

test("skill generalizes File Diet's native outcome ladder without making perfect attribution a gate", () => {
  const skill = readContract();
  assert.match(skill, /smallest independently observable \*\*useful outcome\*\*/);
  assert.match(skill, /13 are an attribution subset, not a cap on the 48/);
  assert.match(skill, /Preserve the stricter frozen acceptance measure/);
  assert.match(skill, /one real outcome and the evidence needed to verify that claim/);
  assert.match(skill, /fixture-only checker or all-unknown report is unfinished measurement/);
  assert.match(skill, /Authoring the instrument today does not itself make the goal prospective/);
  assert.match(skill, /Do not change dates just to make a frozen-cutoff evaluation run/);
  assert.match(skill, /complete issue\/PR inventory does not cover Discussions or comments/);
});

test("skill separates frozen measurements, recent movement and adoption association", () => {
  const skill = readContract();
  assert.match(skill, /immediately preceding equal-duration period/);
  assert.match(skill, /not a sustained trend/);
  assert.match(skill, /make no adoption-relative improvement claim/);
  assert.match(skill, /successful query or non-null score alone is not proof/i);
  assert.match(skill, /never average ratios or add overlapping rolling totals/);
});

test("deterministic reports separate recent deterioration from adoption gain and never invent missing references", (t) => {
  mkdirSync(path.join(root, ".tmp"), { recursive: true });
  const temporary = mkdtempSync(path.join(root, ".tmp", "value-report-periods-"));
  t.after(() => rmSync(temporary, { recursive: true, force: true }));
  const source = path.join(root, "optimization/operational-value/optimization-token-optimizer.mjs");
  const modulePath = path.join(temporary, "value.mjs");
  const snapshot = (end, value, changes = {}) => ({
    observedAt: end,
    window: { startAt: new Date(Date.parse(end) - 7 * 86_400_000).toISOString(), endAt: end },
    provenance: [{ source: "fixture", cutoff: end }],
    evidence: {
      eligibleWorkflowCount: 1, successfulRunCount: 1, successfulRunAicTotal: value,
      concludedRunCount: 1, failedRunPercentagePointTotal: 0, cancelledRunPercentagePointTotal: 0,
      maturityStatus: "matured", coverageStatus: "complete", ...changes
    }
  });
  const base = [
    snapshot("2026-09-08T10:00:00Z", 20), snapshot("2026-09-17T10:00:00Z", 2),
    snapshot("2026-09-23T10:00:00Z", 1), snapshot("2026-09-24T10:00:00Z", 8)
  ];
  const build = (snapshots, mode = "baseline-comparable", endpoint = "2026-09-24T11:00:00Z") => {
    writeFileSync(modulePath, `
import * as original from ${JSON.stringify(pathToFileURL(source).href)};
export const definition = { ...original.definition, evaluation: { mode: ${JSON.stringify(mode)} } };
export const collectBatch = original.collectBatch;
export const scoreMetric = original.scoreMetric;
`);
    const input = path.join(temporary, "observations.json");
    const output = path.join(temporary, "timeline.json");
    writeFileSync(input, JSON.stringify({
      repository: "githubnext/gh-cao", evaluationMode: mode,
      adoptionAt: "2026-09-15T23:30:36Z", workflowName: "Optimization",
      window: { startAt: "2026-09-01T00:00:00Z", endAt: endpoint },
      evidenceCoverage: {}, snapshots, runs: []
    }));
    execFileSync(process.execPath, [path.join(scripts, "build-timeline.mjs"), modulePath, input, output]);
    return JSON.parse(readFileSync(output, "utf8"));
  };
  const report = build(base);
  assert.equal(report.schemaVersion, 3);
  assert.equal(report.metricReview.comparisonPolicy, "adjacent-period-v1");
  const primary = report.metricReview.metrics[0];
  assert.equal(primary.currentValue, 8);
  assert.equal(primary.recentComparison.nativeDelta, 6);
  assert.equal(primary.recentComparison.directionAwareGain, -6);
  assert.equal(primary.adoptionComparison.nativeDelta, -12);
  assert.equal(primary.adoptionComparison.directionAwareGain, 12);
  assert.equal(build(base.slice(1)).metricReview.metrics[0].adoptionComparison.status, "unavailable");
  assert.equal(build(base.slice(2)).metricReview.metrics[0].recentComparison.status, "unavailable");
  assert.equal(build(base.slice(-1)).metricReview.metrics[0].currentValue, 8);
  assert.equal(build(base.slice(1), "attainment-only").metricReview.metrics[0].recentComparison.nativeDelta, 6);
  assert.equal(build([...base.slice(0, -1), snapshot("2026-09-24T10:00:00Z", 8, { coverageStatus: "unknown" })])
    .metricReview.metrics[0].recentComparison.status, "unavailable");
  const missing = build([...base.slice(0, -1), snapshot("2026-09-24T10:00:00Z", 8, { eligibleWorkflowCount: 0 })])
    .metricReview.metrics[0];
  assert.equal(missing.currentValue, null);
  assert.equal(missing.recentComparison.nativeDelta, null);
  const withdrawn = [...base.slice(0, 2), {
    ...snapshot("2026-09-17T10:00:00Z", 2, { eligibleWorkflowCount: 0 }),
    observedAt: "2026-09-23T09:00:00Z"
  }, ...base.slice(2)];
  assert.equal(build(withdrawn).metricReview.metrics[0].recentComparison.status, "unavailable");
  assert.match(build(base, "baseline-comparable", "2026-09-25T10:00:00Z")
    .metricReview.metrics[0].recentComparison.reason, /stale/);
  for (const endpoint of ["2026-09-25T10:00:00Z", "2026-09-24T09:00:00Z"]) {
    const metric = build(base, "baseline-comparable", endpoint).metricReview.metrics[0];
    assert.equal(metric.currentValue, 8);
    assert.equal(metric.adoptionComparison.status, "unavailable");
    assert.match(metric.adoptionComparison.reason, /stale or future/);
  }
  const futureCorrection = [...base.slice(0, 2), {
    ...snapshot("2026-09-17T10:00:00Z", 20), observedAt: "2026-09-25T10:00:00Z"
  }, ...base.slice(2)];
  assert.equal(build(futureCorrection.toSorted((left, right) => Date.parse(left.observedAt) - Date.parse(right.observedAt)))
    .metricReview.metrics[0].recentComparison.status, "unavailable");
});
test("skill tests whether each measured phenomenon existed before adoption", () => {
  const skill = readContract();
  assert.match(skill, /Do not confuse workflow adoption with creation of the measured phenomenon/);
  assert.match(skill, /Do not derive the primary measure from a gh-aw workflow's own output/);
  assert.match(skill, /pre-existing repository problem/);
  assert.match(skill, /Count outcome attainment regardless of actor/);
  assert.match(skill, /security-alert backlog/);
  assert.match(skill, /antecedent-existence test/);
  assert.match(skill, /pre-existing-and-reconstructable/);
  assert.match(skill, /pre-existing-but-not-reconstructable/);
  assert.match(skill, /created-at-adoption/);
  assert.match(skill, /same native formula, unit, population, grain, filters, and window/);
  assert.match(skill, /"the workflow did not exist yet" is not sufficient/);
  assert.match(skill, /attainment-only is a fallback after an explicit failed reconstruction/i);
});

test("campaign workflow listing returns only direct manifest worker workflows", () => {
  const temporary = mkdtempSync(path.join(os.tmpdir(), "operational-value-campaign-list-"));
  mkdirSync(path.join(temporary, ".github/workflows"), { recursive: true });
  mkdirSync(path.join(temporary, "example"), { recursive: true });
  const workflow = (name, role) => `---
name: ${name}
imports:
  - uses: shared/control.md
    with:
      role: ${role}
---
# ${name}
`;
  writeFileSync(
    path.join(temporary, ".github/workflows/example.md"),
    workflow("example", "orchestrator"),
  );
  writeFileSync(
    path.join(temporary, ".github/workflows/example-worker.md"),
    workflow("example-worker", "worker"),
  );
  writeFileSync(
    path.join(temporary, ".github/workflows/unrelated.md"),
    workflow("unrelated", "worker"),
  );
  writeFileSync(path.join(temporary, "example/aw.yml"), `name: Example
includes:
  - ../aw.yml
  - .github/workflows/example.md
  - .github/workflows/example-worker.md
`);

  const output = execFileSync(
    process.execPath,
    [path.join(scripts, "list-workflows.mjs"), "--campaign", "example"],
    { cwd: temporary, encoding: "utf8" },
  );
  assert.equal(output, "example-worker\n");
  assert.equal(execFileSync(
    process.execPath,
    [path.join(scripts, "list-workflows.mjs"), "example-worker", "--campaign", "example"],
    { cwd: temporary, encoding: "utf8" },
  ), ".github/workflows/example-worker.md\n");
  assert.throws(() => execFileSync(
    process.execPath,
    [path.join(scripts, "list-workflows.mjs"), "example", "--campaign", "example"],
    { cwd: temporary, stdio: "pipe" },
  ), /workflow not found: example/);
  assert.throws(() => execFileSync(
    process.execPath,
    [path.join(scripts, "list-workflows.mjs"), "unrelated", "--campaign", "example"],
    { cwd: temporary, stdio: "pipe" },
  ), /workflow not found: unrelated/);
});

test("campaign wiring creates one standard adapter without unsupported manifest entries", () => {
  const temporary = mkdtempSync(path.join(os.tmpdir(), "operational-value-campaign-wire-"));
  mkdirSync(path.join(temporary, "example/operational-value"), { recursive: true });
  writeFileSync(path.join(temporary, "example/aw.yml"), `name: Example
includes:
  - ../aw.yml
  - .github/workflows/example.md
`);
  writeFileSync(
    path.join(temporary, "example/operational-value/example.mjs"),
    "export const definition = {};\n",
  );
  const command = [
    path.join(scripts, "wire-campaign.mjs"),
    "example",
    "example",
    "--root",
    temporary,
  ];
  execFileSync(process.execPath, command);
  execFileSync(process.execPath, command);

  assert.equal(
    readFileSync(path.join(temporary, "example/operational-value.mjs"), "utf8"),
    readFileSync(path.join(root, ".github/skills/add-operational-value/templates/campaign-operational-value.mjs"), "utf8"),
  );
  const manifest = readFileSync(path.join(temporary, "example/aw.yml"), "utf8");
  assert.equal(manifest.includes("operational-value.mjs"), false);
  assert.equal(manifest.includes("operational-value/example.mjs"), false);
  assert.equal(manifest.endsWith("\n"), true);

  writeFileSync(path.join(temporary, "example/operational-value.mjs"), "custom adapter\n");
  assert.throws(
    () => execFileSync(process.execPath, command, { stdio: "pipe" }),
    /already exists and is not the standard campaign adapter/,
  );
});

test("CAO verification accepts namespaced metrics for multiple repositories", () => {
  const temporary = mkdtempSync(path.join(os.tmpdir(), "operational-value-multi-repository-"));
  const source = path.join(root, "optimization/operational-value/optimization-token-optimizer.mjs");
  const valueModule = path.join(temporary, "example-workflow.mjs");
  const adapter = path.join(temporary, "operational-value.mjs");
  writeFileSync(valueModule, `
import * as original from ${JSON.stringify(pathToFileURL(source).href)};
export const definition = {
  ...original.definition,
  slug: "example-workflow",
  workflowName: "Example Workflow",
  evidence: {
    ...original.definition.evidence,
    repositories: ["github/gh-aw", "githubnext/gh-cao"]
  },
  metrics: original.definition.metrics.map(({rollup, ...metric}) => metric)
};
export const collectBatch = original.collectBatch;
export const scoreMetric = original.scoreMetric;
`);
  writeFileSync(adapter, `
const request = JSON.parse(await new Promise((resolve) => {
  let input = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk) => { input += chunk; });
  process.stdin.on("end", () => resolve(input));
}));
console.log(JSON.stringify({
  kind: "operational_value_definition",
  workflowSlug: "example-workflow",
  adoptedAt: "2026-09-15T23:30:36Z",
  evaluationMode: "baseline-comparable",
  cadenceDays: 1,
  repositories: ["github/gh-aw", "githubnext/gh-cao"],
  valueIds: [
    "example-workflow.aic-per-successful-run",
    "example-workflow.failure-rate-percent",
    "example-workflow.cancellation-rate-percent"
  ]
}));
for (const repository of request.repositories) {
  for (const valueId of [
    "example-workflow.aic-per-successful-run",
    "example-workflow.failure-rate-percent",
    "example-workflow.cancellation-rate-percent"
  ]) {
    const metricUnit = valueId.endsWith("aic-per-successful-run") ? "aic-per-run" : "percent";
    console.log(JSON.stringify({repository, valueId, value: 0.5, metricUnit, timestamp: request.timestamp}));
  }
}
`);

  const output = execFileSync(
    process.execPath,
    [
      path.join(scripts, "verify-value-function.mjs"),
      "--cao-adapter",
      adapter,
      valueModule,
    ],
    { encoding: "utf8" },
  );
  assert.equal(output, `verified ${valueModule}\n`);
});

test("CAO verification accepts explicit unavailable periods without accepting malformed null assessments", (t) => {
  mkdirSync(path.join(root, ".tmp"), { recursive: true });
  const temporary = mkdtempSync(path.join(root, ".tmp", "value-verification-periods-"));
  t.after(() => rmSync(temporary, { recursive: true, force: true }));
  const source = path.join(root, "optimization/operational-value/optimization-token-optimizer.mjs");
  const adapter = path.join(temporary, "operational-value.mjs");
  const assessment = {
    value: null,
    maturityStatus: "unavailable",
    windowStart: "2026-09-09T23:30:36Z",
    windowEnd: "2026-09-16T23:30:36Z",
    measurementKind: "interval",
    coverageStatus: "missing",
    missingReason: "no-eligible-opportunities",
  };
  const verify = (changes = {}) => {
    writeFileSync(adapter, `
import {readFileSync} from "node:fs";
import {definition} from ${JSON.stringify(pathToFileURL(source).href)};
const request = JSON.parse(readFileSync(0, "utf8"));
console.log(JSON.stringify({
  kind: "operational_value_definition", workflowSlug: definition.slug,
  adoptedAt: definition.adoption.adoptedAt, evaluationMode: definition.evaluation.mode,
  cadenceDays: definition.evidence.window.cadenceDays, repositories: definition.evidence.repositories,
  valueIds: definition.metrics.map(metric => definition.slug + "." + metric.id)
}));
for (const repository of request.repositories) {
  for (const metric of definition.metrics) {
    console.log(JSON.stringify({
      timestamp: request.timestamp, repository, valueId: definition.slug + "." + metric.id,
      metricUnit: metric.unit, ...${JSON.stringify({ ...assessment, ...changes })}
    }));
  }
}
`);
    return execFileSync(process.execPath, [
      path.join(scripts, "verify-value-function.mjs"), "--cao-adapter", adapter, source,
    ], { encoding: "utf8", stdio: "pipe" });
  };
  assert.match(verify(), /^verified /);
  for (const changes of [
    { missingReason: "" },
    { maturityStatus: "matured" },
    { windowStart: undefined, windowEnd: undefined, measurementKind: undefined, coverageStatus: undefined },
    { windowStart: "2026-09-17T23:30:36Z" },
    { windowEnd: "2026-09-17T23:30:36Z" },
    { coverageStatus: "invented" },
    { rollupNumerator: 0 },
    { rollupDenominator: 1 },
    { rollupNumerator: 0, rollupDenominator: 1 },
    { value: 0 },
  ]) {
    assert.throws(() => verify(changes));
  }
  assert.match(verify({
    value: 0, maturityStatus: "matured", rollupNumerator: 0, rollupDenominator: 1,
  }), /^verified /);
});

test("attainment intervals clip the leading partial period without overlapping mature periods", t => {
  const temporary = mkdtempSync(path.join(os.tmpdir(), "operational-value-maturation-"));
  t.after(() => rmSync(temporary, { recursive: true, force: true }));
  const source = path.join(root, "optimization/operational-value/optimization-token-optimizer.mjs");
  const valueModule = path.join(temporary, "maturation-test.mjs");
  const reports = path.join(temporary, "reports");
  writeFileSync(valueModule, `
import * as original from ${JSON.stringify(pathToFileURL(source).href)};
export const definition = {
  ...original.definition,
  slug: "maturation-test",
  sourcePath: ".github/workflows/maturation-test.md",
  evaluation: { mode: "attainment-only" }
};
export const collectBatch = (requests) => requests.map((request) => {
  const interim = Date.parse(request.windowEnd) - Date.parse(request.windowStart)
    < definition.evidence.window.durationDays * 86400000;
  return {
  evidence: {
    maturityStatus: interim ? "interim" : "matured",
    dubious: interim,
    eligibleWorkflowCount: 1,
    successfulRunCount: 1,
    successfulRunAicTotal: 0,
    concludedRunCount: 1,
    failedRunCount: 0,
    cancelledRunCount: 0,
    failedRunPercentagePointTotal: 0,
    cancelledRunPercentagePointTotal: 0
  },
  provenance: [{ repository: definition.repository, kind: "test-fixture", ref: definition.adoption.commit }]
  };
});
export const scoreMetric = original.scoreMetric;
`);

  execFileSync(
    process.execPath,
    [
      path.join(scripts, "evaluate.mjs"),
      "--function",
      valueModule,
      "--end",
      "2026-09-24T20:48:02Z",
      "--output-dir",
      reports,
      "--no-runs",
      "githubnext/gh-cao",
      "maturation-test",
    ],
    { cwd: root, stdio: "pipe" },
  );
  const timeline = JSON.parse(readFileSync(
    path.join(reports, "githubnext-gh-cao/maturation-test-timeline.json"),
    "utf8",
  ));
  assert.equal(
    timeline.snapshots[0].observedAt,
    "2026-09-17T20:48:02Z",
  );
  assert.equal(
    timeline.snapshots[0].window.startAt,
    timeline.valueFunction.definition.adoption.adoptedAt,
  );
  assert.equal(timeline.snapshots[0].window.endAt, "2026-09-17T20:48:02Z");
  assert.equal(timeline.snapshots[0].evidence.maturityStatus, "interim");
  assert.equal(timeline.snapshots[0].evidence.dubious, true);
  assert.equal(timeline.snapshots[0].metrics["aic-per-successful-run"], 0);
  assert.equal(timeline.snapshots.length, 2);
  assert.equal(timeline.snapshots[1].window.startAt, timeline.snapshots[0].window.endAt);
  assert.equal(timeline.snapshots[1].evidence.maturityStatus, "matured");
  assert.equal(timeline.snapshots[1].evidence.dubious, false);
  assert.equal(Date.parse(timeline.snapshots[1].window.endAt) - Date.parse(timeline.snapshots[1].window.startAt),
    7 * 86400000);
});
