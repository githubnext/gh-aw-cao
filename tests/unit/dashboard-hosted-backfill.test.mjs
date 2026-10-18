import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";

const backfillTest = fileURLToPath(new URL("../integration/dashboard-hosted-backfill.test.mjs", import.meta.url));

function checkBackfill({ statuses = [200], expectedAttempts = statuses.length, evaluatedAt = "2026-10-18T12:00:00Z", available = true }) {
  const preload = `
    import assert from "node:assert/strict";
    const statuses = ${JSON.stringify(statuses)};
    let attempts = 0;
    globalThis.setTimeout = (callback) => { queueMicrotask(callback); return 0; };
    globalThis.fetch = async (url) => {
      if (url === "https://published.example/agent-summary.json") {
        return Response.json({ generatedAt: "2026-10-18T12:30:00Z" });
      }
      assert.equal(url, "https://hosted.example/api/health");
      const status = statuses[attempts++];
      if (status === "network-error") throw new TypeError("fetch failed");
      return Response.json({
        status: "healthy",
        data: { available: ${JSON.stringify(available)}, evaluatedAt: ${JSON.stringify(evaluatedAt)} },
      }, { status });
    };
    process.on("exit", () => assert.equal(attempts, ${expectedAttempts}));
  `;
  const result = spawnSync(process.execPath, [
    "--import", `data:text/javascript,${encodeURIComponent(preload)}`,
    backfillTest,
  ], {
    encoding: "utf8",
    timeout: 10_000,
    env: {
      ...process.env,
      DASHBOARD_PUBLISHED_SUMMARY_URL: "https://published.example/agent-summary.json",
      DASHBOARD_HOSTED_HEALTH_URL: "https://hosted.example/api/health",
      HOSTED_BACKFILL_MAX_LAG_MINUTES: "30",
    },
  });
  assert.ifError(result.error);
  return { status: result.status, output: result.stdout + result.stderr };
}

test("hosted backfill accepts data at the freshness limit", () => {
  const result = checkBackfill({});
  assert.equal(result.status, 0, result.output);
});

test("hosted backfill retries transient HTTP and network failures", () => {
  const result = checkBackfill({ statuses: [503, "network-error", 200] });
  assert.equal(result.status, 0, result.output);
});

test("hosted backfill fails immediately on a missing health endpoint", () => {
  const result = checkBackfill({ statuses: [404], expectedAttempts: 1 });
  assert.equal(result.status, 1, result.output);
  assert.match(result.output, /failed to download https:\/\/hosted\.example\/api\/health: 404/);
});

test("hosted backfill bounds retries for transient failures", () => {
  const result = checkBackfill({ statuses: [503, 503, 503, 503] });
  assert.equal(result.status, 1, result.output);
  assert.match(result.output, /failed to download https:\/\/hosted\.example\/api\/health: 503/);
});

test("hosted backfill still rejects stale or unavailable data", () => {
  const stale = checkBackfill({ evaluatedAt: "2026-10-18T11:59:00Z" });
  assert.equal(stale.status, 1, stale.output);
  assert.match(stale.output, /31 minutes behind/);
  const unavailable = checkBackfill({ available: false });
  assert.equal(unavailable.status, 1, unavailable.output);
});
