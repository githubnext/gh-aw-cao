import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { executeDashboardQueries } from '../../src/data/queries/declarative.js';

const dashboard = /** @type {Record<string, any>} */ (
  JSON.parse(readFileSync(`${process.cwd()}/dashboard.json`, 'utf8')).dashboard
);
const metadata = {
  'source-id': 'indexing-contract',
  'source-kind': 'fixture',
  'as-of': '2026-09-24T00:00:00Z',
  'retrieved-at': '2026-09-24T00:00:00Z',
  completeness: /** @type {'complete'} */ ('complete'),
  freshness: /** @type {'fresh'} */ ('fresh'),
  availability: /** @type {'available'} */ ('available')
};

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
            },
            {
              id: 'ingest-dashboard-sources:three',
              kind: 'ingest-dashboard-sources',
              createdAt: '2026-09-24T02:00:00Z',
              records: 99,
              rawRuns: 99
            }
          ],
          metadata
        }
      },
      ['indexing-daily-ingestion', 'indexing-database-table-counts']
    );

    expect(results['indexing-daily-ingestion'].rows).toEqual([
      { day: '2026-09-24', records: 20, 'workflow-runs': 5 }
    ]);
    expect(results['indexing-database-table-counts'].rows).toEqual([
      { kind: 'ingest-normalized-jsonl', transactions: 2 },
      { kind: 'ingest-dashboard-sources', transactions: 1 }
    ]);
  });

  it('uses a sorted horizontal count chart and focused transaction cards without a table facet', () => {
    const page = dashboard.pages.find(/** @param {any} page */ (page) => page.id === 'indexing');
    const countChart = page.views.find(/** @param {any} view */ (view) => view.id === 'indexing-database-table-counts');
    const transactions = page.views.find(/** @param {any} view */ (view) => view.id === 'transaction-entries');
    const card = dashboard['card-templates'].find(/** @param {any} template */ (template) => template.id === 'ingestion-transaction');

    expect(countChart).toMatchObject({
      mark: 'chart',
      chart: 'horizontal-bar',
      data: { source: 'indexing-database-table-counts' }
    });
    expect(dashboard.queries.find(/** @param {any} query */ (query) => query.name === 'indexing-database-table-counts')['order-by'])
      .toEqual([{ field: 'transactions', direction: 'desc' }]);
    expect(transactions).toMatchObject({
      mark: 'list',
      list: { style: 'entity-cards', card: 'ingestion-transaction' }
    });
    expect(transactions.controls).toBeUndefined();
    expect(card.details.map(/** @param {any} detail */ (detail) => detail.field))
      .toEqual(['created-at', 'committed-records', 'payload-hash']);
  });
});
