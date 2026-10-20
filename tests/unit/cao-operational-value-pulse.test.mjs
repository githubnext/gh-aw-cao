import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { eventPulse, signalPolicy, timelinePulse } from "../../.github/skills/add-operational-value/scripts/pulse-model.mjs";
import { renderPulse } from "../../.github/skills/add-operational-value/scripts/render-pulse.mjs";

const root = path.resolve(import.meta.dirname, "../..");
const scripts = path.join(root, ".github/skills/add-operational-value/scripts");
const reference = { definition: {
  repository: "octo/example", slug: "verify-bugs", workflowName: "Verify bugs",
  sourcePath: ".github/workflows/verify-bugs.md",
  adoption: { adoptedAt: "2026-01-01T00:00:00Z" }, evidence: {},
  metrics: [{ id: "outcome", name: "Verified problem resolution", role: "primary",
    unit: "percent", direction: "increase" }],
} };
const DAY = 86400000;
const metric = { id: "linked", name: "Confirmed linked fixes", unit: "defects", direction: "increase",
  version: "v1", formula: "Count independently verified linked repairs once at acceptance." };
const event = (id, at, value = 1, attribution = "corroborated") => ({
  id, at, value, attribution, label: `Fix ${id}`, detail: "Independent regression verification.",
  acceptance: { state: "accepted", at, ref: id },
  evidence: [{ label: "Accepted revision", url: `https://github.com/octo/example/commit/${id}` }],
});
function ledger(previous = 1, current = 2) {
  const window = { startAt: "2026-01-01T00:00:00Z", endAt: "2026-05-01T00:00:00Z" };
  return { schemaVersion: 1, kind: "operational-value-events", repository: "octo/example",
    workflowSlug: "verify-bugs", workflowName: "Verify bugs", sourcePath: ".github/workflows/verify-bugs.md",
    intent: { goal: "Resolve confirmed defects.", acceptance: "Independent verification at the accepted revision." },
    observedAt: window.endAt, cadenceDays: 7, metric: { ...metric }, basis: "workflow-contribution",
    window, coverage: [{ ...window, status: "complete" }], opportunities: 5, limitations: [],
    events: [event("a", "2026-03-25T00:00:00Z", previous),
      event("b", "2026-04-20T00:00:00Z", current, "receipt-verified")] };
}
const focus = input => eventPulse(input).metrics[0];
function timeline(values = [2, 4]) {
  const definition = { ...structuredClone(reference.definition),
    signal: { metricId: "linked", basis: "workflow-contribution" },
    evidence: { ...structuredClone(reference.definition.evidence), measurementKind: "interval",
      window: { durationDays: 7, cadenceDays: 7, maturationDays: 0 } },
    adoption: { ...reference.definition.adoption, adoptedAt: "2026-01-01T00:00:00Z" },
    metrics: [...structuredClone(reference.definition.metrics), { ...metric, role: "diagnostic" }] };
  return { repository: "octo/example", window: { startAt: "2026-01-01T00:00:00Z", endAt: "2026-01-15T00:00:00Z" },
    valueFunction: { definition },
    snapshots: values.map((value, index) => {
      const end = Date.parse(`2026-01-${index ? "15" : "08"}T00:00:00Z`);
      return { observedAt: new Date(end).toISOString(),
        window: { startAt: new Date(end - 7 * DAY).toISOString(), endAt: new Date(end).toISOString() },
        metrics: { outcome: 80, linked: value },
        evidence: { coverageStatus: "complete", maturityStatus: "matured", eligibleCount: 5 } };
    }),
    metricReview: { metrics: [{ ...definition.metrics[0],
      recentComparison: { status: "available", nativeDelta: 0, directionAwareGain: 0 } }] } };
}

test("delivery trends are exact adjacent-window native rates, not the overlapping baseline", () => {
  for (const [before, after, status, attention] of [
    [1, 2, "improving", "not-indicated"], [2, 1, "worsening", "review"],
    [2, 2, "steady", "not-indicated"], [0, 0, "stalled", "review"],
  ]) {
    const model = focus(ledger(before, after));
    assert.equal(model.signal.status, status);
    assert.equal(model.signal.attention, attention);
    assert.equal(model.signal.previous, before / 4);
    assert.equal(model.signal.current, after / 4);
    assert.equal(model.observedTotal, before + after);
    assert.equal(model.baselineRate, (before + after) / 13);
  }
});

