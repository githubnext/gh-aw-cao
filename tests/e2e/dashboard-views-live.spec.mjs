import { expect, test } from "@playwright/test";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { startDashboardServer } from "../../dashboard/local-server.mjs";
import {
  dashboardAssessmentPageBudgetMs,
  dashboardAssessmentStartupBudgetMs,
  dashboardAssessmentTimeout,
  dashboardPageRendersBeforeSources,
  declaredDashboardViewIds,
  ignoredDashboardPageIds,
  isIgnoredDashboardPageId,
  isSpuriousAbortAfterSuccessResponse,
  renderAssessedDashboardQueryUsageGraph,
  visibleBusyViewSelector,
  visibleLoadingViewSelector,
  visibleViewSelector,
} from "./dashboard-view-assessment.mjs";
import { downloadDeployedDashboardData } from "./dashboard-view-data.mjs";
import {
  dashboardPageChunkPath,
  mergeDashboardPage,
  normalizeDashboardPageChunk,
} from "../../dashboard/site/src/dashboard-chunks.js";

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

async function loadPageDefinition(previewUrl, pageDefinition) {
  const chunkPath = dashboardPageChunkPath(pageDefinition);
  if (!chunkPath) return { page: pageDefinition, queries: [] };
  const response = await fetch(new URL(chunkPath, `${previewUrl.replace(/\/$/, "")}/`));
  if (!response.ok) {
    throw new Error(
      `Unable to load dashboard page definition "${pageDefinition.id}": HTTP ${response.status}.`,
    );
  }
  const chunk = normalizeDashboardPageChunk(await response.json());
  return {
    page: mergeDashboardPage(pageDefinition, chunk.page),
    queries: chunk.queries,
  };
}

