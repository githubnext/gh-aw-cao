import assert from "node:assert/strict";
import test from "node:test";

const publishedSummaryUrl = process.env.DASHBOARD_PUBLISHED_SUMMARY_URL
  ?? "https://githubnext.github.io/gh-aw-cao/cao/agent-summary.json";
const hostedHealthUrl = process.env.DASHBOARD_HOSTED_HEALTH_URL
  ?? "https://cao.githubnext.com/api/v1/health";
const maximumLagMinutes = Number(process.env.HOSTED_BACKFILL_MAX_LAG_MINUTES ?? 30);
const maximumLagMs = maximumLagMinutes * 60_000;
const transientStatuses = new Set([408, 409, 425, 429, 500, 502, 503, 504]);

async function fetchJson(url) {
  const maximumAttempts = 4;
  for (let attempt = 1; attempt <= maximumAttempts; attempt += 1) {
    try {
      const response = await fetch(url, {
        headers: { "cache-control": "no-cache" },
        signal: AbortSignal.timeout(30_000),
      });
      if (response.ok) return response.json();
      if (!transientStatuses.has(response.status) || attempt === maximumAttempts) {
        assert.fail(`failed to download ${url}: ${response.status}`);
      }
      await response.body?.cancel();
    } catch (error) {
      if (attempt === maximumAttempts) throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, attempt * 5_000));
  }
  throw new Error(`failed to download ${url}`);
}

function timestamp(value, field) {
  const parsed = Date.parse(value);
  assert.ok(Number.isFinite(parsed), `${field} must be an ISO-8601 timestamp, got ${value}`);
  return parsed;
}

test("hosted dashboard backfill reaches the current published snapshot", async () => {
  assert.ok(
    Number.isFinite(maximumLagMinutes) && maximumLagMinutes >= 0,
    "HOSTED_BACKFILL_MAX_LAG_MINUTES must be a non-negative number",
  );
  const [published, hosted] = await Promise.all([
    fetchJson(publishedSummaryUrl),
    fetchJson(hostedHealthUrl),
  ]);
  assert.equal(hosted.status, "healthy");
  assert.equal(hosted.data?.available, true);

  const publishedGeneratedAt = timestamp(
    published.generatedAt,
    "published agent-summary generatedAt",
  );
  const hostedEvaluatedAt = timestamp(
    hosted.data?.evaluatedAt,
    "hosted health data.evaluatedAt",
  );
  const lagMs = publishedGeneratedAt - hostedEvaluatedAt;
  assert.ok(
    lagMs <= maximumLagMs,
    `hosted dashboard data is ${Math.ceil(lagMs / 60_000)} minutes behind `
      + `the published snapshot (maximum ${maximumLagMinutes} minutes): `
      + `hosted=${new Date(hostedEvaluatedAt).toISOString()} `
      + `published=${new Date(publishedGeneratedAt).toISOString()}`,
  );
});
