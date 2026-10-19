import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import { reviewValue, validateReviewPolicy, validateValueReview } from "../../.github/skills/add-operational-value/scripts/review-value.mjs";
import { referenceModule } from "../fixtures/operational-value-benchmark/reference.mjs";
import { corpus } from "../fixtures/operational-value-benchmark/corpus.mjs";

const root = path.resolve(import.meta.dirname, "../..");
const scripts = path.join(root, ".github/skills/add-operational-value/scripts");
const reference = await referenceModule("prose-confirmed-bug-resolution");
const policy = { metricId: "linked", basis: "workflow-contribution", periods: 2, minimum: 1,
  rationale: "Synthetic owner-agreed minimum of one independently accepted linked defect per eligible period." };
const diagnostic = { ...reference.definition.metrics[0], id: "linked", role: "diagnostic",
  name: "Accepted workflow contributions", unit: "defects", formula: "independently accepted defects with verified run links",
  presentation: { name: "Accepted contributions", legendLabel: "Accepted contributions", transform: "identity" } };
const snapshot = (end, value, changes = {}) => ({
  observedAt: end, window: { startAt: new Date(Date.parse(end) - 7 * 86400000).toISOString(), endAt: end },
  evidence: { coverageStatus: "complete", maturityStatus: "matured", eligibleCount: 5 },
  metrics: { outcome: 80, linked: value }, ...changes,
});
function fixture(values = [1, 2], review = policy) {
  return {
    valueFunction: { definition: { ...structuredClone(reference.definition), review: structuredClone(review),
      evidence: { ...structuredClone(reference.definition.evidence), measurementKind: "interval" },
      metrics: [...structuredClone(reference.definition.metrics), structuredClone(diagnostic)] } },
    window: { startAt: "2026-10-01T00:00:00Z", endAt: "2026-10-15T00:00:00Z" },
    snapshots: values.map((value, index) => snapshot(`2026-10-${index ? "15" : "08"}T00:00:00Z`, value)),
    metricReview: { metrics: [{ ...reference.definition.metrics[0],
      recentComparison: { status: "available", nativeDelta: 40, directionAwareGain: 40 } }] },
  };
}

test("the entry-point skill stays lean and promises a value review rather than a generic score", () => {
  const text = readFileSync(path.join(scripts, "../SKILL.md"), "utf8");
  assert.ok(Buffer.byteLength(text) <= 6000, "keep technical details in the module contract");
  assert.ok(text.split(/\s+/).length <= 750, "the core skill must remain concise");
  assert.match(text, /Workflow contribution/);
  assert.match(text, /Costs|costs/);
  assert.match(text, /not rated/);
  assert.match(text, /authority to disable/);
  assert.match(text, /partial improvement counts as value/);
  assert.match(text, /Credit shared contribution/);
  assert.match(text, /safeguards and attribution confidence separately/);
});

test("demonstrated workflow-enabled improvement survives unknown or unmet independent safeguards", () => {
  for (const acceptance of [null, 0]) {
    const timeline = fixture([3, 4]);
    timeline.valueFunction.definition.metrics.push({ ...diagnostic, id: "full-acceptance",
      name: "Full goal completion", formula: "all independent safeguards established" });
    timeline.snapshots.forEach(snapshot => {
      snapshot.metrics["full-acceptance"] = acceptance;
      snapshot.evidence.attribution = "shared-corroborated-link";
    });
    const report = reviewValue(timeline);
    assert.deepEqual(report.periods.map(period => period.metrics.linked), [3, 4]);
    assert.deepEqual(report.periods.map(period => period.metrics["full-acceptance"]), [acceptance, acceptance]);
    assert.equal(report.current.value, 80);
  }
});

test("native outcomes and contribution remain separate, with unknown costs and no invented keep bar", () => {
  const timeline = fixture();
  delete timeline.valueFunction.definition.review;
  const report = reviewValue(timeline);
  assert.equal(report.current.value, 80);
  assert.equal(report.current.unit, "percent");
  assert.deepEqual(report.periods.map(row => row.metrics.linked), [1, 2]);
  assert.equal(report.decision.status, "not-rated");
  assert.deepEqual(report.cost, { status: "not-measured", total: null, unit: null, costPerAcceptedOutcome: null });
  assert.equal(reviewValue(fixture()).decision.status, "keep-candidate");
  assert.equal(reviewValue(fixture([0, 0])).decision.status, "change-or-retire-candidate");
  assert.equal(reviewValue(fixture([0, 2])).decision.status, "mixed");
  const range = fixture([1, 4], { ...policy, maximum: 3 });
  assert.equal(reviewValue(range).decision.status, "mixed");
});

test("an explicit partial-contribution bar does not require unrelated full-goal acceptance", () => {
  const timeline = fixture([2, 4]);
  timeline.snapshots.forEach(row => { row.metrics.outcome = null; });
  const report = reviewValue(timeline);
  assert.equal(report.current.value, null);
  assert.equal(report.current.status, "unavailable");
  assert.equal(report.recentComparison.status, "unavailable");
  assert.deepEqual(report.periods.map(row => row.metrics.linked), [2, 4]);
  assert.equal(report.decision.status, "keep-candidate");
  assert.equal(report.decision.policy.metricId, "linked");
  delete timeline.valueFunction.definition.review;
  assert.equal(reviewValue(timeline).decision.status, "not-rated");
});

