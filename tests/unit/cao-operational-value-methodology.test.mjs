import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import { eventPulse, timelinePulse } from "../../.github/skills/add-operational-value/scripts/pulse-model.mjs";
import { renderPulse, writePulse } from "../../.github/skills/add-operational-value/scripts/render-pulse.mjs";
import { reviewValue } from "../../.github/skills/add-operational-value/scripts/review-value.mjs";
import { workflowPortfolio } from "../../.github/skills/add-operational-value/scripts/portfolio-model.mjs";

const root = path.resolve(import.meta.dirname, "../..");
const scripts = path.join(root, ".github/skills/add-operational-value/scripts");
const DAY = 86_400_000;
const endAt = "2026-05-01T00:00:00Z";
const metric = { id: "structural", name: "Structural reductions", role: "diagnostic",
  unit: "files", direction: "increase", version: "structural-v1" };
const event = (id, at, value, attribution = "corroborated") => ({
  id, at, value, attribution, label: `Reduction ${id}`, detail: "Synthetic native before/after verification.",
  evidence: [{ label: "Revision", url: `https://github.com/octo/example/commit/${id}` }],
});
function ledger() {
  const window = { startAt: "2026-01-01T00:00:00Z", endAt };
  return { schemaVersion: 1, kind: "operational-value-events", repository: "octo/example",
    workflowSlug: "file-diet", workflowName: "File Diet", sourcePath: ".github/workflows/file-diet.md",
    observedAt: endAt, cadenceDays: 7, metric: { ...metric }, basis: "workflow-contribution",
    window, coverage: [{ ...window, status: "complete" }], opportunities: 53,
    limitations: ["Synthetic 48/13 example; full behavior preservation is unknown."],
    events: [event("a", "2026-03-25T00:00:00Z", 35),
      event("b", "2026-04-20T00:00:00Z", 13, "receipt-verified")] };
}
function timeline(outcomes = [40, 30], contributions = [2, 4]) {
  const definition = {
    slug: "file-diet", workflowName: "File Diet", sourcePath: ".github/workflows/file-diet.md",
    adoption: { adoptedAt: "2026-01-01T00:00:00Z" },
    evidence: { measurementKind: "interval", window: { durationDays: 7, cadenceDays: 7, maturationDays: 0 } },
    metrics: [{ id: "health", role: "primary", direction: "increase", unit: "files", name: "Healthy files" },
      { ...metric }, { id: "full", role: "diagnostic", direction: "increase", unit: "files", name: "Full acceptance" }],
    signal: { metricId: "structural", basis: "workflow-contribution" },
  };
  return { repository: "octo/example",
    window: { startAt: "2026-01-01T00:00:00Z", endAt: "2026-01-15T00:00:00Z" },
    valueFunction: { definition },
    snapshots: outcomes.map((value, index) => {
      const end = Date.parse("2026-01-08T00:00:00Z") + index * 7 * DAY;
      return { observedAt: new Date(end).toISOString(),
        window: { startAt: new Date(end - 7 * DAY).toISOString(), endAt: new Date(end).toISOString() },
        metrics: { health: value, structural: contributions[index], full: null },
        evidence: { coverageStatus: "complete", maturityStatus: "matured", eligibleCount: 53 } };
    }),
    metricReview: { metrics: [{ id: "health", recentComparison: {
      status: "available", nativeDelta: outcomes[1] - outcomes[0], directionAwareGain: outcomes[1] - outcomes[0],
    } }] },
  };
}

test("48 useful structural reductions retain 13 receipt-backed facts without claiming full preservation", () => {
  const model = eventPulse(ledger());
  const partial = model.metrics[0];
  assert.equal(partial.observedTotal, 48);
  assert.equal(partial.completeTotal, 48);
  assert.equal(partial.receiptTotal, 13);
  assert.equal(partial.cumulative.at(-1).value, 48);
  assert.equal(partial.cumulative.at(-1).receipt, 13);
  assert.equal(model.decision.status, "not-rated");
  assert.equal(model.cost.status, "not-measured");
  assert.match(partial.notes.join(" "), /full behavior preservation is unknown/);
  const withoutReceipts = ledger();
  withoutReceipts.events.forEach(event => { event.attribution = "corroborated"; });
  const corroborated = eventPulse(withoutReceipts).metrics[0];
  assert.equal(corroborated.completeTotal, 48);
  assert.equal(corroborated.receiptTotal, 0);
  const input = timeline([null, null], [35, 48]);
  const report = timelinePulse(input);
  assert.equal(report.metrics[1].signal.current, 48);
  assert.equal(report.metrics[1].signal.status, "improving");
  assert.equal(report.metrics[2].signal.current, null);
});

