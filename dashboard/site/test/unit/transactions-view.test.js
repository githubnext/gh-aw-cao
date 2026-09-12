import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const fixtureDirectory = dirname(fileURLToPath(import.meta.url));
const authoritativeDashboard = JSON.parse(
  readFileSync(resolve(fixtureDirectory, '../../dashboard.json'), 'utf8')
);

describe('Transactions dashboard view', () => {
  it('defines one full-view interactive transaction table outside sidebar navigation', () => {
    const transactionsPage = authoritativeDashboard.dashboard.pages.find(
      (/** @type {{ id: string }} */ page) => page.id === 'transactions'
    );
    const navigationPages = authoritativeDashboard.dashboard.navigation.flatMap(
      (/** @type {{ pages: string[] }} */ section) => section.pages
    );

    expect(transactionsPage).toMatchObject({
      id: 'transactions',
      kind: 'custom',
      title: 'Transactions'
    });
    expect(transactionsPage.sections).toBeUndefined();
    expect(transactionsPage.views).toEqual([
      expect.objectContaining({
        id: 'transactions-table',
        mark: 'table',
        controls: 'interactive',
        'lazy-list': true,
        layout: 'full-view'
      })
    ]);
    expect(navigationPages).not.toContain('transactions');
  });
});
