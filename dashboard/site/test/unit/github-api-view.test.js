// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { renderDashboard } from '../../src/presenter.js';
import { loadDashboardDocument } from '../dashboard-document.js';

const dashboard = loadDashboardDocument();
const metadata = {
  'source-id': 'github-api-fixture',
  'source-kind': 'fixture',
  'as-of': '2026-09-04T13:00:00Z',
  'retrieved-at': '2026-09-04T13:00:00Z',
  completeness: /** @type {'complete'} */ ('complete'),
  freshness: /** @type {'fresh'} */ ('fresh'),
  availability: /** @type {'available'} */ ('available')
};

/** @param {Record<string, unknown>} [overrides] @returns {Record<string, unknown>} */
function rateLimitRow(overrides = {}) {
  return {
    'observation-id': 'run-1:after:reader:core:2026-09-04T12:00:00Z',
    'operation-execution-id': 'run-1',
    'observed-at': '2026-09-04T12:00:00Z',
    phase: 'after',
    operation: 'refresh-activity',
    credential: 'reader',
    resource: 'core',
    remaining: 4_875,
    limit: 5_000,
    used: 125,
    'remaining-percent': 97.5,
    'reset-at': '2026-09-04T13:00:00Z',
    'consumed-since-previous': 25,
    'attribution-status': 'available',
    'run-link': {
      relation: 'run',
      href: 'https://github.com/githubnext/gh-aw-cao/actions/runs/1',
      label: 'View run 1'
    },
    ...overrides
  };
}

/** @param {Array<Record<string, unknown>>} rows */
async function renderApiPage(rows) {
  const rendered = renderDashboard({
    document: dashboard,
    sources: {
      'github-api-rate-limits': {
        source: 'github-api-rate-limits',
        metadata,
        rows
      }
    }
  });
  rendered.ownerDocument.defaultView?.history.replaceState(null, '', '/');
  const link = /** @type {HTMLAnchorElement | null} */ (rendered.querySelector('[data-nav-page-id="github-api"]'));
  link?.click();
  await vi.waitFor(() => {
    expect(rendered.querySelector('[data-page-id="github-api"]')?.hasAttribute('data-page-pending')).toBe(false);
  });
  return rendered.querySelector('[data-page-id="github-api"]');
}

describe('GitHub API rate-limit dashboard', () => {
  it('defines one full-view lazy-list table of raw quota observations', () => {
    const apiPage = dashboard.dashboard.pages.find((/** @type {{ id: string }} */ page) => page.id === 'github-api');

    expect(apiPage).toMatchObject({
      kind: 'custom',
      title: 'GitHub API Rate Limits',
      icon: 'meter',
      views: [{
        id: 'github-api-observations',
        title: 'Raw quota observations',
        mark: 'table',
        controls: 'interactive',
        'lazy-list': true,
        layout: 'full-view',
        data: {
          source: 'github-api-rate-limits',
          'order-by': [
            { field: 'observed-at', direction: 'desc' },
            { field: 'resource', direction: 'asc' },
            { field: 'credential', direction: 'asc' }
          ]
        }
      }]
    });
    expect(apiPage.sections).toBeUndefined();
    expect(apiPage.views).toHaveLength(1);
    expect(apiPage.views[0].data.limit).toBeUndefined();
  });

  it('renders raw quota values and run links', async () => {
    const page = await renderApiPage([rateLimitRow()]);

    expect(page?.querySelector('[data-view-layout="full-view"]')).not.toBeNull();
    expect(page?.querySelector('[data-lazy-list]')).not.toBeNull();
    expect(page?.querySelector('tbody td:first-child a')?.getAttribute('href'))
      .toBe('https://github.com/githubnext/gh-aw-cao/actions/runs/1');
    expect(page?.textContent).toContain('Raw quota observations');
    expect(page?.textContent).toContain('4875');
    expect(page?.textContent).toContain('5000');
    expect(page?.textContent).toContain('available');
  });

  it('enables lazy-list rendering for high-cardinality observations', async () => {
    const rows = Array.from({ length: 1_000 }, (_, index) => rateLimitRow({
      'observation-id': `run-${index}:after:reader:resource-${index}`,
      'operation-execution-id': `run-${index}`,
      'observed-at': new Date(Date.parse('2026-09-04T12:00:00Z') - index * 60_000).toISOString(),
      operation: `operation-${index}`,
      resource: `resource-${index}`
    }));
    const page = await renderApiPage(rows);

    expect(page?.querySelectorAll('tbody tr').length).toBeGreaterThan(0);
    expect(page?.querySelector('[data-lazy-list]')).not.toBeNull();
  });

  it('exposes unavailable source state without fabricated quota values', async () => {
    const page = renderDashboard({
      document: dashboard,
      sources: {
        'github-api-rate-limits': {
          source: 'github-api-rate-limits',
          metadata: {
            ...metadata,
            completeness: 'partial',
            freshness: 'stale',
            availability: 'unavailable'
          },
          rows: []
        }
      }
    });
    const link = /** @type {HTMLAnchorElement | null} */ (page.querySelector('[data-nav-page-id="github-api"]'));
    link?.click();
    await vi.waitFor(() => {
      expect(page.querySelector('[data-page-id="github-api"]')?.textContent).toContain('This view is unavailable.');
    });

    expect(page.querySelector('[data-page-id="github-api"]')?.textContent).toContain('partial');
    expect(page.querySelector('[data-page-id="github-api"]')?.textContent).toContain('stale');
    expect(page.querySelector('[data-page-id="github-api"]')?.textContent).not.toContain('0.0 %');
  });
});
