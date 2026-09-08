// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { renderDashboard } from '../../src/presenter.js';
import { primerStylesheet } from '../../src/styles.js';

const authoritativeDashboardDocument = JSON.parse(
  readFileSync(`${process.cwd()}/dashboard.json`, 'utf8')
);

const metadata = {
  'source-id': 'cost-fixture',
  'source-kind': 'fixture',
  'as-of': '2026-08-31T05:00:00Z',
  'retrieved-at': '2026-08-31T05:01:00Z',
  completeness: /** @type {'partial'} */ ('partial'),
  freshness: /** @type {'fresh'} */ ('fresh'),
  availability: /** @type {'available'} */ ('available')
};

/** @param {HTMLElement} rendered */
async function activateCostPage(rendered) {
  const link = /** @type {HTMLAnchorElement | null} */ (rendered.querySelector('[data-nav-page-id="cost"]'));
  expect(link).not.toBeNull();
  link?.click();
  await vi.waitFor(() => {
    expect(rendered.querySelector('[data-page-id="cost"]')?.hasAttribute('data-page-pending')).toBe(false);
  });
  rendered.ownerDocument.defaultView?.history.replaceState(null, '', '/');
  return rendered.querySelector('[data-page-id="cost"]');
}

describe('Cost and efficiency dashboard view', () => {
  it('renders measured usage, evidence boundaries, repository allocation, and evaluation readiness from JSON', async () => {
    const rendered = renderDashboard({
      document: authoritativeDashboardDocument,
      sources: {
        usage: {
          source: 'usage',
          rows: [
            { organization: 'githubnext', repository: 'gh-aw-cao', workflow: '.github/workflows/daily.md', run: '101', invocation: 'usage-1', aic: 3.5, 'rollout-mode': 'review' },
            { organization: 'githubnext', repository: 'gh-aw-cao', workflow: '.github/workflows/daily.md', run: '101', invocation: 'usage-2', aic: 1.5, 'rollout-mode': 'live' },
            { organization: 'octo-org', repository: 'service', workflow: '.github/workflows/review.md', run: '202', invocation: 'usage-3', aic: 4, 'rollout-mode': 'unknown' }
          ],
          metadata
        }
      }
    });

    const page = await activateCostPage(rendered);
    const dashboardPage = authoritativeDashboardDocument.dashboard.pages.find(
      (/** @type {{ id: string }} */ candidate) => candidate.id === 'cost'
    );

    expect(dashboardPage).toMatchObject({ kind: 'custom', icon: 'meter' });
    expect(dashboardPage.views).toHaveLength(6);
    expect(dashboardPage.sections).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: 'measured-usage',
        'count-source': 'cost-signals',
        'count-label': 'boundaries',
        views: ['cost-usage-trend', 'cost-per-run-distribution', 'cost-summary', 'cost-signals']
      })
    ]));
    expect(dashboardPage.views).not.toContainEqual(expect.objectContaining({ element: 'metric-signal-summary' }));
    expect(primerStylesheet()).toContain(
      ':is(.readiness-page, .runtime-page, .security-page, .firewall-page, .value-page, .cost-page, .github-api-page) .layout-section { padding: 0; border: 0; background: transparent; }'
    );
    expect(rendered.querySelector('[data-nav-page-id="cost"] .octicon-meter')).not.toBeNull();
    const filterBar = rendered.querySelector('.report-actions > .filter-bar');
    expect(filterBar).not.toBeNull();
    expect(rendered.querySelector('.horizon-toggle')?.getAttribute('aria-label')).toContain('1 week');

    const summary = page?.querySelector('.summary-grid');
    expect(summary?.textContent).toContain('Measured AIC9');
    expect(summary?.textContent).toContain('Measured runs2');
    expect(summary?.textContent).toContain('Measured episode AIC—');
    expect(summary?.textContent).toContain('Episode output yield—');
    expect(page?.textContent).toContain('allocation evidence, not monetary cost');
    const histogram = page?.querySelector('[data-chart-widget="histogram"]');
    expect(histogram).not.toBeNull();
    expect(histogram?.querySelectorAll('.histogram-chart-bar')).toHaveLength(2);
    expect(histogram?.querySelector('.histogram-chart-mark')?.getAttribute('aria-label')).toContain('AIC');

    const evidenceBoundaries = [...(page?.querySelectorAll('.signal-list-region') ?? [])]
      .find((region) => region.textContent?.includes('Usage coverage'));
    const signals = [...(evidenceBoundaries?.querySelectorAll('.signal-item') ?? [])];
    expect(signals).toHaveLength(3);
    expect(signals.map((signal) => signal.querySelector('.signal-copy > span')?.textContent)).toEqual([
      'Usage coverage',
      'Budget boundary',
      'Anomaly boundary'
    ]);
    expect(signals[0]?.textContent).toContain('AI Credit telemetry is partial');
    expect(signals[0]?.querySelector('a')?.getAttribute('href')).toBe('#page-coverage');

    expect(page?.querySelectorAll('[data-chart-widget="pie"] [data-chart-category]')).toHaveLength(2);
    expect(page?.querySelector('.pie-chart-total-value')?.textContent).toBe('9');
    const pieChartView = page?.querySelector('.chart-view-pie');
    const pieChartCard = pieChartView?.querySelector('.pie-chart-card');
    const repositoryTable = pieChartView?.querySelector('.table-region');
    expect(pieChartCard).not.toBeNull();
    expect(repositoryTable).toBeNull();
    expect(page?.querySelectorAll('.signal-list-region')).toHaveLength(1);
    const boundary = page?.querySelector('.dashboard-callout');
    expect(boundary?.getAttribute('role')).toBe('note');
    expect(boundary?.querySelector('.scope-kicker')?.textContent).toBe('Evaluation boundary');
    expect(boundary?.querySelector('.octicon-meter')).not.toBeNull();
    expect(boundary?.querySelector('h3')?.textContent).toBe('Budget and anomaly verdicts unavailable');
    expect(boundary?.textContent).toContain('qualified historical baseline');
    expect(boundary?.getAttribute('data-section-id')).toBe('evaluation-boundary');
  });

  it('does not report a telemetry coverage boundary for a complete usage source', async () => {
    const rendered = renderDashboard({
      document: authoritativeDashboardDocument,
      sources: {
        usage: {
          source: 'usage',
          rows: [
            { organization: 'githubnext', repository: 'gh-aw-cao', workflow: '.github/workflows/daily.md', invocation: 'shared-id', aic: 1 },
            { organization: 'octo-org', repository: 'service', workflow: '.github/workflows/daily.md', invocation: 'shared-id', aic: 1 }
          ],
          metadata: { ...metadata, completeness: /** @type {'complete'} */ ('complete') }
        }
      }
    });

    const page = await activateCostPage(rendered);
    const evidenceBoundaries = [...(page?.querySelectorAll('.signal-list-region') ?? [])]
      .find((region) => region.textContent?.includes('Budget boundary'));
    const signals = [...(evidenceBoundaries?.querySelectorAll('.signal-item') ?? [])];
    expect(signals).toHaveLength(2);
    expect(page?.textContent).not.toContain('AI Credit telemetry is partial');
    expect(page?.querySelector('.summary-grid')?.textContent).toContain('Measured AIC2');
    expect(page?.querySelector('.summary-grid')?.textContent).toContain('Measured runs2');
  });
});
