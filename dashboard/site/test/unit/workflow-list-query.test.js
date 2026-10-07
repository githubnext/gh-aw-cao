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
  const events = runs.flatMap((run, index) => Array.from({ length: 4 }, (_, event) => ({
    organization: run.organization, repository: run.repository, workflow: run.workflow,
    run: run.run, 'run-attempt': run['run-attempt'], event: `${index}-${event}`,
    'safe-output-url': `https://github.com/org/${run.repository}/issues/${index * 4 + event + 1}`,
    'event-timestamp': '2026-10-07T09:00:00Z', 'event-source': 'fixture', 'event-type': 'tool.call'
  })));
  return {
    repositories: input('repositories', [
      { organization: 'org', repository: 'control' },
      { organization: 'org', repository: 'other' }
    ]),
    workflows: input('workflows', workflows), runs: input('runs', runs),
    ...Object.fromEntries(['audits', 'domains', 'tools', 'issues'].map((name) => [name, input(name, events)]))
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
  it('selects the latest chronological attempt, including older-run reruns and queued runs, through the canonical worker boundary', async () => {
    const payload = viewPayload(await canonical());
    expect(payload.metadata.availability).toBe('available');
    expect(payload.rows.map((row) => ({
      repository: row.repository, workflow: row.workflow,
      ...(row['latest-run'] ? { run: row['latest-run'] } : {}),
      status: row['latest-run-status'], hasObservedRun: row['has-observed-run']
    }))).toEqual(contract.cases);
    for (const row of payload.rows) {
      for (const field of contract.fields.filter((field) => !['latest-run', 'latest-run-at'].includes(field))) {
        expect(row).toHaveProperty(field);
      }
      expect(row['workflow-link']).toMatchObject({
        'dashboard-href': `#page-${contract.drillPage}?workflow=${encodeURIComponent(String(row['workflow-label']))}`
      });
      expect(row).not.toHaveProperty('successful-runs');
      expect(row).not.toHaveProperty('failed-runs');
      expect(row).not.toHaveProperty('ingestion');
    }
  });

  it('applies a selected horizon before selecting each workflow latest attempt', async () => {
    const payload = viewPayload(await canonical(), {
      timeWindow: { start: '2026-10-06T00:00:00Z', end: '2026-10-07T00:00:00Z' }
    });
    expect(payload.rows.find((row) => row.workflow === 'worker.md' && row.repository === 'org/control'))
      .toMatchObject({ 'latest-run': '100', 'latest-run-status': 'success' });
    expect(payload.rows.filter((row) => row.repository === 'org/control')
      .every((row) => !row['latest-run-at'] || String(row['latest-run-at']) < '2026-10-07T00:00:00Z')).toBe(true);
  });

  it('keeps stable repository and workflow tie-breaks and the latest attempt when timestamps tie', async () => {
    const sources = await canonical();
    const tied = {
      ...sources,
      runs: {
        ...sources.runs,
        rows: sources.runs.rows.map((row) => ({
          ...row, 'started-at': '2026-10-07T12:00:00Z', 'created-at': '2026-10-07T12:00:00Z'
        }))
      }
    };
    const payload = viewPayload(tied);
    expect(payload.rows.map((row) => `${row.repository}:${row.workflow}`)).toEqual([
      'org/control:failed.md', 'org/control:successful.md', 'org/control:worker.md', 'org/other:worker.md', 'org/control:idle.md'
    ]);
  });

  it('degrades evidence quality when runs are unavailable and fails closed when inventory is unavailable', async () => {
    const sources = await canonical();
    const missingRuns = viewPayload({
      ...sources, runs: { ...sources.runs, rows: [], metadata: { ...metadata, availability: 'unavailable' } }
    });
    expect(missingRuns.metadata.completeness).toBe('partial');
    expect(missingRuns.rows).toHaveLength(contract.cases.length);
    const missingInventory = viewPayload({
      ...sources, workflows: { ...sources.workflows, metadata: { ...metadata, availability: 'unavailable' } }
    });
    expect(missingInventory.metadata.availability).toBe('unavailable');
    expect(missingInventory.rows).toEqual([]);
  });

  it('drops all event-coverage dependencies and reduces original inventory query operations by at least 25 percent', async () => {
    const sources = await canonical(200);
    expect(resolveDashboardQuerySources(queries, ['workflow-list']).filter((name) => Object.hasOwn(sources, name)).sort())
      .toEqual(['runs', 'workflows']);
    const before = createDashboardQueryBudget();
    const after = createDashboardQueryBudget();
    expect(executeDashboardQueries(queries, sources, ['workflow-inventory'], { budget: before })['workflow-inventory'].rows)
      .toHaveLength(contract.cases.length);
    const result = executeDashboardQueries(queries, sources, ['workflow-list'], { budget: after })['workflow-list'];
    expect(result.rows).toHaveLength(contract.cases.length);
    expect(result.metadata.availability).toBe('available');
    expect(after.operations).toBeLessThan(before.operations * 0.75);
  }, 30000);
});
