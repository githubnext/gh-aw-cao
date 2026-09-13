import { expect, test } from "@playwright/test";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

const dashboardUrl = "https://githubnext.github.io/gh-aw-cao/cao/";
const outputDirectory = resolve("test-results/dashboard-deployed/performance");
const maximumDomNodes = 6_000;
const maximumInitialRenderMs = 120_000;

test("deployed landing page renders within the iPhone performance budget", async ({ page }, testInfo) => {
  await mkdir(outputDirectory, { recursive: true });
  const browserErrors = [];
  const failedRequests = [];
  let crashed = false;

  page.on("crash", () => {
    crashed = true;
  });
  page.on("pageerror", (error) => browserErrors.push(error.message));
  page.on("requestfailed", (request) => {
    failedRequests.push(`${request.method()} ${request.url()}: ${request.failure()?.errorText || "failed"}`);
  });
  await page.addInitScript(() => {
    window.__dashboardPerformanceEvents = [];
    document.addEventListener("dashboard-data", (event) => {
      window.__dashboardPerformanceEvents.push({
        type: event.type,
        detail: event.detail,
        timestamp: performance.now(),
      });
    });
  });

  const startedAt = Date.now();
  let metrics;
  try {
    await page.goto(dashboardUrl, { waitUntil: "domcontentloaded" });
    const dashboard = page.locator(".dashboard-root");
    await expect(dashboard).toBeVisible({ timeout: maximumInitialRenderMs });
    await expect(dashboard).not.toHaveAttribute("aria-busy", "true", {
      timeout: maximumInitialRenderMs,
    });
    await page.waitForFunction(() =>
      window.__dashboardPerformanceEvents?.some(({ detail }) =>
        detail?.status === "completed"
      ), null, { timeout: maximumInitialRenderMs });

    metrics = await page.evaluate(() => {
      const navigation = performance.getEntriesByType("navigation")[0];
      const resources = performance.getEntriesByType("resource");
      return {
        domNodes: document.getElementsByTagName("*").length,
        navigation: navigation ? {
          domContentLoadedMs: navigation.domContentLoadedEventEnd,
          loadMs: navigation.loadEventEnd,
          transferSize: navigation.transferSize,
          decodedBodySize: navigation.decodedBodySize,
        } : null,
        resources: {
          count: resources.length,
          transferSize: resources.reduce((total, resource) => total + resource.transferSize, 0),
          decodedBodySize: resources.reduce((total, resource) => total + resource.decodedBodySize, 0),
        },
      };
    });
    metrics.initialRenderMs = Date.now() - startedAt;

    expect(crashed, "The deployed landing page crashed under the iPhone profile").toBe(false);
    expect(browserErrors, "The deployed landing page emitted browser errors").toEqual([]);
    expect(failedRequests, "The deployed landing page had failed requests").toEqual([]);
    expect(metrics.domNodes, `Landing page rendered ${metrics.domNodes} DOM nodes`).toBeLessThanOrEqual(maximumDomNodes);
    expect(metrics.initialRenderMs, "Landing page initial render exceeded its budget").toBeLessThanOrEqual(maximumInitialRenderMs);
  } finally {
    const summary = {
      generatedAt: new Date().toISOString(),
      dashboardUrl,
      device: "iPhone 15",
      browser: "webkit",
      budgets: {
        maximumDomNodes,
        maximumInitialRenderMs,
      },
      crashed,
      browserErrors,
      failedRequests,
      metrics: metrics ?? null,
      events: await page.evaluate(() => window.__dashboardPerformanceEvents ?? []).catch(() => []),
    };
    const summaryPath = resolve(outputDirectory, "summary.json");
    await writeFile(summaryPath, `${JSON.stringify(summary, null, 2)}\n`);
    await testInfo.attach("dashboard-pages-performance", {
      path: summaryPath,
      contentType: "application/json",
    });
  }
});
