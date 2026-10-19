import assert from "node:assert/strict";
import test from "node:test";
import { observationWindows } from "../../.github/skills/add-operational-value/scripts/common.mjs";

const start = "2026-02-21T02:35:50Z", end = "2026-10-18T15:00:12Z";
const definition = (window = {}) => ({
  adoption: { adoptedAt: start }, evaluation: { mode: "attainment-only" },
  evidence: { measurementKind: "interval",
    window: { durationDays: 7, cadenceDays: 7, maturationDays: 0, ...window } },
});

function disjoint(windows) {
  for (const [index, window] of windows.entries()) {
    assert.ok(Date.parse(window.windowStart) < Date.parse(window.windowEnd));
    if (index) assert.ok(Date.parse(windows[index - 1].windowEnd) <= Date.parse(window.windowStart));
  }
}

test("interval schedules cover adoption to the cutoff exactly once, including off-cadence cutoffs", () => {
  const windows = observationWindows(definition(), start, end);
  disjoint(windows);
  assert.equal(windows[0].windowStart, start);
  assert.equal(windows.at(-1).windowEnd, end);
  assert.equal(windows.at(-1).windowStart, "2026-10-11T15:00:12Z");
  for (let index = 1; index < windows.length; index++) {
    assert.equal(windows[index - 1].windowEnd, windows[index].windowStart);
  }
  const deliveries = ["2026-09-01T00:00:00Z", "2026-10-11T15:00:12Z", "2026-10-17T00:00:00Z"];
  for (const at of deliveries) assert.equal(windows.filter(window =>
    at >= window.windowStart && at < window.windowEnd).length, 1);
});

test("archived overlapping intervals and comparison points cannot reenter the current delivery schedule", () => {
  const original = observationWindows(definition(), start, end);
  const retained = [{ observedAt: "2026-10-17T02:35:50Z" }, { observedAt: "2026-10-11T15:00:12Z" }];
  assert.deepEqual(observationWindows(definition(), start, end, retained), original);
  assert.deepEqual(retained, [{ observedAt: "2026-10-17T02:35:50Z" }, { observedAt: "2026-10-11T15:00:12Z" }]);
});

test("maturation is applied consistently to leading partial and complete intervals", () => {
  const windows = observationWindows(definition({ maturationDays: 2 }), start, end);
  disjoint(windows);
  assert.equal(windows[0].windowStart, start);
  assert.equal(windows.at(-1).windowEnd, "2026-10-16T15:00:12Z");
  for (let index = 1; index < windows.length; index++) {
    assert.equal(windows[index - 1].windowEnd, windows[index].windowStart);
  }
});

test("short cold starts retain a provisional window, not a fabricated mature period", () => {
  assert.deepEqual(observationWindows(definition({ maturationDays: 2 }), start, "2026-02-22T02:35:50Z"),
    [{ observedAt: "2026-02-22T02:35:50Z", windowStart: start, windowEnd: "2026-02-22T02:35:50Z" }]);
});

test("measurement duration prevents overlapping cohorts even with more frequent report cadence", () => {
  disjoint(observationWindows(definition({ durationDays: 14 }), start, end));
  const sparse = observationWindows(definition({ cadenceDays: 14 }), start, end);
  disjoint(sparse);
  assert.ok(sparse.some((window, index) => index && sparse[index - 1].windowEnd !== window.windowStart));
});

test("snapshot sampling retains its adoption cadence and historical observations", () => {
  const value = definition();
  value.evidence.measurementKind = "snapshot";
  const retained = [{ observedAt: "2026-10-17T04:00:00Z" }];
  const windows = observationWindows(value, start, end, retained);
  assert.equal(windows[0].observedAt, "2026-02-28T02:35:50Z");
  assert.ok(windows.some(window => window.observedAt === retained[0].observedAt));
  assert.equal(windows.at(-1).observedAt, end);
});
