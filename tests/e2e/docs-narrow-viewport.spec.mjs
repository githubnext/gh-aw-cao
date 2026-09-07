import { expect, test } from "@playwright/test";

const paths = [
  "/",
  "/getting-started/",
  "/configuration/",
  "/operations/",
  "/architecture/",
  "/catalog/",
  "/catalog/self-care/",
  "/operational-observability-visualization-specification/",
];

for (const colorScheme of ["light", "dark"]) {
  test.describe(`${colorScheme} scheme`, () => {
    test.use({ colorScheme, viewport: { width: 320, height: 900 } });

    for (const path of paths) {
      test(`${path} does not overflow horizontally`, async ({ page }) => {
        await page.goto(path);

        expect(await page.locator("html").evaluate((element) => element.scrollWidth)).toBeLessThanOrEqual(320);
      });
    }
  });
}

test("long code remains in a keyboard-focusable local scroll region", async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 900 });
  await page.goto("http://127.0.0.1:4321/gh-aw-cao/configuration/");

  const code = page.locator(".sl-markdown-content pre").first();
  expect(await code.evaluate((element) => element.scrollWidth)).toBeGreaterThan(await code.evaluate((element) => element.clientWidth));
  await expect(code).toHaveAttribute("tabindex", "0");
});
