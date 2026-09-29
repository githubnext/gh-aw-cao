import assert from "node:assert/strict";
import test from "node:test";
import { reconcileDispatchCycles } from "../../activity/dispatch-reconciliation.mjs";

const cycles = [
  { id: 1, created_at: "2026-09-29T04:00:00Z", updated_at: "2026-09-29T04:05:00Z" },
  { id: 2, created_at: "2026-09-29T05:00:00Z", updated_at: "2026-09-29T05:05:00Z" },
];
const artifact = (runId) => ({
  requests: [{ type: "dispatch_workflow", workflow_name: "cao-evolution-reliability", inputs: {
    target_repo: "githubnext/gh-aw-cao",
    correlation_id: `correlation-${runId}`,
  } }],
  manifest: [{ type: "dispatch_workflow", timestamp: `2026-09-29T0${runId + 3}:04:00Z` }],
});

test("two accepted dispatch cycles with no corresponding worker runs flag a dark period", () => {
  const result = reconcileDispatchCycles(cycles, new Map([[1, artifact(1)], [2, artifact(2)]]), new Map([["cao-evolution-reliability", []]]), "githubnext/gh-aw-cao");
  assert.equal(result.status, "missing_data");
  assert.equal(result.workers[0].expected, 2);
  assert.equal(result.workers[0].triggered, 0);
  assert.deepEqual(result.workers[0].correlations, ["correlation-1", "correlation-2"]);
});

test("matching workflow_dispatch runs in each window do not flag a healthy campaign", () => {
  const runs = new Map([["cao-evolution-reliability", [
    { id: 10, event: "workflow_dispatch", created_at: "2026-09-29T04:03:59Z" },
    { id: 11, event: "workflow_dispatch", created_at: "2026-09-29T05:08:00Z" },
    { id: 12, event: "schedule", created_at: "2026-09-29T05:09:00Z" },
  ]]]);
  assert.equal(reconcileDispatchCycles(cycles, new Map([[1, artifact(1)], [2, artifact(2)]]), runs, "githubnext/gh-aw-cao").status, "healthy");
});

test("an isolated missed cycle does not trigger a multi-cycle alarm", () => {
  const runs = new Map([["cao-evolution-reliability", [
    { id: 11, event: "workflow_dispatch", created_at: "2026-09-29T05:08:00Z" },
  ]]]);
  const result = reconcileDispatchCycles(cycles, new Map([[1, artifact(1)], [2, artifact(2)]]), runs, "githubnext/gh-aw-cao");
  assert.equal(result.status, "healthy");
  assert.equal(result.workers[0].triggered, 1);
});

test("absent manifest or request evidence is incomplete, not a healthy zero dispatch cycle", () => {
  const result = reconcileDispatchCycles(cycles, new Map([[1, artifact(1)], [2, { requests: [], manifest: null }]]), new Map(), "githubnext/gh-aw-cao");
  assert.equal(result.status, "incomplete");
});

test("a no-dispatch cycle with an empty manifest is not a missing worker run", () => {
  const result = reconcileDispatchCycles(cycles, new Map([[1, { requests: [], manifest: [] }], [2, { requests: [], manifest: [] }]]), new Map(), "githubnext/gh-aw-cao");
  assert.equal(result.status, "healthy");
  assert.deepEqual(result.workers, []);
});
