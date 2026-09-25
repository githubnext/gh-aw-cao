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
        },
        campaigns: { source: 'campaigns', rows: [{ campaign: 'one' }], metadata },
        repositories: { source: 'repositories', rows: [{ repository: 'one' }], metadata },
        workflows: { source: 'workflows', rows: [{ workflow: 'one' }, { workflow: 'two' }], metadata },
        runs: { source: 'runs', rows: [{ run: 'one' }, { run: 'two' }, { run: 'three' }], metadata },
        domains: { source: 'domains', rows: [], metadata },
        tools: { source: 'tools', rows: [{ event: 'tool:one' }], metadata },
        audits: { source: 'audits', rows: [{ event: 'audit:one' }, { event: 'audit:two' }], metadata },
        issues: { source: 'issues', rows: [{ event: 'issue:one' }], metadata },
        'operational-values': { source: 'operational-values', rows: [], metadata }
      },
      ['indexing-daily-ingestion', 'indexing-database-table-counts']
    );

    expect(results['indexing-daily-ingestion'].rows).toEqual([
      { day: '2026-09-24', records: 20, 'workflow-runs': 5 }
    ]);
    expect(results['indexing-database-table-counts'].rows).toEqual([
      { table: 'ingestion transactions', records: 3 },
      { table: 'workflow runs', records: 3 },
      { table: 'audit events', records: 2 },
      { table: 'workflows', records: 2 },
      { table: 'campaigns', records: 1 },
      { table: 'issue events', records: 1 },
      { table: 'repositories', records: 1 },
      { table: 'tool events', records: 1 }
    ]);
    const tableLabels = results['indexing-database-table-counts'].rows.map((row) => row.table);
    expect(tableLabels).not.toContain('network domains');
    expect(tableLabels).not.toContain('operational values');
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
      .toEqual([{ field: 'records', direction: 'desc' }, { field: 'table', direction: 'asc' }]);
    expect(page.views[0].id).toBe('indexing-database-table-counts');
    expect(transactions).toMatchObject({
      mark: 'list',
      list: { style: 'entity-cards', card: 'ingestion-transaction' }
    });
    expect(transactions.controls).toBeUndefined();
    expect(card.details.map(/** @param {any} detail */ (detail) => detail.field))
      .toEqual(['created-at', 'committed-records', 'payload-hash']);
  });
});