test("beginner summaries distinguish net change, missing evidence and whole-goal verification", () => {
  const quiet = focus(ledger(2, 0));
  assert.match(quiet.reader.title, /No net improvement in the last 28 days/);
  assert.equal(quiet.reader.displayTitle, "No recent net progress");
  assert.equal(quiet.currentTotal, 0);
  assert.equal(quiet.previousTotal, 2);
  assert.match(quiet.reader.caution, /not exclusive workflow credit/);
  assert.match(quiet.reader.next, /cannot distinguish/);
  const worse = focus(ledger(2, -1));
  assert.match(worse.reader.title, /has worsened/);
  assert.equal(worse.currentTotal, -1);
  const partial = ledger();
  partial.coverage[0].status = "partial";
  const unknown = focus(partial);
  assert.match(unknown.reader.title, /Not enough evidence/);
  assert.equal(unknown.reader.displayTitle, unknown.reader.title, "Missing data must not become a zero-progress headline.");
  assert.equal(unknown.currentTotal, null);
  assert.equal(unknown.previousTotal, null);
  assert.deepEqual(eventPulse(ledger()).checks, []);
  assert.equal(eventPulse(ledger()).repositoryState, null);
  const noWork = ledger(0, 0);
  noWork.opportunities = 0;
  assert.equal(focus(noWork).reader.title, "No eligible work observed");
  assert.equal(focus(noWork).reader.displayTitle, "No eligible work observed");
});

test("optional result labels describe the native measure without changing any values or rules", () => {
  const input = ledger();
  const before = eventPulse(input);
  input.resultLabel = "verified fixes";
  const after = eventPulse(input);
  assert.equal(after.resultLabel, "verified fixes");
  assert.deepEqual(after.metrics, before.metrics);
  assert.equal(before.resultLabel, null);
  for (const label of ["", " ", 12, {}, null]) {
    input.resultLabel = label;
    assert.throws(() => eventPulse(input), /Invalid report result label/);
  }
});
test("independent snapshot context and explicit quality checks survive without becoming contribution", () => {
  const input = ledger();
  input.repositoryState = {
    metric: { ...metric, id: "remaining", name: "Unresolved defects", direction: "decrease" },
    observations: [
      { at: input.window.startAt, value: 2, ref: "start", url: "https://github.com/octo/example/commit/start",
        items: [{ label: "Retained item", url: "https://github.com/octo/example/blob/start/defect.go#L1" }] },
      { at: input.window.endAt, value: 8, ref: "end", url: "https://github.com/octo/example/commit/end" },
    ],
    limitation: "Sparse snapshots include changes by every actor.",
  };
  input.checks = [{ name: "No regressions", status: "not-verified", detail: "Required tests are not retained." }];
  const model = eventPulse(input);
  assert.deepEqual(model.repositoryState, input.repositoryState);
  assert.deepEqual(model.checks, input.checks);
  assert.equal(model.metrics[0].completeTotal, 3);
  assert.equal(model.metrics[0].signal.status, "improving");
  for (const mutate of [
    value => { value.repositoryState.observations[1].value = NaN; },
    value => { value.repositoryState.observations[1].at = "2026-05-02T00:00:00Z"; },
    value => { value.repositoryState.observations[1].at = value.window.startAt; },
    value => { value.repositoryState.observations[0].url = "javascript:alert(1)"; },
    value => { value.repositoryState.observations[0].url = "https://token@example.com/"; },
    value => { value.repositoryState.observations[0].ref = ""; },
    value => { value.repositoryState.observations[0].items = {}; },
    value => { value.repositoryState.observations[0].items[0] = null; },
    value => { value.repositoryState.observations[0].items[0].label = ""; },
    value => { value.repositoryState.observations[0].items[0].url = "javascript:alert(1)"; },
    value => { value.repositoryState.observations[0].items[0].url = "https://token@example.com/"; },
    value => { value.repositoryState.observations[0] = null; },
    value => { value.repositoryState.metric.formula = ""; },
    value => { value.checks[0].status = "probably-passed"; },
  ]) {
    const altered = structuredClone(input);
    mutate(altered);
    assert.throws(() => eventPulse(altered), /Invalid repository-state|Invalid report checks/);
  }
});

test("no opportunity and unknown opportunity are not workflow failure", () => {
  const input = ledger(0, 0);
  input.opportunities = 0;
  assert.equal(focus(input).signal.status, "no-opportunity");
  assert.equal(focus(input).signal.attention, "not-indicated");
  input.opportunities = null;
  assert.equal(focus(input).signal.status, "steady");
  assert.equal(focus(input).signal.attention, "evidence-needed");
});

