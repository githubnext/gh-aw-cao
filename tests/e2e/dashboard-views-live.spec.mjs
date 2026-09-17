import { expect, test } from "@playwright/test";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { startDashboardServer } from "../../dashboard/local-server.mjs";
import {
  ignoredDashboardPageIds,
  isExpectedPageCloseAbort,
  isIgnoredDashboardPageId,
} from "./dashboard-view-assessment.mjs";
import { downloadDeployedDashboardData } from "./dashboard-view-data.mjs";

const outputDirectory = resolve(
  process.env.DASHBOARD_VIEWS_OUTPUT_DIR || "test-results/dashboard-views",
);
const maximumDomNodes = 6_000;
const maximumFailedViews = 5;

function selectedPages(dashboard) {
  const selected = process.env.DASHBOARD_PAGE_IDS;
  const pages = dashboard.dashboard.pages.filter((page) => !isIgnoredDashboardPageId(page.id));
  if (selected === undefined) return pages;
  const pageIds = new Set(selected.split(",").filter(Boolean));
  return pages.filter((page) => pageIds.has(page.id));
}

function messageText(value) {
  return value instanceof Error ? value.message : String(value);
}

test("each selected dashboard view renders with live data", async ({ browser }, testInfo) => {
  await rm(outputDirectory, { force: true, recursive: true });
  await mkdir(outputDirectory, { recursive: true });

  const sourceUrl = process.env.DASHBOARD_DATA_URL;
  const summary = {
    generatedAt: new Date().toISOString(),
    sourceUrl: sourceUrl || null,
    maximumDomNodes,
    selectionMode: process.env.DASHBOARD_PAGE_IDS === undefined ? "all" : "affected",
    ignoredPageIds: [...ignoredDashboardPageIds],
    selectedPageIds: [],
    results: [],
  };
  let preview;

  try {
    if (process.env.DASHBOARD_PAGE_IDS === "") return;
    if (!sourceUrl) throw new Error("DASHBOARD_DATA_URL is required.");

    preview = await startDashboardServer({
      downloadData: (destination) =>
        downloadDeployedDashboardData(destination, sourceUrl),
      host: "127.0.0.1",
      port: 0,
    });
    const dashboardResponse = await fetch(`${preview.url}/dashboard.json`);
    if (!dashboardResponse.ok) {
      throw new Error(`Unable to load composed dashboard.json: HTTP ${dashboardResponse.status}.`);
    }
    const dashboard = await dashboardResponse.json();
    const pages = selectedPages(dashboard);
    summary.selectedPageIds = pages.map((page) => page.id);
    if (pages.length === 0) {
      if (summary.selectionMode === "affected") return;
      throw new Error("No selected page IDs exist in the composed dashboard.");
    }

    for (const pageDefinition of pages) {
      const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
      const errors = [];
      const failedRequests = [];
      let crashed = false;
      let closing = false;

      page.on("crash", () => {
        crashed = true;
      });
      page.on("console", (message) => {
        if (message.type() === "error") errors.push(message.text());
      });
      page.on("pageerror", (error) => errors.push(error.message));
      page.on("requestfailed", (request) => {
        const errorText = request.failure()?.errorText || "failed";
        if (isExpectedPageCloseAbort(errorText, closing)) return;
        failedRequests.push(`${request.method()} ${request.url()}: ${errorText}`);
      });
      page.on("response", (response) => {
        if (response.status() >= 400) {
          failedRequests.push(`${response.status()} ${response.url()}`);
        }
      });

      const result = {
        pageId: pageDefinition.id,
        title: pageDefinition.title || pageDefinition.page || pageDefinition.id,
        status: "incomplete",
        domNodes: null,
        declaredViews: (pageDefinition.views || pageDefinition.definition?.views || [])
          .map((view, index) => view.id || `view-${index + 1}`),
        renderedViews: [],
        missingViews: [],
        missingData: [],
        crashed: false,
        errors,
        failedRequests,
      };

      try {
        await page.goto(`${preview.url}/#page-${encodeURIComponent(pageDefinition.id)}`, {
          waitUntil: "domcontentloaded",
        });
        const dashboardRoot = page.locator(".dashboard-root");
        const activePage = page.locator(`[data-page-id="${pageDefinition.id}"]`);
        await expect(dashboardRoot).toBeVisible();
        await expect(dashboardRoot).not.toHaveAttribute("aria-busy", "true", { timeout: 120_000 });
        await expect(activePage).toBeVisible();
        await expect(activePage).not.toHaveAttribute("aria-busy", "true", { timeout: 120_000 });
        await activePage.locator("details.view-disclosure").evaluateAll((disclosures) => {
          for (const disclosure of disclosures) disclosure.open = true;
        });

        const views = activePage.locator("[data-view-id]");
        for (let index = 0; index < await views.count(); index += 1) {
          await views.nth(index).scrollIntoViewIfNeeded().catch(() => {});
        }
        const busyViews = activePage.locator('[aria-busy="true"]');
        const hydrationDeadline = Date.now() + 30_000;
        while (await busyViews.count() > 0 && Date.now() < hydrationDeadline) {
          await busyViews.first().scrollIntoViewIfNeeded().catch(() => {});
          await page.waitForTimeout(100);
        }
        await expect(busyViews).toHaveCount(0);

        result.renderedViews = (await views.evaluateAll((elements) =>
          elements.map((element) => element.getAttribute("data-view-id")).filter(Boolean)
        ));
        result.missingViews = result.declaredViews.filter(
          (viewId) => !result.renderedViews.includes(viewId),
        );
        result.missingData = await activePage.locator('[aria-label^="Unable to load "]')
          .evaluateAll((elements) => elements.map((element) => element.getAttribute("aria-label")));
        result.domNodes = await page.locator("*").count();
        result.crashed = crashed;
        result.status = (
          !crashed
          && errors.length === 0
          && failedRequests.length === 0
          && result.missingViews.length === 0
          && result.missingData.length === 0
          && result.domNodes <= maximumDomNodes
        ) ? "passed" : "failed";
      } catch (error) {
        errors.push(messageText(error));
        result.crashed = crashed;
        result.status = "failed";
      } finally {
        summary.results.push(result);
        closing = true;
        await page.close();
      }
      if (summary.results.filter((entry) => entry.status !== "passed").length >= maximumFailedViews) {
        break;
      }
    }
  } catch (error) {
    summary.blocker = messageText(error);
  } finally {
    await writeFile(
      join(outputDirectory, "summary.json"),
      `${JSON.stringify(summary, null, 2)}\n`,
    );
    await preview?.close();
  }

  await testInfo.attach("dashboard-views-summary", {
    path: join(outputDirectory, "summary.json"),
    contentType: "application/json",
  });
  expect(summary.blocker, "The dashboard view assessment was blocked").toBeUndefined();
  expect(
    summary.results.filter((result) => result.status !== "passed"),
    "Every selected dashboard view must render within its DOM budget without crashes or missing data",
  ).toEqual([]);
});