test("repository health and linked contribution can move in opposite directions", () => {
  for (const [health, linked, healthStatus, linkedStatus] of [
    [[40, 30], [2, 4], "worsening", "improving"],
    [[30, 40], [4, 2], "improving", "worsening"],
  ]) {
    const model = timelinePulse(timeline(health, linked));
    assert.equal(model.metrics[0].basis, "repository-outcome");
    assert.equal(model.metrics[0].signal.status, healthStatus);
    assert.equal(model.metrics[1].basis, "workflow-contribution");
    assert.equal(model.metrics[1].signal.status, linkedStatus);
    assert.equal(model.decision.status, "not-rated");
  }
});

test("an explicitly agreed contribution bar does not require an unrelated primary outcome", () => {
  const input = timeline([null, null]);
  input.valueFunction.definition.review = { metricId: "structural", basis: "workflow-contribution",
    periods: 2, minimum: 2, rationale: "Explicit synthetic review bar." };
  assert.equal(reviewValue(input).decision.status, "keep-candidate");
  input.snapshots[1].metrics.structural = null;
  assert.equal(reviewValue(input).decision.status, "insufficient-evidence");
});

test("a repository headline preserves the separately reviewed contribution curve", () => {
  const input = timeline();
  input.valueFunction.definition.review = { metricId: "structural", basis: "workflow-contribution",
    periods: 2, minimum: 2, rationale: "Explicit synthetic review bar." };
  input.valueFunction.definition.signal = { metricId: "health", basis: "repository-outcome" };
  const report = timelinePulse(input);
  assert.equal(report.signal.basis, "repository-outcome");
  assert.equal(report.signal.status, "worsening");
  assert.equal(report.metrics[1].basis, "workflow-contribution");
  assert.equal(report.metrics[1].signal.status, "improving");
  input.valueFunction.definition.signal = { metricId: "structural", basis: "repository-outcome" };
  assert.throws(() => timelinePulse(input), /Invalid signal policy/);
});

test("snapshots and overlapping interval totals never become repeated deliveries", () => {
  const input = timeline();
  input.valueFunction.definition.evidence.measurementKind = "snapshot";
  const report = timelinePulse(input);
  assert.equal(report.metrics[0].signal.status, "worsening");
  assert.equal(report.metrics[1].signal.status, "insufficient-evidence");
  assert.ok(report.metrics.every(metric => metric.cumulative.length === 0));
  input.valueFunction.definition.evidence.measurementKind = "interval";
  input.snapshots[1].window.startAt = "2026-01-07T00:00:00Z";
  assert.equal(timelinePulse(input).signal.status, "insufficient-evidence");
});

test("new unknown evidence masks older success and partial native facts remain visible", () => {
  const input = timeline();
  input.snapshots.push({ ...structuredClone(input.snapshots[1]), observedAt: "2026-01-15T01:00:00Z",
    metrics: { health: null, structural: null, full: null },
    evidence: { coverageStatus: "missing", missingReason: "Expired evidence" } });
  input.window.endAt = "2026-01-15T01:00:00Z";
  const report = timelinePulse(input);
  assert.equal(report.metrics[1].signal.current, null);
  assert.equal(report.metrics[1].series.at(-1).value, null);
  assert.equal(report.signal.status, "insufficient-evidence");
  const partial = timeline();
  partial.snapshots.forEach(snapshot => { snapshot.evidence.coverageStatus = "partial"; });
  assert.deepEqual(timelinePulse(partial).metrics[1].series.map(point => point.value), [2, 4]);
  assert.equal(timelinePulse(partial).signal.status, "insufficient-evidence");
});

