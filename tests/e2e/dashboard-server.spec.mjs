import { expect, test } from "@playwright/test";

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
