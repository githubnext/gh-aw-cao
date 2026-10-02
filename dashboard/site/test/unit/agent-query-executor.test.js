import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it } from 'vitest';

import {
  DEFAULT_NAMED_QUERY_LIMIT,
  MAX_NAMED_QUERY_LIMIT,
  MAX_NAMED_QUERY_PARAMETERS,
  NamedQueryError,
  executeNamedQuery
} from '../../src/agent/query-executor.js';
import { loadDatabaseQuerySources } from '../../src/data/queries/database.js';
import { DATABASE_NAME } from '../../src/data/storage/indexeddb.js';
import { authoritativeDashboard } from '../authoritative-dashboard.js';

const simulatorInputs = {
  repositories: 2,
  'runs-per-day': 3,
  'tools-per-run': 4,
  'issues-per-run': 1,
  'skip-rate': 50
};

it('executes bounded parameterized simulator queries without an IndexedDB source', async () => {
  const result = await executeNamedQuery({
    indexedDB,
    document: authoritativeDashboard,
    queryId: 'simulator-database-summary',
    parameters: simulatorInputs
  });
  expect(result.rows).toHaveLength(4);
  expect(result.rows[0]).toMatchObject({ table: 'Run summaries', bytes: 92_160 });
  expect(result.rows[1]).toMatchObject({ table: 'Tools (30-day TTL)', bytes: 92_160 });
  expect(result.rows[3]).toMatchObject({ table: 'Total', bytes: 230_400 });
  expect(result.metadata.parameters).toEqual(simulatorInputs);
});

it('rejects omitted, unknown and out-of-range simulator operands', async () => {
  for (const parameters of [
    {},
    { ...simulatorInputs, repositories: 100001 },
    { ...simulatorInputs, repositories: '2' },
    { ...simulatorInputs, 'skip-rate': 'Infinity' },
    { ...simulatorInputs, unknown: 1 }
  ]) {
    await expect(executeNamedQuery({
      indexedDB, document: authoritativeDashboard,
      queryId: 'simulator-database-summary', parameters
    })).rejects.toThrow(NamedQueryError);
  }
});

const metadata = { 'as-of': '2026-09-09T05:00:00Z', 'artifact-generation': 'generation-a' };

/** @param {number} count */
function runRows(count) {
  return Array.from({ length: count }, (unused, index) => ({
    organization: 'githubnext',
    repository: index % 2 === 0 ? 'gh-aw-cao' : 'other',
    workflow: '.github/workflows/dashboard.md',
    run: String(index + 1),
    'run-attempt': 1,
    'run-status': 'completed',
    'run-conclusion': index % 3 === 0 ? 'failure' : 'success',
    'started-at': `2026-09-09T04:0${index % 10}:00Z`,
    'rollout-mode': 'review'
  }));
}

/** @param {number} count */
function fixtureSources(count) {
  const repositories = ['gh-aw-cao', 'other'];
  return {
    runs: { rows: runRows(count), metadata },
    campaigns: { rows: [], metadata },
    repositories: {
      rows: repositories.map((repository) => ({
        organization: 'githubnext',
        repository,
        'rollout-mode': 'review'
      })),
      metadata
    },
    workflows: {
      rows: repositories.map((repository) => ({
        organization: 'githubnext',
        repository,
        workflow: '.github/workflows/dashboard.md',
        'workflow-name': 'Dashboard',
        'workflow-role': 'worker',
        'rollout-mode': 'review'
      })),
      metadata
    },
    tools: { rows: [], metadata },
    audits: { rows: [], metadata },
    domains: { rows: [], metadata },
    issues: { rows: [], metadata }
  };
}

const document = {
  dashboard: {
    id: 'test',
    title: 'Test dashboard',
    navigation: [{ pages: ['runs'] }],
    queries: [
      { name: 'all-runs', subject: 'Show every run.', from: 'runs' },
      {
        name: 'failed-runs',
        subject: 'Show failed runs.',
        from: 'all-runs',
        filter: { predicates: [{ field: 'run-conclusion', equals: 'failure' }] }
      },
      { name: 'browser-only', subject: 'Read a browser source.', from: 'work-items' }
    ],
    pages: [
      {
        id: 'runs',
        title: 'Runs',
        views: [
          {
            id: 'runs-table',
            data: {
              source: 'all-runs',
              arguments: [{ name: 'repository', field: 'repository' }]
            }
          },
          { id: 'failures', data: { source: 'failed-runs' } }
        ]
      }
    ]
  }
};

/** @param {number} [count] */
async function ingest(count = 12) {
  await new Promise((resolve, reject) => {
    const request = indexedDB.deleteDatabase(DATABASE_NAME);
    request.onsuccess = () => resolve(undefined);
    request.onerror = () => reject(request.error);
  });
  await loadDatabaseQuerySources(indexedDB, fixtureSources(count), { ingest: true });
}

/** @param {Record<string, any>} request */
function execute(request) {
  return executeNamedQuery(/** @type {any} */ ({ indexedDB, document, ...request }));
}

