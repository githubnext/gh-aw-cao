import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it } from 'vitest';
import { processDataRequest } from '../../src/data-worker.js';
import { createDashboardQueryBudget, executeDashboardQueries, resolveDashboardQuerySources } from '../../src/data/queries/declarative.js';
import { compileDashboardViewPayloadQueries } from '../../src/data/queries/view-payload-compiler.js';
import { DATABASE_NAME } from '../../src/data/storage/indexeddb.js';
import { authoritativeDashboard } from '../authoritative-dashboard.js';
import contract from '../fixtures/workflow-list-contract.json' with { type: 'json' };

const dashboard = authoritativeDashboard.dashboard;
/** @type {import('../../src/data/queries/declarative.js').DashboardQuery[]} */
const queries = dashboard.queries;
const page = dashboard.pages.find((/** @type {{ id: string }} */ candidate) => candidate.id === contract.page);
const metadata = {
  'source-id': 'workflow-list-fixture', 'source-kind': 'fixture',
  'as-of': '2026-10-07T13:00:00Z', 'retrieved-at': '2026-10-07T13:00:00Z',
  availability: /** @type {const} */ ('available'),
  completeness: /** @type {const} */ ('complete'),
  freshness: /** @type {const} */ ('fresh')
};

/** @param {string} source @param {Record<string, unknown>[]} rows */
function input(source, rows) {
  return { source, rows, metadata };
}

/** @param {number} [history] */
function evidence(history = 2) {
  const workflows = contract.cases.map((row) => ({
    organization: 'org', repository: row.repository.split('/')[1],
    workflow: row.workflow, 'workflow-name': row.workflow,
    'workflow-role': 'standalone', 'workflow-active': 'true', 'rollout-mode': 'review'
  }));
  const runs = [
    { repository: 'other', workflow: 'worker.md', run: '400', 'created-at': '2026-10-07T12:30:00Z', 'run-status': 'queued' },
    { repository: 'control', workflow: 'worker.md', run: '10', 'run-attempt': 2, 'started-at': '2026-10-07T12:00:00Z', 'run-status': 'in-progress' },
    { repository: 'control', workflow: 'worker.md', run: '10', 'run-attempt': 1, 'started-at': '2026-10-06T12:00:00Z', 'run-status': 'completed', 'run-conclusion': 'failure' },
    { repository: 'control', workflow: 'worker.md', run: '100', 'started-at': '2026-10-06T13:00:00Z', 'run-status': 'completed', 'run-conclusion': 'success' },
    { repository: 'control', workflow: 'failed.md', run: '300', 'started-at': '2026-10-07T11:00:00Z', 'run-status': 'completed', 'run-conclusion': 'failure' },
    { repository: 'control', workflow: 'successful.md', run: '200', 'started-at': '2026-10-07T10:00:00Z', 'run-status': 'completed', 'run-conclusion': 'success' },
    ...Array.from({ length: history }, (_, index) => ({
      repository: 'control', workflow: 'worker.md', run: String(1000 + index),
      'started-at': '2026-10-01T00:00:00Z', 'run-status': 'completed', 'run-conclusion': 'success'
    }))
  ].map((row) => ({ organization: 'org', 'run-attempt': 1, ...row }));
  return {
    repositories: input('repositories', [
      { organization: 'org', repository: 'control' },
      { organization: 'org', repository: 'other' }
    ]),
    workflows: input('workflows', workflows), runs: input('runs', runs)
  };
}

/** @param {number} [history] */
async function canonical(history) {
  const sources = evidence(history);
  return /** @type {Record<string, import('../../src/presenter.js').LogicalSourceInput>} */ (
    await processDataRequest({
      operation: 'load-dashboard-query-sources', sources, ingest: true,
      sourceNames: Object.keys(sources), queries: []
    })
  );
}

/** @param {Record<string, import('../../src/presenter.js').LogicalSourceInput>} sources @param {Record<string, unknown>} [queryContext] */
function viewPayload(sources, queryContext = {}) {
  const compiled = compileDashboardViewPayloadQueries(page, contract.page, {
    queries, viewId: contract.view, queryContext
  });
  const result = /** @type {Record<string, import('../../src/presenter.js').LogicalSourceInput>} */ (processDataRequest({
    operation: 'execute-dashboard-queries', sources,
    queries: [...queries, ...compiled.queries], sourceNames: compiled.aliases
  }));
  return result[compiled.aliases[0]];
}

beforeEach(async () => {
  await new Promise((resolve, reject) => {
    const request = indexedDB.deleteDatabase(DATABASE_NAME);
    request.onsuccess = () => resolve(undefined);
    request.onerror = () => reject(request.error);
  });
});

describe('workflow list query contract', () => {
  it('lists every declared workflow in stable order through the canonical worker boundary', async () => {
    const payload = viewPayload(await canonical());
    expect(payload.metadata.availability).toBe('available');
    expect(payload.rows.map((row) => ({
      repository: row.repository, workflow: row.workflow
    }))).toEqual(contract.cases);
    for (const row of payload.rows) {
      for (const field of contract.fields) {
        expect(row).toHaveProperty(field);
      }
      expect(row['workflow-link']).toMatchObject({
        'dashboard-href': `#page-${contract.drillPage}?workflow=${encodeURIComponent(String(row['workflow-label']))}`
      });
      expect(row).not.toHaveProperty('successful-runs');
      expect(row).not.toHaveProperty('failed-runs');
      expect(row).not.toHaveProperty('latest-run-status');
      expect(row).not.toHaveProperty('latest-run-at');
      expect(row).not.toHaveProperty('ingestion');
    }
  });

  it('does not depend on retained run history', async () => {
    const sources = await canonical();
    const payload = viewPayload({ ...sources, runs: { ...sources.runs, rows: [] } });
    expect(payload.rows.map((row) => ({ repository: row.repository, workflow: row.workflow }))).toEqual(contract.cases);
  });

  it('keeps inventory available when runs are unavailable and fails closed when inventory is unavailable', async () => {
    const sources = await canonical();
    const missingRuns = viewPayload({
      ...sources, runs: { ...sources.runs, rows: [], metadata: { ...metadata, availability: 'unavailable' } }
    });
    expect(missingRuns.metadata.availability).toBe('available');
    expect(missingRuns.rows).toHaveLength(contract.cases.length);
    const missingInventory = viewPayload({
      ...sources, workflows: { ...sources.workflows, metadata: { ...metadata, availability: 'unavailable' } }
    });
    expect(missingInventory.metadata.availability).toBe('unavailable');
    expect(missingInventory.rows).toEqual([]);
  });

  it('reads only workflow declarations and reduces original inventory query operations by at least 75 percent', async () => {
    const sources = await canonical(200);
    expect(resolveDashboardQuerySources(queries, ['workflow-list']).filter((name) => Object.hasOwn(sources, name)).sort())
      .toEqual(['workflows']);
    const before = createDashboardQueryBudget();
    const after = createDashboardQueryBudget();
    expect(executeDashboardQueries(queries, sources, ['workflow-inventory'], { budget: before })['workflow-inventory'].rows)
      .toHaveLength(contract.cases.length);
    const result = executeDashboardQueries(queries, sources, ['workflow-list'], { budget: after })['workflow-list'];
    expect(result.rows).toHaveLength(contract.cases.length);
    expect(result.metadata.availability).toBe('available');
    expect(after.operations).toBeLessThan(before.operations * 0.25);
  }, 30000);
});