test("fractional native units do not turn floating-point roundoff into a trend", () => {
  const input = ledger(.3, .1);
  input.events.push(event("fraction", "2026-04-21T00:00:00Z", .2));
  assert.equal(focus(input).signal.status, "steady");
  input.events[2].value = .21;
  assert.equal(focus(input).signal.status, "improving");
});

test("cold start, partial evidence and stale capture remain unknown rather than zero", () => {
  const cold = ledger();
  cold.window.startAt = cold.coverage[0].startAt = "2026-04-10T00:00:00Z";
  cold.events.shift();
  assert.equal(focus(cold).signal.status, "insufficient-evidence");
  assert.equal(focus(cold).signal.current, null);
  assert.equal(focus(cold).baselineRate, null);
  const partial = ledger();
  partial.coverage[0].status = "partial";
  assert.equal(focus(partial).completeTotal, null);
  assert.equal(focus(partial).observedTotal, 3);
  assert.equal(focus(partial).signal.status, "insufficient-evidence");
  const stale = ledger();
  stale.events.pop();
  stale.observedAt = "2026-04-20T00:00:00Z";
  stale.coverage[0].endAt = stale.observedAt;
  assert.equal(focus(stale).signal.attention, "evidence-needed");
  assert.match(focus(stale).signal.reason, /stale/);
});

test("gaps invalidate crossing windows and cumulative completeness, not the known subtotal", () => {
  const input = ledger();
  input.coverage = [
    { startAt: input.window.startAt, endAt: "2026-03-30T00:00:00Z", status: "complete" },
    { startAt: "2026-04-01T00:00:00Z", endAt: input.window.endAt, status: "complete" },
  ];
  const model = focus(input);
  assert.equal(model.signal.current, .5);
  assert.equal(model.signal.previous, null);
  assert.equal(model.signal.status, "insufficient-evidence");
  assert.equal(model.completeTotal, null);
  assert.equal(model.cumulative.at(-1).value, null);
  assert.equal(model.observedTotal, 3);
});

test("events are counted once; later attribution enriches the original delivery date", () => {
  const input = ledger();
  input.events.push(structuredClone(input.events[0]));
  const upgrade = { ...structuredClone(input.events[0]), attribution: "receipt-verified",
    observedAt: "2026-04-29T00:00:00Z" };
  input.events[0].observedAt = input.events[2].observedAt = "2026-04-01T00:00:00Z";
  input.events.push(upgrade);
  const model = focus(input);
  assert.equal(model.events.length, 2);
  assert.equal(model.observedTotal, 3);
  assert.equal(model.receiptTotal, 3);
  assert.equal(model.events[0].at, "2026-03-25T00:00:00Z");
  assert.equal(model.signal.previous, .25);
});

test("negative native effects survive without clamping, smoothing or weighted attribution", () => {
  const input = ledger(2, -1);
  const model = focus(input);
  assert.equal(model.observedTotal, 1);
  assert.equal(model.signal.current, -.25);
  assert.equal(model.signal.status, "worsening");
  assert.equal(model.cumulative.at(-1).value, 1);
  assert.equal(model.receiptTotal, -1);
});

test("half-open windows, true calendar exposure and cumulative steps agree exactly", () => {
  const input = ledger();
  input.events.push(event("boundary", "2026-04-03T00:00:00Z", 4));
  input.events.push(event("week-boundary", "2026-03-30T00:00:00Z", 0));
  const model = focus(input);
  assert.equal(model.signal.previous, .25);
  assert.equal(model.signal.current, 1.5);
  assert.equal(model.weekly.reduce((sum, bucket) => sum + bucket.value, 0), 7);
  assert.ok(model.weekly[0].partial);
  assert.ok(model.weekly.at(-1).partial);
  assert.equal(model.cumulative.at(-1).value, 7);
  assert.equal(model.cumulative.find(point => point.at === input.events[2].at).value, 5);
  assert.equal(model.series[0].value, null);
  assert.deepEqual(model.currentEventIds, ["boundary", "b"]);
  assert.deepEqual(model.previousEventIds, ["a", "week-boundary"]);
  const byId = new Map(model.events.map(event => [event.id, event]));
  assert.deepEqual(model.weekly.flatMap(bucket => bucket.eventIds), model.events.map(event => event.id));
  for (const bucket of model.weekly) {
    assert.equal(bucket.eventIds.reduce((sum, id) => sum + byId.get(id).value, 0), bucket.value);
    assert.ok(bucket.eventIds.every(id => Date.parse(byId.get(id).at) >= Date.parse(bucket.startAt)
      && Date.parse(byId.get(id).at) < Date.parse(bucket.endAt)));
  }
  input.coverage[0].status = "partial";
  const partial = focus(input);
  assert.equal(partial.currentTotal, null);
  assert.deepEqual(partial.currentEventIds, model.currentEventIds, "Incomplete coverage must not erase known evidence.");
});

