import 'fake-indexeddb/auto';
import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ingestCachedGhAwJsonl } from '../../src/data/ingest/coordinator.js';
import {
  CANONICAL_DATABASE_SCHEMA,
  DATABASE_NAME,
  DATABASE_STORES,
  recordTransaction
} from '../../src/data/storage/indexeddb.js';
import {
  loadDatabaseQuerySources,
  queryDatabaseSources,
  queryIndexedDatabaseSources
} from '../../src/data/queries/database.js';
import { processDataRequest } from '../../src/data-worker.js';
import { createDashboardQueryBudget, executeDashboardQueries } from '../../src/data/queries/declarative.js';

const loadCanonicalViewSources = loadDatabaseQuerySources;
const queryCanonicalViewSources = queryDatabaseSources;
const queryNativeCountSources = queryIndexedDatabaseSources;

const metadata = { 'as-of': '2026-09-09T05:00:00Z', 'artifact-generation': 'generation-a' };
const dashboardQueries = JSON.parse(
  readFileSync(`${process.cwd()}/dashboard.json`, 'utf8')
).dashboard.queries;

/** @param {string} storeName @param {Record<string, unknown>} record */
async function putCanonicalRecord(storeName, record) {
  const database = await new Promise((resolve, reject) => {
    const request = indexedDB.open(DATABASE_NAME);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  await new Promise((resolve, reject) => {
    const transaction = database.transaction(storeName, 'readwrite');
    transaction.objectStore(storeName).put(record);
    transaction.oncomplete = () => resolve(undefined);
    transaction.onerror = () => reject(transaction.error);
  });
  database.close();
}
const sources = {  campaigns: {
    rows: [{
      campaign: 'dashboard', 'campaign-name': 'CAO Dashboard', 'campaign-description': 'Deploy the dashboard.',
      'campaign-icon': 'graph', 'campaign-mode': 'review', 'campaign-enabled': true,
      'campaign-worker-count': 1, 'campaign-min-version': 'v0.89.3', 'campaign-experimental': true
    }],
    metadata
  },
  repositories: {
    rows: [{ organization: 'githubnext', repository: 'gh-aw-cao', 'rollout-mode': 'review' }],
    metadata
  },
  workflows: {
    rows: [{
      organization: 'githubnext', repository: 'gh-aw-cao', workflow: '.github/workflows/dashboard.lock.yml',
      campaign: 'dashboard', 'campaign-name': 'CAO Dashboard', 'workflow-id': '501',
      'workflow-name': 'Published registry name', 'workflow-role': 'worker',
      'workflow-registry-state': 'active', 'workflow-active': 'true',
      'admission-status': 'admitted', 'inventory-ready': true,
      'workflow-link': {
        relation: 'workflow',
        href: 'https://github.com/githubnext/gh-aw-cao/actions/workflows/501'
      },
      'created-at': '2026-09-01T00:00:00Z', 'updated-at': '2026-09-08T00:00:00Z',
      'rollout-mode': 'review'
    }],
    metadata
  },
  runs: {
    rows: [{
      organization: 'githubnext', repository: 'gh-aw-cao', workflow: '.github/workflows/dashboard.md',
      run: '42', 'run-attempt': 2, 'run-status': 'completed', 'run-conclusion': 'failure',
      'started-at': '2026-09-09T04:00:00Z', 'failure-detail': 'Build failed',
      'admission-status': 'admitted', resource: 'actions', 'resource-wait-hours': 2,
      'rollout-mode': 'review', engine: 'copilot', 'engine-version': '1.2.3',
      'gh-aw-version': 'v0.89.4',
      'requested-model': 'model-a', 'resolved-model': 'model-b',
      'run-link': { relation: 'run', href: 'https://github.com/githubnext/gh-aw-cao/actions/runs/42', label: 'Run 42' }
    }],
    metadata
  },
  'job-performance': {
    rows: [{
      organization: 'githubnext', repository: 'gh-aw-cao', workflow: '.github/workflows/dashboard.md',
      run: '42', 'run-attempt': 2, 'job-id': '99', job: 'build',
      'job-status': 'completed', 'job-conclusion': 'failure', 'job-duration-seconds': 120,
      'started-at': '2026-09-09T04:01:00Z', runner: 'ubuntu-latest', engine: 'copilot', model: 'model-b'
    }],
    metadata
  },
  'work-items': {
    rows: [{
      'work-item-id': 'githubnext/gh-aw-cao:.github/workflows/dashboard.md',
      name: 'Dashboard · Publish report', objective: 'Dashboard',
      organization: 'githubnext', repository: 'gh-aw-cao', workflow: '.github/workflows/dashboard.md',
      run: '42', 'workflow-name': 'Dashboard', 'workflow-icon': 'workflow', campaign: 'dashboard',
      scope: 'githubnext/gh-aw-cao', domain: 'dashboard', 'work-type': 'worker',
      'lifecycle-state': 'blocked', phase: 'completed', reason: 'Build failed',
      'reason-evidence-class': 'observed', 'next-action': 'Resolve the run failure',
      'next-actor': 'maintainer', 'safe-output-kind': 'workflow-output', 'waiting-on': 'scheduled run',
      'waiting-since': '2026-09-09T04:00:00Z', owner: 'dashboard', 'consequence-tier': 'medium',
      'verification-state': 'pending', 'outcome-state': 'pending',
      'started-at': '2026-09-09T04:00:00Z', 'ended-at': '2026-09-09T04:02:00Z',
      'observed-at': '2026-09-09T04:00:00Z',
      'run-link': { relation: 'run', href: 'https://github.com/githubnext/gh-aw-cao/actions/runs/42' }
    }],
    metadata
  },
  'security-findings': {
    rows: [{
      organization: 'githubnext', repository: 'gh-aw-cao', workflow: '.github/workflows/dashboard.md', run: '42',
      'smell-observation-id': 'threat-detection:observation-1', 'smell-id': 'threat-detection-secret-leak',
      'smell-name': 'Secret leak detected', 'smell-category': 'trust-and-security', 'smell-severity': 'high',
      'smell-summary': 'Threat detection reported untrusted or unsafe agent behavior.',
      'smell-evidence': 'credentials', 'observed-at': '2026-09-09T04:01:00Z',
      'run-link': { relation: 'run', href: 'https://github.com/githubnext/gh-aw-cao/actions/runs/42' }
    }],
    metadata
  },
  tools: {
    rows: [
      {
        organization: 'githubnext', repository: 'gh-aw-cao', workflow: '.github/workflows/dashboard.md',
        run: '42', 'run-attempt': 2, event: 'event:tool-call',
        'event-timestamp': '2026-09-09T04:00:10Z', 'event-source': 'mcp', 'event-type': 'tool.call',
        'event-summary': 'github.list_issues', 'event-status': 'requested',
        'request-count': 7,
        'correlation-id': 'call-1', 'safe-output-type': 'create_issue',
        'mcp-server-version': '1.0.0', 'mcp-protocol-version': '2025-06-18', 'response-bytes': 256,
        'github-entity-type': 'issue', 'source-sequence': 0, 'observed-at': '2026-09-09T04:00:10Z'
      }
    ],
    metadata
  },
  audits: {
    rows: [
      {
        organization: 'githubnext', repository: 'gh-aw-cao', workflow: '.github/workflows/dashboard.md',
        run: '42', 'run-attempt': 2, event: 'event:agent-turn',
        'event-timestamp': '2026-09-09T04:00:20Z', 'event-source': 'agent', 'event-type': 'agent_turn',
        'event-summary': 'Planned the change', 'source-sequence': 1, 'observed-at': '2026-09-09T04:00:20Z'
      }
    ],
    metadata
  },
  domains: { rows: /** @type {Record<string, unknown>[]} */ ([]), metadata },
  issues: { rows: /** @type {Record<string, unknown>[]} */ ([]), metadata },
  usage: {
    rows: [{ organization: 'githubnext', repository: 'gh-aw-cao', workflow: '.github/workflows/dashboard.md', run: '42', aic: 17 }],
    metadata
  }
};

/**
 * @param {string} generation
 * @param {Record<string, unknown>[]} auditRows
 */
function collection(generation, auditRows) {
  const collected = { 'as-of': metadata['as-of'], 'artifact-generation': generation };
  return Object.fromEntries(Object.entries(sources).map(([name, source]) => [
    name,
    { rows: name === 'audits' ? auditRows : source.rows, metadata: collected }
  ]));
}

beforeEach(async () => {
  await new Promise((resolve, reject) => {
    const request = indexedDB.deleteDatabase(DATABASE_NAME);
    request.onsuccess = () => resolve(undefined);
    request.onerror = () => reject(request.error);
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('canonical view sources', () => {
  it('summarizes canonical database diagnostics inside the query layer', async () => {
    const diagnostics = /** @type {import('../../src/diagnostics.js').DatabaseDiagnostics} */ (await processDataRequest({
      operation: 'query-canonical-database-diagnostics'
    }));

    expect(diagnostics.schemaVersion).toBeGreaterThan(0);
    expect(diagnostics.counts).toEqual(expect.objectContaining({
      campaigns: 0,
      repositories: 0,
      workflows: 0,
      runs: 0
    }));
    expect(diagnostics.relationshipErrors).toEqual([]);
    expect(diagnostics.duplicateRecordIds).toEqual(expect.objectContaining({
      campaigns: [],
      repositories: [],
      workflows: [],
      runs: []
    }));
  });

  it('finds canonical relationship failures through declarative database queries', async () => {
    await processDataRequest({ operation: 'query-canonical-database-diagnostics' });
    await putCanonicalRecord('workflows', {
      id: 'workflow:orphan',
      repositoryId: 'repository:missing'
    });

    const diagnostics = /** @type {import('../../src/diagnostics.js').DatabaseDiagnostics} */ (await processDataRequest({
      operation: 'query-canonical-database-diagnostics'
    }));

    expect(diagnostics.counts.workflows).toBe(1);
    expect(diagnostics.relationshipErrors).toEqual([
      'workflow:orphan.repositoryId does not reference an existing repository'
    ]);
  });

  it('matches declarative counts for every canonical database table', async () => {
    await loadCanonicalViewSources(indexedDB, sources, { ingest: true });
    const tableNames = [...DATABASE_STORES];
    const canonical = await queryCanonicalViewSources(indexedDB, sources, tableNames);
    const definitions = tableNames.map((table) => ({
      name: `${table}-count`,
      from: table,
      aggregate: {
        values: [{ field: String(CANONICAL_DATABASE_SCHEMA[table].keyPath), as: 'count', reducer: 'count' }]
      }
    }));
    const collectionReads = vi.spyOn(IDBObjectStore.prototype, 'getAll');
    const nativeCounts = vi.spyOn(IDBObjectStore.prototype, 'count');
    const requested = definitions.map(({ name }) => name);

    const native = await queryNativeCountSources(indexedDB, sources, definitions, requested);
    const declarative = executeDashboardQueries(definitions, canonical, requested);

    expect(Object.keys(native)).toEqual(requested);
    for (const name of requested) {
      expect(native[name].rows).toEqual(declarative[name].rows);
    }
    expect(nativeCounts).toHaveBeenCalledTimes(tableNames.length);
    expect(collectionReads).not.toHaveBeenCalled();
  });

  it('returns the same zero counts as declarative execution for empty tables', async () => {
    const tableNames = [...DATABASE_STORES];
    const definitions = tableNames.map((table) => ({
      name: `${table}-count`,
      from: table,
      aggregate: {
        values: [{ field: String(CANONICAL_DATABASE_SCHEMA[table].keyPath), as: 'count', reducer: 'count' }]
      }
    }));
    const requested = definitions.map(({ name }) => name);
    const emptyMetadata = /** @type {import('../../src/presenter.js').SourceMetadata} */ ({
      'source-id': 'empty',
      'source-kind': 'database-query',
      'as-of': metadata['as-of'],
      'retrieved-at': metadata['as-of'],
      completeness: 'complete',
      freshness: 'fresh',
      availability: 'empty'
    });
    const emptySources = Object.fromEntries(tableNames.map((table) => [
      table,
      { source: table, rows: [], metadata: emptyMetadata }
    ]));

    const native = await queryNativeCountSources(indexedDB, emptySources, definitions, requested);
    const declarative = executeDashboardQueries(definitions, emptySources, requested);

    for (const name of requested) {
      expect(native[name].rows).toEqual([{ count: 0 }]);
      expect(native[name].rows).toEqual(declarative[name].rows);
    }
  });

  it('resolves the Overview repository metric with native IndexedDB count', async () => {
    await loadCanonicalViewSources(indexedDB, sources, { ingest: true });
    const collectionReads = vi.spyOn(IDBObjectStore.prototype, 'getAll');
    const nativeCounts = vi.spyOn(IDBObjectStore.prototype, 'count');

    const result = await queryNativeCountSources(
      indexedDB,
      sources,
      dashboardQueries,
      ['overview-registered-repository-summary']
    );

    expect(result['overview-registered-repository-summary'].rows).toEqual([
      { 'registered-repositories': 1 }
    ]);
    expect(nativeCounts).toHaveBeenCalledOnce();
    expect(collectionReads).not.toHaveBeenCalled();
  });

  it('pushes declarative failed-run predicates into the canonical run index', async () => {
    await loadCanonicalViewSources(indexedDB, sources, { ingest: true });
    const collectionReads = vi.spyOn(IDBObjectStore.prototype, 'getAll');
    const indexedReads = vi.spyOn(IDBIndex.prototype, 'getAll');

    const result = await queryNativeCountSources(
      indexedDB,
      sources,
      dashboardQueries,
      ['failed-runs']
    );

    expect(result['failed-runs']).toMatchObject({
      source: 'failed-runs',
      rows: [{ repository: 'gh-aw-cao', run: '42', 'run-conclusion': 'failure' }],
      metadata: { 'source-kind': 'derived', 'query-name': 'failed-runs' }
    });
    expect(indexedReads).toHaveBeenCalledTimes(4);
    expect(collectionReads).not.toHaveBeenCalled();
  });

  it('keeps computed daily run aggregates in the declarative engine', async () => {
    await loadCanonicalViewSources(indexedDB, sources, { ingest: true });

    const native = await queryNativeCountSources(
      indexedDB,
      sources,
      dashboardQueries,
      ['runs-daily-conclusions']
    );

    expect(Object.keys(native)).toEqual([]);
  });

  it('falls back for joins, transformed counts, invalid queries, and non-table sources', async () => {
    await loadCanonicalViewSources(indexedDB, sources, { ingest: true });
    const definitions = [
      {
        name: 'repository-count',
        from: 'repositories',
        aggregate: { values: [{ field: 'id', as: 'repositories', reducer: 'count' }] }
      },
      {
        name: 'filtered-run-count',
        from: 'runs',
        filter: { predicates: [{ field: 'run-status', equals: 'completed' }] },
        aggregate: { values: [{ field: 'id', as: 'runs', reducer: 'count' }] }
      },
      {
        name: 'joined-run-count',
        from: 'runs',
        joins: [{
          source: 'workflows',
          type: 'left',
          on: [{ left: 'workflowId', right: 'id' }],
          fields: [{ field: 'id', as: 'workflow-id' }]
        }],
        aggregate: { values: [{ field: 'id', as: 'runs', reducer: 'count' }] }
      },
      {
        name: 'grouped-run-count',
        from: 'runs',
        aggregate: {
          by: ['conclusion'],
          values: [{ field: 'id', as: 'runs', reducer: 'count' }]
        }
      },
      {
        name: 'non-key-run-count',
        from: 'runs',
        aggregate: { values: [{ field: 'githubRunId', as: 'runs', reducer: 'count' }] }
      },
      {
        name: 'distinct-run-count',
        from: 'runs',
        aggregate: { values: [{ field: 'id', as: 'runs', reducer: 'distinct-count' }] }
      },
      {
        name: 'limited-run-count',
        from: 'runs',
        aggregate: { values: [{ field: 'id', as: 'runs', reducer: 'count' }] },
        limit: 1
      },
      {
        name: 'selected-run-count',
        from: 'runs',
        aggregate: { values: [{ field: 'id', as: 'runs', reducer: 'count' }] },
        select: [{ field: 'runs' }]
      },
      {
        name: 'events-count',
        from: 'events',
        aggregate: { values: [{ field: 'id', as: 'events', reducer: 'count' }] }
      },
      {
        name: 'missing-aggregate',
        from: 'runs'
      }
    ];
    const requested = definitions.map(({ name }) => name);
    const nativeCounts = vi.spyOn(IDBObjectStore.prototype, 'count');

    const projected = await queryNativeCountSources(
      indexedDB,
      sources,
      definitions,
      requested
    );

    expect(Object.keys(projected)).toEqual(['repository-count']);
    expect(projected['repository-count']).toMatchObject({
      source: 'repository-count',
      rows: [{ repositories: 1 }],
      metadata: {
        'source-kind': 'derived',
        availability: 'available',
        'query-name': 'repository-count'
      }
    });
    expect(nativeCounts.mock.instances.map((store) => (
      /** @type {IDBObjectStore} */ (store).name
    ))).toEqual(['repositories']);
  });

  it('projects retained ingestion transactions for dashboard inspection', async () => {
    await recordTransaction(indexedDB, {
      id: 'ingest-jsonl:current:test',
      kind: 'ingest-jsonl',
      createdAt: '2026-09-09T05:00:00Z',
      payloadScope: 'gh-aw-jsonl',
      payloadHash: 'abc123',
      records: 12,
      committedRecords: 10,
      unenrichedRuns: 2
    });
    await recordTransaction(indexedDB, {
      id: 'ingest-jsonl:current:newer',
      kind: 'ingest-jsonl',
      createdAt: '2026-09-09T06:00:00Z',
      payloadScope: 'gh-aw-jsonl',
      committedRecords: 4
    });

    const projected = await queryCanonicalViewSources(indexedDB, sources, ['transactions']);

    expect(projected.transactions).toMatchObject({
      source: 'transactions',
      metadata: { 'source-kind': 'database-query', availability: 'available' },
      rows: [
        {
          id: 'ingest-jsonl:current:newer',
          kind: 'ingest-jsonl',
          createdAt: '2026-09-09T06:00:00Z',
          payloadScope: 'gh-aw-jsonl',
          committedRecords: 4
        },
        {
          id: 'ingest-jsonl:current:test',
          kind: 'ingest-jsonl',
          createdAt: '2026-09-09T05:00:00Z',
          payloadScope: 'gh-aw-jsonl',
          payloadHash: 'abc123',
          records: 12,
          committedRecords: 10,
          unenrichedRuns: 2
        }
      ]
    });
  });

  it('queries only the canonical payload requested by a view', async () => {
    await loadCanonicalViewSources(indexedDB, sources, { ingest: true });
    /** @type {{ databaseMs: number, projectionMs: number, totalMs: number, recordsRead: number, stores: string[] } | undefined} */
    let metrics;

    const canonical = await queryCanonicalViewSources(
      indexedDB,
      sources,
      ['runs'],
      { onMetrics: (value) => { metrics = value; } }
    );
    const projected = executeDashboardQueries(
      dashboardQueries,
      canonical,
      ['failed-runs']
    );

    expect(Object.keys(projected)).toEqual(['failed-runs']);
    expect(projected['failed-runs']).toMatchObject({
      source: 'failed-runs',
      rows: [{ repository: 'gh-aw-cao', run: '42', 'run-conclusion': 'failure' }],
      metadata: { 'source-kind': 'derived' }
    });
    expect(metrics).toMatchObject({
      databaseMs: expect.any(Number),
      projectionMs: expect.any(Number),
      totalMs: expect.any(Number),
      recordsRead: expect.any(Number),
      stores: ['workflows', 'runs']
    });
    expect(metrics?.totalMs).toBeGreaterThanOrEqual(metrics?.databaseMs ?? 0);
  });

  it('projects campaign rows and workflow membership from canonical records', async () => {
    await loadCanonicalViewSources(indexedDB, sources, { ingest: true });

    const projected = await queryCanonicalViewSources(indexedDB, sources, ['campaigns', 'workflows']);

    expect(projected.campaigns).toMatchObject({
      source: 'campaigns',
      rows: [{
        campaign: 'dashboard',
        'campaign-name': 'CAO Dashboard',
        'campaign-description': 'Deploy the dashboard.',
        'campaign-mode': 'review',
        'campaign-worker-count': 1
      }],
      metadata: { 'source-kind': 'database-query' }
    });
    expect(projected.workflows.rows).toEqual([
      expect.objectContaining({
        campaign: 'dashboard',
        'campaign-name': 'CAO Dashboard',
        workflow: '.github/workflows/dashboard.md',
        'workflow-id': '501',
        'workflow-name': 'Published registry name',
        'workflow-role': 'worker',
        'workflow-registry-state': 'active',
        'admission-status': 'admitted',
        'inventory-ready': true,
        'created-at': '2026-09-01T00:00:00Z',
        'updated-at': '2026-09-08T00:00:00Z',
        'workflow-link': {
          relation: 'workflow',
          href: 'https://github.com/githubnext/gh-aw-cao/actions/workflows/501'
        }
      })
    ]);
  });

  it('projects run records and MCP calls through declarative canonical queries', async () => {
    await loadCanonicalViewSources(indexedDB, sources, { ingest: true });

    const projected = await queryCanonicalViewSources(indexedDB, {
      ...sources,
      'mcp-calls': { rows: [], metadata }
    }, ['tools', 'mcp-calls']);

    expect(projected.tools).toMatchObject({
      source: 'tools',
      rows: [{
        organization: 'githubnext',
        repository: 'gh-aw-cao',
        run: '42',
        event: 'event:tool-call',
        'event-type': 'tool.call'
      }],
      metadata: { 'source-kind': 'database-query' }
    });
    expect(projected['mcp-calls']).toMatchObject({
      source: 'mcp-calls',
      rows: [{
        organization: 'githubnext',
        repository: 'gh-aw-cao',
        run: '42',
        'mcp-observation': 'event:tool-call',
        'mcp-status': 'requested',
        'mcp-server-version': '1.0.0',
        'mcp-protocol-version': '2025-06-18',
        'response-bytes': 256
      }],
      metadata: { 'source-kind': 'database-query' }
    });
  });

  it('does not read database stores for a populated published source', async () => {
    const collectionReads = vi.spyOn(IDBObjectStore.prototype, 'getAll');
    const published = { rows: [{ 'mcp-observation': 'published-call' }], metadata };

    const projected = await queryDatabaseSources(
      indexedDB,
      { 'mcp-calls': published },
      ['mcp-calls']
    );

    expect(projected['mcp-calls'].rows).toEqual(published.rows);
    expect(collectionReads).not.toHaveBeenCalled();
  });

  it('does not read database stores for a missing logical source', async () => {
    const collectionReads = vi.spyOn(IDBObjectStore.prototype, 'getAll');

    const projected = await queryDatabaseSources(indexedDB, {}, ['usage']);

    expect(projected.usage).toMatchObject({
      rows: [],
      metadata: { availability: 'empty' }
    });
    expect(collectionReads).not.toHaveBeenCalled();
  });

  it('returns requested authoritative sources through the canonical query boundary', async () => {
    const loaded = await loadCanonicalViewSources(indexedDB, sources, {
      ingest: true,
      sourceNames: ['work-items', 'security-findings']
    });

    const projected = await queryCanonicalViewSources(
      indexedDB,
      sources,
      ['work-items', 'security-findings']
    );

    expect(projected['work-items']).toMatchObject({
      source: 'work-items',
      rows: [{ 'work-item-id': 'githubnext/gh-aw-cao:.github/workflows/dashboard.md', 'lifecycle-state': 'blocked' }]
    });
    expect(projected['security-findings']).toMatchObject({
      source: 'security-findings',
      rows: [{ 'smell-observation-id': 'threat-detection:observation-1', 'smell-severity': 'high' }]
    });
    expect(projected).not.toHaveProperty('usage');
    expect(loaded['work-items']).toMatchObject({
      source: 'work-items',
      rows: [{ 'work-item-id': 'githubnext/gh-aw-cao:.github/workflows/dashboard.md', 'lifecycle-state': 'blocked' }]
    });
    expect(loaded['security-findings']).toMatchObject({
      source: 'security-findings',
      rows: [{ 'smell-observation-id': 'threat-detection:observation-1', 'smell-severity': 'high' }]
    });
  });

  it('projects failed-run evidence from the active canonical generation', async () => {
    const projected = await loadCanonicalViewSources(indexedDB, sources, {
      ingest: true,
      sourceNames: ['failed-runs', 'runs', 'repositories', 'workflows'],
      queries: dashboardQueries
    });

    expect(projected['failed-runs']).toMatchObject({
      source: 'failed-runs',
      rows: [{ repository: 'gh-aw-cao', run: '42', 'run-attempt': 2, 'run-conclusion': 'failure', 'failure-detail': 'Build failed' }],
      metadata: { 'source-kind': 'derived', availability: 'available' }
    });
    expect(projected.runs).toMatchObject({
      source: 'runs',
      rows: [{
        repository: 'gh-aw-cao', run: '42', 'run-attempt': 2,
        'rollout-mode': 'review', engine: 'copilot', 'engine-version': '1.2.3',
        'gh-aw-version': 'v0.89.4',
        'requested-model': 'model-a', 'resolved-model': 'model-b',
        'admission-status': 'admitted', resource: 'actions', 'resource-wait-hours': 2
      }],
      metadata: { 'source-kind': 'database-query', availability: 'available' }
    });
    expect(projected.repositories).toMatchObject({
      source: 'repositories',
      rows: [{ organization: 'githubnext', repository: 'gh-aw-cao' }],
      metadata: { 'source-kind': 'database-query', availability: 'available' }
    });
    expect(projected.workflows).toMatchObject({
      source: 'workflows',
      rows: [{
        organization: 'githubnext', repository: 'gh-aw-cao',
        workflow: '.github/workflows/dashboard.md'
      }],
      metadata: { 'source-kind': 'database-query', availability: 'available' }
    });
    expect(projected['job-performance']).toMatchObject({
      source: 'job-performance',
      rows: [{
        organization: 'githubnext', repository: 'gh-aw-cao', run: '42',
        'run-attempt': 2, 'job-id': '99', job: 'build',
        'job-duration-seconds': 120, runner: 'ubuntu-latest', engine: 'copilot', model: 'model-b'
      }],
      metadata
    });
    expect(Reflect.get(projected, 'usage')).toEqual({
      source: 'usage',
      rows: [{ organization: 'githubnext', repository: 'gh-aw-cao', workflow: '.github/workflows/dashboard.md', run: '42', aic: 17 }],
      metadata
    });
  });

  it('projects workflow configuration onto runs when run metadata is absent', async () => {
    const input = structuredClone(sources);
    Reflect.deleteProperty(input.runs.rows[0], 'rollout-mode');
    await loadCanonicalViewSources(indexedDB, input, { ingest: true });

    const projected = await queryCanonicalViewSources(indexedDB, input, ['runs']);

    expect(projected.runs.rows).toEqual([
      expect.objectContaining({
        workflow: '.github/workflows/dashboard.md',
        'rollout-mode': 'review'
      })
    ]);
  });

  it('projects run-linked view sources from their canonical tables', async () => {
    await loadCanonicalViewSources(indexedDB, sources, { ingest: true });

    const projected = await queryCanonicalViewSources(
      indexedDB,
      sources,
      ['tools', 'audits']
    );

    expect(Object.keys(projected)).toEqual(['tools', 'audits']);
    expect(projected.tools).toMatchObject({
      source: 'tools',
      metadata: { 'source-kind': 'database-query', availability: 'available' }
    });
    expect(projected.tools.rows).toEqual([
      expect.objectContaining({
        organization: 'githubnext',
        repository: 'gh-aw-cao',
        workflow: '.github/workflows/dashboard.md',
        run: '42',
        'run-attempt': 2,
        event: 'event:tool-call',
        'event-type': 'tool.call',
        'event-source': 'mcp',
        'event-summary': 'github.list_issues',
        'request-count': 7,
        'correlation-id': 'call-1',
        'safe-output-type': 'create_issue',
        'github-entity-type': 'issue'
      })
    ]);
    expect(projected.audits.rows).toEqual([
      expect.objectContaining({ event: 'event:agent-turn', 'event-source': 'agent', 'event-type': 'agent_turn' })
    ]);
  });

  it('projects firewall event arity with canonical event types', async () => {
    const firewallSources = structuredClone(sources);
    const firewallEvent = structuredClone(firewallSources.tools.rows[0]);
    firewallEvent.event = 'event:firewall-blocked';
    firewallEvent['event-source'] = 'firewall';
    firewallEvent['event-type'] = 'net_blocked';
    firewallSources.tools.rows = [];
    firewallSources.domains.rows = [firewallEvent];
    await loadCanonicalViewSources(indexedDB, firewallSources, { ingest: true });

    const projected = await queryCanonicalViewSources(indexedDB, firewallSources, ['domains']);

    expect(projected.domains.rows).toEqual([
      expect.objectContaining({
        event: 'event:firewall-blocked',
        'event-source': 'firewall',
        'event-type': 'firewall.request.blocked',
        'request-count': 7
      })
    ]);
  });

  it('does not synthesize undeclared grader sources in JavaScript', async () => {
    const content = JSON.stringify({
      schema_version: 2,
      kind: 'run',
      run: {
        run_id: 84,
        run_attempt: 1,
        organization: 'githubnext',
        repository: 'githubnext/gh-aw-cao',
        workflow_name: 'Value worker',
        workflow_path: '.github/workflows/value-worker.md',
        status: 'completed',
        conclusion: 'success',
        created_at: '2026-09-09T04:00:00Z',
        started_at: '2026-09-09T04:00:00Z',
        updated_at: '2026-09-09T04:02:00Z',
        graders: {
          results: [{
            id: 'operational-value',
            name: 'Operational Value',
            status: 'pass',
            unit: 'count',
            direction: 'higher_is_better',
            value: 0,
            metrics: [
              { id: 'accepted-maintenance-outcomes', value: 0 },
              { id: 'eligible-maintenance-items', value: 3 },
              { id: 'unavailable-maintenance-items', value: null }
            ]
          }]
        }
      }
    });
    await ingestCachedGhAwJsonl(indexedDB, `${content}\n`, {
      now: Date.parse('2026-09-09T05:00:00Z')
    });

    const projected = await queryCanonicalViewSources(
      indexedDB,
      {},
      ['grader-observations', 'operational-values']
    );

    expect(projected['grader-observations'].rows).toEqual([]);
    expect(projected['operational-values'].rows).toEqual([]);
  });

  it.skip('projects token optimizer interventions without parsing issue display text', async () => {
    const records = [
      {
        schema_version: 2,
        kind: 'run',
        run: {
          run_id: 1186001,
          run_attempt: 1,
          organization: 'githubnext',
          repository: 'githubnext/gh-aw-cao',
          workflow_name: 'Optimization / Token Optimizer',
          workflow_path: '.github/workflows/optimization-token-optimizer.md',
          status: 'completed',
          conclusion: 'success',
          created_at: '2026-09-15T04:00:00Z',
          updated_at: '2026-09-15T04:02:00Z'
        }
      },
      {
        schema_version: 2,
        kind: 'safe_output_item',
        safe_output: {
          run_id: 1186001,
          type: 'create_issue',
          url: 'https://github.com/githubnext/gh-aw-cao/issues/11861',
          number: 11861,
          repo: 'githubnext/gh-aw-cao',
          timestamp: '2026-09-15T04:02:00Z'
        }
      },
      {
        schema_version: 2,
        kind: 'token_efficiency_observation',
        observation: {
          schemaVersion: 1,
          observedAt: '2026-09-15T04:02:00Z',
          controlRepository: 'githubnext/gh-aw-cao',
          optimizerRunId: '1186001',
          runAttempt: 1,
          targetRepo: 'octo/example',
          workflowPath: '.github/workflows/review.md',
          evidenceWindowStart: '2026-09-01T00:00:00Z',
          evidenceWindowEnd: '2026-09-08T00:00:00Z',
          assignmentRunId: '1185999',
          experimentId: 'review-context-v1',
          opportunityKind: 'unbounded-context-growth',
          opportunityId: 'token-opportunity:octo/example:.github/workflows/review.md:2026-09-01T00:00:00Z:2026-09-08T00:00:00Z:1185999:review-context-v1',
          evidenceState: 'complete',
          evidenceConfidence: 0.9,
          costGrain: 'invocation',
          evidenceProvenance: [{ source: 'activity', runId: '42', costGrain: 'invocation' }],
          interventionId: 'token-intervention:review-context-v1:1186001',
          interventionState: 'proposed',
          recommendationDisposition: 'unapplied',
          controlVariant: 'control',
          optimizedVariant: 'optimized',
          proposedSavingsAic: 12.5,
          attributableRunIds: ['1185999', '1186001']
        }
      },
      {
        schema_version: 2,
        kind: 'token_efficiency_lifecycle_observation',
        observation: {
          schemaVersion: 1,
          lifecycleObservationId: 'token-lifecycle:accepted-1',
          observedAt: '2026-09-16T04:02:00Z',
          controlRepository: 'githubnext/gh-aw-cao',
          claimRunId: '1189001',
          claimRunAttempt: 1,
          actor: 'maintainer',
          optimizerRunId: '1186001',
          optimizerRunAttempt: 1,
          optimizerWorkflowPath: '.github/workflows/optimization-token-optimizer.md',
          optimizerWorkflowName: 'Optimization / Token Optimizer',
          targetRepo: 'octo/example',
          workflowPath: '.github/workflows/review.md',
          opportunityId: 'token-opportunity:octo/example:.github/workflows/review.md:2026-09-01T00:00:00Z:2026-09-08T00:00:00Z:1185999:review-context-v1',
          interventionId: 'token-intervention:review-context-v1:1186001',
          experimentId: 'review-context-v1',
          controlVariant: 'control',
          optimizedVariant: 'optimized',
          proposedSavingsAic: 12.5,
          previousInterventionState: 'proposed',
          interventionState: 'running',
          previousRecommendationDisposition: 'unapplied',
          recommendationDisposition: 'applied',
          evidenceState: 'complete',
          safeOutputId: 'github:issue:githubnext/gh-aw-cao:11861',
          safeOutputUrl: 'https://github.com/githubnext/gh-aw-cao/issues/11861',
          implementationChangeId: 'github:pull-request:octo/example:42',
          implementationPullRequestUrl: 'https://github.com/octo/example/pull/42',
          implementationRunIds: ['1187001'],
          acceptedAt: '2026-09-15T06:00:00Z',
          implementationStartedAt: '2026-09-15T07:00:00Z',
          implementationCompletedAt: '2026-09-16T04:00:00Z',
          sourceProvenance: {
            kind: 'workflow-dispatch-claim',
            sourceId: 'github-actions-run:githubnext/gh-aw-cao:1189001:attempt:1',
            sourceSchemaRevision: 1,
            generation: 'github-actions-run:githubnext/gh-aw-cao:1189001:attempt:1',
            completeness: 'complete',
            freshness: 'fresh',
            evidenceLinks: [
              'https://github.com/githubnext/gh-aw-cao/issues/11861',
              'https://github.com/octo/example/pull/42'
            ]
          }
        }
      }
    ];
    await ingestCachedGhAwJsonl(indexedDB, `${records.map((record) => JSON.stringify(record)).join('\n')}\n`, {
      now: Date.parse('2026-09-15T05:00:00Z')
    });

    const canonical = await queryCanonicalViewSources(
      indexedDB,
      {},
      ['audits']
    );
    const projected = executeDashboardQueries(
      [],
      canonical,
      ['token-efficiency-interventions']
    );

    expect(projected['token-efficiency-interventions'].rows).toEqual([
      expect.objectContaining({
        organization: 'octo',
        repository: 'example',
        'intervention-state': 'proposed',
        'recommendation-disposition': 'unapplied',
        'proposed-savings-aic': 12.5
      }),
      expect.objectContaining({
        organization: 'octo',
        repository: 'example',
        'lifecycle-observation-id': 'token-lifecycle:accepted-1',
        'previous-intervention-state': 'proposed',
        'intervention-state': 'running',
        'recommendation-disposition': 'applied',
        experiment: 'review-context-v1',
        'proposed-savings-aic': 12.5,
        'safe-output-id': 'github:issue:githubnext/gh-aw-cao:11861',
        'implementation-change-id': 'github:pull-request:octo/example:42',
        'implementation-run-ids': ['1187001'],
        'implementation-completed-at': '2026-09-16T04:00:00.000Z',
        'issue-link': 'https://github.com/githubnext/gh-aw-cao/issues/11861',
        'pull-request-link': 'https://github.com/octo/example/pull/42'
      })
    ]);
    expect(projected['token-efficiency-interventions'].rows[0]).not.toHaveProperty('issue-link');
    const latest = executeDashboardQueries([{
      name: 'latest-token-intervention',
      from: 'token-efficiency-interventions',
      select: [
        { field: 'intervention-id' },
        { field: 'intervention-state' },
        { field: 'recommendation-disposition' },
        { field: 'observed-at' }
      ],
      'order-by': [{ field: 'observed-at', direction: 'desc' }],
      limit: 1
    }], canonical, ['latest-token-intervention']);
    expect(latest['latest-token-intervention'].rows).toEqual([{
      'intervention-id': 'token-intervention:review-context-v1:1186001',
      'intervention-state': 'running',
      'recommendation-disposition': 'applied',
      'observed-at': '2026-09-16T04:02:00.000Z'
    }]);
  });

  it('keeps retained events available to event-backed views after a partial collection', async () => {
    await loadCanonicalViewSources(indexedDB, collection('generation-a', sources.audits.rows), { ingest: true });
    const partial = collection('generation-b', []);

    const projected = await loadCanonicalViewSources(indexedDB, partial, { ingest: true });
    const rows = /** @type {{ rows: Record<string, unknown>[] }} */ (projected.audits).rows;

    expect(rows.map((row) => row.event)).toEqual(['event:agent-turn']);
    expect(rows.map((row) => row['event-type'])).toEqual(['agent_turn']);
  });

  it('queries an empty database before fresh data is ingested', async () => {
    const projected = await loadCanonicalViewSources(indexedDB, sources);
    expect(/** @type {{ rows: unknown[] }} */ (projected.runs).rows).toEqual([]);
  });

  it('keeps lazy continuation snapshots safe across background IndexedDB updates', async () => {
    /** @param {string} generation @param {string[]} runIds */
    const snapshot = (generation, runIds) => {
      const input = structuredClone(sources);
      const collected = { ...metadata, 'artifact-generation': generation };
      for (const source of Object.values(input)) source.metadata = collected;
      input.runs.rows = runIds.map((run) => ({
        ...sources.runs.rows[0],
        run,
        'run-link': { relation: 'run', href: `https://github.com/githubnext/gh-aw-cao/actions/runs/${run}`, label: `Run ${run}` }
      }));
      input['job-performance'].rows = [];
      input.audits.rows = [];
      return input;
    };
    const definitions = [{
      name: 'recent-runs',
      from: 'runs',
      select: [{ field: 'run' }],
      'order-by': [{ field: 'run', direction: 'desc' }]
    }];
    const initial = snapshot('generation-a', ['42', '43', '44']);
    await loadCanonicalViewSources(indexedDB, initial, { ingest: true });
    const initialSources = await queryCanonicalViewSources(indexedDB, initial, ['runs']);
    const initialBudget = createDashboardQueryBudget();
    const firstPage = executeDashboardQueries(definitions, initialSources, ['recent-runs'], {
      budget: initialBudget,
      pagination: { 'recent-runs': { limit: 2 } }
    });

    expect(initialBudget.operations).toBe(0);

    const updated = snapshot('generation-b', ['42', '43', '44', '45']);
    await loadCanonicalViewSources(indexedDB, updated, { ingest: true });

    expect(initialBudget.operations).toBe(0);
    expect(firstPage['recent-runs'].rows).toEqual([{ run: '44' }, { run: '43' }]);
    expect(initialBudget.operations).toBeGreaterThan(0);

    const updatedSources = await queryCanonicalViewSources(indexedDB, updated, ['runs']);
    expect(() => executeDashboardQueries(definitions, updatedSources, ['recent-runs'], {
      pagination: {
        'recent-runs': {
          limit: 2,
          continuationToken: firstPage['recent-runs'].continuationToken
        }
      }
    })['recent-runs']).toThrow('Invalid or stale continuation token');

    const refreshedBudget = createDashboardQueryBudget();
    const refreshed = executeDashboardQueries(definitions, updatedSources, ['recent-runs'], {
      budget: refreshedBudget,
      pagination: { 'recent-runs': { limit: 2 } }
    });
    expect(refreshedBudget.operations).toBe(0);
    expect(refreshed['recent-runs'].rows).toEqual([{ run: '45' }, { run: '44' }]);
    expect(refreshedBudget.operations).toBeGreaterThan(0);
  });
});