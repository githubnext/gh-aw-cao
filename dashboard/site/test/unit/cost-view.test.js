// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { renderDashboard } from '../../src/presenter.js';

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

const efficiencyRows = [
  {
    organization: 'githubnext',
    repository: 'githubnext/gh-aw-cao',
    workflow: '.github/workflows/daily.md',
    'workflow-name': 'Daily triage',
    'agent-model': 'copilot / claude-sonnet-4',
    runs: 2,
    aic: 5,
    'aic-per-run': 2.5,
    'failed-runs': 1,
    'mcp-tool-calls': 12,
    'denied-tool-calls': 2,
    'firewall-blocked': 3,
    'workflow-link': { relation: 'workflow', href: 'https://github.com/githubnext/gh-aw-cao/blob/main/.github/workflows/daily.md', label: 'Daily triage' }
  },
  {
    organization: 'octo-org',
    repository: 'octo-org/service',
    workflow: '.github/workflows/review.md',
    'workflow-name': 'Review worker',
    'agent-model': 'codex / gpt-5',
    runs: 1,
    aic: 4,
    'aic-per-run': 4,
    'failed-runs': 0,
    'mcp-tool-calls': 4,
    'denied-tool-calls': 0,
    'firewall-blocked': 0,
    'workflow-link': { relation: 'workflow', href: 'https://github.com/octo-org/service/blob/main/.github/workflows/review.md', label: 'Review worker' }
  }
];

const runRows = [
  { 'started-at': '2026-08-29T08:00:00Z', workflow: '.github/workflows/daily.md', aic: 2 },
  { 'started-at': '2026-08-29T08:00:00Z', workflow: '.github/workflows/daily.md', aic: 3 },
  { 'started-at': '2026-08-29T12:00:00Z', workflow: '.github/workflows/review.md', aic: 3 },
  { 'started-at': '2026-08-30T08:00:00Z', workflow: '.github/workflows/daily.md', aic: 4 },
  { 'started-at': '2026-08-30T12:00:00Z', workflow: '.github/workflows/review.md', aic: 1 }
];

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

describe('Cost dashboard view', () => {
  it('leads with an AI Credit area trend, top consumers, and workflow efficiency', async () => {
    const rendered = renderDashboard({
      document: authoritativeDashboardDocument,
      sources: {
        'cost-aic-over-time': {
          source: 'cost-aic-over-time',
          rows: runRows,
          metadata
        },
        'cost-top-workflow-aic': {
          source: 'cost-top-workflow-aic',
          rows: efficiencyRows,
          metadata
        },
        'cost-workflow-efficiency': {
          source: 'cost-workflow-efficiency',
          rows: efficiencyRows,
          metadata
        }
      }
    });

    const page = await activateCostPage(rendered);
    const dashboardPage = authoritativeDashboardDocument.dashboard.pages.find(
      (/** @type {{ id: string }} */ candidate) => candidate.id === 'cost'
    );

    expect(dashboardPage).toMatchObject({ kind: 'custom', title: 'Cost', icon: 'meter' });
    expect(dashboardPage.sections).toBeUndefined();
    expect(dashboardPage.views).toHaveLength(3);
    expect(dashboardPage.views[0]).toMatchObject({
      id: 'cost-aic-over-time',
      mark: 'chart',
      chart: 'area',
      data: { source: 'cost-aic-over-time' },
      encoding: {
        x: { field: 'started-at', type: 'temporal', 'time-unit': 'day' },
        y: { field: 'aic', type: 'quantitative', aggregate: 'sum', unit: 'aic' },
        color: { field: 'workflow', type: 'nominal' }
      }
    });
    expect(dashboardPage.views[1]).toMatchObject({
      id: 'cost-top-workflow-aic',
      mark: 'chart',
      chart: 'pie',
      data: { source: 'cost-top-workflow-aic' }
    });
    const topQuery = authoritativeDashboardDocument.dashboard.queries.find(
      (/** @type {{ name: string }} */ candidate) => candidate.name === 'cost-top-workflow-aic'
    );
    expect(topQuery).toMatchObject({
      from: 'cost-workflow-efficiency',
      'order-by': expect.arrayContaining([{ field: 'aic', direction: 'desc' }]),
      limit: 10
    });
    expect(dashboardPage.views[1].encoding.y).toMatchObject({ field: 'aic', aggregate: 'sum', unit: 'aic' });
    expect(dashboardPage.views[2]).toMatchObject({
      id: 'cost-workflow-efficiency',
      mark: 'table',
      controls: 'interactive',
      'lazy-list': true,
      layout: 'full-view',
      data: { source: 'cost-workflow-efficiency' }
    });

    expect(rendered.querySelector('[data-nav-page-id="cost"] .octicon-meter')).not.toBeNull();
    expect(page?.querySelector('[data-view-id="cost-aic-over-time"] [data-chart-widget="area"]')).not.toBeNull();
    expect(page?.querySelectorAll('[data-view-id="cost-aic-over-time"] .area-chart-area')).toHaveLength(2);
    expect(page?.querySelectorAll('[data-view-id="cost-aic-over-time"] .chart-point')).toHaveLength(4);
    expect([...page?.querySelectorAll('[data-view-id="cost-aic-over-time"] .chart-point') ?? []]
      .map((point) => point.getAttribute('aria-label'))).toEqual(expect.arrayContaining([
        expect.stringContaining('5')
      ]));
    expect(page?.querySelector('[data-view-id="cost-top-workflow-aic"] [data-chart-widget="pie"]')).not.toBeNull();
    expect(page?.querySelector('[data-view-id="cost-workflow-efficiency"] [data-lazy-list]')).not.toBeNull();
    expect(page?.querySelectorAll('tbody tr')).toHaveLength(2);
    const headers = [...page?.querySelectorAll('thead th') ?? []].map((cell) => cell.textContent);
    expect(headers).toEqual(expect.arrayContaining([
      expect.stringContaining('Workflow'),
      expect.stringContaining('Agent / model'),
      expect.stringContaining('Runs'),
      expect.stringContaining('Total AIC'),
      expect.stringContaining('AIC / run'),
      expect.stringContaining('Failed runs'),
      expect.stringContaining('MCP tool calls'),
      expect.stringContaining('Denied tool calls'),
      expect.stringContaining('Firewall blocked')
    ]));
    expect([...page?.querySelectorAll('[data-field="agent-model"]') ?? []].map((cell) => cell.textContent))
      .toContain('copilot / claude-sonnet-4');
    expect([...page?.querySelectorAll('[data-field="aic-per-run"]') ?? []].map((cell) => cell.textContent))
      .toContain('2.50');
    expect([...page?.querySelectorAll('[data-field="denied-tool-calls"]') ?? []].map((cell) => cell.textContent))
      .toContain('2');
    const workflowCell = page?.querySelector('[data-field="workflow-name"] a');
    expect(workflowCell?.getAttribute('href')).toBe(
      'https://github.com/githubnext/gh-aw-cao/blob/main/.github/workflows/daily.md'
    );
    rendered.remove();
  });
});