test("mixed versions/units, conflicting corrections, unsafe evidence and coverage overlap fail closed", () => {
  const mutations = [
    value => { value.events[0].metricVersion = "v2"; },
    value => { value.events[0].unit = "dollars"; },
    value => { value.events[0].metricId = "other"; },
    value => { value.events.push({ ...value.events[0], value: 200 }); },
    value => { value.events.push({ ...value.events[0],
      acceptance: { ...value.events[0].acceptance, ref: "different-accepted-revision" } }); },
    value => { value.events[0].evidence[0].url = "javascript:alert(1)"; },
    value => { value.events[0].evidence[0].url = "https://token@example.com/"; },
    value => { value.coverage.push({ ...value.coverage[0] }); },
    value => { value.events[0].at = value.window.endAt; },
    value => { value.events[0].attribution = "unverified-claim"; },
    value => { value.observedAt = "2026-04-30T00:00:00Z"; },
    value => { value.metric.direction = "maintain"; value.metric.target = 1; },
  ];
  for (const mutate of mutations) {
    const input = ledger();
    mutate(input);
    assert.throws(() => eventPulse(input), /Invalid|Conflicting/);
  }
});

test("generic timeline export uses its declared contribution without inventing a keep bar", () => {
  const input = timeline();
  const model = timelinePulse(input);
  assert.equal(model.selectedMetricId, "linked");
  assert.equal(model.signal.status, "improving");
  assert.equal(model.signal.metricId, "linked");
  assert.equal(model.signal.unit, "defects");
  assert.equal(model.metrics[1].signal.status, "improving");
  assert.equal(model.metrics[1].signal.directionAwareGain, 2);
  assert.equal(model.decision.status, "not-rated");
  assert.equal(model.metrics[1].cumulative.length, 0);
  delete input.valueFunction.definition.signal;
  const outcome = timelinePulse(input);
  assert.equal(outcome.selectedMetricId, "outcome");
  assert.equal(outcome.metrics[0].basis, "repository-outcome");
  assert.equal(outcome.metrics[1].basis, "diagnostic");
  assert.equal(outcome.metrics[0].signal.status, "steady");
});

test("decrease and target directions describe native improvement without complementing the values", () => {
  for (const direction of ["decrease", "target", "maintain"]) {
    const input = timeline([4, 2]);
    Object.assign(input.valueFunction.definition.metrics[1], { direction, target: 0 });
    const model = timelinePulse(input).metrics[1];
    assert.equal(model.signal.status, "improving");
    assert.equal(model.signal.current, 2);
    assert.equal(model.signal.directionAwareGain, 2);
  }
});

test("repository health and contribution retain opposing curves regardless of headline selection", () => {
  for (const improvingRepository of [true, false]) {
    const input = timeline(improvingRepository ? [4, 2] : [2, 4]);
    input.snapshots.forEach((row, index) => {
      row.metrics.outcome = improvingRepository === (index === 1) ? 80 : 40;
    });
    input.valueFunction.definition.signal = { metricId: "outcome", basis: "repository-outcome" };
    input.valueFunction.definition.review = { metricId: "linked", basis: "workflow-contribution",
      periods: 2, minimum: 1, rationale: "Synthetic owner-agreed contribution bar, not repository health." };
    const model = timelinePulse(input);
    assert.equal(model.selectedMetricId, "outcome");
    assert.equal(model.metrics[0].basis, "repository-outcome");
    assert.equal(model.metrics[1].basis, "workflow-contribution");
    assert.equal(model.metrics[0].signal.status, improvingRepository ? "improving" : "worsening");
    assert.equal(model.metrics[1].signal.status, improvingRepository ? "worsening" : "improving");
    assert.equal(model.decision.status, "keep-candidate");
    input.valueFunction.definition.signal = { metricId: "linked", basis: "repository-outcome" };
    assert.throws(() => timelinePulse(input), /Invalid signal policy/);
  }
});

