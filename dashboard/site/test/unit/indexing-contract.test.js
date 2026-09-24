import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { executeDashboardQueries } from '../../src/data/queries/declarative.js';

const dashboard = JSON.parse(readFileSync(`${process.cwd()}/dashboard.json`, 'utf8')).dashboard;

describe('indexing dashboard', () => {
  it('projects normalized ingestion transactions into non-empty insights', () => {
    const results = executeDashboardQueries(
      dashboard.queries,
      {
        transactions: {
          source: 'transactions',
          rows: [
            {
              id: 'ingest-normalized-jsonl:one',
              kind: 'ingest-normalized-jsonl',
              createdAt: '2026-09-24T00:00:00Z',
              records: 12,
              rawRuns: 3
            },
            {
              id: 'ingest-normalized-jsonl:two',
              kind: 'ingest-normalized-jsonl',
              createdAt: '2026-09-24T01:00:00Z',
              records: 8,
              rawRuns: 2
            }
          ],
          metadata: {}
        }
      },
      ['indexing-daily-ingestion', 'indexing-database-table-counts']
    );

    expect(results['indexing-daily-ingestion'].rows).toEqual([
      { day: '2026-09-24', records: 20, 'workflow-runs': 5 }
    ]);
    expect(results['indexing-database-table-counts'].rows).toEqual([
      { kind: 'ingest-normalized-jsonl', transactions: 2 }
    ]);
  });

  it('uses a sorted horizontal count chart and focused transaction cards without a table facet', () => {
    const page = dashboard.pages.find((page) => page.id === 'indexing');
    const countChart = page.views.find((view) => view.id === 'indexing-database-table-counts');
    const transactions = page.views.find((view) => view.id === 'transaction-entries');
    const card = dashboard['card-templates'].find((template) => template.id === 'ingestion-transaction');

    expect(countChart).toMatchObject({
      mark: 'chart',
      chart: 'horizontal-bar',
      data: { source: 'indexing-database-table-counts' }
    });
    expect(dashboard.queries.find((query) => query.name === 'indexing-database-table-counts')['order-by'])
      .toEqual([{ field: 'transactions', direction: 'desc' }]);
    expect(transactions).toMatchObject({
      mark: 'list',
      list: { style: 'entity-cards', card: 'ingestion-transaction' }
    });
    expect(transactions.controls).toBeUndefined();
    expect(card.details.map((detail) => detail.field))
      .toEqual(['created-at', 'committed-records', 'payload-hash']);
  });
});
