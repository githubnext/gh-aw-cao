import { expect, test } from "@playwright/test";
import { copyFile, glob, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { startDashboardServer } from "../../dashboard/local-server.mjs";

const maximumDomNodes = 1_400;
let preview;

test.beforeAll(async () => {
  const dataRoot = process.env.DASHBOARD_DATA_ROOT;
  if (!dataRoot) throw new Error("DASHBOARD_DATA_ROOT is required.");
  const sources = await Array.fromAsync(glob("**/sources.json", { cwd: dataRoot }));
  if (sources.length !== 1) throw new Error("The dashboard cache must contain exactly one sources.json file.");
  preview = await startDashboardServer({
    downloadData: async (destination) => {
      await mkdir(destination, { recursive: true });
      await copyFile(join(dataRoot, sources[0]), join(destination, "sources.json"));
    },
    host: "127.0.0.1",
    port: 0,
  });
});

test.afterAll(async () => {
  await preview?.close();
});

test("latest dashboard data loads within the mobile DOM budget", async ({ page }, testInfo) => {
  const pageErrors = [];
  let crashed = false;
  let sourcesResponse;

  page.on("crash", () => {
    crashed = true;
  });
  page.on("pageerror", (error) => {
    pageErrors.push(error.message);
  });
  page.on("response", (response) => {
    if (new URL(response.url()).pathname.endsWith("/sources.json")) {
      sourcesResponse = response;
    }
  });

  await page.goto(`${preview.url}/`, { waitUntil: "domcontentloaded" });
  const dashboard = page.locator(".dashboard-root");
  await expect(dashboard).toBeVisible();
  await expect(dashboard).not.toHaveAttribute("aria-busy", "true", { timeout: 120_000 });

  expect(sourcesResponse, "The dashboard must request its latest downloaded sources").toBeDefined();
  expect(sourcesResponse?.ok(), `sources.json returned ${sourcesResponse?.status()}`).toBe(true);
  expect(crashed, "The mobile browser page crashed while rendering the dashboard").toBe(false);
  expect(pageErrors, "The dashboard emitted browser errors").toEqual([]);

  const menu = page.locator(".mobile-nav-menu");
  await expect(menu).toBeVisible();
  await menu.locator("summary").click();
  await expect(menu).toHaveAttribute("open", "");

  const domNodes = await page.evaluate(() => document.getElementsByTagName("*").length);
  await testInfo.attach("mobile-dashboard-metrics", {
    body: JSON.stringify({ device: process.env.MOBILE_DEVICE, domNodes }, null, 2),
    contentType: "application/json",
  });
  expect(domNodes, `Dashboard rendered ${domNodes} DOM nodes`).toBeLessThanOrEqual(maximumDomNodes);
});