test("snapshot states compare by cadence but never earn workflow delivery or cumulative credit", () => {
  const input = timeline();
  input.valueFunction.definition.evidence.measurementKind = "snapshot";
  assert.equal(timelinePulse(input).metrics[1].signal.status, "insufficient-evidence");
  delete input.valueFunction.definition.signal;
  input.snapshots[0].metrics.outcome = 40;
  const model = timelinePulse(input).metrics[0];
  assert.equal(model.signal.status, "improving");
  assert.equal(model.cumulative.length, 0);
});

test("rolling interval trends skip overlapping assessments and compare independent cohorts", () => {
  const input = timeline();
  input.valueFunction.definition.evidence.window.durationDays = 14;
  input.window.endAt = "2026-01-29T00:00:00Z";
  input.snapshots = [1, 99, 3].map((value, index) => {
    const end = Date.parse("2026-01-15T00:00:00Z") + index * 7 * DAY;
    return { observedAt: new Date(end).toISOString(),
      window: { startAt: new Date(end - 14 * DAY).toISOString(), endAt: new Date(end).toISOString() },
      metrics: { outcome: 80, linked: value },
      evidence: { coverageStatus: "complete", maturityStatus: "matured", eligibleCount: 5 } };
  });
  const model = timelinePulse(input).metrics[1];
  assert.equal(model.signal.previous, 1);
  assert.equal(model.signal.current, 3);
  assert.equal(model.signal.status, "improving");
});

test("a missed agreed bar still requests attention when a positive trend is steady", () => {
  const input = timeline([1, 1]);
  input.valueFunction.definition.review = { metricId: "linked", basis: "workflow-contribution", periods: 2,
    minimum: 2, rationale: "Synthetic explicit owner-agreed minimum for this test." };
  const model = timelinePulse(input);
  assert.equal(model.signal.status, "steady");
  assert.equal(model.signal.attention, "review");
  assert.match(model.signal.reason, /bar was missed/);
});

test("incomplete latest assessments mask older good evidence and do not trigger decline alerts", () => {
  const input = timeline([2, 0]);
  input.snapshots.push({ ...structuredClone(input.snapshots[1]), observedAt: "2026-01-15T01:00:00Z",
    metrics: { outcome: null, linked: null } });
  input.window.endAt = "2026-01-15T01:00:00Z";
  const model = timelinePulse(input).metrics[1];
  assert.equal(model.signal.status, "insufficient-evidence");
  assert.equal(model.signal.attention, "evidence-needed");
  assert.equal(model.series.at(-1).value, null);
});

test("unknown acceptance diagnostics never erase separately demonstrated contribution", () => {
  const input = timeline([2, 4]);
  input.valueFunction.definition.metrics.push({ ...metric, id: "acceptance", role: "diagnostic" });
  input.snapshots.forEach(snapshot => { snapshot.metrics.acceptance = null; });
  const model = timelinePulse(input);
  assert.equal(model.metrics[1].signal.current, 4);
  assert.equal(model.metrics[1].signal.status, "improving");
  assert.equal(model.metrics[2].signal.status, "insufficient-evidence");
});

test("partial evidence plots known native subtotals without inventing a complete comparison", () => {
  const input = timeline([2, 4]);
  input.snapshots.forEach(snapshot => {
    snapshot.evidence.coverageStatus = "partial";
    snapshot.metrics.outcome = null;
  });
  const model = timelinePulse(input);
  assert.deepEqual(model.metrics[0].series.map(point => point.value), [null, null]);
  assert.deepEqual(model.metrics[1].series.map(point => point.value), [2, 4]);
  assert.equal(model.metrics[1].series.at(-1).status, "incomplete-evidence");
  assert.equal(model.signal.status, "insufficient-evidence");
  assert.equal(model.signal.attention, "evidence-needed");
});

test("signal selection validates basis without silently crediting an actor-independent primary", () => {
  const input = timeline();
  for (const signal of [
    { metricId: "absent", basis: "workflow-contribution" },
    { metricId: "outcome", basis: "workflow-contribution" },
    { metricId: "linked", basis: "runs-succeeded" },
    { metricId: "linked", basis: "workflow-contribution", minimum: 3 },
  ]) assert.throws(() => signalPolicy({ ...input.valueFunction.definition, signal }), /Invalid signal policy/);
  input.valueFunction.definition.metrics[1].direction = "target";
  assert.throws(() => timelinePulse(input), /Invalid pulse metric/);
});

