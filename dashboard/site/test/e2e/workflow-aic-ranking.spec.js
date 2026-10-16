import { authoritativeDashboard, expect, registerSmokeRoutes, test } from './helpers/smoke-fixtures.js';
import contract from '../fixtures/workflow-aic-ranking-contract.json' with { type: 'json' };

registerSmokeRoutes();

for (const width of [1200, 390]) {
  test(`workflow cost ranking excludes unpriced telemetry at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 844 });
    await page.evaluate(async ({ documentModel, contract }) => {
      const { compileDashboardViewPayloadQueries } = await import(`${location.origin}/src/data/queries/view-payload-compiler.js`);
      const { renderChartWidget } = await import(`${location.origin}/src/components/chart-elements.js`);
      const { buildChartPoints } = await import(`${location.origin}/src/components/view-data.js`);
      const { chartStyles } = await import(`${location.origin}/src/styles-charts.js`);
      const dashboard = documentModel.dashboard;
      const selectedPage = dashboard.pages.find((/** @type {{ id: string }} */ candidate) => candidate.id === contract.page);
      const view = selectedPage.definition.views.find((/** @type {{ id: string }} */ candidate) => candidate.id === contract.view);
      const compiled = compileDashboardViewPayloadQueries(selectedPage, contract.page, {
        queries: dashboard.queries, viewId: contract.view
      });
      const metadata = {
        'source-id': 'aic-ranking', 'source-kind': 'fixture',
        'as-of': '2026-10-15T12:00:00Z', 'retrieved-at': '2026-10-15T12:00:00Z',
        availability: 'available', completeness: 'complete', freshness: 'fresh'
      };
      const workflows = Array.from({ length: contract.unpricedWorkflows + contract.recordedCosts.length }, (_, index) => ({
        organization: 'example', repository: 'control', workflow: `.github/workflows/worker-${index}.md`
      }));
      const runs = workflows.map((workflow, index) => ({
        ...workflow, run: String(index + 1), 'run-attempt': 1,
        'aic-total': index < contract.unpricedWorkflows
          ? index % 2 === 0 ? 0 : null
          : contract.recordedCosts[index - contract.unpricedWorkflows]
      }));
      const style = document.createElement('style');
      style.textContent = chartStyles;
      document.head.append(style);
      const worker = new Worker('http://dashboard.test/src/data-worker.js', { type: 'module' });
      const source = await new Promise((resolve, reject) => {
        worker.onerror = reject;
        worker.onmessage = (event) => {
          if (event.data.id !== 1) return;
          if (event.data.error) return reject(new Error(event.data.error));
          resolve(event.data.data[compiled.aliases[0]]);
        };
        worker.postMessage({
          id: 1, operation: 'execute-dashboard-queries',
          queries: [...dashboard.queries, ...compiled.queries], sourceNames: compiled.aliases,
          sources: {
            workflows: { source: 'workflows', rows: workflows, metadata },
            runs: { source: 'runs', rows: runs, metadata }
          }
        });
      }).finally(() => worker.terminate());
      const points = buildChartPoints(contract.page, view.title, source.rows,
        view.encoding.x, view.encoding.y, null, view.encoding.href.field);
      document.querySelector('#root')?.replaceChildren(renderChartWidget(view.chart, points, []));
    }, { documentModel: authoritativeDashboard, contract });

    const values = page.locator('.horizontal-bar-chart-value');
    await expect(values).toHaveText(contract.rankedCosts.map(String));
    await expect(page.locator('.horizontal-bar-chart-label a').first()).toHaveAttribute(
      'href', '#page-workflow-runtime?workflow=example%2Fcontrol%3A.github%2Fworkflows%2Fworker-16.md'
    );
    await expect(page.getByText('worker-0.md (example/control)', { exact: true })).toHaveCount(0);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
  });
}
