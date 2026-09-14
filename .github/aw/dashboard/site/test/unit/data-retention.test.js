import { describe, expect, it } from 'vitest';
import { normalize } from '../../src/data/normalize/index.js';
import {
  BROWSER_RETENTION_WINDOWS_MS,
  capCanonicalBatchSize,
  estimateCanonicalBatchBytes,
  mergeRetainedRecords,
  RETENTION_WINDOW_DAYS
} from '../../src/data/storage/retention.js';

const NOW = Date.parse('2026-09-09T05:00:00Z');

/**
 * @param {{ eventId: string, timestamp: string, sessionId?: string }[]} events
 */
function batch(events) {
  const sessionIds = new Set(events.map((event) => event.sessionId ?? 'session:1'));
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
        id: 'run:1',
        repositoryId: 'repository:1',
        workflowId: 'workflow:1',
        startedAt: '2026-09-09T04:00:00Z'
      }
    },
    ...[...sessionIds].map((sessionId) => ({
      kind: /** @type {const} */ ('session'),
      source: 'fixture',
      sourceId: sessionId,
      observedAt: '2026-09-09T05:00:00Z',
      data: { id: sessionId, runId: 'run:1', startedAt: '2026-09-09T04:00:00Z' }
    })),
    ...events.map((event) => ({
      kind: /** @type {const} */ ('event'),
      source: 'fixture',
      sourceId: event.eventId,
      observedAt: event.timestamp,
      data: {
        id: event.eventId,
        sessionId: event.sessionId ?? 'session:1',
        timestamp: event.timestamp,
        source: 'agent',
        type: 'agent_turn'
      }
    }))
  ]);
}

