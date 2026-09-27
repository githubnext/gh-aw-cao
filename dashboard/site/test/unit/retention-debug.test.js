import { afterEach, describe, expect, it, vi } from 'vitest';
import { normalize } from '../../src/data/normalize/index.js';

const NOW = Date.parse('2026-09-09T05:00:00Z');

/**
 * @param {{ eventId: string, timestamp: string, runId?: string }[]} events
 */
function batch(events) {
  return normalize([
    {
      kind: 'repository',
      source: 'fixture',
      sourceId: 'repository-1',
      observedAt: '2026-09-09T05:00:00Z',
      data: { id: 'repository:1', owner: 'githubnext', name: 'gh-aw-cao' }
    },
    {
      kind: 'workflow',
      source: 'fixture',
      sourceId: 'workflow-1',
      observedAt: '2026-09-09T05:00:00Z',
      data: { id: 'workflow:1', repositoryId: 'repository:1', path: '.github/workflows/dashboard.md' }
    },
    {
      kind: 'run',
      source: 'fixture',
      sourceId: 'run-1',
      observedAt: '2026-09-09T05:00:00Z',
      data: {
        githubRunId: 1,
        owner: 'githubnext',
        repository: 'gh-aw-cao',
        repositoryId: 'repository:1',
        workflowId: 'workflow:1',
        startedAt: '2026-09-09T04:00:00Z'
      }
    },
    ...events.map((event) => ({
      kind: /** @type {const} */ ('audit'),
      source: 'fixture',
      sourceId: event.eventId,
      observedAt: event.timestamp,
      data: {
        id: event.eventId,
        runId: event.runId ?? 'github:run:githubnext/gh-aw-cao:1',
        timestamp: event.timestamp,
        source: 'agent',
        type: 'agent_turn'
      }
    }))
  ]);
}

afterEach(() => {
  vi.doUnmock('../../src/debug.js');
  vi.resetModules();
});

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

describe('retention debug logging', () => {
  it('is disabled by default (no debug output) when the debug query is absent', async () => {
    const debugFn = vi.fn();
    mockDebugModule(debugFn, '');
    const { mergeRetainedRecords, capCanonicalBatchSize, estimateCanonicalBatchBytes } = await import(
      '../../src/data/storage/retention.js'
    );

    const previous = batch([{ eventId: 'event:1', timestamp: '2026-09-01T04:00:00Z' }]);
    const incoming = batch([{ eventId: 'event:2', timestamp: '2026-09-09T04:00:00Z' }]);
    mergeRetainedRecords(previous, incoming, { now: NOW });
    capCanonicalBatchSize(incoming, estimateCanonicalBatchBytes(incoming) - 1);

    expect(debugFn).not.toHaveBeenCalled();
  });

  it('logs merged batch counts under its predictable category when enabled', async () => {
    const debugFn = vi.fn();
    mockDebugModule(debugFn, '?debug=retention');
    const { mergeRetainedRecords } = await import('../../src/data/storage/retention.js');

    const previous = batch([{ eventId: 'event:1', timestamp: '2026-09-01T04:00:00Z' }]);
    const incoming = batch([{ eventId: 'event:2', timestamp: '2026-09-09T04:00:00Z' }]);
    mergeRetainedRecords(previous, incoming, { now: NOW });

    expect(debugFn).toHaveBeenCalledWith(
      '[cao:retention]',
      expect.objectContaining({ event: 'merged', runCount: expect.any(Number), repositoryCount: expect.any(Number), workflowCount: expect.any(Number) })
    );
  });

  it('logs a batch-capped event with the eviction outcome when enabled', async () => {
    const debugFn = vi.fn();
    mockDebugModule(debugFn, '?debug=retention');
    const { capCanonicalBatchSize, estimateCanonicalBatchBytes } = await import('../../src/data/storage/retention.js');

    const records = batch([{ eventId: 'event:old', timestamp: '2026-09-01T04:00:00Z' }]);
    records.runs[0].startedAt = '2026-09-01T04:00:00Z';
    records.runs.push({ ...records.runs[0], id: 'run:new', startedAt: '2026-09-09T04:00:00Z' });
    records.audits.push({ ...records.audits[0], id: 'event:new', runId: 'run:new', timestamp: '2026-09-09T04:00:00Z' });

    capCanonicalBatchSize(records, estimateCanonicalBatchBytes(records) - 1);

    expect(debugFn).toHaveBeenCalledWith(
      '[cao:retention]',
      expect.objectContaining({ event: 'batch-capped', evictedRunCount: 1 })
    );
  });

  it('never logs record content, only scalar counts and identifiers', async () => {
    const debugFn = vi.fn();
    mockDebugModule(debugFn, '?debug=retention');
    const { mergeRetainedRecords } = await import('../../src/data/storage/retention.js');

    const previous = batch([{ eventId: 'event:1', timestamp: '2026-09-01T04:00:00Z' }]);
    const incoming = batch([{ eventId: 'event:2', timestamp: '2026-09-09T04:00:00Z' }]);
    mergeRetainedRecords(previous, incoming, { now: NOW });

    for (const call of debugFn.mock.calls) {
      const [, payload] = call;
      for (const value of Object.values(payload)) {
        expect(typeof value === 'string' || typeof value === 'number').toBe(true);
      }
      expect(JSON.stringify(payload)).not.toContain('gh-aw-cao');
      expect(JSON.stringify(payload)).not.toContain('event:');
    }
  });
});