test("repository attainment cannot earn the workflow credit or a retirement recommendation", () => {
  const review = { ...policy, metricId: "outcome", basis: "repository-outcome", minimum: 75 };
  assert.equal(reviewValue(fixture([1, 2], review)).decision.status, "goal-met");
  const stock = fixture([1, 2], review);
  stock.valueFunction.definition.evidence.measurementKind = "snapshot";
  assert.equal(reviewValue(stock).decision.status, "goal-met");
  const missed = fixture([1, 2], review);
  missed.snapshots.forEach(row => { row.metrics.outcome = 40; });
  assert.equal(reviewValue(missed).decision.status, "goal-missed");
  missed.snapshots[1].metrics.outcome = 80;
  assert.equal(reviewValue(missed).decision.status, "mixed");
});

test("malformed review bars fail explicitly rather than becoming recommendations", () => {
  for (const invalid of [
    { metricId: "missing" }, { metricId: "outcome" }, { periods: 0 }, { periods: 1.5 },
    { minimum: Infinity }, { maximum: NaN }, { maximum: -1 }, { basis: "runs-succeeded" },
    { rationale: "" }, { minumum: 1 },
  ]) assert.throws(() => validateReviewPolicy(fixture([1, 2], { ...policy, ...invalid }).valueFunction.definition), /Invalid value-review/);
});

test("unknown or zero opportunities and incomplete outcome evidence never become bad or good value", () => {
  for (const changes of [
    { eligibleCount: 0 }, { eligibleCount: null }, { eligibleCount: -1 },
    { coverageStatus: "partial" }, { coverageStatus: "unknown" }, { coverageStatus: undefined },
    { maturityStatus: "interim" }, { maturityStatus: "unavailable" }, { maturityStatus: "unknown" }, { dubious: true },
  ]) {
    const timeline = fixture([0, 0]);
    Object.assign(timeline.snapshots[1].evidence, changes);
    assert.equal(reviewValue(timeline).decision.status, "insufficient-evidence", JSON.stringify(changes));
  }
  const timeline = fixture();
  timeline.snapshots[1].metrics.linked = null;
  assert.equal(reviewValue(timeline).decision.status, "insufficient-evidence");
});

test("review requires genuinely mature, fresh and consecutive periods, not lifetime totals or stale backfills", () => {
  const mutations = [
    timeline => { timeline.snapshots.pop(); },
    timeline => { timeline.snapshots[1].window.startAt = "2026-10-09T00:00:00Z"; },
    timeline => { timeline.snapshots[0] = snapshot("2026-10-07T00:00:00Z", 1); },
    timeline => { timeline.snapshots[1].observedAt = "2026-10-16T00:00:00Z"; },
    timeline => { timeline.window.endAt = "2026-10-22T00:00:00Z"; },
    timeline => { timeline.snapshots[1].observedAt = timeline.window.endAt = "2026-10-22T00:00:00Z"; },
    timeline => { timeline.valueFunction.definition.evidence.window.maturationDays = 1; },
    timeline => { timeline.valueFunction.definition.adoption.adoptedAt = "2026-10-14T00:00:00Z"; },
  ];
  for (const mutate of mutations) {
    const timeline = fixture();
    mutate(timeline);
    assert.equal(reviewValue(timeline).decision.status, "insufficient-evidence");
  }
  const intervals = fixture();
  assert.equal(reviewValue(intervals).decision.status, "keep-candidate");
  const interleaved = fixture();
  interleaved.snapshots.splice(1, 0, snapshot("2026-10-09T00:00:00Z", 1));
  assert.equal(reviewValue(interleaved).decision.status, "keep-candidate",
    "extra overlapping observations do not hide the complete consecutive reviewed cohorts");
  intervals.snapshots[0] = snapshot("2026-10-09T00:00:00Z", 1);
  assert.equal(reviewValue(intervals).decision.status, "insufficient-evidence", "overlapping intervals are not independent periods");
  const stock = fixture();
  stock.valueFunction.definition.evidence.measurementKind = "snapshot";
  assert.equal(reviewValue(stock).decision.status, "insufficient-evidence", "retained old fixes are not new delivery");
});

test("a newer unavailable assessment masks the old accepted value for the same period", () => {
  const timeline = fixture();
  timeline.snapshots.push({ ...structuredClone(timeline.snapshots[1]), observedAt: "2026-10-15T01:00:00Z",
    metrics: { outcome: null, linked: null } });
  timeline.window.endAt = "2026-10-15T01:00:00Z";
  const report = reviewValue(timeline);
  assert.equal(report.periods.length, 2);
  assert.equal(report.current.value, null);
  assert.equal(report.current.status, "unavailable");
  assert.equal(report.decision.status, "insufficient-evidence");
  timeline.valueReview = report;
  validateValueReview(timeline);
  timeline.valueReview.decision.status = "keep-candidate";
  assert.throws(() => validateValueReview(timeline), /differs from its frozen evidence/);
});

