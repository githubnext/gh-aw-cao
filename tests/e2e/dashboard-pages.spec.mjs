import { expect, test } from "@playwright/test";
import { startDashboardPagesPreview } from "../helpers/dashboard-pages-preview.mjs";

let preview;

test.beforeAll(async () => {
  test.setTimeout(240_000);
  preview = await startDashboardPagesPreview({ fixture: true });
});

test.afterAll(async () => { await preview?.close(); });

for (const width of [1440, 390]) {
  test(`Go Pages deployment uses populated IndexedDB at ${width}px`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width, height: 900 });
    const hostedRequests = [];
    const errors = [];
    page.on("request", (request) => {
      if (/\/api\/v1\/(?:query|refresh|diagnostics|events)(?:[/?]|$)/.test(request.url())) {
        hostedRequests.push(request.url());
      }
    });
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto(`${preview.url}/?debug-eager-ingest=1#page-overview`, { waitUntil: "domcontentloaded" });
    await expect(page.locator(".first-load-overlay")).toHaveCount(0, { timeout: 90_000 });
    await expect(page.locator("#page-title")).toHaveText("Overview");
    await expect(page.locator('meta[name="dashboard-data-backend"]')).toHaveCount(0);
    await expect.poll(() => page.evaluate(async () => {
      const databases = await indexedDB.databases();
      const descriptor = databases.find(({ name }) => name?.startsWith("gh-aw-cao-dashboard-data"));
      if (!descriptor?.name) return 0;
      const database = await new Promise((resolve, reject) => {
        const request = indexedDB.open(descriptor.name);
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
      try {
        return await new Promise((resolve, reject) => {
          const transaction = database.transaction("runs", "readonly");
          const request = transaction.objectStore("runs").count();
          request.onsuccess = () => resolve(request.result);
          request.onerror = () => reject(request.error);
        });
      } finally { database.close(); }
    }), { timeout: 90_000 }).toBeGreaterThan(0);
    await expect(page.locator("body")).toContainText("example/pages-fixture");
    const screenshot = testInfo.outputPath(`pages-indexeddb-${width}.png`);
    await page.screenshot({ path: screenshot, fullPage: true });
    await testInfo.attach(`Pages IndexedDB ${width}px`, { path: screenshot, contentType: "image/png" });
    await page.reload({ waitUntil: "domcontentloaded" });
    await expect(page.locator("#page-title")).toHaveText("Overview");
    await expect(page.locator(".first-load-overlay")).toHaveCount(0);
    expect(hostedRequests).toEqual([]);
    expect(errors).toEqual([]);
    for (const name of ["payload-hashes.json", "inventory-sources.json", "gh-aw-logs.sqlite"]) {
      const response = await page.request.get(`${preview.url}/${name}`);
      expect(response.ok(), name).toBe(true);
    }
    expect((await page.request.post(`${preview.url}/api/v1/query`, { data: {} })).status()).toBe(405);
    expect((await page.request.get(`${preview.url}/api/v1/query`)).status()).toBe(404);
  });
}
