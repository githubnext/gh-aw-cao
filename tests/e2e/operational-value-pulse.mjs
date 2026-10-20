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
  const ledger = JSON.parse(readFileSync(process.argv[2] ?? path.join(root, "tests/fixtures/operational-value/file-diet-events.json"), "utf8"));
  const output = path.join(directory, "pulse.html");
  const model = writePulse(ledger, output);
  const browser = await chromium.launch({ headless: true });
  try {
    for (const colorScheme of ["light", "dark"]) {
      writePulse(ledger, output);
      for (const width of [320, 1280]) {
        const page = await browser.newPage({ colorScheme, viewport: { width, height: 900 } });
        try {
          const errors = [], requests = [];
          page.on("pageerror", error => errors.push(error.message));
          page.on("request", request => {
            if (request.url().startsWith("http")) requests.push(request.url());
          });
          await page.goto(pathToFileURL(output).href);
          await page.locator(".signal h2").waitFor();
          assert.equal(await page.locator("h1").textContent(), "Daily File Diet");
          assert.match(await page.locator("main").innerText(), /Goal: Identify oversized production Go files/);
          assert.match(await page.locator(".signal").innerText(), /No net improvement in the last 28 days/);
          assert.match(await page.locator("main").innerText(), /not verified/i);
          assert.equal(await page.locator(".facts > div").count(), 3);
          assert.equal(await page.locator("details:visible").count(), 1, "Only one evidence disclosure belongs in the default view.");
          assert.equal(await page.locator(".chart:visible").count(), model.repositoryState ? 1 : 0);
          const words = (await page.locator("main").innerText()).trim().split(/\s+/).length;
          assert.ok(words <= 220, `Default File Diet view is too verbose: ${words} words.`);
          assert.equal(await page.locator(".metric-picker").isVisible(), false);
          assert.doesNotMatch(await page.locator("main").innerText(), /Lineage:|Fixed rule|Basis: workflow-contribution/);
          assert.equal(await page.locator(".history").getAttribute("open"), null);
          assert.equal(await page.locator("aside details").getAttribute("open"), null);
          assert.equal(await page.locator('[data-event]').count(), model.metrics[0].events.length);
          assert.equal(await page.locator(".chart svg").count(), model.repositoryState ? 3 : 2);
          if (model.repositoryState) {
            assert.equal(await page.locator(".snapshot-chart circle").count(), model.repositoryState.observations.length);
            assert.equal(await page.locator(".snapshot-chart path").count(), 0, "Sparse snapshots must not imply continuous change.");
            assert.match(await page.locator(".facts").innerText(),
              new RegExp(`${model.repositoryState.observations.at(-1).value} files`));
          } else assert.match(await page.locator(".facts").innerText(), /Not measured here/);
          await page.locator(".evidence > summary").focus();
          await page.locator(".evidence > summary").press("Enter");
          if (model.repositoryState) assert.equal(await page.locator(".checks li").count(), 3);
          await page.locator(".history > summary").click();
          const first = page.locator('[data-event]').first();
          await first.focus();
          await first.press("Enter");
          assert.ok((await page.locator("aside").innerText()).includes(model.metrics[0].events[0].label));
          await page.locator("aside details > summary").click();
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
          assert.equal(await page.locator('.chart[tabindex="0"][role="region"][aria-label]').count(), model.repositoryState ? 3 : 2);
          assert.ok(await page.locator("html").evaluate(element => element.scrollWidth <= window.innerWidth));
          assert.deepEqual(errors, []);
          assert.deepEqual(requests, [], "The standalone report must not require hosted assets or APIs.");
        } finally {
          await page.close();
        }
      }
      const page = await browser.newPage({ colorScheme, viewport: { width: 320, height: 900 } });
      try {
        const partial = structuredClone(ledger);
        partial.coverage.forEach(interval => { interval.status = "partial"; });
        writePulse(partial, output);
        await page.goto(pathToFileURL(output).href);
        await page.locator(".signal h2").waitFor();
        assert.match(await page.locator(".signal").innerText(), /Not enough evidence/);
        assert.match(await page.locator(".facts").innerText(), /Known subtotal only; coverage is incomplete/);
        assert.match(await page.locator(".facts").innerText(), /Unknown files/);
        const negative = structuredClone(ledger);
        const at = new Date(Date.parse(ledger.window.endAt) - 86400000).toISOString();
        negative.events.push({ ...structuredClone(negative.events.at(-1)), id: "negative-example",
          at, observedAt: ledger.observedAt, value: -3, lineage: [],
          acceptance: { state: "accepted", at, ref: "negative-native-example" } });
        writePulse(negative, output);
        await page.goto(pathToFileURL(output).href);
        await page.locator(".signal h2").waitFor();
        assert.match(await page.locator(".signal").innerText(), /has worsened/);
        assert.match(await page.locator(".facts").innerText(), /-3 files/);
        const noWork = structuredClone(ledger);
        noWork.events = [];
        noWork.opportunities = 0;
        delete noWork.repositoryState;
        delete noWork.checks;
        writePulse(noWork, output);
        await page.goto(pathToFileURL(output).href);
        await page.locator(".signal h2").waitFor();
        assert.match(await page.locator(".signal").innerText(), /No eligible work observed/);
        assert.match(await page.locator("main").innerText(), /not verified here/);
        await page.locator(".evidence > summary").click();
        assert.match(await page.locator("main").innerText(), /does not establish workflow failure/);
      } finally {
        await page.close();
      }
    }
  } finally {
    await browser.close();
  }
} finally {
  rmSync(directory, { recursive: true, force: true });
}
console.log("Operational-value pulse: desktop/mobile, light/dark, keyboard evidence and offline rendering passed.");
