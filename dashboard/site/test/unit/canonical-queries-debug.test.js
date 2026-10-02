import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { DATABASE_NAME, upsertCanonicalBatch } from '../../src/data/storage/indexeddb.js';

async function resetDatabase() {
  await new Promise((resolve, reject) => {
    const request = indexedDB.deleteDatabase(DATABASE_NAME);
    request.onsuccess = () => resolve(undefined);
    request.onerror = () => reject(request.error);
  });
}

function fixtureBatch() {
  return {
    campaigns: [{ id: 'campaign:1', slug: 'aw-doctor', name: 'aw-doctor' }],
    repositories: [{ id: 'repository:1', fullName: 'githubnext/gh-aw-cao' }],
    workflows: [],
    runs: [
      {
        id: 'run:1', repositoryId: 'repository:1', workflowId: 'workflow:1',
        conclusion: 'failure', startedAt: '2026-09-09T04:00:00Z'
      },
      {
        id: 'run:2', repositoryId: 'repository:1', workflowId: 'workflow:1',
        conclusion: 'success', startedAt: '2026-09-09T05:00:00Z'
      }
    ],
    domains: [], tools: [
      { id: 'tool:1', runId: 'run:1', sequence: 1 },
      { id: 'tool:2', runId: 'run:1', sequence: 2 }
    ],
    skills: [], friction: [], audits: [], issues: [],
    operationalValues: [], marketplacePackages: [], experiments: [],
    experimentAssignments: [], graders: [], graderObservations: [], evals: [], evalObservations: []
  };
}

/**
 * @param {ReturnType<typeof vi.fn>} debugFn
 * @param {string} search
 */
function mockDebugModule(debugFn, search) {
  const output = /** @type {Pick<Console, 'debug'>} */ ({ debug: debugFn });
  vi.doMock('../../src/debug.js', async () => {
    const actual = /** @type {typeof import('../../src/debug.js')} */ (
      await vi.importActual('../../src/debug.js')
    );
    return {
      ...actual,
      createDebug: (/** @type {string} */ category) => actual.createDebug(category, { search: () => search, output })
    };
  });
  vi.resetModules();
}

afterEach(() => {
  vi.doUnmock('../../src/debug.js');
  vi.resetModules();
});

describe('canonical queries debug logging', () => {
  beforeEach(async () => {
    await resetDatabase();
  });

  it('is disabled by default (no debug output) when the debug query is absent', async () => {
    const debugFn = vi.fn();
    mockDebugModule(debugFn, '');
    await upsertCanonicalBatch(indexedDB, fixtureBatch(), { validateRelationships: false });
    const { createCanonicalQueries } = await import('../../src/data/queries/index.js');

    const queries = createCanonicalQueries(indexedDB);
    await queries.campaigns.getBySlug('aw-doctor');
    await queries.runs.recentFailures();
    await queries.tools.forRun('run:1');

    expect(debugFn).not.toHaveBeenCalled();
  });

  it('logs the three derived-query boundaries under a predictable category when enabled', async () => {
    const debugFn = vi.fn();
    mockDebugModule(debugFn, '?debug=canonical-queries');
    await upsertCanonicalBatch(indexedDB, fixtureBatch(), { validateRelationships: false });
    const { createCanonicalQueries } = await import('../../src/data/queries/index.js');

    const queries = createCanonicalQueries(indexedDB);
    await queries.campaigns.getBySlug('aw-doctor');
    await queries.runs.recentFailures();
    await queries.tools.forRun('run:1');

    const events = debugFn.mock.calls.map(([, payload]) => payload.event);
    expect(events).toContain('campaigns.get-by-slug');
    expect(events).toContain('runs.recent-failures');
    expect(events).toContain('run-linked.for-run');
    for (const call of debugFn.mock.calls) {
      expect(call[0]).toBe('[cao:canonical-queries]');
    }
  });

  it('reports a found/count summary, never the campaign slug or collection row contents', async () => {
    const debugFn = vi.fn();
    mockDebugModule(debugFn, '?debug=canonical-queries');
    await upsertCanonicalBatch(indexedDB, fixtureBatch(), { validateRelationships: false });
    const { createCanonicalQueries } = await import('../../src/data/queries/index.js');

    const queries = createCanonicalQueries(indexedDB);
    const found = await queries.campaigns.getBySlug('aw-doctor');
    expect(found).not.toBeNull();
    const failures = await queries.runs.recentFailures();
    expect(failures).toHaveLength(1);
    const tools = await queries.tools.forRun('run:1');
    expect(tools).toHaveLength(2);

    for (const call of debugFn.mock.calls) {
      const [, payload] = call;
      for (const value of Object.values(payload)) {
        expect(typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean').toBe(true);
      }
      expect(JSON.stringify(payload)).not.toContain('aw-doctor');
      expect(JSON.stringify(payload)).not.toContain('run:1');
      expect(JSON.stringify(payload)).not.toContain('githubnext');
    }

    const bySlugCall = debugFn.mock.calls.find(([, payload]) => payload.event === 'campaigns.get-by-slug');
    expect(bySlugCall?.[1]).toEqual({ event: 'campaigns.get-by-slug', found: true });

    const failuresCall = debugFn.mock.calls.find(([, payload]) => payload.event === 'runs.recent-failures');
    expect(failuresCall?.[1]).toEqual({ event: 'runs.recent-failures', count: 1 });

    const toolsCall = debugFn.mock.calls.find(([, payload]) => payload.event === 'run-linked.for-run');
    expect(toolsCall?.[1]).toEqual({ event: 'run-linked.for-run', collection: 'tools', count: 2 });
  });
});
