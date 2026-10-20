import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { chromium } from "@playwright/test";
import { writePulse } from "../../.github/skills/add-operational-value/scripts/render-pulse.mjs";

const root = path.resolve(import.meta.dirname, "../..");
mkdirSync(path.join(root, ".tmp"), { recursive: true });
const directory = mkdtempSync(path.join(root, ".tmp", "value-pulse-browser-"));
try {
  const ledger = JSON.parse(readFileSync(path.join(root, "tests/fixtures/operational-value/file-diet-events.json"), "utf8"));
  const output = path.join(directory, "pulse.html");
  const model = writePulse(ledger, output);
  const browser = await chromium.launch({ headless: true });
  try {
    for (const colorScheme of ["light", "dark"]) {
      for (const width of [320, 1280]) {
        const page = await browser.newPage({ colorScheme, viewport: { width, height: 900 } });
        try {
          const errors = [], requests = [];
          page.on("pageerror", error => errors.push(error.message));
          page.on("request", request => {
            if (request.url().startsWith("http")) requests.push(request.url());
          });
          await page.goto(pathToFileURL(output).href);
          await page.locator("[data-event]").first().waitFor();
          assert.equal(await page.locator("h1").textContent(), "Daily File Diet");
          assert.match(await page.locator("main").innerText(), /Goal: Identify oversized production Go files/);
          assert.equal(await page.locator('[data-event]').count(), 51);
          assert.equal(await page.locator("svg").count(), 2);
          const first = page.locator('[data-event]').first();
          await first.focus();
          await first.press("Enter");
          assert.ok((await page.locator("aside").innerText()).includes(model.metrics[0].events[0].label));
          assert.ok((await page.locator("aside").innerText()).includes("Acceptance:"));
          assert.ok((await page.locator("aside").innerText()).includes("closed-by"));
          assert.ok((await page.locator("aside").innerText()).includes("2025-11-15T17:16:13Z"));
          const evidenceLinks = await page.locator("aside a").evaluateAll(links => links.map(link => ({
            href: link.href, rel: link.rel,
          })));
          assert.ok(evidenceLinks.some(link => link.href.includes("/tree/")));
          assert.ok(evidenceLinks.every(link => link.rel.includes("noopener") && link.rel.includes("noreferrer")));
          assert.ok(await page.locator("svg path").evaluateAll(paths =>
            paths.every(element => !/NaN|undefined/.test(element.getAttribute("d")))));
          assert.equal(await page.locator('.chart[tabindex="0"][role="region"][aria-label]').count(), 2);
          assert.ok(await page.locator("html").evaluate(element => element.scrollWidth <= window.innerWidth));
          assert.deepEqual(errors, []);
          assert.deepEqual(requests, [], "The standalone report must not require hosted assets or APIs.");
        } finally {
          await page.close();
        }
      }
    }
  } finally {
    await browser.close();
  }
} finally {
  rmSync(directory, { recursive: true, force: true });
}
console.log("Operational-value pulse: desktop/mobile, light/dark, keyboard evidence and offline rendering passed.");
