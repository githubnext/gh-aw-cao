import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';

const dashboardDocument = JSON.parse(readFileSync(`${process.cwd()}/dashboard.json`, 'utf8'));

describe('data health view', () => {
  it('declares one full-view table over the database table inventory query', () => {
    const page = dashboardDocument.dashboard.pages.find(({ id }) => id === 'data-health');
    const query = dashboardDocument.dashboard.queries.find(({ name }) => name === 'database-table-inventory');

    expect(page?.views).toEqual([
      expect.objectContaining({
        id: 'database-table-inventory',
        data: { source: 'database-table-inventory' },
        mark: 'table',
        controls: 'interactive',
        layout: 'full-view',
        'lazy-list': true
      })
    ]);
    expect(query).toMatchObject({
      from: 'database-tables',
      select: [
        { field: 'table' },
        { field: 'records' },
        { field: 'indexes' },
        { field: 'primary-key' },
        { field: 'generation' },
        { field: 'schema-version' },
        { field: 'database-version' }
      ]
    });
    expect(JSON.stringify(dashboardDocument)).not.toContain('"source":"data-health-');
  });
});
