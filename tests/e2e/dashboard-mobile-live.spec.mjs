import { expect, test } from "@playwright/test";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { startDashboardServer } from "../../dashboard/local-server.mjs";
import { summarizeAccessibilityTree, summarizeDomTree } from "./dashboard-tree-analysis.mjs";

const maximumDomNodes = 6_000;
let preview;

function formatDomAnalysis(dom) {
  const formatDistribution = ({ mean, median, p95, maximum }) => `mean ${mean}, median ${median}, p95 ${p95}, max ${maximum}`;
  const formatFrequencies = (values) => values.slice(0, 5).map(({ name, count }) => `${name} (${count})`).join(", ") || "none";
  const formatStructures = dom.topStructures
    .slice(0, 5)
    .map(({ tag, id, descendantElements }) => `${tag}${id ? `#${id}` : ""} (${descendantElements} descendants)`)
    .join(", ") || "none";

  return [
    "Mobile dashboard DOM analysis:",
    `  Elements: ${dom.totalElements}`,
    `  Depth: ${formatDistribution(dom.depth)}`,
    `  Child elements: ${formatDistribution(dom.childElements)}`,
    `  Tags: ${formatFrequencies(dom.byTag)}`,
    `  Classes: ${formatFrequencies(dom.byClass)}`,
    `  Largest structures: ${formatStructures}`,
  ].join("\n");
}

test.beforeAll(async () => {
  const dataUrl = process.env.DASHBOARD_DATA_URL;
  if (!dataUrl) throw new Error("DASHBOARD_DATA_URL is required.");
  preview = await startDashboardServer({
    downloadData: async (destination) => {
      const response = await fetch(dataUrl);
      if (!response.ok) throw new Error(`Unable to download deployed dashboard data: HTTP ${response.status}.`);
      await mkdir(destination, { recursive: true });
      await writeFile(join(destination, "sources.json"), await response.text());
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

  const domTree = await page.evaluate(() => {
    const elements = [...document.getElementsByTagName("*")];
    const nodes = elements.map((element) => {
      let depth = 0;
      for (let parent = element.parentElement; parent; parent = parent.parentElement) depth += 1;
      return {
        tag: element.tagName.toLowerCase(),
        classes: [...element.classList],
        depth,
        childElementCount: element.childElementCount,
      };
    });
    const structures = [...document.querySelectorAll(
      "[data-page-id], [data-section-id], [data-view-id], header, nav, main, footer, table, svg, details",
    )].map((element) => ({
      tag: element.tagName.toLowerCase(),
      id: element.id || null,
      classes: [...element.classList],
      pageId: element.getAttribute("data-page-id"),
      sectionId: element.getAttribute("data-section-id"),
      viewId: element.getAttribute("data-view-id"),
      descendantElements: element.getElementsByTagName("*").length,
    }));
    return { nodes, structures };
  });
  const accessibilitySnapshot = await page.locator("body").ariaSnapshot();
  const analysis = {
    device: process.env.MOBILE_DEVICE,
    browser: process.env.MOBILE_BROWSER,
    dom: summarizeDomTree(domTree.nodes, domTree.structures),
    accessibility: summarizeAccessibilityTree(accessibilitySnapshot),
  };
  console.log(formatDomAnalysis(analysis.dom));
  await mkdir(testInfo.outputDir, { recursive: true });
  const analysisPath = testInfo.outputPath("mobile-dashboard-analysis.json");
  const accessibilityPath = testInfo.outputPath("mobile-dashboard-accessibility-tree.yml");
  await writeFile(analysisPath, `${JSON.stringify(analysis, null, 2)}\n`);
  await writeFile(accessibilityPath, accessibilitySnapshot);
  await testInfo.attach("mobile-dashboard-analysis", {
    path: analysisPath,
    contentType: "application/json",
  });
  await testInfo.attach("mobile-dashboard-accessibility-tree", {
    path: accessibilityPath,
    contentType: "application/yaml",
  });
  expect(analysis.dom.totalElements, `Dashboard rendered ${analysis.dom.totalElements} DOM elements`).toBeLessThanOrEqual(maximumDomNodes);
});
