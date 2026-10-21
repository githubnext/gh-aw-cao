import { expect, test } from "@playwright/test";

for (const { name, viewport } of [
  { name: "desktop", viewport: { width: 1440, height: 900 } },
  { name: "mobile", viewport: { width: 390, height: 844 } },
]) {
  for (const colorScheme of ["light", "dark"]) {
    test(`landing storyboard resets after repeated scrolls on ${name} in ${colorScheme} mode`, async ({ page }, testInfo) => {
      await page.setViewportSize(viewport);
      await page.emulateMedia({ colorScheme, reducedMotion: "no-preference" });
      await page.goto("./");
      await page.evaluate(() => document.fonts.ready);
      const story = page.locator(".dispatch-story");
      await expect(story).toHaveCSS("opacity", "0");

      for (let cycle = 0; cycle < 3; cycle++) {
        await story.scrollIntoViewIfNeeded();
        await expect(story).toHaveCSS("opacity", "1");
        await expect(page.getByRole("heading", { name: "Shared work. Clear ownership.", exact: true })).toBeInViewport();
        if (cycle === 2 && colorScheme === "dark") {
          const path = testInfo.outputPath(`hero-${name}-revealed.png`);
          await page.screenshot({ path });
          await testInfo.attach(`${name} storyboard revealed`, { path, contentType: "image/png" });
        }

        await page.evaluate(() => window.scrollTo({ top: 0, behavior: "instant" }));
        await expect.poll(() => page.evaluate(() => window.scrollY)).toBe(0);
        await expect(story).toHaveCSS("opacity", "0");
        await expect(story).toHaveClass(/reveal-pending/);
        await expect(story).not.toHaveClass(/is-visible/);
      }

      if (colorScheme === "dark") {
        const path = testInfo.outputPath(`hero-${name}-reset.png`);
        await page.screenshot({ path });
        await testInfo.attach(`${name} hero reset at top`, { path, contentType: "image/png" });
      }
    });
  }
}

test("landing stories remain visible with reduced motion", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto("./");
  for (const story of await page.locator("[data-reveal]").all()) {
    await expect(story).toHaveCSS("opacity", "1");
    await expect(story).not.toHaveClass(/reveal-pending/);
  }
});

test("landing stories remain visible without JavaScript", async ({ browser, baseURL }) => {
  const context = await browser.newContext({ baseURL, javaScriptEnabled: false });
  try {
    const page = await context.newPage();
    await page.goto("./");
    for (const story of await page.locator("[data-reveal]").all()) {
      await expect(story).toHaveCSS("opacity", "1");
    }
  } finally {
    await context.close();
  }
});
