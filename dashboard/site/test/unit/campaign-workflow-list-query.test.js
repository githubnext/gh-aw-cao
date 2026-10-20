import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { processDataRequest } from '../../src/data-worker.js';
import { compileDashboardViewPayloadQueries } from '../../src/data/queries/view-payload-compiler.js';
import { dashboardQueryOutputFields, resolveDashboardQuerySources } from '../../src/data/queries/declarative.js';
import { DATABASE_NAME } from '../../src/data/storage/indexeddb.js';
import { queryIndexedDatabaseSources } from '../../src/data/queries/database.js';
import { TABLE_FIELDS } from '../../src/specification.js';
import { authoritativeDashboard } from '../authoritative-dashboard.js';
import contract from '../fixtures/campaign-workflow-list-contract.json' with { type: 'json' };

/** @typedef {import('../../src/data/queries/declarative.js').DashboardQuery} Query */
/** @typedef {import('../../src/presenter.js').LogicalSourceInput} Source */
/** @type {Query[]} */
const queries = authoritativeDashboard.dashboard.queries;
const page = authoritativeDashboard.dashboard.pages.find((/** @type {{ id: string }} */ page) => page.id === contract.page);
/** @param {string} name @returns {Query} */
function queryDefinition(name) {
  const query = queries.find(query => query.name === name);
  if (!query) throw new Error(`Missing authoritative query: ${name}`);
  return query;
}
/** @type {Map<string, Query>} */
const originals = new Map([
  ['campaign-workflow-import-evidence', {
    name: 'campaign-workflow-import-evidence',
    from: 'audit-event-runs', union: ['domain-event-runs', 'tool-event-runs', 'issue-event-runs'],
    aggregate: {
      by: ['organization', 'repository', 'workflow'],
      values: [{ field: 'events', as: 'events', reducer: 'sum' }]
    }
  }],
  ['campaign-workflow-execution-base', {
    ...queryDefinition('campaign-workflow-execution-base'),
    compute: queryDefinition('campaign-workflow-execution-base').compute?.filter(value => value.as !== 'import-scope'),
    aggregate: {
      by: ['organization', 'repository', 'workflow'],
      values: queryDefinition('campaign-workflow-execution-base').aggregate?.values ?? []
    }
  }],
  ['campaign-workflow-execution-totals', {
    ...queryDefinition('campaign-workflow-execution-totals'),
    joins: [{
      source: 'campaign-workflow-import-evidence', type: 'left',
      on: ['organization', 'repository', 'workflow'].map(field => ({ left: field, right: field })),
      fields: [{ field: 'events', as: 'imported-events' }]
    }]
  }]
]);
/** @type {Query[]} */
const baseline = queries.map(query => originals.get(query.name) ?? query);

/** @param {string} name @param {Record<string, unknown>[]} rows @returns {Source} */
function source(name, rows) {
  return {
    source: name, rows,
    metadata: {
      'source-id': name, 'source-kind': 'fixture',
      'as-of': '2026-10-19T12:00:00Z', 'retrieved-at': '2026-10-19T12:00:00Z',
      availability: rows.length ? 'available' : 'empty', completeness: 'complete', freshness: 'fresh'
    }
  };
}