test("coverage gaps and stale cutoffs preserve historical subtotals without a current all-clear", () => {
  const input = ledger();
  input.coverage = [{ startAt: input.window.startAt, endAt: "2026-04-01T00:00:00Z", status: "complete" },
    { startAt: "2026-04-02T00:00:00Z", endAt, status: "complete" }];
  const partial = eventPulse(input).metrics[0];
  assert.equal(partial.observedTotal, 48);
  assert.equal(partial.completeTotal, null);
  assert.equal(partial.signal.status, "insufficient-evidence");
  const history = { index: { complete: true, repository: input.repository, until: "2026-05-10T00:00:00Z",
    sourceRevision: "a".repeat(40), workflows: [{ id: input.workflowSlug, path: input.sourcePath, gitBlob: "b".repeat(40) }] },
  entities: [] };
  const portfolio = workflowPortfolio(history, [], [{ workflowId: input.workflowSlug, input: ledger() }]);
  const measurement = portfolio.workflows[0].measurement;
  assert.equal(measurement.signal.current, null);
  assert.equal(measurement.signal.status, "insufficient-evidence");
  assert.equal(measurement.model.metrics[0].observedTotal, 48);
});

test("historical delivery and evidenced zero are distinct from unknown current value", () => {
  const input = ledger();
  input.observedAt = input.window.endAt = input.coverage[0].endAt = "2026-07-01T00:00:00Z";
  const historical = eventPulse(input).metrics[0];
  assert.equal(historical.observedTotal, 48);
  assert.equal(historical.signal.current, 0);
  assert.equal(historical.signal.status, "stalled");
  input.events = [];
  input.opportunities = 0;
  assert.equal(eventPulse(input).signal.status, "no-opportunity");
  input.opportunities = null;
  assert.equal(eventPulse(input).signal.attention, "evidence-needed");
  input.coverage[0].status = "unknown";
  const missing = eventPulse(input).metrics[0];
  assert.equal(missing.signal.current, null);
  assert.equal(missing.completeTotal, null);
  assert.equal(missing.signal.status, "insufficient-evidence");
});

test("receipt enrichment updates the original delivery and rejects conflicting native corrections", () => {
  const input = ledger();
  input.events.push({ ...input.events[0], attribution: "receipt-verified", observedAt: endAt });
  input.events[0].observedAt = "2026-04-01T00:00:00Z";
  const report = eventPulse(input).metrics[0];
  assert.equal(report.events.length, 2);
  assert.equal(report.observedTotal, 48);
  assert.equal(report.receiptTotal, 48);
  assert.equal(report.events[0].at, "2026-03-25T00:00:00Z");
  input.events.at(-1).value = 36;
  assert.throws(() => eventPulse(input), /Conflicting native facts/);
});

test("signal-only diagnostics must return null rather than zero for unknown evidence", t => {
  const directory = mkdtempSync(path.join(root, ".aw-value-methodology-test."));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const source = pathToFileURL(path.join(root, "optimization/operational-value/optimization-token-optimizer.mjs")).href;
  const module = path.join(directory, "value.mjs");
  const write = bad => writeFileSync(module, `
import * as original from ${JSON.stringify(source)};
export const definition = { ...original.definition,
  signal: { metricId: "partial", basis: "workflow-contribution" },
  metrics: [...original.definition.metrics, { ...original.definition.metrics[0],
    id: "partial", role: "diagnostic" }] };
export const collectBatch = original.collectBatch;
export function scoreMetric(id, evidence) {
  if (id !== "partial") return original.scoreMetric(id, evidence);
  return original.scoreMetric(original.definition.metrics[0].id, evidence)${bad ? " ?? 0" : ""};
}
`);
  write(false);
  assert.match(execFileSync(process.execPath, [path.join(scripts, "verify-value-function.mjs"), module],
    { encoding: "utf8", stdio: "pipe" }), /^verified /);
  write(true);
  assert.throws(() => execFileSync(process.execPath, [path.join(scripts, "verify-value-function.mjs"), module],
    { stdio: "pipe" }), /must return null for missing and malformed evidence/);
});

test("portable reports publish matching facts and escape untrusted labels", t => {
  const directory = mkdtempSync(path.join(root, ".aw-value-pulse-test."));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const output = path.join(directory, "pulse.html");
  const model = writePulse(ledger(), output);
  assert.deepEqual(JSON.parse(readFileSync(path.join(directory, "pulse.json"), "utf8")), model);
  assert.match(readFileSync(output, "utf8"), /<!doctype html>/);
  model.workflowName = "</script><img src=x onerror=alert(1)>";
  const html = renderPulse(model);
  assert.equal((html.match(/<\/script>/g) ?? []).length, 1);
  assert.ok(!html.includes("<img"));
  assert.ok(html.includes("\\u003c/script\\u003e"));
});
