import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { processDataRequest } from '../../src/data-worker.js';
import { resolveDashboardQuerySources } from '../../src/data/queries/declarative.js';
import { compileDashboardViewPayloadQueries } from '../../src/data/queries/view-payload-compiler.js';
import { DATABASE_NAME } from '../../src/data/storage/indexeddb.js';
import { TABLE_FIELDS } from '../../src/specification.js';
import { authoritativeDashboard } from '../authoritative-dashboard.js';
import contract from '../fixtures/campaign-repository-inventory-contract.json' with { type: 'json' };

/** @typedef {import('../../src/data/queries/declarative.js').DashboardQuery} Query */
/** @typedef {import('../../src/presenter.js').LogicalSourceInput} Source */
/** @typedef {import('../../src/presenter.js').SourceMetadata} Metadata */
/** @type {Query[]} */
const queries = authoritativeDashboard.dashboard.queries;
const page = authoritativeDashboard.dashboard.pages.find((/** @type {{ id: string }} */ candidate) => candidate.id === contract.page);
const baselinePage = {
  ...page,
  views: page.views.map((/** @type {{ id: string, data: object }} */ view) => (
    contract.views.includes(view.id) ? { ...view, data: { ...view.data, source: 'campaign-workflows' } } : view
  ))
};
const baselineQueries = queries.map((query) => query.name === 'campaign-workflows' ? {
  ...query,
  from: 'workflow-inventory',
  filter: {
    predicates: [
      { field: 'workflow-role', in: ['orchestrator', 'worker'] },
      { field: 'workflow-active', equals: 'true' }
    ]
  },
  compute: undefined,
  select: [...contract.fields, 'runs', 'aic', 'workflow-link'].map((field) => ({ field }))
} : query);

/** @param {string} name @param {Record<string, unknown>[]} rows @param {Partial<Metadata>} [quality] @returns {Source} */
function source(name, rows, quality = {}) {
  return {
    source: name, rows,
    metadata: {
      'source-id': name, 'source-kind': 'fixture',
      'as-of': '2026-10-19T12:00:00Z', 'retrieved-at': '2026-10-19T12:00:00Z',
      availability: rows.length ? 'available' : 'empty',
      completeness: 'complete', freshness: 'fresh', ...quality
    }
  };
}

function evidence() {
  const declared = [
    { repository: 'control', workflow: 'plan', 'workflow-role': 'orchestrator' },
    { repository: 'other', workflow: 'same', 'workflow-name': 'Same', 'workflow-role': 'worker' },
    { repository: 'control', workflow: 'same', 'workflow-name': 'Same', 'workflow-role': 'worker' },
    { repository: 'other', workflow: 'unnamed', 'workflow-name': '', 'workflow-role': 'worker', 'rollout-mode': '' },
    { repository: 'control', workflow: 'disabled', 'workflow-role': 'worker', 'workflow-active': 'false' },
    { repository: 'control', workflow: 'unknown', 'workflow-role': 'worker', 'workflow-active': 'unknown' },
    { repository: 'control', workflow: 'standalone', 'workflow-role': 'standalone' },
    { repository: 'control', workflow: 'other-campaign', 'workflow-role': 'worker', campaign: 'beta' }
  ];
  const workflows = declared.map((row) => ({
    organization: 'example', campaign: 'alpha', 'campaign-name': 'Alpha',
    'workflow-name': row.workflow, 'workflow-active': 'true', 'rollout-mode': 'review',
    'repository-link': { relation: 'repository', href: `https://ghe.example/example/${row.repository}` },
    ...row
  }));
  return {
    campaigns: source('campaigns', ['alpha', 'beta', 'empty'].map((campaign) => ({ campaign }))),
    repositories: source('repositories', ['control', 'other'].map((repository) => ({ organization: 'example', repository }))),
    workflows: source('workflows', workflows),
    runs: source('runs', [{
      organization: 'example', repository: 'control', workflow: 'same', run: '101', 'run-attempt': 1,
      'run-status': 'completed', 'run-conclusion': 'success', 'aic-total': 3,
      'target-repository': 'example/not-enrolled', 'started-at': '2026-10-18T12:00:00Z'
    }]),
    ...Object.fromEntries(['audits', 'domains', 'tools', 'issues'].map((name) => [name, source(name, [])]))
  };
}