/** @returns {Record<string, Source>} */
function evidence() {
  const identity = { organization: 'example', repository: 'control' };
  const workflows = Array.from({ length: 31 }, (_, index) => ({
    ...identity, campaign: 'populated', workflow: `worker-${String(index).padStart(2, '0')}`,
    'workflow-role': index ? 'worker' : 'orchestrator', 'workflow-active': 'true', 'rollout-mode': 'review'
  }));
  return {
    campaigns: source('campaigns', [{ campaign: 'populated' }, { campaign: 'empty' }]),
    repositories: source('repositories', [identity]),
    workflows: source('workflows', [
      ...workflows,
      { ...identity, campaign: 'populated', workflow: 'inactive', 'workflow-role': 'worker', 'workflow-active': 'false' },
      { ...identity, campaign: 'populated', workflow: 'unknown', 'workflow-role': 'worker' },
      { ...identity, campaign: 'populated', workflow: 'standalone', 'workflow-role': 'standalone', 'workflow-active': 'true' },
      { ...identity, campaign: 'other', workflow: 'worker-00', 'workflow-role': 'worker', 'workflow-active': 'true', repository: 'other' }
    ]),
    runs: source('runs', workflows.flatMap(workflow => [1, 2, 3].map(attempt => ({
      ...workflow, run: `run-${workflow.workflow}-${attempt}`, 'run-attempt': attempt,
      'aic-total': attempt === 3 ? 99 : 0.5, 'run-status': 'completed', 'run-conclusion': 'success',
      'started-at': attempt === 3 ? '2026-09-01T00:00:00Z' : '2026-10-18T00:00:00Z'
    })))),
    ...Object.fromEntries(contract.importSources.map(name => [name, source(name, workflows.map((workflow, index) => ({
      ...workflow, event: `${name}-${index}`, run: `run-${workflow.workflow}-1`, 'run-attempt': 1,
      'event-timestamp': '2026-10-18T00:00:00Z', 'event-type': 'retained.event', 'event-source': 'fixture',
      'safe-output-url': name === 'issues' ? `https://github.com/example/control/issues/${index + 1}` : ''
    })))]))
  };
}

/** @param {Query[]} definitions @param {string} campaign */
function compiled(definitions, campaign) {
  return compileDashboardViewPayloadQueries(page, contract.page, {
    queries: definitions, viewId: contract.view, routeParameters: { campaign },
    queryContext: { timeWindow: { start: '2026-10-12T00:00:00Z', end: '2026-10-19T12:00:00Z' } }
  });
}

/** @param {Query[]} definitions @param {Record<string, Source>} sources @param {string} campaign */
async function result(definitions, sources, campaign) {
  const payload = compiled(definitions, campaign);
  const loaded = /** @type {Record<string, Source>} */ (await processDataRequest({
    operation: 'load-dashboard-query-sources', sources, queries: payload.queries, sourceNames: payload.aliases
  }));
  const value = loaded[payload.aliases[0]];
  return { ...value, rows: value.rows, metadata: value.metadata };
}

beforeEach(async () => {
  await new Promise((resolve, reject) => {
    const request = indexedDB.deleteDatabase(DATABASE_NAME);
    request.onsuccess = () => resolve(undefined);
    request.onerror = () => reject(request.error);
  });
});