describe('named query execution', () => {
  beforeEach(async () => {
    await ingest();
  });

  it('executes a reviewed query and reports its identity', async () => {
    const result = await execute({ queryId: 'all-runs' });
    expect(result.query).toBe('all-runs');
    expect(result.rows).toHaveLength(12);
    expect(result.metadata.availability).toBe('available');
    expect(result.metadata['returned-rows']).toBe(12);
    expect(result.metadata.limit).toBe(DEFAULT_NAMED_QUERY_LIMIT);
  });

  it('preserves the declarative filter of the reviewed query', async () => {
    const result = await execute({ queryId: 'failed-runs' });
    expect(result.rows.length).toBeGreaterThan(0);
    expect(result.rows.every((row) => row['run-conclusion'] === 'failure')).toBe(true);
  });

  it('narrows rows with declared parameters', async () => {
    const result = await execute({
      queryId: 'all-runs',
      parameters: { repository: 'gh-aw-cao' }
    });
    expect(result.rows.every((row) => row.repository === 'gh-aw-cao')).toBe(true);
    expect(result.rows).toHaveLength(6);
    expect(result.metadata.parameters).toEqual({ repository: 'gh-aw-cao' });
  });

  it('reports an empty result as empty rather than unavailable', async () => {
    const result = await execute({
      queryId: 'all-runs',
      parameters: { repository: 'never-ingested' }
    });
    expect(result.rows).toEqual([]);
    expect(result.metadata.availability).toBe('empty');
  });

  it('bounds results and reports truncation as partial completeness', async () => {
    const result = await execute({ queryId: 'all-runs', limit: 5 });
    expect(result.rows).toHaveLength(5);
    expect(result.metadata.limit).toBe(5);
    expect(result.metadata.completeness).toBe('partial');
  });

  it('does not report truncation when every matching row fits', async () => {
    const result = await execute({ queryId: 'all-runs', limit: 12 });
    expect(result.rows).toHaveLength(12);
    expect(result.metadata.completeness).not.toBe('partial');
  });

  it('caps an oversized limit at the documented maximum', async () => {
    const result = await execute({ queryId: 'all-runs', limit: MAX_NAMED_QUERY_LIMIT * 10 });
    expect(result.metadata.limit).toBe(MAX_NAMED_QUERY_LIMIT);
  });

  it('always reports freshness and as-of alongside rows', async () => {
    const result = await execute({ queryId: 'all-runs' });
    expect(result.metadata).toHaveProperty('freshness');
    expect(result.metadata).toHaveProperty('as-of');
    expect(result.metadata).toHaveProperty('completeness');
  });

  it('refuses a query that the local projection cannot materialize', async () => {
    const result = await execute({ queryId: 'browser-only' });
    expect(result.rows).toEqual([]);
    expect(result.metadata.availability).toBe('unavailable');
    expect(result.metadata['query-diagnostic']).toMatch(/work-items/);
  });

  it('rejects an unknown query identifier', async () => {
    await expect(execute({ queryId: 'nope' })).rejects.toThrow(NamedQueryError);
  });

  it('rejects an empty query identifier', async () => {
    await expect(execute({ queryId: '   ' })).rejects.toThrow(NamedQueryError);
  });

  it('rejects an undeclared parameter', async () => {
    await expect(execute({
      queryId: 'all-runs',
      parameters: { workflow: '.github/workflows/dashboard.md' }
    })).rejects.toThrow(/Unknown parameter/);
  });

  it('rejects parameters that are not an object', async () => {
    await expect(execute({ queryId: 'all-runs', parameters: ['repository'] }))
      .rejects.toThrow(NamedQueryError);
  });

  it('rejects a non-scalar parameter value', async () => {
    await expect(execute({ queryId: 'all-runs', parameters: { repository: { nested: true } } }))
      .rejects.toThrow(/string, number, or boolean/);
  });

  it('rejects more parameters than the documented bound', async () => {
    const parameters = Object.fromEntries(
      Array.from({ length: MAX_NAMED_QUERY_PARAMETERS + 1 }, (unused, index) => [`p${index}`, 'x'])
    );
    await expect(execute({ queryId: 'all-runs', parameters }))
      .rejects.toThrow(/At most/);
  });

  it('rejects a limit that is not a positive integer', async () => {
    await expect(execute({ queryId: 'all-runs', limit: 0 })).rejects.toThrow(NamedQueryError);
    await expect(execute({ queryId: 'all-runs', limit: 2.5 })).rejects.toThrow(NamedQueryError);
    await expect(execute({ queryId: 'all-runs', limit: -3 })).rejects.toThrow(NamedQueryError);
  });

  it('never executes SQL or an unreviewed query definition', async () => {
    await expect(execute({ queryId: 'select * from runs' })).rejects.toThrow(NamedQueryError);
    await expect(execute({ queryId: JSON.stringify({ name: 'x', from: 'runs' }) }))
      .rejects.toThrow(NamedQueryError);
  });

  it('stops before returning rows when the caller cancels', async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(execute({ queryId: 'all-runs', signal: controller.signal })).rejects.toThrow();
  });

  it('returns the same rows for the same request', async () => {
    const first = await execute({ queryId: 'failed-runs' });
    const second = await execute({ queryId: 'failed-runs' });
    expect(second.rows).toEqual(first.rows);
  });
});
