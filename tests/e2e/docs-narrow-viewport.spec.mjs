import { expect, test } from "@playwright/test";

const paths = [
  "./",
  "setup-quickstarts/",
  "repo-assist-quickstart/",
  "setup-one-organization/",
  "setup-multiple-organizations/",
  "setup-fine-grained-pat/",
  "cao-cli/",
  "author-your-first-operation/",
  "authentication/",
  "configuration/",
  "operations/",
  "architecture/",
  "dashboard/",
  "catalog/",
  "catalog/dependabot/",
  "blog/",
  "operational-observability-visualization-specification/",
];

for (const width of [390, 799, 800, 1920]) {
  test(`documentation uses responsive content width at ${width}px without changing the hero page`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    expect((await page.goto("setup-quickstarts/"))?.ok()).toBe(true);
    await expect(page.locator("html")).not.toHaveAttribute("data-has-hero");
    expect(await page.locator("html").evaluate(
      (element) => getComputedStyle(element).getPropertyValue("--sl-content-width").trim(),
    )).toBe(width < 800 ? "100%" : "52rem");
    const content = page.locator(".sl-markdown-content");
    const bounds = await content.boundingBox();
    expect(bounds.width).toBeGreaterThan(0);
    expect(bounds.width).toBeLessThanOrEqual(Math.min(width, 832));
    if (width === 1920) expect(bounds.width).toBeCloseTo(832, 0);
    expect(await page.locator("html").evaluate((element) => element.scrollWidth))
      .toBeLessThanOrEqual(width);

    expect((await page.goto("./"))?.ok()).toBe(true);
    await expect(page.locator("html")).toHaveAttribute("data-has-hero", "");
    expect(await page.locator("html").evaluate(
      (element) => getComputedStyle(element).getPropertyValue("--sl-content-width").trim(),
    )).toBe("67.5rem");
  });
}

test("Get started navigation follows the user journey without duplicate authentication pages", async ({ page }) => {
  expect((await page.goto("getting-started/"))?.ok()).toBe(true);

  const overviewGroup = page.locator('nav[aria-label="Main"] summary').filter({ hasText: /^Overview$/ }).locator("..");
  await expect(overviewGroup.getByRole("link")).toHaveText([
    "What is Central Agentic Ops?",
    "How the control plane works",
  ]);

  const getStartedGroup = page.locator('nav[aria-label="Main"] summary').filter({ hasText: /^Get started$/ }).locator("..");
  await expect(getStartedGroup.getByRole("link")).toHaveText([
    "Set up and monitor",
    "Add a campaign (optional)",
    "CAO commands",
    "Authentication",
  ]);
});

test("getting started leads from monitoring to a separate optional campaign guide", async ({ page }, testInfo) => {
  expect((await page.goto("setup-quickstarts/"))?.ok()).toBe(true);
  await expect(page.locator("main h2")).toHaveText([
    "Prerequisites",
    "1. Install CAO",
    "2. Connect one repository",
    "3. Publish your configuration",
    "4. Open your dashboard",
    "Optional: add automation later",
  ]);
  const content = page.locator(".sl-markdown-content");
  await expect(content).toContainText("This setup is for monitoring only.");
  await expect(content).toContainText("An empty dashboard is expected.");
  await expect(content).not.toContainText("gh aw run");
  for (const [name, viewport] of [
    ["desktop", { width: 1280, height: 900 }],
    ["mobile", { width: 390, height: 844 }],
  ]) {
    await page.setViewportSize(viewport);
    const screenshot = testInfo.outputPath(`getting-started-${name}.png`);
    await page.screenshot({ path: screenshot, fullPage: true });
    await testInfo.attach(`Getting started (${name})`, { path: screenshot, contentType: "image/png" });
  }
  await content.getByRole("link", { name: "Repo Assist walkthrough", exact: true }).click();
  await expect(page).toHaveURL(/\/repo-assist-quickstart\/$/);
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Try a Repo Assist review");
});

test("legacy getting-started route redirects to interactive setup", async ({ page }) => {
  await page.goto("getting-started/");
  await expect(page).toHaveURL(/\/setup-quickstarts\/$/);
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Set Up CAO");
});