/** @returns {Promise<Record<string, Source>>} */
async function canonicalSources() {
  const required = resolveDashboardQuerySources(queries, ['campaign-workflows']);
  return /** @type {Record<string, Source>} */ (await processDataRequest({
    operation: 'load-dashboard-query-sources', ingest: true, queries: [], sources: evidence(),
    sourceNames: required.filter((name) => Object.hasOwn(TABLE_FIELDS, name))
  }));
}

/** @param {Record<string, Source>} sources @param {boolean} baseline @param {string} campaign @param {string} viewId @param {import('../../src/data/queries/view-payload-compiler.js').GlobalQueryContext} [queryContext] */
function viewResult(sources, baseline, campaign, viewId, queryContext) {
  const definitions = baseline ? baselineQueries : queries;
  const compiled = compileDashboardViewPayloadQueries(baseline ? baselinePage : page, contract.page, {
    queries: definitions, viewId, routeParameters: { campaign }, queryContext
  });
  const result = /** @type {Record<string, Source>} */ (processDataRequest({
    operation: 'execute-dashboard-queries', queries: [...definitions, ...compiled.queries],
    sourceNames: compiled.aliases, sources
  }));
  return result[compiled.aliases[0]];
}

/** @param {Source} result */
function topology(result) {
  return result.rows.map((row) => Object.fromEntries(contract.fields.map((field) => [field, row[field]])));
}

beforeEach(async () => {
  vi.spyOn(Date, 'now').mockReturnValue(Date.parse('2026-10-19T12:00:00Z'));
  await new Promise((resolve, reject) => {
    const request = indexedDB.deleteDatabase(DATABASE_NAME);
    request.onsuccess = () => resolve(undefined);
    request.onerror = () => reject(request.error);
  });
});

afterEach(() => vi.restoreAllMocks());

