import { expect, test } from "@playwright/test";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

const dashboardUrl = "https://githubnext.github.io/gh-aw-cao/cao/";
const outputDirectory = resolve("test-results/dashboard-deployed");
const populatedPages = ["events", "repositories", "workflows"];

test("deployed dashboard refreshes and renders populated views", async ({ page }, testInfo) => {
  await mkdir(outputDirectory, { recursive: true });
  const browserErrors = [];
  const failedRequests = [];
  page.on("console", (message) => {
    if (message.type() === "error") browserErrors.push(message.text());
  });
  page.on("pageerror", (error) => browserErrors.push(error.message));
  page.on("requestfailed", (request) => {
    failedRequests.push(`${request.method()} ${request.url()}: ${request.failure()?.errorText || "failed"}`);
  });
  page.on("response", (response) => {
    if (response.status() >= 400) failedRequests.push(`${response.status()} ${response.url()}`);
  });
  await page.addInitScript(() => {
    window.__dashboardTestEvents = [];
    for (const type of ["dashboard-data", "dashboard-render"]) {
      document.addEventListener(type, (event) => {
        window.__dashboardTestEvents.push({ type, detail: event.detail });
      });
    }
  });

  let diagnostics;
  try {
    await page.goto(dashboardUrl, { waitUntil: "domcontentloaded" });
    await expect(page.locator(".dashboard-root")).toBeVisible({ timeout: 120_000 });
    await page.waitForFunction(() =>
      window.__dashboardTestEvents?.some(({ type, detail }) =>
        type === "dashboard-data" && detail?.status === "completed"
      ), null, { timeout: 120_000 });
    await page.reload({ waitUntil: "domcontentloaded" });
    await expect(page.locator(".dashboard-root")).toBeVisible({ timeout: 120_000 });
    await page.waitForFunction(() =>
      window.__dashboardTestEvents?.some(({ type, detail }) =>
        type === "dashboard-data"
        && detail?.kind === "refresh"
        && detail?.status === "completed"
      ), null, { timeout: 120_000 });
    await expect(page.locator(".dashboard-root")).not.toHaveAttribute("aria-busy", "true");
    await expect(page.locator(".dashboard-stale, .source-refresh-error")).toHaveCount(0);

    for (const pageId of populatedPages) {
      await page.evaluate((nextPageId) => {
        window.location.hash = `#page-${nextPageId}`;
      }, pageId);
      const activePage = page.locator(`[data-page-id="${pageId}"]`);
      await expect(activePage).toBeVisible({ timeout: 120_000 });
      await expect(activePage).not.toHaveAttribute("aria-busy", "true", { timeout: 120_000 });
      await page.waitForFunction((nextPageId) =>
        window.__dashboardTestEvents?.some(({ type, detail }) =>
          type === "dashboard-render"
          && detail?.kind === "page"
          && detail?.pageId === nextPageId
          && detail?.status === "completed"
        ), pageId, { timeout: 120_000 });
      await activePage.locator("details.view-disclosure").evaluateAll((details) => {
        for (const detail of details) {
          detail.open = true;
          detail.dispatchEvent(new Event("toggle"));
        }
      });
      const views = activePage.locator("[data-view-id]");
      for (let index = 0; index < await views.count(); index += 1) {
        await views.nth(index).scrollIntoViewIfNeeded().catch(() => {});
      }
      await expect(activePage.locator("[data-lazy-view]")).toHaveCount(0, { timeout: 60_000 });
      await expect(activePage.locator('[aria-busy="true"]')).toHaveCount(0);
      await expect(activePage.locator('[aria-label^="Unable to load "]')).toHaveCount(0);
      const populatedRows = activePage.locator("tbody > tr").filter({ has: page.locator("td") });
      await expect(populatedRows.first(), `${pageId} should render populated rows`).toBeVisible();
    }

    diagnostics = await page.evaluate(() => window.collectFullDiagnostics());
    expect(diagnostics.passed, JSON.stringify(diagnostics.checks, null, 2)).toBe(true);
    expect(diagnostics.database.counts.repositories).toBeGreaterThan(0);
    expect(diagnostics.database.counts.workflows).toBeGreaterThan(0);
    expect(diagnostics.database.counts.events).toBeGreaterThan(0);
    expect(browserErrors).toEqual([]);
    expect(failedRequests).toEqual([]);
  } finally {
    const summary = {
      generatedAt: new Date().toISOString(),
      dashboardUrl,
      diagnostics: diagnostics ?? null,
      browserErrors,
      failedRequests,
      events: await page.evaluate(() => window.__dashboardTestEvents ?? []).catch(() => []),
    };
    const summaryPath = resolve(outputDirectory, "summary.json");
    await writeFile(summaryPath, `${JSON.stringify(summary, null, 2)}\n`);
    await testInfo.attach("dashboard-deployed-summary", {
      path: summaryPath,
      contentType: "application/json",
    });
  }
});
