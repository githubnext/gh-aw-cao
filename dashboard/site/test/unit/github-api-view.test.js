// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { renderDashboard } from '../../src/presenter.js';

const dashboard = JSON.parse(readFileSync(`${process.cwd()}/dashboard.json`, 'utf8'));
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
function githubApiEvent(overrides = {}) {
  return {
    'observed-at': '2026-09-04T12:00:00Z',
    'event-type': 'github-api.response',
    'event-summary': 'GET /rate_limit',
    'event-status': '200',
    organization: 'githubnext',
    repository: 'gh-aw-cao',
    workflow: '.github/workflows/dashboard.md',
    run: '1',
    'correlation-id': 'request-1',
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
      'github-api-events': {
        source: 'github-api-events',
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

describe('GitHub API event dashboard', () => {
  it('defines one declarative full-view lazy-list table of canonical events', () => {
    const apiPage = dashboard.dashboard.pages.find((/** @type {{ id: string }} */ page) => page.id === 'github-api');

    expect(apiPage).toMatchObject({
      kind: 'custom',
      title: 'GitHub API',
      icon: 'meter',
      views: [{
        id: 'github-api-observations',
        title: 'GitHub API events',
        mark: 'table',
        controls: 'interactive',
        'lazy-list': true,
        layout: 'full-view',
        data: {
          source: 'github-api-events',
          'order-by': [
            { field: 'observed-at', direction: 'desc' }
          ]
        }
      }]
    });
    expect(apiPage.sections).toBeUndefined();
    expect(apiPage.views).toHaveLength(1);
    expect(apiPage.views[0].data.limit).toBeUndefined();
    expect(dashboard.dashboard.queries).toContainEqual(expect.objectContaining({
      name: 'github-api-events',
      from: 'events',
      filter: { predicates: [{ field: 'event-type', includes: 'github-api.' }] }
    }));
  });

  it('renders API event context and run links', async () => {
    const page = await renderApiPage([githubApiEvent()]);

    expect(page?.querySelector('[data-view-layout="full-view"]')).not.toBeNull();
    expect(page?.querySelector('[data-lazy-list]')).not.toBeNull();
    expect(page?.querySelector('tbody td:first-child a')?.getAttribute('href'))
      .toBe('https://github.com/githubnext/gh-aw-cao/actions/runs/1');
    expect(page?.textContent).toContain('GitHub API events');
    expect(page?.textContent).toContain('github-api.response');
    expect(page?.textContent).toContain('GET /rate_limit');
    expect(page?.textContent).toContain('request-1');
  });

  it('enables lazy-list rendering for high-cardinality observations', async () => {
    const rows = Array.from({ length: 1_000 }, (_, index) => githubApiEvent({
      'observed-at': new Date(Date.parse('2026-09-04T12:00:00Z') - index * 60_000).toISOString(),
      'event-summary': `request-${index}`,
      'correlation-id': `correlation-${index}`
    }));
    const page = await renderApiPage(rows);

    expect(page?.querySelectorAll('tbody tr').length).toBeGreaterThan(0);
    expect(page?.querySelector('[data-lazy-list]')).not.toBeNull();
  });

  it('exposes unavailable source state without fabricated quota values', async () => {
    const page = renderDashboard({
      document: dashboard,
      sources: {
        'github-api-events': {
          source: 'github-api-events',
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
      expect(page.querySelector('[data-page-id="github-api"]')?.textContent).toContain('This view cannot be shown because its data source is unavailable.');
    });

    expect(page.querySelector('[data-page-id="github-api"]')?.textContent).toContain('partial');
    expect(page.querySelector('[data-page-id="github-api"]')?.textContent).toContain('stale');
    expect(page.querySelector('[data-page-id="github-api"]')?.textContent).not.toContain('0.0 %');
  });
});