describe('campaign workflow list import quality', () => {
  it('retains the view contract and all evidence sources but no per-run import graph', () => {
    const view = page.views.find((/** @type {{ id: string }} */ view) => view.id === contract.view);
    expect(view.data).toMatchObject({ source: contract.source, 'route-field': contract.routeField });
    /** @type {Record<string, string[]>} */
    const tableFields = TABLE_FIELDS;
    /** @param {string} name @returns {string[] | undefined} */
    const fields = name => {
      const query = queries.find(query => query.name === name);
      return query ? dashboardQueryOutputFields(query, fields) : tableFields[name];
    };
    expect(fields(contract.source)).toEqual(contract.fields);
    const payload = compiled(queries, 'populated');
    const dependencies = resolveDashboardQuerySources(payload.queries, payload.aliases);
    expect(dependencies).toEqual(expect.arrayContaining(contract.importSources));
    expect(dependencies.some(name => /(?:audit|domain|tool|issue)-event-runs/.test(name))).toBe(false);
  });

  it('matches the original worker payload for populated, empty and missing campaigns without record scans', async () => {
    const sources = evidence();
    await processDataRequest({ operation: 'load-dashboard-query-sources', sources, queries: [], sourceNames: ['workflows'], ingest: true });
    for (const campaign of ['populated', 'empty', 'missing', '']) {
      const before = await result(baseline, sources, campaign);
      const reads = vi.spyOn(IDBIndex.prototype, 'openKeyCursor');
      const counts = vi.spyOn(IDBObjectStore.prototype, 'count');
      const documents = vi.spyOn(IDBObjectStore.prototype, 'getAll');
      const after = await result(queries, sources, campaign);
      expect(after).toEqual(before);
      expect(reads).not.toHaveBeenCalled();
      expect(counts.mock.instances.map(store => store instanceof IDBObjectStore ? store.name : '')).toEqual(expect.arrayContaining(contract.importSources));
      expect(documents.mock.instances.some(store => store instanceof IDBObjectStore && contract.importSources.includes(store.name))).toBe(false);
      reads.mockRestore();
      counts.mockRestore();
      documents.mockRestore();
      if (campaign === 'populated') {
        expect(after.rows).toHaveLength(31);
        expect(after.rows.every(row => row.runs === 2 && row.aic === 1)).toBe(true);
        expect(after.rows[0]['workflow-link']).toMatchObject({
          'dashboard-href': '#page-workflow-runtime?workflow=example%2Fcontrol%3Aworker-00'
        });
      } else expect(after.rows).toEqual([]);
    }
  });

  it('keeps worker search, ordering and continuation pages inside the selected campaign', async () => {
    const sources = evidence();
    await processDataRequest({ operation: 'load-dashboard-query-sources', sources, queries: [], sourceNames: ['workflows'], ingest: true });
    const payload = compileDashboardViewPayloadQueries(page, contract.page, {
      queries, viewId: contract.view, routeParameters: { campaign: 'populated' },
      queryContext: {
        search: { fields: ['workflow'], query: 'worker-' },
        orderBy: [{ field: 'workflow', direction: 'desc' }]
      }
    });
    const name = payload.aliases[0];
    const load = async (/** @type {string | undefined} */ continuationToken = undefined) => {
      const loaded = /** @type {Record<string, Source>} */ (await processDataRequest({
        operation: 'load-dashboard-query-sources', sources, queries: payload.queries, sourceNames: [name],
        pagination: { [name]: { limit: 25, ...(continuationToken ? { continuationToken } : {}) } }
      }));
      return loaded[name];
    };
    const first = await load();
    expect(first.rows).toHaveLength(25);
    expect(first.rows[0].workflow).toBe('worker-30');
    expect(first.continuationToken).toEqual(expect.any(String));
    const second = await load(first.continuationToken);
    expect(second.rows).toHaveLength(6);
    expect(second.rows[5].workflow).toBe('worker-00');
    expect(second.continuationToken).toBeUndefined();
    expect([...first.rows, ...second.rows].every(row => row.campaign === 'populated')).toBe(true);
  });

  it.each(contract.importSources)('retains stale and partial %s metadata', async name => {
    const sources = evidence();
    await processDataRequest({ operation: 'load-dashboard-query-sources', sources, queries: [], sourceNames: ['workflows'], ingest: true });
    sources[name].metadata = {
      ...sources[name].metadata, freshness: 'stale', completeness: 'partial', 'as-of': '2026-09-01T00:00:00Z'
    };
    const before = await result(baseline, sources, 'populated');
    const after = await result(queries, sources, 'populated');
    expect(after).toEqual(before);
    expect(after.metadata).toMatchObject({ freshness: 'stale', completeness: 'partial', 'as-of': '2026-09-01T00:00:00Z' });
  });

  it.each(contract.importSources)('does not turn unavailable %s into a successful native count', async name => {
    const sources = evidence();
    await processDataRequest({ operation: 'load-dashboard-query-sources', sources, queries: [], sourceNames: ['workflows'], ingest: true });
    sources[name].metadata = { ...sources[name].metadata, availability: 'unavailable' };
    const definition = queries.find(query => query.from === name && query.name.startsWith('campaign-import-'));
    if (!definition) throw new Error(`Missing import count for ${name}`);
    const native = await queryIndexedDatabaseSources(indexedDB, sources, [definition], [definition.name]);
    expect(native[definition.name].rows).toEqual([]);
    expect(native[definition.name].metadata).toMatchObject({
      availability: 'unavailable', 'query-error': { code: 'input-unavailable', source: name }
    });
    const after = await result(queries, sources, 'populated');
    expect(after.rows).toHaveLength(31);
    expect(after.metadata.completeness).toBe('partial');
  });
});