test("legacy authentication profile route redirects to the consolidated guide", async ({ page }) => {
  await page.goto("control-plane-authentication/");
  await expect(page).toHaveURL(/\/authentication\/$/);
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Authentication");
});

test("removed setup wizard route redirects to the command quickstart", async ({ page }) => {
  expect((await page.goto("setup"))?.ok()).toBe(true);
  await expect(page).toHaveURL(/\/setup-quickstarts\/$/);
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Set Up CAO");
});

for (const width of [320, 390, 768, 1024]) {
  test(`landing page exposes navigation and header controls at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 844 });
    expect((await page.goto("./"))?.ok()).toBe(true);

    await expect(page.getByRole("button", { name: /Switch to (light|dark) theme/ })).toBeVisible();
    await expect(page.getByRole("link", { name: "GitHub repository" })).toBeVisible();

    const menu = page.locator(".cao-mobile-nav");
    await expect(menu.locator("summary")).toBeVisible();
    await expect(menu.getByRole("navigation", { name: "Global links menu" })).toBeHidden();
    await menu.locator("summary").click();
    await expect(menu).toHaveAttribute("open", "");
    await expect(menu.getByRole("navigation", { name: "Global links menu" })).toBeVisible();
    await expect(menu.getByRole("link")).toHaveText(["Docs", "Blog"]);
    await expect(menu.getByRole("link", { name: "Docs", exact: true }))
      .toHaveAttribute("href", "/gh-aw-cao/architecture-at-a-glance/");
    expect(await page.locator("html").evaluate((element) => element.scrollWidth))
      .toBeLessThanOrEqual(width);
  });
}

test("desktop documentation navigation links to the introduction and an empty blog", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  expect((await page.goto("setup-quickstarts/"))?.ok()).toBe(true);

  const navigation = page.getByRole("navigation", { name: "Global links", exact: true });
  await expect(navigation.getByRole("link")).toHaveText(["Docs", "Blog"]);
  await navigation.getByRole("link", { name: "Docs", exact: true }).click();
  await expect(page).toHaveURL(/\/architecture-at-a-glance\/$/);
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("What Is Central Agentic Ops?");

  await navigation.getByRole("link", { name: "Blog", exact: true }).click();
  await expect(page).toHaveURL(/\/blog\/$/);
  await expect(page).toHaveTitle(/Central Agentic Ops Blog/);
  await expect(page.getByRole("navigation", { name: "Main", exact: true }).getByRole("link"))
    .toHaveText(["All posts", "RSS"]);
  await expect(page.locator('main a[href*="/blog/"]')).toHaveCount(0);
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
  { name: "wide desktop", viewport: { width: 1920, height: 1080 } },
  { name: "tablet", viewport: { width: 768, height: 1024 } },
  { name: "mobile", viewport: { width: 390, height: 844 } },
]) {
  for (const colorScheme of ["light", "dark"]) {
    test(`landing ${name} has compact branding and balanced spacing in ${colorScheme} mode`, async ({ page }, testInfo) => {
      await page.addInitScript(() => localStorage.removeItem("starlight-theme"));
      await page.emulateMedia({ colorScheme, reducedMotion: "reduce" });
      await page.setViewportSize(viewport);
      expect((await page.goto("./"))?.ok()).toBe(true);
      await page.evaluate(() => document.fonts.ready);

      const logo = page.locator(".site-title img:visible");
      const logoBounds = await logo.boundingBox();
      const title = page.locator(".site-title span");
      const titleBounds = await title.boundingBox();
      const titleFontSize = await title.evaluate((element) => parseFloat(getComputedStyle(element).fontSize));
      expect(logoBounds?.width).toBeLessThanOrEqual(titleFontSize);
      expect(logoBounds?.height).toBeLessThanOrEqual(titleBounds.height);
      expect(logoBounds?.width).toBeGreaterThanOrEqual(12);
      expect(await page.locator(".site-title span").evaluate(
        (element) => element.scrollWidth <= element.clientWidth,
      )).toBe(true);
      for (const action of await page.locator(".hero-action").all()) {
        expect((await action.boundingBox())?.height).toBeGreaterThanOrEqual(44);
      }

      const hero = await page.locator(".hierarchy-hero").boundingBox();
      const stories = await page.locator(".product-story").evaluateAll(
        (elements) => elements.map((element) => element.getBoundingClientRect().toJSON()),
      );
      expect(hero?.width).toBeLessThanOrEqual(1216);
      expect(Math.max(...stories.map((story) => story.width))
        - Math.min(...stories.map((story) => story.width))).toBeLessThanOrEqual(1);
      const eyebrow = await page.locator(".dispatch-story > .section-eyebrow").boundingBox();
      const heading = await page.locator("#dispatch-title").boundingBox();
      expect(heading.y - (eyebrow.y + eyebrow.height)).toBeLessThanOrEqual(16);
      if (name === "desktop" || name === "wide desktop") {
        const actions = await page.locator(".actions").boundingBox();
        expect(actions.y + actions.height).toBeLessThan(viewport.height);
      } else if (name === "mobile") {
        expect((await page.locator(".phone-preview").boundingBox())?.width).toBeLessThanOrEqual(240);
      }
      expect(await page.locator("html").evaluate((element) => element.scrollWidth))
        .toBeLessThanOrEqual(viewport.width);

      if (name === "desktop" || name === "mobile") {
        await page.locator(".product-shot").last().scrollIntoViewIfNeeded();
        await expect.poll(() => page.locator(".product-image, .phone-image").evaluateAll(
          (images) => images.every((image) => image.complete && image.naturalWidth > 0),
        )).toBe(true);
        await page.evaluate(() => window.scrollTo(0, 0));
        const screenshot = testInfo.outputPath(`homepage-${name}-${colorScheme}.png`);
        await page.screenshot({ path: screenshot, fullPage: true });
        await testInfo.attach(`Homepage (${name}, ${colorScheme})`, { path: screenshot, contentType: "image/png" });
      }
    });

    test(`landing ${name} emphasizes overview and control in ${colorScheme} mode`, async ({ page }) => {
      await page.addInitScript(() => localStorage.removeItem("starlight-theme"));
      await page.emulateMedia({ colorScheme });
      await page.setViewportSize(viewport);
      expect((await page.goto("./"))?.ok()).toBe(true);

      await expect(page.getByRole("heading", { level: 1 })).toHaveText(
        "Monitor and control GitHub Agentic Workflows at scale.",
      );
      const tagline = page.locator(".docs-hero-intro .tagline");
      await expect(tagline).toBeVisible();
      await expect(tagline).toHaveText("Keep track of all runs, costs, and outcomes of your GitHub Agentic Workflows across repositories. Set execution scope and rollout policy.");
      await expect(page.getByRole("heading", { name: "Control where workflows run.", exact: true })).toBeAttached();
      await expect(page.getByRole("heading", { name: "Monitor what runs.", exact: true })).toBeAttached();
      await expect(page.getByRole("heading", { name: "Roll out safely.", exact: true })).toBeAttached();
      await expect(page.getByRole("heading", { name: "Reuse what works.", exact: true })).toBeAttached();
      await expect(page.locator('.product-story a[href^="https://github.github.com/gh-aw/practices/"]'))
        .toHaveCount(0);
      for (const story of await page.locator(".product-story-copy, .dispatch-story").all()) {
        await expect(story).not.toContainText(/campaign/i);
      }
      expect(await page.locator("html").evaluate((element) => element.scrollWidth))
        .toBeLessThanOrEqual(viewport.width);
    });

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
        ? source.includes("-light.")
        : !source.includes("-light."))).toBe(true);
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
    (images) => images.every((image) => !image.currentSrc.includes("-light.")),
  )).toBe(true);

  await page.getByRole("button", { name: "Switch to light theme" }).click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
  await expect.poll(() => page.locator(".product-image, .phone-image").evaluateAll(
    (images) => images.every((image) => image.currentSrc.includes("-light.")),
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
