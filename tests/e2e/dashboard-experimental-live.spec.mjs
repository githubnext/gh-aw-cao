import { expect, test } from "@playwright/test";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { startDashboardServer } from "../../dashboard/local-server.mjs";

const dashboardPath = resolve("dashboard/site/dashboard.json");
const outputDirectory = resolve(
  process.env.EXPERIMENTAL_VIEWS_OUTPUT_DIR || "test-results/experimental-views",
);
const maximumDomNodes = 6_000;

function experimentalPages(dashboard) {
  const pageIds = new Set(
    (dashboard.dashboard.navigation || [])
      .filter((section) => section.experimental === true)
      .flatMap((section) => section.pages || []),
  );
  return dashboard.dashboard.pages.filter((page) => pageIds.has(page.id));
}

function messageText(value) {
  return value instanceof Error ? value.message : String(value);
}

function declaredSourceNames(value, names = new Set()) {
  if (Array.isArray(value)) {
    for (const item of value) declaredSourceNames(item, names);
  } else if (value && typeof value === "object") {
    if (typeof value.source === "string") names.add(value.source);
    for (const item of Object.values(value)) declaredSourceNames(item, names);
  }
  return names;
}

test("each experimental dashboard view renders with live data", async ({ browser }, testInfo) => {
  await rm(outputDirectory, { force: true, recursive: true });
  await mkdir(outputDirectory, { recursive: true });

  const sourceUrl = process.env.DASHBOARD_DATA_URL;
  const dashboard = JSON.parse(await readFile(dashboardPath, "utf8"));
  const pages = experimentalPages(dashboard);
  const summary = {
    generatedAt: new Date().toISOString(),
    sourceUrl: sourceUrl || null,
    maximumDomNodes,
    experimentalPageIds: pages.map((page) => page.id),
    results: [],
  };
  let preview;
  let liveSources;

  try {
    if (!sourceUrl) throw new Error("DASHBOARD_DATA_URL is required.");
    if (pages.length === 0) throw new Error("dashboard.json does not declare experimental pages.");

    preview = await startDashboardServer({
      downloadData: async (destination) => {
        const response = await fetch(sourceUrl);
        if (!response.ok) {
          throw new Error(`Unable to download deployed dashboard data: HTTP ${response.status}.`);
        }
        await mkdir(destination, { recursive: true });
        const sourceText = await response.text();
        liveSources = JSON.parse(sourceText);
        await writeFile(join(destination, "sources.json"), sourceText);
      },
      host: "127.0.0.1",
      port: 0,
    });

    for (const pageDefinition of pages) {
      const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
      const errors = [];
      const failedRequests = [];
      let crashed = false;

      page.on("crash", () => {
        crashed = true;
      });
      page.on("console", (message) => {
        if (message.type() === "error") errors.push(message.text());
      });
      page.on("pageerror", (error) => errors.push(error.message));
      page.on("requestfailed", (request) => {
        failedRequests.push(`${request.method()} ${request.url()}: ${request.failure()?.errorText || "failed"}`);
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
        await expect(activePage.locator('[aria-busy="true"]')).toHaveCount(0, { timeout: 30_000 });

        result.renderedViews = (await views.evaluateAll((elements) =>
          elements.map((element) => element.getAttribute("data-view-id")).filter(Boolean)
        ));
        result.missingViews = result.declaredViews.filter(
          (viewId) => !result.renderedViews.includes(viewId),
        );
        const sourceProblems = [...declaredSourceNames(pageDefinition)]
          .filter((sourceName) =>
            !Object.hasOwn(liveSources, sourceName)
            || liveSources[sourceName]?.metadata?.availability === "unavailable"
          )
          .map((sourceName) => `${sourceName}: missing or unavailable`);
        result.missingData = [
          ...sourceProblems,
          ...await activePage.locator('[aria-label^="Unable to load "]')
            .evaluateAll((elements) => elements.map((element) => element.getAttribute("aria-label"))),
        ];
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
        await page.close();
      }
    }
  } catch (error) {
    summary.blocker = messageText(error);
  } finally {
    await preview?.close();
    await writeFile(
      join(outputDirectory, "summary.json"),
      `${JSON.stringify(summary, null, 2)}\n`,
    );
  }

  await testInfo.attach("experimental-views-summary", {
    path: join(outputDirectory, "summary.json"),
    contentType: "application/json",
  });
  expect(summary.blocker, "The experimental view assessment was blocked").toBeUndefined();
  expect(
    summary.results.filter((result) => result.status !== "passed"),
    "Every experimental dashboard view must render within its DOM budget without crashes or missing data",
  ).toEqual([]);
});
