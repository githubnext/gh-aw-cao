// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { renderDashboard } from '../../src/presenter.js';

const dashboard = JSON.parse(readFileSync(`${process.cwd()}/dashboard.json`, 'utf8'));
const metadata = {
  'source-id': 'safe-output-items-fixture',
  'source-kind': 'fixture',
  'as-of': '2026-09-14T23:00:00Z',
  'retrieved-at': '2026-09-14T23:00:00Z',
  completeness: /** @type {'complete'} */ ('complete'),
  freshness: /** @type {'fresh'} */ ('fresh'),
  availability: /** @type {'available'} */ ('available')
};

/** @param {Record<string, unknown>[]} rows */
async function renderSafeOutputItemsPage(rows) {
  const rendered = renderDashboard({
    document: dashboard,
    sources: {
      'safe-output-items': { source: 'safe-output-items', metadata, rows }
    }
  });
  rendered.ownerDocument.defaultView?.history.replaceState(null, '', '/');
  const link = /** @type {HTMLAnchorElement | null} */ (
    rendered.querySelector('[data-nav-page-id="safe-output-items"]')
  );
  link?.click();
  await vi.waitFor(() => {
    expect(rendered.querySelector('[data-page-id="safe-output-items"]')
      ?.hasAttribute('data-page-pending')).toBe(false);
  });
  return rendered.querySelector('[data-page-id="safe-output-items"]');
}

describe('safe-output items dashboard', () => {
  it('defines an experimental interactive full-view lazy-list table', () => {
    const page = dashboard.dashboard.pages.find(
      (/** @type {{ id?: string }} */ candidate) => candidate.id === 'safe-output-items'
    );
    const query = dashboard.dashboard.queries.find(
      (/** @type {{ name?: string }} */ candidate) => candidate.name === 'safe-output-items'
    );
    expect(dashboard.dashboard.navigation.find(
      (/** @type {{ label?: string }} */ section) => section.label === 'Explore'
    )).toMatchObject({ experimental: true, pages: expect.arrayContaining(['safe-output-items']) });
    expect(page).toMatchObject({
      kind: 'custom',
      views: [{
        id: 'safe-output-item-events',
        mark: 'table',
        controls: 'interactive',
        'lazy-list': true,
        layout: 'full-view',
        data: { source: 'safe-output-items' }
      }]
    });
    expect(query).toMatchObject({
      from: 'events',
      filter: { predicates: [{ field: 'event-type', equals: 'safe_output.created' }] }
    });
  });

  describe('issues dashboard', () => {
    it('defines an experimental issue-style card list from safe-output item events', () => {
      const page = dashboard.dashboard.pages.find(
        (/** @type {{ id?: string }} */ candidate) => candidate.id === 'issues'
      );
      const query = dashboard.dashboard.queries.find(
        (/** @type {{ name?: string }} */ candidate) => candidate.name === 'issues'
      );
      const view = dashboard.dashboard.views.find(
        (/** @type {{ id?: string }} */ candidate) => candidate.id === 'issues'
      );

      expect(dashboard.dashboard.navigation.find(
        (/** @type {{ label?: string }} */ section) => section.label === 'Explore'
      )).toMatchObject({ experimental: true, pages: expect.arrayContaining(['issues']) });
      expect(page).toMatchObject({
        kind: 'built-in',
        page: 'issues',
        definition: {
          views: ['issues']
        }
      });
      expect(view).toMatchObject({
        id: 'issues',
        title: 'Issues',
        mark: 'list',
        list: {
          style: 'entity-cards',
          card: 'issue',
          drill: { type: 'external', field: 'entity-url' }
        },
        data: {
          source: 'issues'
        }
      });
      expect(query).toMatchObject({
        from: 'safe-output-items',
        filter: { predicates: [{ field: 'github-entity-type', equals: 'issue' }] }
      });
    });

    it('renders issue safe-output items as GitHub-like issue rows', async () => {
      const rendered = renderDashboard({
        document: dashboard,
        sources: {
          issues: {
            source: 'issues',
            metadata,
            rows: [{
              'observed-at': '2026-09-14T22:00:00Z',
              'github-entity-type': 'issue',
              'event-summary': 'Investigate failing compiler run',
              'entity-url': 'https://github.com/githubnext/gh-aw-cao/issues/42',
              'safe-output-type': 'create_issue',
              repository: 'gh-aw-cao',
              workflow: '.github/workflows/dashboard.md',
              run: '303',
              'run-link': {
                relation: 'run',
                href: 'https://github.com/githubnext/gh-aw-cao/actions/runs/303',
                label: 'View run 303'
              }
            }]
          }
        }
      });
      rendered.ownerDocument.defaultView?.history.replaceState(null, '', '/');
      const link = /** @type {HTMLAnchorElement | null} */ (
        rendered.querySelector('[data-nav-page-id="issues"]')
      );
      link?.click();
      await vi.waitFor(() => {
        expect(rendered.querySelector('[data-page-id="issues"]')
          ?.hasAttribute('data-page-pending')).toBe(false);
      });
      const page = rendered.querySelector('[data-page-id="issues"]');

      expect(page?.querySelector('[data-view-layout="full-view"]')).not.toBeNull();
      expect(page?.querySelector('.issue-list-card-title a')?.getAttribute('href'))
        .toBe('https://github.com/githubnext/gh-aw-cao/issues/42');
      expect(page?.querySelector('.issue-list-labels')?.textContent).toContain('create_issue');
      expect(page?.textContent).toContain('Investigate failing compiler run');
    });
  });

  it('renders entity type, action, and run provenance', async () => {
    const page = await renderSafeOutputItemsPage([{
      'observed-at': '2026-09-14T22:00:00Z',
      'github-entity-type': 'pull_request',
      'safe-output-type': 'create_pull_request',
      'event-summary': 'create_pull_request/githubnext/gh-aw-cao/43',
      'entity-url': 'https://github.com/githubnext/gh-aw-cao/pull/43',
      repository: 'gh-aw-cao',
      workflow: '.github/workflows/dashboard.md',
      run: '303',
      'run-link': {
        relation: 'run',
        href: 'https://github.com/githubnext/gh-aw-cao/actions/runs/303',
        label: 'View run 303'
      }
    }]);

    expect(page?.querySelector('[data-view-layout="full-view"]')).not.toBeNull();
    expect(page?.querySelector('[data-lazy-list]')).not.toBeNull();
    expect(page?.querySelector('[data-table-filter]')).not.toBeNull();
    expect(page?.textContent).toContain('pull_request');
    expect(page?.textContent).toContain('create_pull_request');
    expect(page?.querySelector('tbody td:first-child a')?.getAttribute('href'))
      .toBe('https://github.com/githubnext/gh-aw-cao/actions/runs/303');
  });
});
