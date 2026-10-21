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

for (const colorScheme of ["light", "dark"]) {
  for (const width of [320, 390, 1440]) {
    test(`hero snippet stories render at ${width}px in ${colorScheme}`, async ({ page }, testInfo) => {
      await page.setViewportSize({ width, height: 900 });
      await page.emulateMedia({ colorScheme, reducedMotion: "reduce" });
      await page.goto("./");
      const section = page.getByRole("region", { name: "Built on Agentic Workflows", exact: true });
      await section.scrollIntoViewIfNeeded();
      await expect(section).toBeVisible();
      await expect(page.locator(".product-story").last()).toHaveAttribute("aria-labelledby", "agentic-workflows-title");
      await expect(section.getByRole("link", { name: "Explore GitHub Agentic Workflows" }))
        .toHaveAttribute("href", "https://github.github.com/gh-aw/");
      const example = section.getByRole("group", { name: "Illustrative example: from a prompt to a campaign to bounded repository work" });
      await expect(example).toContainText("name: Dependabot");
      await expect(example).toContainText(".github/workflows/dependabot-update-planner.md");
      await expect(example).toContainText("Campaign prepared for review");
      await expect(example).toContainText("disabled and review-only");
      const gateway = page.getByRole("region", { name: "Webhook Gateway", exact: true });
      const admission = page.getByRole("region", { name: "Admission Gate", exact: true });
      await expect(gateway).toContainText("reviewed enrollment");
      await expect(gateway.locator("code")).toContainText("gateway-dispatch:");
      await expect(gateway.locator("code")).toContainText("security-alerts: {}");
      await expect(gateway.getByRole("link", { name: "Explore the Webhook Gateway" }))
        .toHaveAttribute("href", /#webhook-gateway-operations$/);
      await expect(admission).toContainText("OIDC");
      await expect(admission).toContainText("not a billing cap");
      await expect(admission.locator("code")).toContainText("gh cao setup admission");
      await expect(admission.locator("code")).toContainText("--dry-run");
      await expect(admission.getByRole("link", { name: "Set up the Admission Gate" }))
        .toHaveAttribute("href", "/gh-cao/admission-gate/");
      expect(await page.locator("html").evaluate(element => element.scrollWidth)).toBeLessThanOrEqual(width);
      if (width !== 320) {
        for (const [name, story] of [["agentic-workflows", section], ["webhook-gateway", gateway], ["admission-gate", admission]]) {
          const path = testInfo.outputPath(`${name}-${width}-${colorScheme}.png`);
          await story.screenshot({ path });
          await testInfo.attach(name, { path, contentType: "image/png" });
        }
      }
    });
  }
}

test("landing stories remain visible without JavaScript", async ({ browser, baseURL }) => {
  const context = await browser.newContext({ baseURL, javaScriptEnabled: false });
  try {
    const page = await context.newPage();
    await page.goto("./");
    for (const story of await page.locator("[data-reveal]").all()) {
      await expect(story).toHaveCSS("opacity", "1");
    }
    for (const name of ["Webhook Gateway", "Admission Gate", "Built on Agentic Workflows"]) {
      const section = page.getByRole("region", { name, exact: true });
      await expect(section).toBeVisible();
      await expect(section.locator(".workflow-example-card")).toHaveCount(3);
      await expect(section.locator("pre code")).not.toBeEmpty();
    }
  } finally {
    await context.close();
  }
});