test("the existing function-to-report pipeline publishes a checked native value and keep review", () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "operational-value-review-"));
  try {
    const module = path.join(directory, "value.mjs");
    const input = path.join(directory, "observations.json");
    const timeline = path.join(directory, "timeline.json");
    const markdown = path.join(directory, "definitions.md");
    const referenceUrl = pathToFileURL(path.join(root, "tests/fixtures/operational-value-benchmark/reference.mjs")).href;
    writeFileSync(module, `
import { referenceModule } from ${JSON.stringify(referenceUrl)};
const original = await referenceModule("prose-confirmed-bug-resolution");
export const definition = {
  ...original.definition,
  intent: { ...original.definition.intent, goal: "Resolve independently verified defects in each weekly opportunity cohort." },
  evidence: { ...original.definition.evidence, measurementKind: "interval",
    opportunity: "Five distinct confirmed defects in each weekly opportunity cohort." },
  metrics: [...original.definition.metrics, ${JSON.stringify(diagnostic)}],
  review: ${JSON.stringify(policy)},
  validationExamples: Object.fromEntries(Object.entries(original.definition.validationExamples).map(([name, evidence]) => [
    name, { ...evidence, ...(evidence.records ? { records: evidence.records.map(record => ({ ...record, runLinked: true })) } : {}) }
  ]))
};
export const collectBatch = original.collectBatch;
export function scoreMetric(id, evidence) {
  if (id !== "linked") return original.scoreMetric(id, evidence);
  if (original.scoreMetric("outcome", evidence) === null
    || !evidence.records.every(record => typeof record.runLinked === "boolean")) return null;
  return evidence.records.filter(record => record.closed && record.merged && record.regressionPassed && record.runLinked).length;
}
`);
    const item = corpus.find(row => row.id === "prose-confirmed-bug-resolution");
    const snapshots = [item.before, item.after].map((evidence, index) => ({
      ...snapshot(index ? "2026-10-15T00:00:00Z" : "2026-10-08T00:00:00Z", index ? 2 : 1),
      provenance: [{ repository: "githubnext/gh-aw-cao", kind: "synthetic-fixture", ref: "frozen-review-fixture" }],
      evidence: { ...evidence, records: evidence.records.map((record, row) => ({
        ...record, id: "week-" + index + "-" + row, runLinked: row % 2 === 0,
      })),
        eligibleCount: 5, coverageStatus: "complete", maturityStatus: "matured" },
    }));
    writeFileSync(input, JSON.stringify({
      generatedAt: "2026-10-15T00:00:00Z", repository: reference.definition.repository,
      workflowName: reference.definition.workflowName, adoptionAt: reference.definition.adoption.adoptedAt,
      evaluationMode: "attainment-only", window: fixture().window, evidenceCoverage: {}, snapshots, runs: [],
    }));
    const run = (script, args) => execFileSync(process.execPath, [path.join(scripts, script), ...args], { encoding: "utf8", stdio: "pipe" });
    run("verify-value-function.mjs", [module]);
    run("build-timeline.mjs", [module, input, timeline]);
    run("render-definitions.mjs", [timeline, markdown]);
    run("validate-report-artifacts.mjs", [timeline, markdown]);
    const result = JSON.parse(readFileSync(timeline, "utf8"));
    assert.deepEqual(result.valueReview.periods.map(period => period.metrics), [
      { outcome: 40, linked: 1 }, { outcome: 80, linked: 2 },
    ]);
    assert.equal(result.valueReview.decision.status, "keep-candidate");
    const rendered = readFileSync(markdown, "utf8");
    assert.match(rendered, /## Value review/);
    assert.match(rendered, /80 percent/);
    assert.match(rendered, /\+40 percentage points/);
    assert.match(rendered, /Not measured/);
    assert.match(rendered, /keep-candidate/);
    assert.match(rendered, /Demonstrated workflow-enabled improvements count as shared contribution/);
    assert.match(rendered, /unknown quality dimension does not cancel independently verified improvement/);
    result.valueReview.decision.status = "change-or-retire-candidate";
    writeFileSync(timeline, JSON.stringify(result));
    assert.throws(() => run("validate-report-artifacts.mjs", [timeline]), /differs from its frozen evidence/);
    const badScorer = readFileSync(module, "utf8").replace(
      'if (original.scoreMetric("outcome", evidence) === null',
      'if (evidence?.valid !== true) return 0;\n  if (original.scoreMetric("outcome", evidence) === null',
    );
    writeFileSync(module, badScorer);
    assert.throws(() => run("verify-value-function.mjs", [module]), /review metric linked must return null/);
    writeFileSync(module, badScorer.replace(`review: ${JSON.stringify(policy)},`,
      'signal: { metricId: "linked", basis: "workflow-contribution" },'));
    assert.throws(() => run("verify-value-function.mjs", [module]), /signal metric linked must return null/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
