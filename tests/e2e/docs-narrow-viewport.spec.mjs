import { expect, test } from "@playwright/test";

const paths = [
  "./",
  "getting-started/",
  "configuration/",
  "operations/",
  "architecture/",
  "dashboard/",
  "catalog/",
  "catalog/dependabot/",
  "operational-observability-visualization-specification/",
];

for (const colorScheme of ["light", "dark"]) {
  test.describe(`${colorScheme} scheme`, () => {
    test.use({ colorScheme, viewport: { width: 320, height: 900 } });

    for (const path of paths) {
      test(`${path} does not overflow horizontally`, async ({ page }) => {
        expect((await page.goto(path))?.ok()).toBe(true);

        expect(await page.locator("html").evaluate((element) => element.scrollWidth)).toBeLessThanOrEqual(320);
      });
    }
  });
}

test("sidebar groups Dashboard documentation by reader task", async ({ page }) => {
  expect((await page.goto("dashboard/"))?.ok()).toBe(true);

  const dashboardGroup = page.locator('nav[aria-label="Main"] summary').filter({ hasText: /^Dashboard$/ }).locator("..");
  await expect(dashboardGroup.locator(":scope > summary")).toHaveText("Dashboard");
  await expect(dashboardGroup.getByRole("link")).toHaveText([
    "What it shows",
    "Data model",
    "Language",
    "About this view",
    "Status header",
    "Factory rhythm",
    "Registered repositories",
    "Successful runs",
    "Dispatches",
    "Value gains"
  ]);
  const viewsGroup = dashboardGroup.locator(":scope > ul > li > details");
  await expect(viewsGroup.locator(":scope > summary")).toHaveText("Views");
  const overviewGroup = viewsGroup.locator(":scope > ul > li > details");
  await expect(overviewGroup.locator(":scope > summary")).toHaveText("Overview");
  await expect(overviewGroup.getByRole("link")).toHaveText([
    "About this view",
    "Status header",
    "Factory rhythm",
    "Registered repositories",
    "Successful runs",
    "Dispatches",
    "Value gains"
  ]);
});

for (const { name, viewport, scene } of [
  { name: "desktop", viewport: { width: 1280, height: 900 }, scene: "desktop" },
  { name: "mobile", viewport: { width: 390, height: 844 }, scene: "mobile" },
]) {
  for (const colorScheme of ["light", "dark"]) {
    test(`landing ${name} illustration renders its ${colorScheme} SVG layers`, async ({ page }) => {
      await page.emulateMedia({ colorScheme });
      await page.setViewportSize(viewport);
      expect((await page.goto("./"))?.ok()).toBe(true);

      const sceneElement = page.locator(`.${scene}-scene`);
      const fallback = sceneElement.locator(`.theme-${colorScheme}`);
      const motion = sceneElement.locator(".dispatch-motion");
      await expect(sceneElement).toBeVisible();
      await expect(fallback).toBeVisible();
      await expect(motion).toBeVisible();

      for (const image of [fallback, motion]) {
        const dimensions = await image.evaluate((element) => ({
          naturalWidth: element.naturalWidth,
          naturalHeight: element.naturalHeight,
          width: element.getBoundingClientRect().width,
          height: element.getBoundingClientRect().height,
        }));
        expect(dimensions.naturalWidth).toBeGreaterThan(0);
        expect(dimensions.naturalHeight).toBeGreaterThan(0);
        expect(dimensions.width).toBeGreaterThan(0);
        expect(dimensions.height).toBeGreaterThan(0);
      }
    });
  }
}

for (const colorScheme of ["light", "dark"]) {
  test(`dashboard view diagram loads its ${colorScheme} SVG`, async ({ page }) => {
    await page.emulateMedia({ colorScheme });
    expect((await page.goto("dashboard/"))?.ok()).toBe(true);

    const diagram = page.locator('img[alt^="Language queries the shared data model"]');
    await expect(diagram).toHaveJSProperty("complete", true);
    expect(await diagram.evaluate((image) => image.naturalWidth)).toBeGreaterThan(0);
    expect(await diagram.evaluate((image) => image.naturalHeight)).toBeGreaterThan(0);
    expect(await diagram.evaluate((image) => image.currentSrc)).toContain(`-${colorScheme}.svg`);
  });

  test(`dashboard data flow diagram loads its ${colorScheme} SVG`, async ({ page }) => {
    await page.emulateMedia({ colorScheme });
    expect((await page.goto("dashboard-data-model/"))?.ok()).toBe(true);

    const diagram = page.locator('img[alt^="Agentic workflow logs are collected by Activity"]');
    await expect(diagram).toHaveJSProperty("complete", true);
    expect(await diagram.evaluate((image) => image.naturalWidth)).toBeGreaterThan(0);
    expect(await diagram.evaluate((image) => image.naturalHeight)).toBeGreaterThan(0);
    expect(await diagram.evaluate((image) => image.currentSrc)).toContain(`-${colorScheme}.svg`);
  });
}

for (const colorScheme of ["light", "dark"]) {
  test(`Overview component diagram loads its ${colorScheme} SVG`, async ({ page }) => {
    await page.emulateMedia({ colorScheme });
    expect((await page.goto("dashboard-overview-components/"))?.ok()).toBe(true);

    const diagrams = page.locator('img[alt^="Color-coded map of the Overview"]');
    await expect(diagrams).toHaveCount(1);
    for (const diagram of await diagrams.all()) {
      await expect(diagram).toHaveJSProperty("complete", true);
      expect(await diagram.evaluate((image) => image.naturalWidth)).toBeGreaterThan(0);
      expect(await diagram.evaluate((image) => image.naturalHeight)).toBeGreaterThan(0);
      expect(await diagram.evaluate((image) => image.currentSrc)).toContain(`-${colorScheme}.svg`);
    }
  });
}

test("long code remains in a keyboard-focusable local scroll region", async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 900 });
  await page.goto("configuration/");

  const code = page.locator(".sl-markdown-content pre").first();
  const dimensions = await code.evaluate((element) => ({
    clientWidth: element.clientWidth,
    scrollWidth: element.scrollWidth,
  }));
  expect(dimensions.scrollWidth).toBeGreaterThan(dimensions.clientWidth);
  await expect(code).toHaveAttribute("tabindex", "0");
});
