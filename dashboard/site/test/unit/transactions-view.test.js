import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const dashboard = JSON.parse(readFileSync(`${process.cwd()}/dashboard.json`, 'utf8'));

describe('Transactions view', () => {
  it('declares one full-view table backed by the canonical transactions source', () => {
    const page = dashboard.dashboard.pages.find((candidate) => candidate.id === 'transactions');

    expect(page.views).toHaveLength(1);
    expect(page.views[0]).toMatchObject({
      id: 'transactions-table',
      mark: 'table',
      layout: 'full-view',
      controls: 'interactive',
      data: { source: 'transactions' }
    });
  });
});
