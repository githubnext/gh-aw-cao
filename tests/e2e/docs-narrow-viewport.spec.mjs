import { expect, test } from "@playwright/test";

const paths = [
  "./",
  "getting-started/",
  "setup/",
  "cao-cli/",
  "author-your-first-operation/",
  "authentication/",
  "configuration/",
  "operations/",
  "architecture/",
  "dashboard/",
  "catalog/",
  "catalog/dependabot/",
  "operational-observability-visualization-specification/",
];

test("Get started navigation follows the user journey without duplicate authentication pages", async ({ page }) => {
  expect((await page.goto("getting-started/"))?.ok()).toBe(true);

  const overviewGroup = page.locator('nav[aria-label="Main"] summary').filter({ hasText: /^Overview$/ }).locator("..");
  await expect(overviewGroup.getByRole("link")).toHaveText([
    "What is Central Agentic Ops?",
    "How the control plane works",
  ]);

  const getStartedGroup = page.locator('nav[aria-label="Main"] summary').filter({ hasText: /^Get started$/ }).locator("..");
  await expect(getStartedGroup.getByRole("link")).toHaveText([
    "Quickstart",
    "Setup wizard",
    "CAO commands",
    "Browse campaigns",
    "Build a campaign",
    "Authentication",
  ]);
});

test("legacy authentication profile route redirects to the consolidated guide", async ({ page }) => {
  await page.goto("control-plane-authentication/");
  await expect(page).toHaveURL(/\/authentication\/$/);
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Authentication");
});

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
  await expect(dashboardGroup.locator(":scope > ul > li > a")).toHaveText([
    "At a glance",
    "Data ingestion",
    "Data model",
    "Language",
    "Language specification",
    "View catalog",
  ]);
  const viewsGroup = dashboardGroup.locator(":scope > ul > li > details");
  await expect(viewsGroup.locator(":scope > summary")).toHaveText("Views");
  await expect(viewsGroup.getByRole("link")).toHaveText(["Overview", "Overview components"]);
});

for (const { name, viewport } of [
  { name: "desktop", viewport: { width: 1280, height: 900 } },
  { name: "mobile", viewport: { width: 390, height: 844 } },
]) {
  for (const colorScheme of ["light", "dark"]) {
    test(`landing ${name} product story renders in ${colorScheme} mode`, async ({ page }) => {
      await page.addInitScript(() => localStorage.removeItem("starlight-theme"));
      await page.emulateMedia({ colorScheme });
      await page.setViewportSize(viewport);
      expect((await page.goto("./"))?.ok()).toBe(true);

      const pageCanvas = page.locator(".content-panel").first();
      const phone = page.locator(".phone-preview");
      await expect(page.locator("html")).toHaveAttribute("data-theme", colorScheme);
      await expect(phone).toBeVisible();
      await expect(page.locator(".terminal")).toBeAttached();
      await expect(page.locator(".product-image, .phone-image")).toHaveCount(3);
      await expect(page.locator(".product-shot-mobile")).toHaveCount(2);
      await page.locator(".product-shot").last().scrollIntoViewIfNeeded();
      await expect.poll(() => page.locator(".product-image, .phone-image").evaluateAll(
        (images) => images.every((image) => image.complete && image.naturalWidth > 0),
      )).toBe(true);
      const productSources = await page.locator(".product-image, .phone-image").evaluateAll(
        (images) => images.map((image) => image.currentSrc),
      );
      expect(productSources.every((source) => colorScheme === "light"
        ? source.includes("-light.png")
        : !source.includes("-light.png"))).toBe(true);
      expect(productSources.slice(1).every((source) => source.includes("-mobile"))).toBe(true);
      expect(await page.locator(".product-shot-mobile").evaluateAll((frames) => frames.every((frame) => {
        const image = frame.querySelector("img");
        return image !== null
          && image.naturalHeight > image.naturalWidth
          && getComputedStyle(frame).overflow === "hidden"
          && frame.clientHeight < image.getBoundingClientRect().height;
      }))).toBe(true);
      expect(await pageCanvas.evaluate((element) => getComputedStyle(element).backgroundImage))
        .toContain("linear-gradient");
      expect(await page.locator("html").evaluate((element) => element.scrollWidth))
        .toBeLessThanOrEqual(viewport.width);
    });
  }
}

test("landing product media follows a manual theme change", async ({ page }) => {
  await page.addInitScript(() => localStorage.removeItem("starlight-theme"));
  await page.emulateMedia({ colorScheme: "dark" });
  expect((await page.goto("./"))?.ok()).toBe(true);

  await expect.poll(() => page.locator(".product-image, .phone-image").evaluateAll(
    (images) => images.every((image) => !image.currentSrc.includes("-light.png")),
  )).toBe(true);

  await page.getByRole("button", { name: "Switch to light theme" }).click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
  await expect.poll(() => page.locator(".product-image, .phone-image").evaluateAll(
    (images) => images.every((image) => image.currentSrc.includes("-light.png")),
  )).toBe(true);
});

const dashboardDiagramPages = [
  { name: "view system", path: "dashboard/" },
  { name: "data flow", path: "dashboard-data-ingestion/" },
  { name: "Overview components", path: "dashboard-overview-components/" },
];

for (const { name, path } of dashboardDiagramPages) {
  for (const colorScheme of ["light", "dark"]) {
    test(`${name} diagram loads its ${colorScheme} SVG in auto mode`, async ({ page }) => {
      await page.addInitScript(() => localStorage.removeItem("starlight-theme"));
      await page.emulateMedia({ colorScheme });
      expect((await page.goto(path))?.ok()).toBe(true);

      const diagram = page.locator(`.docs-theme-diagram-${colorScheme}`);
      const otherDiagram = page.locator(`.docs-theme-diagram-${colorScheme === "light" ? "dark" : "light"}`);
      await expect(page.locator("html")).toHaveAttribute("data-theme", colorScheme);
      await expect(diagram).toBeVisible();
      await expect(otherDiagram).toBeHidden();
      await expect(diagram).toHaveJSProperty("complete", true);
      expect(await diagram.evaluate((image) => image.naturalWidth)).toBeGreaterThan(0);
      expect(await diagram.evaluate((image) => image.naturalHeight)).toBeGreaterThan(0);
      expect(await diagram.evaluate((image) => image.currentSrc)).toContain(`-${colorScheme}.svg`);
    });
  }

  for (const theme of ["light", "dark"]) {
    test(`${name} diagram honors manual ${theme} mode`, async ({ page }) => {
      const oppositeTheme = theme === "light" ? "dark" : "light";
      await page.addInitScript(() => localStorage.removeItem("starlight-theme"));
      await page.emulateMedia({ colorScheme: oppositeTheme });
      expect((await page.goto(path))?.ok()).toBe(true);
      await page.getByRole("button", { name: `Switch to ${theme} theme` }).click();

      const diagram = page.locator(`.docs-theme-diagram-${theme}`);
      await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
      await expect(diagram).toBeVisible();
      await expect(page.locator(`.docs-theme-diagram-${oppositeTheme}`)).toBeHidden();
      expect(await diagram.evaluate((image) => image.currentSrc)).toContain(`-${theme}.svg`);
    });
  }
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
