import { expect, test } from "@playwright/test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const siteRoot = fileURLToPath(new URL("../..", import.meta.url));
const origin = "http://cached-refresh.dashboard.test";
const metadata = { "as-of": "2026-09-15T10:00:00Z" };

const dashboard = {
  "language-version": "0.1.0",
  dashboard: {
    id: "cached-refresh",
    title: "Cached refresh",
    pages: [{
      id: "runs",
      kind: "custom",
      title: "Runs",
      views: [{
        id: "runs-table",
        title: "Recent runs",
        data: { source: "runs" },
        mark: "table",
        encoding: {
          columns: [
            { field: "run-title", type: "nominal", title: "Run title" },
            { field: "run", type: "nominal", title: "Run" },
          ],
        },
      }],
    }, {
      id: "repositories",
      kind: "custom",
      title: "Repositories",
      views: [{
        id: "repositories-table",
        title: "Repositories",
        data: { source: "repositories" },
        mark: "table",
        encoding: {
          columns: [
            { field: "repository", type: "nominal", title: "Repository" },
          ],
        },
      }],
    }],
  },
};

const inventory = {
  repositories: {
    rows: [{ organization: "githubnext", repository: "gh-aw-cao" }],
    metadata,
  },
  workflows: {
    rows: [{
      organization: "githubnext",
      repository: "gh-aw-cao",
      workflow: ".github/workflows/dashboard.md",
      "workflow-name": "Dashboard",
    }],
    metadata,
  },
};

const cachedSources = {
  ...inventory,
  runs: {
    rows: [{
      organization: "githubnext",
      repository: "gh-aw-cao",
      workflow: ".github/workflows/dashboard.md",
      run: "100",
      "run-title": "Cached dashboard run",
      "run-status": "completed",
      "run-conclusion": "success",
      "started-at": "2026-09-15T10:00:00Z",
    }],
    metadata,
  },
};

test("cached view is populated before background ingestion updates it", async ({ context, page }) => {
  /** @type {(value?: void) => void} */
  let releaseFreshData = () => {};
  const freshDataAllowed = new Promise((resolve) => {
    releaseFreshData = resolve;
  });
  let freshDataRequested = false;

  await context.route(`${origin}/**`, async (route) => {
    const pathname = new URL(route.request().url()).pathname;
    if (pathname === "/" || pathname === "/seed") {
      await route.fulfill({
        contentType: "text/html",
        body: pathname === "/seed"
          ? "<main>Seed dashboard cache</main>"
          : '<div id="root"></div><script type="module" src="./src/main.js"></script>',
      });
      return;
    }
    if (pathname === "/dashboard.json") {
      await route.fulfill({ contentType: "application/json", body: JSON.stringify(dashboard) });
      return;
    }
    if (pathname === "/inventory-sources.json") {
      await route.fulfill({ contentType: "application/json", body: JSON.stringify(inventory) });
      return;
    }
    if (pathname === "/payload-hashes.json") {
      await route.fulfill({
        contentType: "application/json",
        body: JSON.stringify({ "gh-aw-logs-shards/logs-1.jsonl": "a".repeat(64) }),
      });
      return;
    }
    if (pathname === "/gh-aw-logs-shards/logs-1.jsonl") {
      freshDataRequested = true;
      await freshDataAllowed;
      await route.fulfill({
        contentType: "application/x-ndjson",
        body: `${JSON.stringify({
          schema_version: 2,
          kind: "run",
          run: {
            run_id: 101,
            run_attempt: 1,
            organization: "githubnext",
            repository: "gh-aw-cao",
            workflow_name: "Dashboard",
            workflow_path: ".github/workflows/dashboard.md",
            display_title: "Fresh dashboard run",
            status: "completed",
            conclusion: "success",
            created_at: "2026-09-15T11:00:00Z",
            updated_at: "2026-09-15T11:05:00Z",
          },
        })}\n`,
      });
      return;
    }

    const filePath = join(siteRoot, pathname);
    if (existsSync(filePath)) {
      await route.fulfill({
        contentType: pathname.endsWith(".json") ? "application/json" : "application/javascript",
        body: readFileSync(filePath),
      });
      return;
    }
    await route.fulfill({ status: 404, body: "Not found" });
  });

  await page.goto(`${origin}/seed`);
  await page.evaluate(async ({ sources, moduleUrl }) => {
    const { loadDatabaseQuerySources } = await import(moduleUrl);
    await loadDatabaseQuerySources(indexedDB, sources, {
      ingest: true,
      storage: navigator.storage,
    });
  }, {
    sources: cachedSources,
    moduleUrl: `${origin}/src/data/queries/database.js`,
  });

  await page.goto(`${origin}/`);
  await expect(page.getByRole("cell", { name: "Cached dashboard run" })).toBeVisible();
  await expect(page.locator(".dashboard-view-skeleton")).toHaveCount(0);
  await expect(page.getByRole("cell", { name: "gh-aw-cao" })).toHaveCount(0);

  await page.getByRole("link", { name: "Repositories" }).click();
  await expect(page.getByRole("cell", { name: "gh-aw-cao" })).toBeVisible();

  await page.getByRole("link", { name: "Runs" }).click();
  await expect.poll(() => freshDataRequested).toBe(true);
  await expect(page.getByRole("cell", { name: "Fresh dashboard run" })).toHaveCount(0);
  await expect(page.getByRole("cell", { name: "Cached dashboard run" })).toBeVisible();
  await expect(page.locator(".dashboard-view-skeleton")).toHaveCount(0);
  await expect(page.locator(".loading-progress")).toHaveCount(1);

  releaseFreshData();

  await expect(page.getByRole("cell", { name: "Fresh dashboard run" })).toBeVisible();
});