test("each selected dashboard view renders with live data", async ({ page }, testInfo) => {
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
    const pageChunks = await Promise.all(
      selectedPages(dashboard).map((page) => loadPageDefinition(preview.url, page)),
    );
    const pages = pageChunks.map((chunk) => chunk.page);
    summary.selectedPageIds = pages.map((page) => page.id);
    if (pages.length === 0) {
      if (summary.selectionMode === "affected") return;
      throw new Error("No selected page IDs exist in the composed dashboard.");
    }
    summary.queryUsageGraph = renderAssessedDashboardQueryUsageGraph(dashboard, pageChunks);
    test.setTimeout(dashboardAssessmentTimeout(pages.length));

    await page.setViewportSize({ width: 1440, height: 900 });
    await page.addInitScript(() => {
      window.__dashboardRefreshStatus = null;
      window.__dashboardPageRenderCounts = {};
      document.addEventListener("dashboard-data", (event) => {
        if (event.detail?.kind === "refresh") {
          window.__dashboardRefreshStatus = event.detail.status;
          if (event.detail.status === "completed") {
            window.__dashboardPageRenderCounts = {};
          }
        }
      });
      document.addEventListener("dashboard-render", (event) => {
        if (event.detail?.kind !== "page" || event.detail?.status !== "completed") return;
        const pageId = event.detail.pageId;
        window.__dashboardPageRenderCounts[pageId] =
          (window.__dashboardPageRenderCounts[pageId] || 0) + 1;
      });
    });
    let activeResult;
    let crashed = false;
    const succeededRequests = new WeakSet();
    const requestOwners = new WeakMap();
    page.on("crash", () => {
      crashed = true;
    });
    page.on("console", (message) => {
      if (message.type() === "error") activeResult?.errors.push(message.text());
    });
    page.on("pageerror", (error) => activeResult?.errors.push(error.message));
    page.on("request", (request) => {
      if (activeResult) requestOwners.set(request, activeResult);
    });
    page.on("requestfailed", (request) => {
      const errorText = request.failure()?.errorText || "failed";
      if (isSpuriousAbortAfterSuccessResponse(errorText, succeededRequests.has(request))) return;
      requestOwners.get(request)?.failedRequests.push(
        `${request.method()} ${request.url()}: ${errorText}`,
      );
    });
    page.on("response", (response) => {
      if (response.status() >= 400) {
        requestOwners.get(response.request())?.failedRequests.push(
          `${response.status()} ${response.url()}`,
        );
        return;
      }
      succeededRequests.add(response.request());
    });

    for (const [pageIndex, pageDefinition] of pages.entries()) {
      const result = {
        pageId: pageDefinition.id,
        title: pageDefinition.title || pageDefinition.page || pageDefinition.id,
        status: "incomplete",
        domNodes: null,
        declaredViews: declaredDashboardViewIds(pageDefinition, dashboard.dashboard.views),
        renderedViews: [],
        missingViews: [],
        missingData: [],
        loadingViews: [],
        crashed: false,
        errors: [],
        failedRequests: [],
      };
      activeResult = result;

      try {
        if (pageIndex === 0) {
          await page.goto(`${preview.url}/#page-${encodeURIComponent(pageDefinition.id)}`, {
            waitUntil: "domcontentloaded",
          });
        } else {
          await page.evaluate((pageId) => {
            window.__dashboardPageRenderCounts[pageId] = 0;
            window.location.hash = `#page-${encodeURIComponent(pageId)}`;
          }, pageDefinition.id);
        }
        const dashboardRoot = page.locator(".dashboard-root");
        const activePage = page.locator(`[data-page-id="${pageDefinition.id}"]`);
        await expect(dashboardRoot).toBeVisible();
        if (pageIndex === 0) {
          // The shell can be visible and idle before canonical ingestion starts.
          await page.waitForFunction(() =>
            ["completed", "failed"].includes(window.__dashboardRefreshStatus),
          null, { timeout: dashboardAssessmentStartupBudgetMs });
          expect(
            await page.evaluate(() => window.__dashboardRefreshStatus),
            "The dashboard must complete its canonical data refresh",
          ).toBe("completed");
        }
        const expectedPageRenders = dashboardPageRendersBeforeSources(
          pageDefinition,
          dashboard.dashboard.views,
        ) ? 2 : 1;
        await page.waitForFunction(({ pageId, expected }) =>
          (window.__dashboardPageRenderCounts[pageId] || 0) >= expected,
        { pageId: pageDefinition.id, expected: expectedPageRenders }, {
          timeout: dashboardAssessmentPageBudgetMs,
        });
        await expect(dashboardRoot).not.toHaveAttribute("aria-busy", "true", { timeout: 120_000 });
        await expect(activePage).toBeVisible();
        await expect(activePage).not.toHaveAttribute("data-page-pending", "", { timeout: 120_000 });
        await expect(activePage).not.toHaveAttribute("aria-busy", "true", { timeout: 120_000 });
        await activePage.locator("details.view-disclosure").evaluateAll((disclosures) => {
          for (const disclosure of disclosures) disclosure.open = true;
        });

        // Rendered-view accounting covers every declared view, including views the
        // page's view-mode selection currently hides; only visible views are scrolled
        // into view and awaited.
        const renderedViewElements = activePage.locator("[data-view-id]");
        const visibleViews = activePage.locator(visibleViewSelector);
        for (let index = 0; index < await visibleViews.count(); index += 1) {
          await visibleViews.nth(index).scrollIntoViewIfNeeded().catch(() => {});
        }
        const busyViews = activePage.locator(visibleBusyViewSelector);
        const hydrationDeadline = Date.now() + 30_000;
        while (await busyViews.count() > 0 && Date.now() < hydrationDeadline) {
          await busyViews.first().scrollIntoViewIfNeeded().catch(() => {});
          await page.waitForTimeout(100);
        }
        await expect(busyViews).toHaveCount(0);

        result.renderedViews = (await renderedViewElements.evaluateAll((elements) =>
          elements.map((element) => element.getAttribute("data-view-id")).filter(Boolean)
        ));
        result.missingViews = result.declaredViews.filter(
          (viewId) => !result.renderedViews.includes(viewId),
        );
        result.missingData = await activePage.locator('[aria-label^="Unable to load "]')
          .evaluateAll((elements) => elements.map((element) => element.getAttribute("aria-label")));
        result.loadingViews = await activePage.locator(visibleLoadingViewSelector)
          .evaluateAll((elements) => elements.map((element) =>
            element.closest("[data-view-id]")?.getAttribute("data-view-id") || "page"
          ));
        result.domNodes = await page.locator("*").count();
        result.crashed = crashed;
        result.status = (
          !crashed
          && result.errors.length === 0
          && result.failedRequests.length === 0
          && result.missingViews.length === 0
          && result.missingData.length === 0
          && result.loadingViews.length === 0
          && result.domNodes <= maximumDomNodes
        ) ? "passed" : "failed";
      } catch (error) {
        result.errors.push(messageText(error));
        result.crashed = crashed;
        result.status = "failed";
      } finally {
        summary.results.push(result);
      }
      if (summary.results.filter((entry) => entry.status !== "passed").length >= maximumFailedViews) {
        break;
      }
    }
    for (const result of summary.results) {
      if (result.status === "passed"
          && (result.errors.length > 0 || result.failedRequests.length > 0)) {
        result.status = "failed";
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
