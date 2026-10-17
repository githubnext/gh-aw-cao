import assert from "node:assert/strict";
import test from "node:test";
import { createDashboardServerQueryBudget } from "../e2e/dashboard-server-query-budget.mjs";

function fixture() {
  let clock = 0;
  const waits = [];
  const budget = createDashboardServerQueryBudget({
    now: () => clock,
    async sleep(duration) {
      waits.push(duration);
      clock += duration;
    },
  });
  const response = (remaining, reset = 60, capacity = 30) => ({
    headers: () => ({
      "ratelimit-limit": String(capacity),
      "ratelimit-remaining": String(remaining),
      "ratelimit-reset": String(reset),
    }),
  });
  return { budget, waits, response };
}

test("server page queries are serialized and respect the advertised refill rate", async () => {
  const { budget, waits, response } = fixture();
  const calls = [];
  let release;
  const first = budget.run(async () => {
    calls.push("first");
    await new Promise((resolve) => { release = resolve; });
    return response(0);
  });
  const second = budget.run(async () => {
    calls.push("second");
    assert.deepEqual(waits, [3000]);
    return response(0);
  });
  await Promise.resolve();
  await Promise.resolve();
  assert.deepEqual(calls, ["first"]);
  release();
  await Promise.all([first, second]);
  assert.deepEqual(calls, ["first", "second"]);
});

test("server page navigation waits for enough tokens without disabling rate limits", async () => {
  const { budget, waits, response } = fixture();
  await budget.run(async () => response(10, 40));
  await budget.waitForBudget();
  assert.deepEqual(waits, [21_000]);
  await budget.run(async () => response(20, 20));
  await budget.waitForBudget();
  assert.deepEqual(waits, [21_000]);
});

test("server query scheduling retains HTTP failures and surfaces request errors", async () => {
  const { budget, waits, response } = fixture();
  const throttled = { ...response(0), status: () => 429 };
  assert.equal(await budget.run(async () => throttled), throttled);
  await assert.rejects(budget.run(async () => { throw new Error("query failed"); }), /query failed/);
  const success = response(29);
  assert.equal(await budget.run(async () => success), success);
  assert.deepEqual(waits, [3000]);
});

test("server query scheduling rejects missing or invalid rate-limit evidence", async () => {
  for (const headers of [
    {},
    { "ratelimit-limit": "30", "ratelimit-remaining": "-1", "ratelimit-reset": "2" },
    { "ratelimit-limit": "30", "ratelimit-remaining": "31", "ratelimit-reset": "2" },
  ]) {
    const { budget } = fixture();
    await assert.rejects(budget.run(async () => ({ headers: () => headers })), /invalid rate-limit headers/);
  }
});
