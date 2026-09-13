import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it } from 'vitest';
import { ingestCachedGhAwJsonl } from '../../src/data/ingest/coordinator.js';
import { DATABASE_NAME, recordTransaction } from '../../src/data/storage/indexeddb.js';
import { loadCanonicalViewSources, queryCanonicalViewSources } from '../../src/data/queries/view-sources.js';
import { createDashboardQueryBudget, executeDashboardQueries } from '../../src/data/queries/declarative.js';

const metadata = { 'as-of': '2026-09-09T05:00:00Z', 'artifact-generation': 'generation-a' };
const sources = {
  packages: {
    rows: [{
      package: 'dashboard', 'package-name': 'CAO Dashboard', 'package-description': 'Deploy the dashboard.',
      'package-icon': 'graph', 'package-mode': 'review', 'package-enabled': true,
      'package-worker-count': 1, 'package-min-version': 'v0.89.3', 'package-experimental': true
    }],
    metadata
  },
  repositories: { rows: [{ organization: 'githubnext', repository: 'gh-aw-cao' }], metadata },
  workflows: {
    rows: [{
      organization: 'githubnext', repository: 'gh-aw-cao', workflow: '.github/workflows/dashboard.md',
      package: 'dashboard', 'package-name': 'CAO Dashboard', 'workflow-role': 'worker', 'rollout-mode': 'review'
    }],
    metadata
  },
  runs: {
    rows: [{
      organization: 'githubnext', repository: 'gh-aw-cao', workflow: '.github/workflows/dashboard.md',
      run: '42', 'run-attempt': 2, 'run-status': 'completed', 'run-conclusion': 'failure',
      'started-at': '2026-09-09T04:00:00Z', 'failure-detail': 'Build failed',
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
      run: '42', 'workflow-name': 'Dashboard', 'workflow-icon': 'workflow', package: 'dashboard',
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
  sessions: {
    rows: [{
      organization: 'githubnext', repository: 'gh-aw-cao', workflow: '.github/workflows/dashboard.md',
      run: '42', 'run-attempt': 2, session: 'session:run-42', 'job-id': '99',
      'session-kind': 'unified-operational-log', 'session-status': 'completed',
      'started-at': '2026-09-09T04:00:00Z', 'observed-at': '2026-09-09T04:00:00Z'
    }],
    metadata
  },
  events: {
    rows: [
      {
        organization: 'githubnext', repository: 'gh-aw-cao', workflow: '.github/workflows/dashboard.md',
        run: '42', 'run-attempt': 2, session: 'session:run-42', event: 'event:tool-call',
        'event-timestamp': '2026-09-09T04:00:10Z', 'event-source': 'mcp', 'event-type': 'tool.call',
        'event-summary': 'github.list_issues', 'event-status': 'requested',
        'correlation-id': 'call-1', 'source-sequence': 0, 'observed-at': '2026-09-09T04:00:10Z'
      },
      {
        organization: 'githubnext', repository: 'gh-aw-cao', workflow: '.github/workflows/dashboard.md',
        run: '42', 'run-attempt': 2, session: 'session:run-42', event: 'event:agent-turn',
        'event-timestamp': '2026-09-09T04:00:20Z', 'event-source': 'agent', 'event-type': 'agent_turn',
        'event-summary': 'Planned the change', 'source-sequence': 1, 'observed-at': '2026-09-09T04:00:20Z'
      }
    ],
    metadata
  },
  usage: {
    rows: [{ organization: 'githubnext', repository: 'gh-aw-cao', workflow: '.github/workflows/dashboard.md', run: '42', aic: 17 }],
    metadata
  }
};

/**
 * @param {string} generation
 * @param {Record<string, unknown>[]} eventRows
 */
function collection(generation, eventRows) {
  const collected = { 'as-of': metadata['as-of'], 'artifact-generation': generation };
  return Object.fromEntries(Object.entries(sources).map(([name, source]) => [
    name,
    { rows: name === 'events' ? eventRows : source.rows, metadata: collected }
  ]));
}

beforeEach(async () => {
  await new Promise((resolve, reject) => {
    const request = indexedDB.deleteDatabase(DATABASE_NAME);
    request.onsuccess = () => resolve(undefined);
    request.onerror = () => reject(request.error);
  });
});

describe('canonical view sources', () => {
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
      metadata: { 'source-kind': 'canonical-query', availability: 'available' },
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

    const projected = await queryCanonicalViewSources(
      indexedDB,
      sources,
      ['failed-runs']
    );

    expect(Object.keys(projected)).toEqual(['failed-runs']);
    expect(projected['failed-runs']).toMatchObject({
      source: 'failed-runs',
      rows: [{ repository: 'gh-aw-cao', run: '42', 'run-conclusion': 'failure' }],
      metadata: { 'source-kind': 'canonical-query' }
    });
  });

  it('projects package rows and workflow membership from canonical records', async () => {
    await loadCanonicalViewSources(indexedDB, sources, { ingest: true });

    const projected = await queryCanonicalViewSources(indexedDB, sources, ['packages', 'workflows']);

    expect(projected.packages).toMatchObject({
      source: 'packages',
      rows: [{
        package: 'dashboard',
        'package-name': 'CAO Dashboard',
        'package-description': 'Deploy the dashboard.',
        'package-mode': 'review',
        'package-worker-count': 1
      }],
      metadata: { 'source-kind': 'canonical-query' }
    });
    expect(projected.workflows.rows).toEqual([
      expect.objectContaining({
        package: 'dashboard',
        'package-name': 'CAO Dashboard',
        'workflow-role': 'worker'
      })
    ]);
  });

  it('keeps work items and security findings outside canonical entities', async () => {
    const loaded = await loadCanonicalViewSources(indexedDB, sources, { ingest: true });

    const projected = await queryCanonicalViewSources(
      indexedDB,
      sources,
      ['work-items', 'security-findings']
    );

    expect(projected).toEqual({});
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
    const projected = await loadCanonicalViewSources(indexedDB, sources, { ingest: true });

    expect(projected['failed-runs']).toMatchObject({
      source: 'failed-runs',
      rows: [{ repository: 'gh-aw-cao', run: '42', 'run-attempt': 2, 'run-conclusion': 'failure', 'failure-detail': 'Build failed' }],
      metadata: { 'source-kind': 'canonical-query', availability: 'available' }
    });
    expect(projected.runs).toMatchObject({
      source: 'runs',
      rows: [{
        repository: 'gh-aw-cao', run: '42', 'run-attempt': 2,
        'rollout-mode': 'review', engine: 'copilot', 'engine-version': '1.2.3',
        'gh-aw-version': 'v0.89.4',
        'requested-model': 'model-a', 'resolved-model': 'model-b'
      }],
      metadata: { 'source-kind': 'canonical-query', availability: 'available' }
    });
    expect(projected.repositories).toMatchObject({
      source: 'repositories',
      rows: [{ organization: 'githubnext', repository: 'gh-aw-cao' }],
      metadata: { 'source-kind': 'canonical-query', availability: 'available' }
    });
    expect(projected.workflows).toMatchObject({
      source: 'workflows',
      rows: [{
        organization: 'githubnext', repository: 'gh-aw-cao',
        workflow: '.github/workflows/dashboard.md'
      }],
      metadata: { 'source-kind': 'canonical-query', availability: 'available' }
    });
    expect(projected['job-performance']).toMatchObject({
      source: 'job-performance',
      rows: [{
        organization: 'githubnext', repository: 'gh-aw-cao', run: '42',
        'run-attempt': 2, 'job-id': '99', job: 'build',
        'job-duration-seconds': 120, runner: 'ubuntu-latest', engine: 'copilot', model: 'model-b'
      }],
      metadata: { 'source-kind': 'canonical-query', availability: 'available' }
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

  it('projects event-backed view sources from retained canonical events', async () => {
    await loadCanonicalViewSources(indexedDB, sources, { ingest: true });

    const projected = await queryCanonicalViewSources(
      indexedDB,
      sources,
      ['events']
    );

    expect(Object.keys(projected)).toEqual(['events']);
    expect(projected.events).toMatchObject({
      source: 'events',
      metadata: { 'source-kind': 'canonical-query', availability: 'available' }
    });
    expect(projected.events.rows).toEqual([
      expect.objectContaining({
        organization: 'githubnext',
        repository: 'gh-aw-cao',
        workflow: '.github/workflows/dashboard.md',
        run: '42',
        'run-attempt': 2,
        session: 'session:run-42',
        event: 'event:tool-call',
        'event-type': 'tool.call',
        'event-source': 'mcp',
        'event-summary': 'github.list_issues',
        'correlation-id': 'call-1'
      }),
      expect.objectContaining({ event: 'event:agent-turn', 'event-source': 'agent', 'event-type': 'agent_turn' })
    ]);
  });

  it('projects current gh-aw grader summaries without treating zero as missing', async () => {
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
            value: 0
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

    expect(projected['grader-observations'].rows).toEqual([
      expect.objectContaining({
        repository: 'gh-aw-cao',
        run: '84',
        grader: 'operational-value',
        status: 'pass',
        included: true,
        value: 0
      })
    ]);
    expect(projected['operational-values'].rows).toEqual([
      expect.objectContaining({
        repository: 'gh-aw-cao',
        run: '84',
        'operational-value': 0,
        'operational-case': 'run:84',
        'maturity-status': 'observed'
      })
    ]);
  });

  it('keeps retained events available to event-backed views after a partial collection', async () => {
    await loadCanonicalViewSources(indexedDB, collection('generation-a', sources.events.rows), { ingest: true });
    const partial = collection('generation-b', sources.events.rows.filter((row) => row.event === 'event:agent-turn'));

    const projected = await loadCanonicalViewSources(indexedDB, partial, { ingest: true });
    const rows = /** @type {{ rows: Record<string, unknown>[] }} */ (projected.events).rows;

    expect(rows.map((row) => row.event)).toEqual(['event:tool-call', 'event:agent-turn']);
    expect(rows.map((row) => row['event-type'])).toEqual(['tool.call', 'agent_turn']);
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
      input.sessions.rows = [];
      input.events.rows = [];
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