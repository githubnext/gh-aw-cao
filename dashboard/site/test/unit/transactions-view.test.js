// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { renderDashboard } from '../../src/presenter.js';

const dashboard = JSON.parse(readFileSync(`${process.cwd()}/dashboard.json`, 'utf8'));
const metadata = {
  'source-id': 'transactions-fixture',
  'source-kind': 'fixture',
  'as-of': '2026-09-11T14:00:00Z',
  'retrieved-at': '2026-09-11T14:00:00Z',
  completeness: /** @type {'complete'} */ ('complete'),
  freshness: /** @type {'fresh'} */ ('fresh'),
  availability: /** @type {'available'} */ ('available')
};

describe('Transactions dashboard', () => {
  it('defines one declarative full-view interactive table in Data', () => {
    const transactionsPage = dashboard.dashboard.pages.find(
      (/** @type {{ id: string }} */ page) => page.id === 'transactions'
    );
    const dataNavigation = dashboard.dashboard.navigation.find(
      (/** @type {{ label?: string }} */ section) => section.label === 'Data'
    );

    expect(transactionsPage).toMatchObject({
      kind: 'custom',
      title: 'Transactions',
      icon: 'database',
      views: [{
        id: 'transaction-inspection',
        mark: 'table',
        controls: 'interactive',
        'lazy-list': true,
        layout: 'full-view',
        data: {
          source: 'transactions',
          'order-by': [{ field: 'created-at', direction: 'desc' }]
        }
      }]
    });
    expect(transactionsPage.views).toHaveLength(1);
    expect(dataNavigation.pages).toContain('transactions');
  });

  it('renders collection context and links to the activity run', async () => {
    const rendered = renderDashboard({
      document: dashboard,
      sources: {
        transactions: {
          source: 'transactions',
          metadata,
          rows: [{
            transaction: 'activity-collection:githubnext/gh-aw-cao:303:1',
            'transaction-kind': 'activity-collection',
            'created-at': '2026-09-11T14:00:00Z',
            status: 'collected',
            repository: 'githubnext/gh-aw-cao',
            workflow: '.github/workflows/activity.yml',
            run: '303',
            'run-attempt': 1,
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
      rendered.querySelector('[data-nav-page-id="transactions"]')
    );
    link?.click();
    await vi.waitFor(() => {
      expect(rendered.querySelector('[data-page-id="transactions"]')?.hasAttribute('data-page-pending')).toBe(false);
    });

    const page = rendered.querySelector('[data-page-id="transactions"]');
    expect(page?.querySelector('[data-view-layout="full-view"]')).not.toBeNull();
    expect(page?.querySelector('[data-lazy-list]')).not.toBeNull();
    expect(page?.querySelector('tbody td:first-child a')?.getAttribute('href'))
      .toBe('https://github.com/githubnext/gh-aw-cao/actions/runs/303');
    expect(page?.textContent).toContain('activity-collection');
    expect(page?.textContent).toContain('.github/workflows/activity.yml');
  });
});