describe('canonical retention merge', () => {
  it('upserts a partial collection onto retained events', () => {
    const previous = batch([
      { eventId: 'event:1', timestamp: '2026-09-01T04:00:00Z' },
      { eventId: 'event:2', timestamp: '2026-09-05T04:00:00Z' }
    ]);
    const incoming = batch([
      { eventId: 'event:2', timestamp: '2026-09-05T04:00:00Z' },
      { eventId: 'event:3', timestamp: '2026-09-09T04:00:00Z' }
    ]);

    const merged = mergeRetainedRecords(previous, incoming, { now: NOW });

    expect(merged.events.map((event) => event.id)).toEqual(['event:1', 'event:2', 'event:3']);
    expect(merged.events.map((event) => event.sequence)).toEqual([0, 1, 2]);
  });

  it(`prunes retained events observed before the ${RETENTION_WINDOW_DAYS}-day window`, () => {
    const previous = batch([
      { eventId: 'event:expired', timestamp: '2026-07-01T04:00:00Z' },
      { eventId: 'event:retained', timestamp: '2026-08-20T04:00:00Z' }
    ]);
    const incoming = batch([
      { eventId: 'event:current', timestamp: '2026-09-09T04:00:00Z' }
    ]);

    const merged = mergeRetainedRecords(previous, incoming, { now: NOW });

    expect(merged.events.map((event) => event.id)).toEqual(['event:retained', 'event:current']);
  });

  it('keeps historical run summaries while pruning historical detail in the browser', () => {
    const incoming = batch([
      { eventId: 'event:historical', timestamp: '2026-07-01T04:00:00Z' }
    ]);
    incoming.runs[0].startedAt = '2026-07-01T04:00:00Z';
    incoming.runs[0].observedAt = '2026-07-01T04:00:00Z';
    incoming.sessions[0].startedAt = '2026-07-01T04:00:00Z';
    incoming.sessions[0].observedAt = '2026-07-01T04:00:00Z';

    const merged = mergeRetainedRecords(normalize([]), incoming, {
      now: NOW,
      retentionWindowMsByStore: BROWSER_RETENTION_WINDOWS_MS
    });

    expect(merged.runs.map((run) => run.id)).toEqual(['run:1']);
    expect(merged.sessions).toEqual([]);
    expect(merged.events).toEqual([]);
    expect(merged.workflows.map((workflow) => workflow.id)).toEqual(['workflow:1']);
    expect(merged.repositories.map((repository) => repository.id)).toEqual(['repository:1']);
  });

  it('drops retained records whose parents no longer survive', () => {
    const previous = batch([
      { eventId: 'event:orphan', timestamp: '2026-09-01T04:00:00Z', sessionId: 'session:orphan' }
    ]);
    previous.sessions = previous.sessions.filter((session) => session.id !== 'session:orphan');
    previous.runs[0].startedAt = '2026-07-01T04:00:00Z';
    previous.runs[0].observedAt = '2026-07-01T04:00:00Z';
    const incoming = batch([
      { eventId: 'event:current', timestamp: '2026-09-09T04:00:00Z' }
    ]);

    const merged = mergeRetainedRecords(previous, incoming, { now: NOW });

    expect(merged.events.map((event) => event.id)).toEqual(['event:current']);
    expect(merged.sessions.map((session) => session.id)).toEqual(['session:1']);
  });

  it('expires retained records that carry no usable observation time', () => {
    const previous = batch([
      { eventId: 'event:untimed', timestamp: '2026-09-01T04:00:00Z' }
    ]);
    for (const event of previous.events) {
      delete event.timestamp;
      delete event.observedAt;
    }
    const incoming = batch([
      { eventId: 'event:current', timestamp: '2026-09-09T04:00:00Z' }
    ]);

    const merged = mergeRetainedRecords(previous, incoming, { now: NOW });

    expect(merged.events.map((event) => event.id)).toEqual(['event:current']);
  });

  it('collects structural parents that no retained record still references', () => {
    const previous = batch([
      { eventId: 'event:expired', timestamp: '2026-07-01T04:00:00Z' }
    ]);
    previous.repositories.push({ id: 'repository:removed', owner: 'githubnext', name: 'removed' });
    previous.workflows.push({
      id: 'workflow:removed',
      repositoryId: 'repository:removed',
      path: '.github/workflows/removed.md'
    });
    const incoming = batch([
      { eventId: 'event:current', timestamp: '2026-09-09T04:00:00Z' }
    ]);

    const merged = mergeRetainedRecords(previous, incoming, { now: NOW });

    expect(merged.repositories.map((repository) => repository.id)).toEqual(['repository:1']);
    expect(merged.workflows.map((workflow) => workflow.id)).toEqual(['workflow:1']);
  });

  it('keeps retained runs whose workflow is missing from a partial collection', () => {
    const previous = batch([
      { eventId: 'event:1', timestamp: '2026-09-01T04:00:00Z' }
    ]);
    const incoming = normalize([]);

    const merged = mergeRetainedRecords(previous, incoming, { now: NOW });

    expect(merged.repositories.map((repository) => repository.id)).toEqual(['repository:1']);
    expect(merged.workflows.map((workflow) => workflow.id)).toEqual(['workflow:1']);
    expect(merged.runs.map((run) => run.id)).toEqual(['run:1']);
    expect(merged.events.map((event) => event.id)).toEqual(['event:1']);
  });

  it('drops the oldest whole run subtree to fit a byte cap', () => {
    const records = batch([
      { eventId: 'event:old', timestamp: '2026-09-01T04:00:00Z', sessionId: 'session:old' }
    ]);
    records.runs[0].startedAt = '2026-09-01T04:00:00Z';
    records.runs.push({
      ...records.runs[0],
      id: 'run:new',
      startedAt: '2026-09-09T04:00:00Z'
    });
    records.jobs.push({ id: 'job:old', runId: 'run:1', name: 'old' });
    records.jobs.push({ id: 'job:new', runId: 'run:new', name: 'new' });
    records.sessions.push({
      ...records.sessions[0],
      id: 'session:new',
      runId: 'run:new',
      startedAt: '2026-09-09T04:00:00Z'
    });
    records.events.push({
      ...records.events[0],
      id: 'event:new',
      sessionId: 'session:new',
      timestamp: '2026-09-09T04:00:00Z'
    });

    const capped = capCanonicalBatchSize(records, estimateCanonicalBatchBytes(records) - 1);

    expect(capped.runs.map((run) => run.id)).toEqual(['run:new']);
    expect(capped.jobs.map((job) => job.id)).toEqual(['job:new']);
    expect(capped.sessions.map((session) => session.id)).toEqual(['session:new']);
    expect(capped.events.map((event) => event.id)).toEqual(['event:new']);
  });
});