describe('campaign repository declaration-only inventory', () => {
  it('shares raw campaign declaration identities and role selection without dropping inactive or unknown entries', async () => {
    const sources = await canonicalSources();
    const results = /** @type {Record<string, Source>} */ (processDataRequest({
      operation: 'execute-dashboard-queries', queries,
      sourceNames: [contract.declarations], sources: { workflows: sources.workflows }
    }));
    const rows = results[contract.declarations].rows;
    expect(rows).toHaveLength(7);
    expect(rows.map((row) => [row.organization, row.repository, row.workflow]))
      .toEqual(sources.workflows.rows.filter((row) => row['workflow-role'] !== 'standalone')
        .map((row) => [row.organization, row.repository, row.workflow]));
    for (const workflow of ['disabled', 'unknown']) {
      expect(rows.some((row) => row.workflow === workflow)).toBe(true);
    }
    expect(rows.find((row) => row.workflow === 'unnamed')).toMatchObject({
      repository: 'other', 'repository-slug': 'example/other',
      'workflow-name': '', 'workflow-display-name': 'unnamed', 'declared-mode': 'unknown'
    });
    expect(queries.find((query) => query.name === 'campaign-workflow-inventory')?.from).toBe(contract.declarations);
    expect(queries.find((query) => query.name === 'campaign-repository-declarations')?.from).toBe(contract.declarations);
    for (const name of ['campaign-workflows', 'campaign-repository-declarations']) {
      expect(queries.find((query) => query.name === name)?.filter?.predicates)
        .toEqual([{ field: 'workflow-active', equals: 'true' }]);
    }
    for (const name of ['campaign-workflow-inventory', 'campaign-workflow-totals']) {
      expect(queries.find((query) => query.name === name)?.filter).toBeUndefined();
    }
    expect(resolveDashboardQuerySources(queries, [contract.declarations])
      .filter((name) => Object.hasOwn(TABLE_FIELDS, name))).toEqual(contract.dependencies);
  });

  it('keeps both topology views on workflow declarations and retains all navigation count sources', () => {
    for (const id of contract.views) {
      const view = page.views.find((/** @type {{ id: string }} */ candidate) => candidate.id === id);
      expect(view.data.source).toBe(contract.source);
      const compiled = compileDashboardViewPayloadQueries(page, contract.page, {
        queries, viewId: id, routeParameters: { campaign: 'alpha' }
      });
      const required = resolveDashboardQuerySources([...queries, ...compiled.queries], compiled.aliases);
      expect(required.filter((name) => Object.hasOwn(TABLE_FIELDS, name))).toEqual(contract.dependencies);
      expect(required).not.toContain('campaign-workflows');
      expect(required).not.toContain('campaign-workflow-execution-totals');
    }
    expect(page.views.find((/** @type {{ id: string }} */ view) => view.id === 'campaign-repository-navigation')
      .data.sources).toEqual(contract.navigationSources);
  });

  it('preserves populated and empty chart/table payloads, stable identities, names, roles, modes, and links', async () => {
    const sources = await canonicalSources();
    for (const campaign of ['alpha', 'beta', 'empty', 'not-declared']) {
      for (const id of contract.views) {
        const before = viewResult(sources, true, campaign, id);
        const after = viewResult(sources, false, campaign, id);
        expect(topology(after)).toEqual(topology(before));
        expect(after.metadata.availability).toBe(before.metadata.availability);
        expect(after.rows.length).toBe(campaign === 'alpha' ? 4 : campaign === 'beta' ? 1 : 0);
        expect(after.rows.every((row) => row.repository !== 'example/not-enrolled')).toBe(true);
      }
    }
    const result = viewResult(sources, false, 'alpha', contract.views[1]);
    expect(result.rows.filter((row) => row.workflow === 'same').map((row) => row.repository))
      .toEqual(['example/control', 'example/other']);
    expect(result.rows.find((row) => row.workflow === 'unnamed')).toMatchObject({
      'workflow-name': 'unnamed', 'rollout-mode': 'unknown',
      'repository-link': {
        href: 'https://ghe.example/example/other',
        'dashboard-href': '#page-repository-detail?repository=example%2Fother'
      }
    });
    expect(result.rows[0]).not.toHaveProperty('runs');
    expect(result.rows[0]).not.toHaveProperty('aic');
  });

  it('preserves filtering, search, ordering, horizon independence, and chart/table mode payloads', async () => {
    const sources = await canonicalSources();
    /** @type {import('../../src/data/queries/view-payload-compiler.js').GlobalQueryContext[]} */
    const contexts = [
      { filters: { repository: ['example/other'] } },
      { filters: { 'workflow-role': ['orchestrator'] } },
      { search: { fields: ['workflow-name', 'repository'], query: 'Same' } },
      { orderBy: [{ field: 'workflow-name', direction: 'desc' }] },
      { timeWindow: { start: '2026-10-19T00:00:00Z', end: '2026-10-19T12:00:00Z' } },
      { viewMode: 'chart' }, { viewMode: 'table' }
    ];
    for (const queryContext of contexts) for (const id of contract.views) {
      const after = viewResult(sources, false, 'alpha', id, queryContext);
      expect(topology(after)).toEqual(topology(viewResult(sources, true, 'alpha', id, queryContext)));
      expect(after.rows.length).toBeGreaterThan(0);
    }
  });

  it('distinguishes available empty inventory from missing or unavailable declarations', async () => {
    const sources = await canonicalSources();
    for (const id of contract.views) {
      const empty = viewResult({ ...sources, workflows: source('workflows', []) }, false, 'alpha', id);
      expect(empty.rows).toEqual([]);
      expect(empty.metadata.availability).toBe('empty');
      for (const workflows of [
        undefined,
        source('workflows', [], { availability: 'unavailable', completeness: 'unknown' })
      ]) {
        const input = { ...sources };
        if (workflows) input.workflows = workflows;
        else delete input.workflows;
        const unavailable = viewResult(input, false, 'alpha', id);
        expect(unavailable.rows).toEqual([]);
        expect(unavailable.metadata.availability).toBe('unavailable');
        expect(unavailable.metadata['query-error']).toBeDefined();
      }
    }
  });

  it('retains declaration quality while missing execution/import evidence cannot suppress topology', async () => {
    const sources = await canonicalSources();
    const inventoryOnly = { workflows: sources.workflows };
    for (const id of contract.views) {
      expect(viewResult(inventoryOnly, false, 'alpha', id)).toEqual(viewResult(sources, false, 'alpha', id));
      const partial = viewResult({
        workflows: {
          ...sources.workflows,
          metadata: { ...sources.workflows.metadata, completeness: 'partial', freshness: 'stale' }
        }
      }, false, 'alpha', id);
      expect(partial.metadata).toMatchObject({ completeness: 'partial', freshness: 'stale' });
      expect(partial.rows).toHaveLength(4);
    }
  });
});
