import assert from "node:assert/strict";
import { test } from "node:test";
import { waitForServer } from "../e2e/dashboard-query-parity-readiness.mjs";

test("waits beyond the old 100 attempts while the server starts", async () => {
  let attempts = 0;
  await waitForServer("http://127.0.0.1:18443", {
    child: { exitCode: null },
    fetchHealth: async () => {
      attempts += 1;
      return { ok: attempts > 100, status: 503 };
    },
    timeoutMs: 5_000,
    retryIntervalMs: 0,
  });
  assert.equal(attempts, 101);
});

test("fails promptly if the server exits before becoming healthy", async () => {
  const child = { exitCode: null };
  await assert.rejects(
    waitForServer("http://127.0.0.1:18443", {
      child,
      fetchHealth: async () => {
        child.exitCode = 1;
        throw new Error("connection refused");
      },
      retryIntervalMs: 0,
    }),
    /Postgres dashboard server exited with code 1/,
  );
});