test("reports are self-contained and treat workflow goals/labels as untrusted text", () => {
  const model = eventPulse(ledger());
  model.workflowName = "</script><img src=x onerror=alert(1)>";
  model.resultLabel = "</script><img src=x onerror=alert(5)>";
  model.metrics[0].events[0].detail = "</script><script>alert(2)</script>";
  model.metrics[0].events[0].title = "</script><img src=x onerror=alert(3)>";
  model.metrics[0].events[0].summary = "</script><script>alert(4)</script>";
  const html = renderPulse(model);
  assert.equal((html.match(/<script /g) ?? []).length, 1);
  assert.equal((html.match(/<\/script>/g) ?? []).length, 1);
  assert.ok(html.includes("\\u003c/script\\u003e"));
  assert.ok(!html.includes("<img"));
  assert.ok(!html.includes("fetch("));
});

test("File Diet reuses the generic ledger with its real 48/13 oracle and worsening delivery signal", () => {
  const input = JSON.parse(readFileSync(path.join(root, "tests/fixtures/operational-value/file-diet-events.json"), "utf8"));
  assert.equal(eventPulse(input).signal.unit, "files/week");
  const model = focus(input);
  assert.equal(model.events.length, 51);
  assert.equal(model.observedTotal, 48);
  assert.equal(model.receiptTotal, 13);
  assert.equal(model.signal.current, 0);
  assert.equal(model.baselineRate, 1);
  assert.equal(model.lastPositiveAt, "2026-08-25T16:35:32Z");
  assert.equal(model.signal.status, "worsening");
  assert.equal(model.signal.attention, "review");
  assert.equal(model.signal.opportunities, 53);
  assert.equal(model.cumulative.at(-1).value, 48);
  assert.equal(eventPulse(input).decision.status, "not-rated");
  const withoutReceipts = structuredClone(input);
  withoutReceipts.events.forEach(event => { event.attribution = "corroborated"; });
  const corroborated = focus(withoutReceipts);
  assert.equal(corroborated.observedTotal, 48);
  assert.equal(corroborated.receiptTotal, 0);
  assert.equal(corroborated.cumulative.at(-1).value, 48);
  assert.equal(corroborated.signal.current, 0, "historical delivery is not current-period delivery");
  withoutReceipts.coverage[0].status = "unknown";
  const unavailable = focus(withoutReceipts);
  assert.equal(unavailable.observedTotal, 48);
  assert.equal(unavailable.completeTotal, null);
  assert.equal(unavailable.signal.current, null, "missing coverage is not an observed current zero");
});

test("the report CLI publishes reusable machine-readable and file-backed visual artifacts", () => {
  mkdirSync(path.join(root, ".tmp"), { recursive: true });
  const directory = mkdtempSync(path.join(root, ".tmp", "value-pulse-"));
  try {
    const input = path.join(directory, "events.json");
    const output = path.join(directory, "pulse.html");
    writeFileSync(input, JSON.stringify(ledger()));
    execFileSync("node", [path.join(scripts, "render-pulse.mjs"), input, output]);
    assert.match(readFileSync(output, "utf8"), /<!doctype html>/);
    const model = JSON.parse(readFileSync(path.join(directory, "pulse.json"), "utf8"));
    assert.equal(model.signal.status, "improving");
    assert.equal(model.signal.attention, "not-indicated");
    assert.equal(model.metrics[0].signal.status, "improving");
    assert.equal(model.metrics[0].signal.attention, "not-indicated");
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test("delivery requires explicit acceptance at its event time and matured evidence", () => {
  for (const state of ["pending", "rejected", "unknown", undefined]) {
    const input = ledger();
    input.events[0].acceptance.state = state;
    assert.throws(() => eventPulse(input), /Invalid event/);
  }
  for (const mutate of [
    value => { delete value.events[0].acceptance; },
    value => { value.events[0].acceptance.at = "2026-03-26T00:00:00Z"; },
    value => { value.events[0].acceptance.ref = ""; },
    value => { value.maturationDays = 14; },
    value => { value.maturationDays = -1; },
    value => { delete value.intent; },
    value => { delete value.metric.formula; },
  ]) {
    const input = ledger();
    mutate(input);
    assert.throws(() => eventPulse(input), /Invalid/);
  }
  const mature = ledger();
  mature.maturationDays = 7;
  assert.equal(focus(mature).observedTotal, 3);
});
