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
          const theme = await page.locator("body").evaluate(element => ({
            foreground: getComputedStyle(element).color,
            background: getComputedStyle(element).backgroundColor,
            font: getComputedStyle(element).fontFamily,
          }));
          assert.equal(theme.foreground, colorScheme === "light" ? "rgb(31, 35, 40)" : "rgb(240, 246, 252)");
          assert.equal(theme.background, colorScheme === "light" ? "rgb(246, 248, 250)" : "rgb(21, 27, 35)");
          assert.match(theme.font, /Mona Sans VF.*Segoe UI.*Noto Sans/);
          assert.equal(await page.locator("h1").evaluate(element => getComputedStyle(element).fontWeight), "600");
          assert.deepEqual(await page.locator(".eyebrow a").evaluateAll(links => links.map(link => link.href)), [
            `https://github.com/${model.repository}`,
          ]);
          assert.equal(await page.locator('#measurement-rules a').first().getAttribute("href"),
            `https://github.com/${model.repository}/blob/HEAD/${model.sourcePath}`);
          assert.match(await page.locator('#measurement-rules a').first().textContent(), /source \(current\)/);
          assert.match(await page.locator(".report-date").innerText(), /Saved report/);
          assert.ok((await page.locator(".report-date").getAttribute("title")).includes(model.observedAt));
          assert.match(await page.locator(".goal").innerText(), /Workflow intent.*Identify oversized production Go files/s);
          assert.equal(await page.locator(".signal h2").innerText(), "No recent net progress");
          assert.match(await page.locator("main").innerText(), /not verified/i);
          assert.equal(await page.locator(".facts > div").count(), 2);
          assert.equal(await page.locator('.facts .fact-icon[aria-hidden="true"]').count(), 2);
          assert.equal(await page.locator(".fact-unit").count(), model.repositoryState ? 2 : 1);
          assert.deepEqual(await page.locator(".workflow-trail .trail-value").allTextContents(), [
            model.outputs ? String(model.outputs.retainedCount) : "Unknown",
            model.outputs ? String(model.outputs.implementationCount) : "Unknown",
            String(model.metrics[0].completeTotal ?? model.metrics[0].observedTotal),
          ]);
          assert.match(await page.locator(".trail-scope").innerText(), /Output creation is not acceptance/);
          assert.equal(await page.locator(".attention-label").innerText(), "Review results");
          assert.equal(await page.locator("details:visible").count(), 1, "Only one evidence disclosure belongs in the default view.");
          const disclosure = page.locator(".evidence > summary");
          assert.ok((await disclosure.boundingBox()).height >= 44, "Evidence must have an obvious touch-sized target.");
          assert.equal(await disclosure.evaluate(element => getComputedStyle(element).cursor), "pointer");
          assert.ok(await page.locator(".disclosure-hint").isVisible());
          assert.equal(await page.locator(".chart:visible").count(), model.repositoryState ? 1 : 0);
          const words = (await page.locator("main").innerText()).trim().split(/\s+/).length;
          assert.ok(words <= 150, `Default File Diet view is too verbose: ${words} words.`);
          const height = await page.locator("main").evaluate(element => element.getBoundingClientRect().height);
          assert.ok(height <= (width >= 1000 ? 900 : 1100), `At-a-glance view is too tall: ${height}px at ${width}px.`);
          assert.ok(await page.locator(".facts > div").first().evaluate(element => element.classList.contains("repository-fact")),
            "The independent repository outcome must lead, not the contribution total.");
          assert.ok(await page.locator(".repository-fact .snapshot-chart").count() === (model.repositoryState ? 1 : 0),
            "The chart belongs beside the outcome, not in a second repeated section.");
          assert.equal(await page.locator(".metric-picker").isVisible(), false);
          assert.doesNotMatch(await page.locator("main").innerText(), /Lineage:|Fixed rule|Basis: workflow-contribution/);
          assert.equal(await page.locator(".history").getAttribute("open"), null);
          assert.equal(await page.locator("aside details").getAttribute("open"), null);
          assert.equal(await page.locator('[data-event]').count(), model.metrics[0].events.length);
          assert.equal(await page.locator(".chart svg").count(), model.repositoryState ? 3 : 2);
          if (model.repositoryState) {
            assert.equal(await page.locator(".snapshot-chart circle").count(), model.repositoryState.observations.length);
            assert.equal(await page.locator(".snapshot-chart path, .snapshot-chart polygon").count(), 0,
              "Snapshots must not use a smoothed curve or filled area.");
            assert.equal(await page.locator(".snapshot-connector").count(), model.repositoryState.observations.length - 1);
            const segments = await page.locator(".snapshot-connector").evaluateAll(lines => lines.map(line => ({
              x1: line.getAttribute("x1"), y1: line.getAttribute("y1"), x2: line.getAttribute("x2"), y2: line.getAttribute("y2"),
              dash: getComputedStyle(line).strokeDasharray, hidden: line.getAttribute("aria-hidden"),
              pointerEvents: getComputedStyle(line).pointerEvents,
            })));
            const points = await page.locator(".snapshot-chart circle").evaluateAll(points => points.map(point => ({
              x: point.getAttribute("cx"), y: point.getAttribute("cy"),
            })));
            segments.forEach((segment, index) => {
              assert.deepEqual([segment.x1, segment.y1, segment.x2, segment.y2],
                [points[index].x, points[index].y, points[index + 1].x, points[index + 1].y]);
              assert.notEqual(segment.dash, "none", "Every connector must be explicitly illustrative, not a solid continuous series.");
              assert.equal(segment.hidden, "true");
              assert.equal(segment.pointerEvents, "none", "Connectors must not intercept evidence links.");
            });
            assert.match(await page.locator(".snapshot-chart > .chart svg > title").textContent(), /not continuous observations/);
            assert.match(await page.locator(".snapshot-chart .chart-caption").innerText(), /Dashed guide/);
            assert.equal(await page.locator(".snapshot-direction").textContent(), "↓ Lower is better");
            assert.ok(await page.locator(".snapshot-direction").evaluate(label => {
              const bounds = label.getBoundingClientRect(), chart = label.ownerSVGElement.getBoundingClientRect();
              return bounds.top >= chart.top && bounds.bottom <= chart.bottom
                && bounds.left >= chart.left && bounds.right <= chart.right;
            }), "The goal-direction cue must stay fully inside the responsive chart.");
            assert.ok(await page.locator(".snapshot-chart .axis, .snapshot-chart .snapshot-value, .snapshot-direction").evaluateAll(labels =>
              labels.every(label => parseFloat(getComputedStyle(label).fontSize) * label.getScreenCTM().a >= 11)),
            "Chart labels must remain readable after SVG scaling on narrow screens.");
            assert.deepEqual(await page.locator(".snapshot-value").allTextContents(),
              [model.repositoryState.observations[0].value, model.repositoryState.observations.at(-1).value].map(String));
            assert.match(await page.locator(".facts").innerText(),
              new RegExp(`${model.repositoryState.observations.at(-1).value} files`));
            const change = model.repositoryState.observations.at(-1).value - model.repositoryState.observations[0].value;
            assert.equal(await page.locator(".repository-fact .fact-detail").innerText(), `↑ +${change} files · Worse`);
            assert.ok(await page.locator(".repository-fact .fact-detail").evaluate(element => element.classList.contains("worsening")));
            assert.equal(await page.locator(".repository-fact .fact-detail").evaluate(element => getComputedStyle(element).color),
              colorScheme === "light" ? "rgb(154, 103, 0)" : "rgb(210, 153, 34)");
            assert.deepEqual(await page.locator(".snapshot-chart a").evaluateAll(links => links.map(link => link.getAttribute("href"))),
              model.repositoryState.observations.map((_, index) => `#snapshot-${index}`));
            assert.equal(await page.locator(".snapshot-chart").getByRole("link").count(), model.repositoryState.observations.length,
              "Snapshot links must be exposed to assistive technology.");
          } else assert.match(await page.locator(".facts").innerText(), /Not measured here/);
          if (model.resultLabel) {
            assert.equal(await page.locator(".recent-fact dt").innerText(), `Recent ${model.resultLabel}`);
            assert.equal(await page.locator(".workflow-trail .trail-detail").last().innerText(), model.resultLabel);
          }
          await page.locator('.goal a[href="#workflow-intent"]').click();
          assert.equal(await page.locator("#workflow-intent").evaluate(element => element.open && element === document.activeElement), true);
          assert.deepEqual(await page.locator("#workflow-intent .evidence-links a").evaluateAll(links => links.map(link => ({
            label: link.textContent, url: link.href,
          }))), model.intent.sources ?? []);
          await page.locator(".attention-label").click();
          assert.equal(await page.locator("#attention-signal").evaluate(element => element.open && element === document.activeElement), true);
          assert.match(await page.locator("#attention-signal").innerText(), /not a failure verdict/);
          await page.locator('.workflow-trail a[href="#outputs-created"]').click();
          assert.equal(await page.locator("#outputs-created").evaluate(element => element.open && element === document.activeElement), true);
          if (model.outputs) {
            assert.equal(await page.locator("#outputs-created .result-list > li").count(), model.outputs.retainedCount);
            assert.match(await page.locator("#outputs-created").innerText(), /Closed issues alone are not accepted/);
            const firstLinkedIndex = model.outputs.items.findIndex(item => item.implementationIds.length);
            const source = page.locator("#outputs-created .result-list > li").nth(firstLinkedIndex).locator("details");
            await source.locator("summary").click();
            assert.equal(await source.locator(".evidence-links a").first().getAttribute("href"),
              model.outputs.items[firstLinkedIndex].url);
            const target = source.locator('a[href^="#result-"]').first();
            const destination = await target.getAttribute("href");
            await target.focus();
            await target.press("Enter");
            assert.equal(await page.locator(destination).evaluate(element => element.open && element === document.activeElement), true);
          } else assert.match(await page.locator("#outputs-created").innerText(), /lifecycle was not retained/);
          await page.locator('.quality-note a').click();
          assert.equal(await page.locator("#goal-checks").evaluate(element => element === document.activeElement), true);
          assert.ok(await page.locator("#goal-checks").isVisible(), "Unknown quality must have an obvious, actionable explanation.");
          await page.locator(".evidence").evaluate(element => { element.open = false; });
          const internalLinks = await page.locator('a[href^="#"]').evaluateAll(links => links.map(link => ({
            destination: link.getAttribute("href"), exists: !!document.getElementById(link.getAttribute("href").slice(1)),
          })));
          assert.ok(internalLinks.length > 3);
          assert.ok(internalLinks.every(link => link.exists), "Every report fragment must resolve to real retained evidence.");
          const recentNumber = page.locator('.facts a[href="#recent-results"]');
          assert.ok((await recentNumber.boundingBox()).height >= 44);
          await recentNumber.focus();
          await recentNumber.press("Enter");
          assert.equal(await page.locator("#recent-results").evaluate(element => element.open && element === document.activeElement), true);
          const recent = page.locator('[data-period="current"]');
          assert.ok((await recent.innerText()).includes(model.metrics[0].currentWindow.startAt));
          assert.ok((await recent.innerText()).includes(model.metrics[0].currentWindow.endAt));
          assert.match(await recent.innerText(), /Net measured change: 0 files/);
          assert.match(await recent.innerText(), /does not establish an absence of workflow activity/);
          for (const period of ["current", "previous"]) {
            assert.equal(await page.locator(`[data-period="${period}"] a`).count(), model.metrics[0][`${period}EventIds`].length);
          }
          await page.locator('.workflow-trail a[href="#accepted-results"]').first().click();
          assert.equal(await page.locator("#accepted-results").evaluate(element => element.open && element === document.activeElement), true);
          assert.equal(await page.locator("#accepted-results .result-list > li").count(), model.metrics[0].events.length);
          if (model.repositoryState) {
            const index = model.repositoryState.observations.length - 1;
            await page.locator(`.facts strong a[href="#snapshot-${index}"]`).click();
            assert.equal(await page.locator("#repository-snapshots").evaluate(element => element.open), true);
            assert.equal(await page.locator(`#snapshot-${index}`).evaluate(element => element.open && element === document.activeElement), true);
            const retained = model.repositoryState.observations[index].items ?? [];
            assert.deepEqual(await page.locator(`#snapshot-${index} .snapshot-items a`).evaluateAll(links => links.map(link => ({
              label: link.textContent, url: link.href,
            }))), retained);
          }
          await page.locator(".evidence").evaluate(element => { element.open = false; });
          await page.locator(".evidence > summary").focus();
          await page.locator(".evidence > summary").press("Enter");
          assert.notEqual(await page.locator(".evidence").getAttribute("open"), null);
          assert.notEqual(await disclosure.evaluate(element => getComputedStyle(element).outlineStyle), "none");
          if (model.repositoryState) assert.equal(await page.locator(".checks li").count(), 3);
          await page.locator(".history > summary").click();
          const firstWeek = model.metrics[0].weekly.findIndex(bucket => bucket.rate != null);
          const weeklyMark = page.locator(`svg a[href="#week-${firstWeek}"]`);
          await weeklyMark.focus();
          await weeklyMark.press("Enter");
          const week = page.locator(`#week-${firstWeek}`);
          assert.equal(await week.evaluate(element => element === document.activeElement), true);
          assert.ok((await week.innerText()).includes(model.metrics[0].weekly[firstWeek].startAt));
          assert.equal(await week.locator("a").count(), model.metrics[0].weekly[firstWeek].eventIds.length);
          const first = page.locator('[data-event]').first();
          await first.focus();
          await first.press("Enter");
          assert.equal(await page.locator("#result-0").evaluate(element => element.open && element === document.activeElement), true);
          assert.deepEqual(await page.locator("#result-0 .evidence-links a").evaluateAll(links => links.map(link => link.href)),
            model.metrics[0].events[0].evidence.map(ref => ref.url));
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
          await page.emulateMedia({ reducedMotion: "reduce" });
          assert.equal(await disclosure.evaluate(element => getComputedStyle(element).transitionDuration), "0s");
          assert.equal(await disclosure.evaluate(element => getComputedStyle(element, "::after").transitionDuration), "0s");
          await page.goto(`${pathToFileURL(output).href}#result-0`);
          await page.reload();
          assert.equal(await page.locator("#result-0").evaluate(element => element.open && element === document.activeElement), true,
            "Saved deep links must open all enclosing evidence disclosures.");
          if (model.repositoryState) {
            await page.context().route("https://github.com/**", route => route.fulfill({
              status: 200, contentType: "text/plain", body: "Outbound navigation intercepted by the test.",
            }));
            const point = page.locator(".snapshot-chart a").first();
            await point.focus();
            await point.press("Enter");
            assert.equal(await page.locator("#snapshot-0").evaluate(element => element.open && element === document.activeElement), true,
              "A chart point must reveal the measured items, not jump straight to a repository tree.");
            const retained = model.repositoryState.observations[0].items;
            if (retained?.length) {
              const item = page.locator("#snapshot-0 .snapshot-items a").first();
              await item.focus();
              const popupPromise = page.waitForEvent("popup");
              await item.press("Enter");
              const popup = await popupPromise;
              try {
                await popup.waitForURL(retained[0].url);
                assert.equal(popup.url(), retained[0].url, "The item link must open the exact retained file permalink.");
                assert.ok(new URL(popup.url()).pathname.includes(`/blob/${model.repositoryState.observations[0].ref}/`));
              } finally {
                await popup.close();
              }
            } else if (retained === undefined) {
              assert.match(await page.locator("#snapshot-0").innerText(), /Item-level evidence was not retained/);
            }
            await page.reload();
            assert.equal(await page.locator("#snapshot-0").evaluate(element => element.open && element === document.activeElement), true);
          }
          assert.deepEqual(errors, []);
          assert.deepEqual(requests, []);
        } finally {
          await page.close();
        }
      }
      const page = await browser.newPage({ colorScheme, viewport: { width: 320, height: 900 } });
      try {
        if (ledger.repositoryState) {
          const singleton = structuredClone(ledger);
          singleton.repositoryState.observations = [singleton.repositoryState.observations.at(-1)];
          writePulse(singleton, output);
          await page.goto(pathToFileURL(output).href);
          assert.match(await page.locator(".repository-fact .fact-detail").innerText(), /No earlier snapshot for comparison/);
          assert.equal(await page.locator(".snapshot-chart circle").count(), 1);
          assert.equal(await page.locator(".snapshot-connector, .fact-movement").count(), 0);
          assert.equal(await page.locator(".snapshot-chart .axis").count(), 1,
            "One snapshot must not produce an overlapping or invented comparison.");
          const recovered = structuredClone(ledger);
          const final = recovered.repositoryState.observations.at(-1);
          final.value = recovered.repositoryState.observations[0].value - 1;
          delete final.items;
          writePulse(recovered, output);
          await page.reload();
          assert.equal(await page.locator(".repository-fact .fact-detail").innerText(), "↓ -1 files · Better");
          assert.equal(await page.locator(".repository-fact .fact-detail").evaluate(element => getComputedStyle(element).color),
            colorScheme === "light" ? "rgb(26, 127, 55)" : "rgb(63, 185, 80)");
          recovered.repositoryState.metric.direction = "increase";
          writePulse(recovered, output);
          await page.reload();
          assert.equal(await page.locator(".snapshot-direction").textContent(), "↑ Higher is better");
          assert.equal(await page.locator(".repository-fact .fact-detail").innerText(), "↓ -1 files · Worse");
          final.value = recovered.repositoryState.observations[0].value + 1;
          writePulse(recovered, output);
          await page.reload();
          assert.equal(await page.locator(".repository-fact .fact-detail").innerText(), "↑ +1 files · Better");
          final.value = recovered.repositoryState.observations[0].value;
          writePulse(recovered, output);
          await page.reload();
          assert.equal(await page.locator(".repository-fact .fact-detail").innerText(), "Unchanged since first snapshot");
          assert.equal(await page.locator(".fact-movement.improving, .fact-movement.worsening").count(), 0);
          const missingItems = structuredClone(ledger);
          for (const row of missingItems.repositoryState.observations) delete row.items;
          writePulse(missingItems, output);
          await page.goto("about:blank");
          await page.goto(`${pathToFileURL(output).href}#snapshot-0`);
          assert.match(await page.locator("#snapshot-0").innerText(), /Item-level evidence was not retained/);
          assert.equal(await page.locator("#snapshot-0 .snapshot-items a").count(), 0);
          missingItems.repositoryState.observations[0].items = [];
          missingItems.repositoryState.observations[0].value = 0;
          writePulse(missingItems, output);
          await page.reload();
          assert.match(await page.locator("#snapshot-0").innerText(), /retained item list is empty/);
          assert.doesNotMatch(await page.locator("#snapshot-0").innerText(), /Item-level evidence was not retained/);
          await page.goto("about:blank");
        }
        const partial = structuredClone(ledger);
        partial.coverage.forEach(interval => { interval.status = "partial"; });
        if (partial.outputs) partial.outputs.coverage = "partial";
        writePulse(partial, output);
        await page.goto(pathToFileURL(output).href);
        await page.locator(".signal h2").waitFor();
        assert.match(await page.locator(".signal").innerText(), /Not enough evidence/);
        assert.match(await page.locator(".workflow-trail").innerText(), /Known subtotal; incomplete coverage/);
        assert.equal(await page.locator(".attention-label").innerText(), "Check evidence");
        assert.match(await page.locator(".facts").innerText(), /Unknown files/);
        await page.locator('.facts a[href="#recent-results"]').click();
        assert.match(await page.locator('[data-period="current"]').innerText(), /Coverage is incomplete/);
        assert.doesNotMatch(await page.locator('[data-period="current"]').innerText(), /Net measured change: 0/);
        const negative = structuredClone(ledger);
        const at = new Date(Date.parse(ledger.window.endAt) - 86400000).toISOString();
        negative.events.push({ ...structuredClone(negative.events.at(-1)), id: "negative-example",
          at, observedAt: ledger.observedAt, value: -3, lineage: [],
          acceptance: { state: "accepted", at, ref: "negative-native-example" } });
        if (negative.outputs) negative.outputs.items[0].implementationIds.push("negative-example");
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
        delete noWork.outputs;
        writePulse(noWork, output);
        await page.goto(pathToFileURL(output).href);
        await page.locator(".signal h2").waitFor();
        assert.match(await page.locator(".signal").innerText(), /No eligible work observed/);
        assert.equal(await page.locator(".attention-label").innerText(), "No review triggered");
        assert.match(await page.locator("main").innerText(), /Full quality checks not verified/);
        await page.locator(".evidence > summary").click();
        assert.match(await page.locator("main").innerText(), /does not establish workflow failure/);
        const independent = structuredClone(ledger);
        independent.basis = "repository-outcome";
        delete independent.outputs;
        writePulse(independent, output);
        await page.goto(pathToFileURL(output).href);
        await page.reload();
        assert.equal(await page.locator(".workflow-trail").count(), 0,
          "Actor-independent outcomes must not be presented as a workflow output funnel.");
        assert.equal(await page.locator(".historical-fact dt").innerText(), "Historical outcomes");
        const metrics = [
          { id: "outcome", name: "Verified problem resolution", role: "primary", unit: "percent", direction: "increase" },
          { id: "linked", name: "Linked repairs", role: "diagnostic", unit: "defects", direction: "increase" },
        ];
        const timeline = {
          repository: "octo/example",
          window: { startAt: "2026-01-01T00:00:00Z", endAt: "2026-01-15T00:00:00Z" },
          valueFunction: { definition: {
            repository: "octo/example", slug: "verify-bugs", workflowName: "Verify bugs",
            sourcePath: ".github/workflows/verify-bugs.md",
            adoption: { adoptedAt: "2026-01-01T00:00:00Z" },
            evidence: { measurementKind: "interval", window: { durationDays: 7, cadenceDays: 7, maturationDays: 0 } },
            metrics, signal: { metricId: "linked", basis: "workflow-contribution" },
          } },
          snapshots: ["2026-01-08T00:00:00Z", "2026-01-15T00:00:00Z"].map((at, index) => ({
            observedAt: at, window: { startAt: new Date(Date.parse(at) - 7 * 86400000).toISOString(), endAt: at },
            metrics: { outcome: 80, linked: index ? 4 : 2 },
            evidence: { coverageStatus: "complete", maturityStatus: "matured", eligibleCount: 5 },
          })),
          metricReview: { metrics: [{ ...metrics[0],
            recentComparison: { status: "available", nativeDelta: 0, directionAwareGain: 0 } }] },
        };
        writePulse(timeline, output);
        await page.goto("about:blank");
        await page.goto(`${pathToFileURL(output).href}#observations-outcome`);
        assert.equal(await page.locator(".metric-picker select").inputValue(), "outcome");
        assert.equal(await page.locator("#observations-outcome").evaluate(element => element.open && element === document.activeElement), true);
        await page.locator(".metric-picker select").selectOption("linked");
        await page.locator('.facts a[href="#observations-outcome"]').click();
        assert.equal(await page.locator(".metric-picker select").inputValue(), "outcome",
          "Repository-state evidence must select the primary measure, not show the diagnostic curve.");
        await page.locator(".history > summary").click();
        await page.locator('svg a[href="#observation-outcome-0"]').focus();
        await page.locator('svg a[href="#observation-outcome-0"]').press("Enter");
        assert.match(await page.locator("#observation-outcome-0").innerText(), /80 percent; complete/);
        await page.locator(".metric-picker select").selectOption("linked");
        await page.reload();
        assert.equal(await page.locator(".metric-picker select").inputValue(), "outcome",
          "A saved point link must retain its metric identity.");
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
