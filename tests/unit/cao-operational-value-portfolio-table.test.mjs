import assert from "node:assert/strict";
import test from "node:test";
import { portfolioTableModel, renderPortfolioTable } from "../../scripts/workflow-portfolio-table.mjs";

const workflow = (id, { current = 2, previous = 1, signal = "improving", fresh = true,
  status = "measured", progress, attention = "not-indicated" } = {}) => ({
  id, measurement: { status, fresh, progress, attention,
    signal: status === "measured" ? { status: signal, basis: "workflow-contribution" } : null,
    model: status === "measured" ? {
      selectedMetricId: "native", window: { endAt: "2026-10-18T00:00:00Z" },
      metrics: [{ id: "native", unit: "verified effects", kind: "interval",
        signal: { current }, series: [
          { at: "2026-10-11T00:00:00Z", value: previous },
          { at: "2026-10-18T00:00:00Z", value: current },
        ] }],
    } : null,
  },
});

test("presentation preserves supplied direction-aware signals instead of interpreting raw quantities", () => {
  const input = [workflow("negative-improvement", { current: -4 }),
    workflow("positive-decline", { current: 4, signal: "worsening", attention: "review" }),
    workflow("zero-steady", { current: 0, previous: 0, signal: "steady" }),
    workflow("unknown", { current: null, previous: null, signal: "insufficient-evidence" })];
  const original = structuredClone(input);
  const model = portfolioTableModel(input);
  assert.deepEqual(model.rows.map(row => row.signal), ["improving", "worsening", "steady", "insufficient-evidence"]);
  assert.deepEqual(model.orders.signal, [1, 0, 2, 3]);
  assert.equal(model.rows[2].current, 0);
  assert.equal(model.rows[3].current, null);
  assert.deepEqual(input, original);
});

test("stale reports and historical-only values stay separate from current trends and failures", () => {
  const model = portfolioTableModel([
    workflow("stale", { current: 12, fresh: false }),
    workflow("historical", { current: null, previous: 3, signal: "insufficient-evidence" }),
    workflow("not-started", { status: "evaluation-in-progress", progress: { functionReady: false } }),
  ]);
  assert.equal(model.rows[0].signal, "stale");
  assert.equal(model.rows[0].current, 12);
  assert.equal(model.rows[0].freshnessLabel, "Stale report");
  assert.equal(model.rows[1].freshnessLabel, "Historical value only");
  assert.equal(model.rows[1].lastKnown, 3);
  assert.equal(model.rows[1].lastKnownAt, "2026-10-11T00:00:00Z");
  assert.equal(model.rows[2].signal, "not-evaluated");
  assert.equal(model.rows[2].stage, "In progress");
  assert.equal(model.rows[2].total, 0);
  assert.deepEqual(model.groups.find(group => group.id === "native").rows, [0, 1]);
});

test("coverage ordering prioritizes real evaluations and known-period coverage, not gap reports or activity", () => {
  const model = portfolioTableModel([
    workflow("partial", { previous: null, progress: { partial: true } }),
    workflow("gap", { status: "evidence-unavailable", progress: { functionReady: true, reportAvailable: true } }),
    workflow("fuller-history"),
    workflow("contract", { status: "outcome-contract-needed" }),
  ]);
  assert.deepEqual(model.orders.coverage, [2, 0, 1, 3]);
  assert.equal(model.rows[0].ratio, 0.5);
  assert.equal(model.rows[0].limited, true);
  assert.equal(model.rows[1].stage, "Gap report");
  assert.deepEqual(model.groups.find(group => group.id === "native").rows, [0, 2]);
});

test("event rates keep their per-week unit and use disjoint periods, not smoothed daily points", () => {
  const input = workflow("events");
  Object.assign(input.measurement.model.metrics[0], {
    kind: "events", unit: "files", signal: { current: 1.75 },
    weekly: [{ endAt: "2026-10-11T00:00:00Z", value: 4 }, { endAt: "2026-10-18T00:00:00Z", value: null }],
  });
  const row = portfolioTableModel([input]).rows[0];
  assert.equal(row.current, 1.75);
  assert.equal(row.unit, "files/week");
  assert.equal(row.lastKnownUnit, "files");
  assert.equal(row.total, 2);
  assert.equal(row.known, 1);
});

test("static report escapes content and emits compiled presentation orders with honest empty states", () => {
  const input = workflow("<script>alert(1)</script>");
  input.measurement.model.metrics[0].unit = '<img src=x onerror="alert(1)">';
  const html = renderPortfolioTable([input], new Map([[input.id, "details.html#safe"]]));
  assert.ok(!html.includes("<script>alert(1)</script>"));
  assert.ok(!html.includes("<img src=x"));
  assert.match(html, /&lt;script&gt;/);
  assert.match(html, /&lt;img/);
  assert.match(html, /aria-sort="none"/);
  assert.match(html, /No workflows match this status/);
  assert.match(html, /Sorting and status selection require JavaScript/);
  assert.match(html, /100\.0%/);
  assert.match(html, /1 \/ 1 workflows; 0 remaining/);
  const plan = JSON.parse(html.match(/data-table-plan>(.*?)<\/script>/s)[1]);
  assert.deepEqual(plan.orders.coverage, [0]);
  assert.deepEqual(plan.groups.stale, []);
  assert.throws(() => portfolioTableModel([workflow("bad", { signal: "invented" })]), /Unknown portfolio/);
  const partial = renderPortfolioTable([input, workflow("missing", { status: "outcome-contract-needed" })],
    new Map([[input.id, "details.html#safe"], ["missing", "details.html#missing"]]));
  assert.match(partial, /50\.0%/);
  assert.match(partial, /1 \/ 2 workflows; 1 remaining/);
  assert.match(renderPortfolioTable([], new Map()), /0\.0%/);
});
