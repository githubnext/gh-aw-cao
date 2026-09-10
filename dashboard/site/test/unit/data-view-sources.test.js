import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it } from 'vitest';
import { DATABASE_NAME } from '../../src/data/storage/indexeddb.js';
import { createCanonicalQueries } from '../../src/data/queries/index.js';
import { loadCanonicalViewSources, queryCanonicalViewSources } from '../../src/data/queries/view-sources.js';

const metadata = { 'as-of': '2026-09-09T05:00:00Z', 'artifact-generation': 'generation-a' };
const sources = {
  repositories: { rows: [{ organization: 'githubnext', repository: 'gh-aw-cao' }], metadata },
  workflows: { rows: [{ organization: 'githubnext', repository: 'gh-aw-cao', workflow: '.github/workflows/dashboard.md' }], metadata },
  runs: {
    rows: [{
      organization: 'githubnext', repository: 'gh-aw-cao', workflow: '.github/workflows/dashboard.md',
      run: '42', 'run-attempt': 2, 'run-status': 'completed', 'run-conclusion': 'failure',
      'started-at': '2026-09-09T04:00:00Z', 'failure-detail': 'Build failed',
      'rollout-mode': 'review', engine: 'copilot', 'engine-version': '1.2.3',
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
  it('queries only the canonical payload requested by a view', async () => {
    await loadCanonicalViewSources(indexedDB, sources, { ingest: true });

    const projected = await queryCanonicalViewSources(
      indexedDB,
      sources,
      metadata['artifact-generation'],
      ['failed-runs']
    );

    expect(Object.keys(projected)).toEqual(['failed-runs']);
    expect(projected['failed-runs']).toMatchObject({
      source: 'failed-runs',
      rows: [{ repository: 'gh-aw-cao', run: '42', 'run-conclusion': 'failure' }],
      metadata: { 'source-kind': 'canonical-query' }
    });
  });

  it('projects work items and security findings from canonical entities', async () => {
    await loadCanonicalViewSources(indexedDB, sources, { ingest: true });

    const projected = await queryCanonicalViewSources(
      indexedDB,
      sources,
      metadata['artifact-generation'],
      ['work-items', 'security-findings']
    );

    expect(Object.keys(projected)).toEqual(['work-items', 'security-findings']);
    expect(projected['work-items']).toMatchObject({
      source: 'work-items',
      rows: [{ 'work-item-id': 'githubnext/gh-aw-cao:.github/workflows/dashboard.md', 'lifecycle-state': 'blocked' }],
      metadata: { 'source-kind': 'canonical-query' }
    });

    expect(projected['security-findings']).toMatchObject({
      source: 'security-findings',
      rows: [{ 'smell-observation-id': 'threat-detection:observation-1', 'smell-severity': 'high' }],
      metadata: { 'source-kind': 'canonical-query' }
    });
    const queries = createCanonicalQueries(indexedDB);
    await expect(queries.workItems.byLifecycleState('blocked')).resolves.toEqual([
      expect.objectContaining({ lifecycleState: 'blocked', workItemId: 'githubnext/gh-aw-cao:.github/workflows/dashboard.md' })
    ]);
    await expect(queries.findings.bySeverity('high')).resolves.toEqual([
      expect.objectContaining({ observationId: 'threat-detection:observation-1', severity: 'high' })
    ]);
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

  it('projects event-backed view sources from retained canonical events', async () => {
    await loadCanonicalViewSources(indexedDB, sources, { ingest: true });

    const projected = await queryCanonicalViewSources(
      indexedDB,
      sources,
      metadata['artifact-generation'],
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

  it('keeps retained events available to event-backed views after a partial collection', async () => {
    await loadCanonicalViewSources(indexedDB, collection('generation-a', sources.events.rows), { ingest: true });
    const partial = collection('generation-b', sources.events.rows.filter((row) => row.event === 'event:agent-turn'));

    const projected = await loadCanonicalViewSources(indexedDB, partial, { ingest: true });
    const rows = /** @type {{ rows: Record<string, unknown>[] }} */ (projected.events).rows;

    expect(rows.map((row) => row.event)).toEqual(['event:tool-call', 'event:agent-turn']);
    expect(rows.map((row) => row['event-type'])).toEqual(['tool.call', 'agent_turn']);
  });

  it('rejects a generation that is not active and usable', async () => {
    await expect(loadCanonicalViewSources(indexedDB, sources)).rejects.toThrow(
      'Canonical generation generation-a is not active and usable'
    );
  });
});