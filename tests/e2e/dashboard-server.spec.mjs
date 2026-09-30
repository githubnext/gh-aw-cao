import { expect, test } from "@playwright/test";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import {
  dashboardAssessmentPageHash,
  declaredDashboardViewIds,
  visibleBusyViewSelector,
} from "./dashboard-view-assessment.mjs";
import {
  dashboardPageChunkPath,
  mergeDashboardPage,
  normalizeDashboardPageChunk,
} from "../../dashboard/site/src/dashboard-chunks.js";

const accessToken = process.env.DASHBOARD_SERVER_ACCESS_TOKEN
  || "0123456789abcdef0123456789abcdef";

const populatedViews = [
  {
    page: "runs",
    heading: "Runs",
    view: "runs-runs-source",
    field: "run",
    value: "424242",
  },
  {
    page: "workflows",
    heading: "Workflows",
    view: "workflows-inventory",
    field: "workflow-name",
    value: "Dashboard",
  },
  {
    page: "repositories",
    heading: "Repositories",
    view: "repositories-activity",
    field: "repository",
    value: "gh-aw-cao",
  },
];

test("deployed shards populate server-backed dashboard views", async ({ context, page }) => {
  await page.goto(`/?access_token=${accessToken}`);
  await expect(page).toHaveURL("http://127.0.0.1:8443/");
  await expect(page.locator('meta[name="dashboard-data-backend"]')).toHaveAttribute("content", "redis-http");
  const headers = { Authorization: `Bearer ${accessToken}` };

  const health = await context.request.get("/api/v1/health", { headers });
  expect(health.ok()).toBe(true);
  const healthPayload = await health.json();
  expect(healthPayload.redis).toEqual({ connected: true });
  expect(healthPayload.revision).toBeGreaterThan(0);
  expect(healthPayload.counts).toMatchObject({
    repositories: 1,
    workflows: 1,
    runs: 1,
    domains: 1,
    tools: 1,
    audits: 1,
    issues: 1,
  });

  test("every dashboard page resolves its queries against the Go Redis server", async ({ context, page }) => {
    test.setTimeout(1_600_000);
    const outputDirectory = resolve("test-results/dashboard-server");
    await mkdir(outputDirectory, { recursive: true });
    const results = [];
    let blocker;

    try {
      await page.goto(`/?access_token=${accessToken}`);
      const dashboardResponse = await context.request.get("/dashboard.json");
      expect(dashboardResponse.ok()).toBe(true);
      const dashboard = await dashboardResponse.json();
      const pages = [];
      for (const definition of dashboard.dashboard.pages) {
        const chunkPath = dashboardPageChunkPath(definition);
        if (!chunkPath) {
          pages.push(definition);
          continue;
        }
        const chunkResponse = await context.request.get(`/${chunkPath.replace(/^\/+/, "")}`);
        expect(chunkResponse.ok(), `Load page definition for ${definition.id}`).toBe(true);
        pages.push(mergeDashboardPage(definition, normalizeDashboardPageChunk(await chunkResponse.json()).page));
      }
      expect(pages.length).toBeGreaterThan(0);

      for (const definition of pages) {
        const result = { pageId: definition.id, status: "failed", queries: 0, errors: [] };
        results.push(result);
        const assessedPage = await context.newPage();
        const queryResponses = [];
        const browserErrors = [];
        assessedPage.on("pageerror", (error) => browserErrors.push(error.message));
        assessedPage.on("response", (response) => {
          if (new URL(response.url()).pathname !== "/api/v1/query") return;
          queryResponses.push(response);
        });
        try {
          await assessedPage.goto(`/${dashboardAssessmentPageHash(definition, dashboard)}`, {
            waitUntil: "domcontentloaded",
          });
          const activePage = assessedPage.locator(`[data-page-id="${definition.id}"]`);
          await expect(activePage).toBeVisible({ timeout: 30_000 });
          await expect(activePage).not.toHaveAttribute("aria-busy", "true", { timeout: 30_000 });
          await activePage.locator("details.view-disclosure").evaluateAll((items) => {
            for (const item of items) item.open = true;
          });
          const views = activePage.locator("[data-view-id]");
          const declared = declaredDashboardViewIds(definition, dashboard.dashboard.views);
          const rendered = await views.evaluateAll((items) =>
            items.map((item) => item.getAttribute("data-view-id")));
          for (const viewId of declared) {
            if (!rendered.includes(viewId)) result.errors.push(`Missing view: ${viewId}`);
          }
          for (let index = 0; index < await views.count(); index += 1) {
            const view = views.nth(index);
            if (await view.isVisible()) await view.scrollIntoViewIfNeeded();
          }
          await expect(activePage.locator(visibleBusyViewSelector)).toHaveCount(0, { timeout: 30_000 });
          const failures = await activePage.locator('[aria-label^="Unable to load "]')
            .evaluateAll((items) => items.map((item) => item.getAttribute("aria-label")));
          result.errors.push(...failures, ...browserErrors);
          for (const response of queryResponses) {
            result.queries += 1;
            if (!response.ok()) {
              result.errors.push(`Query HTTP ${response.status()}`);
              continue;
            }
            const payload = await response.json();
            if (!payload.sources || typeof payload.sources !== "object") {
              result.errors.push("Query returned no sources object");
            }
          }
          if (declared.length > 0 && result.queries === 0) result.errors.push("No Go server queries observed");
          result.status = result.errors.length === 0 ? "passed" : "failed";
        } catch (error) {
          result.errors.push(error instanceof Error ? error.message : String(error));
        } finally {
          await assessedPage.close();
        }
      }
    } catch (error) {
      blocker = error instanceof Error ? error.message : String(error);
    } finally {
      const passed = results.filter((result) => result.status === "passed").length;
      const summary = [
        "### Go Redis dashboard page checks",
        "",
        `**${blocker || results.some((result) => result.status !== "passed") ? "FAILED" : "PASSED"}** — ${passed}/${results.length} pages passed.`,
        ...(blocker ? ["", `Setup failed: ${blocker.replaceAll("\n", " ")}`] : []),
        "",
        "| Page | Status | Queries | Errors |",
        "|---|---|---:|---|",
        ...results.map((result) =>
          `| ${result.pageId} | ${result.status.toUpperCase()} | ${result.queries} | ${result.errors.map((error) => error.replaceAll("|", "\\|").replaceAll("\n", " ")).join("; ") || "—"} |`),
        "",
      ].join("\n");
      await writeFile(resolve(outputDirectory, "summary.md"), summary);
      await writeFile(resolve(outputDirectory, "summary.json"), `${JSON.stringify({ blocker, results }, null, 2)}\n`);
    }
    expect(blocker, "Dashboard setup must succeed").toBeUndefined();
    expect(results.length, "Every declared page must be assessed").toBeGreaterThan(0);
    expect(results.filter((result) => result.status !== "passed"), "Every Go Redis dashboard page must load").toEqual([]);
  });
  expect(JSON.stringify(healthPayload)).not.toMatch(/redis:\/\/|password|credential/i);

  const query = await context.request.post("/api/v1/query", {
    headers,
    data: { sourceNames: ["runs"], queries: [] },
  });
  expect(query.ok()).toBe(true);
  const queryPayload = await query.json();
  expect(queryPayload.sources.runs.rows).toEqual([
    expect.objectContaining({
      run: "424242",
      repository: "gh-aw-cao",
      workflow: ".github/workflows/dashboard.md",
    }),
  ]);

  for (const expected of populatedViews) {
    await page.goto(`/#page-${expected.page}`);
    await expect(page.getByRole("heading", { name: expected.heading, exact: true, level: 1 })).toBeVisible();
    const tableMode = page.getByRole("button", { name: "Table", exact: true });
    await expect(tableMode).toBeVisible();
    await tableMode.click();
    await expect(tableMode).toHaveAttribute("aria-pressed", "true");
    const view = page.locator(`[data-view-id="${expected.view}"]`);
    await view.scrollIntoViewIfNeeded();
    await expect(view).toBeVisible();
    await expect(view.locator(`td[data-field="${expected.field}"]`, { hasText: expected.value })).toBeVisible();
    await expect(view).not.toContainText("Unavailable");
  }
});
