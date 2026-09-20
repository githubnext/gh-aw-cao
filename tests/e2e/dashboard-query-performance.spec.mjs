import { expect, test } from "@playwright/test";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import {
  deployedDashboardUrl,
  shouldIgnoreRequestFailure,
} from "./dashboard-deployed-refresh-helpers.mjs";
import {
  QUERY_CHUNK_SIZE,
  queryPerformanceMarkdown,
} from "./dashboard-query-performance-helpers.mjs";

const outputDirectory = resolve("test-results/dashboard-query-performance");
const dashboardUrl = process.env.DASHBOARD_QUERY_PERFORMANCE_URL || deployedDashboardUrl;
const dashboardDocument = JSON.parse(
  await readFile(resolve("dashboard/site/dashboard.json"), "utf8"),
).dashboard;
const dashboardContext = {
  pages: dashboardDocument.pages,
  queries: dashboardDocument.queries,
  views: dashboardDocument.views ?? [],
};

test("benchmarks every dashboard query against settled deployed data", async ({ page }, testInfo) => {
  await mkdir(outputDirectory, { recursive: true });
  const browserErrors = [];
  const failedRequests = [];
  const succeededRequests = new WeakSet();
  page.on("console", (message) => {
    if (message.type() === "error") browserErrors.push(message.text());
  });
  page.on("pageerror", (error) => browserErrors.push(error.message));
  page.on("requestfailed", (request) => {
    const errorText = request.failure()?.errorText || "failed";
    if (shouldIgnoreRequestFailure({
      method: request.method(),
      url: request.url(),
      errorText,
      hadSuccessResponse: succeededRequests.has(request),
    })) return;
    failedRequests.push(`${request.method()} ${request.url()}: ${errorText}`);
  });
  page.on("response", (response) => {
    if (response.status() >= 400) {
      failedRequests.push(`${response.status()} ${response.url()}`);
      return;
    }
    succeededRequests.add(response.request());
  });
  await page.addInitScript(() => {
    window.__dashboardPerformanceEvents = [];
    document.addEventListener("dashboard-data", (event) => {
      window.__dashboardPerformanceEvents.push({
        at: performance.now(),
        detail: event.detail,
      });
    });
  });

  await page.goto(dashboardUrl, { waitUntil: "domcontentloaded" });
  await expect(page.locator(".dashboard-root")).toBeVisible({ timeout: 120_000 });
  await page.waitForFunction(() => {
    const events = window.__dashboardPerformanceEvents ?? [];
    return events.some(({ detail }) => detail?.kind === "refresh" && detail?.status === "completed");
  }, null, { timeout: 300_000 });
  await expect(page.locator(".dashboard-root")).not.toHaveAttribute("aria-busy", "true", {
    timeout: 120_000,
  });
  await page.evaluate(() => new Promise((resolvePromise) => {
    requestAnimationFrame(() => requestAnimationFrame(resolvePromise));
  }));

  const populateMs = await page.evaluate(() => {
    const events = window.__dashboardPerformanceEvents ?? [];
    const started = events.find(({ detail }) =>
      detail?.kind === "refresh" && detail?.status === "started"
    );
    const completed = events.findLast(({ detail }) =>
      detail?.kind === "refresh" && detail?.status === "completed"
    );
    if (!started || !completed || completed.at < started.at) {
      throw new Error("Dashboard refresh timing events are incomplete.");
    }
    return completed.at - started.at;
  });

  const results = await page.evaluate(async ({ context, chunkSize }) => {
    const { loadCanonicalDashboardPage } = await import("./src/data-processor.js");
    const rounded = (value) => Math.round(value * 100) / 100;
    const timings = [];
    for (const definition of context.queries) {
      const name = definition?.name;
      if (typeof name !== "string" || !name) continue;
      const fillStartedAt = performance.now();
      let chunkStartedAt = performance.now();
      let sources = await loadCanonicalDashboardPage(
        [name],
        context,
        { [name]: { limit: chunkSize } },
      );
      const firstChunkMs = performance.now() - chunkStartedAt;
      let source = sources[name];
      if (!source) throw new Error(`Query "${name}" did not return its named source.`);
      let rows = source.rows.length;
      const continuationChunkMs = [];
      while (source.continuationToken) {
        chunkStartedAt = performance.now();
        sources = await loadCanonicalDashboardPage(
          [name],
          context,
          { [name]: { limit: chunkSize, continuationToken: source.continuationToken } },
        );
        continuationChunkMs.push(performance.now() - chunkStartedAt);
        source = sources[name];
        if (!source) throw new Error(`Query "${name}" continuation omitted its named source.`);
        rows += source.rows.length;
      }
      timings.push({
        query: name,
        rows,
        chunks: 1 + continuationChunkMs.length,
        firstChunkMs: rounded(firstChunkMs),
        meanContinuationChunkMs: continuationChunkMs.length > 0
          ? rounded(continuationChunkMs.reduce((total, duration) => total + duration, 0)
            / continuationChunkMs.length)
          : null,
        fillMs: rounded(performance.now() - fillStartedAt),
        continuationChunkMs: continuationChunkMs.map(rounded),
      });
    }
    return timings;
  }, { context: dashboardContext, chunkSize: QUERY_CHUNK_SIZE });

  const report = {
    generatedAt: new Date().toISOString(),
    dashboardUrl,
    methodology: "Fresh Chromium profile; wait for deployed refresh completion and two animation frames; query current dashboard.json through the deployed data worker; drain 25-row continuations sequentially.",
    chunkSize: QUERY_CHUNK_SIZE,
    populateMs: Math.round(populateMs * 100) / 100,
    queries: results,
  };
  const jsonPath = resolve(outputDirectory, "summary.json");
  const markdownPath = resolve(outputDirectory, "summary.md");
  await writeFile(jsonPath, `${JSON.stringify(report, null, 2)}\n`);
  const markdown = queryPerformanceMarkdown(report);
  await writeFile(markdownPath, markdown);
  console.log(markdown);
  await testInfo.attach("dashboard-query-performance-json", {
    path: jsonPath,
    contentType: "application/json",
  });
  await testInfo.attach("dashboard-query-performance-markdown", {
    path: markdownPath,
    contentType: "text/markdown",
  });

  expect(results.map(({ query }) => query)).toEqual(
    dashboardContext.queries.map(({ name }) => name),
  );
  expect(browserErrors).toEqual([]);
  expect(failedRequests).toEqual([]);
});
