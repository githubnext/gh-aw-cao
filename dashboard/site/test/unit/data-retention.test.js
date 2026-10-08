import { describe, expect, it } from 'vitest';
import { normalize } from '../../src/data/normalize/index.js';
import {
  BROWSER_RETENTION_WINDOWS_MS,
  capCanonicalBatchSize,
  estimateCanonicalBatchBytes,
  mergeRetainedRecords,
  RUN_DETAIL_RETENTION_DAYS
} from '../../src/data/storage/retention.js';
import { relationshipErrors } from '../../src/data/model/schema.js';

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

describe('canonical retention merge', () => {
  it('upserts a partial collection onto retained events', () => {
    const previous = batch([
      { eventId: 'event:1', timestamp: '2026-09-03T04:00:00Z' },
      { eventId: 'event:2', timestamp: '2026-09-05T04:00:00Z' }
    ]);
    const incoming = batch([
      { eventId: 'event:2', timestamp: '2026-09-05T04:00:00Z' },
      { eventId: 'event:3', timestamp: '2026-09-09T04:00:00Z' }
    ]);

    const merged = mergeRetainedRecords(previous, incoming, { now: NOW });

    expect(merged.audits.map((event) => event.id)).toEqual(['event:1', 'event:2', 'event:3']);
    expect(merged.audits.map((event) => event.sequence)).toEqual([0, 1, 2]);
    expect(merged.audits[0]).toBe(previous.audits[0]);
  });

  it(`prunes run-linked events observed before the ${RUN_DETAIL_RETENTION_DAYS}-day window`, () => {
    const previous = batch([
      { eventId: 'event:expired', timestamp: '2026-07-01T04:00:00Z' },
      { eventId: 'event:retained', timestamp: '2026-09-03T04:00:00Z' }
    ]);
    const incoming = batch([
      { eventId: 'event:current', timestamp: '2026-09-09T04:00:00Z' }
    ]);

    const merged = mergeRetainedRecords(previous, incoming, { now: NOW });

    expect(merged.audits.map((event) => event.id)).toEqual(['event:retained', 'event:current']);
  });

  it('keeps historical run summaries while pruning historical detail in the browser', () => {
    const incoming = batch([
      { eventId: 'event:historical', timestamp: '2026-07-01T04:00:00Z' }
    ]);
    incoming.runs[0].startedAt = '2026-07-01T04:00:00Z';
    incoming.runs[0].observedAt = '2026-07-01T04:00:00Z';

    const merged = mergeRetainedRecords(normalize([]), incoming, {
      now: NOW,
      retentionWindowMsByStore: BROWSER_RETENTION_WINDOWS_MS
    });

    expect(merged.runs.map((run) => run.id)).toEqual(['github:run:githubnext/gh-aw-cao:1']);
    expect(merged.audits).toEqual([]);
    expect(merged.workflows.map((workflow) => workflow.id)).toEqual(['workflow:1']);
    expect(merged.repositories.map((repository) => repository.id)).toEqual(['repository:1']);
  });

  it('drops retained records whose parents no longer survive', () => {
    const previous = batch([
      { eventId: 'event:orphan', timestamp: '2026-09-01T04:00:00Z' }
    ]);
    previous.audits[0].runId = 'run:missing';
    const incoming = batch([
      { eventId: 'event:current', timestamp: '2026-09-09T04:00:00Z' }
    ]);

    const merged = mergeRetainedRecords(previous, incoming, { now: NOW });

    expect(merged.audits.map((event) => event.id)).toEqual(['event:current']);
  });

  it('drops retained evidence whose definition belongs to a different workflow than its run', () => {
    const previous = batch([]);
    const observedAt = new Date(NOW).toISOString();
    previous.experiments ??= [];
    previous.experimentAssignments ??= [];
    previous.graders ??= [];
    previous.graderObservations ??= [];
    previous.evals ??= [];
    previous.evalObservations ??= [];
    previous.workflows.push({
      id: 'workflow:2',
      repositoryId: 'repository:1',
      path: '.github/workflows/other.md'
    });
    previous.experiments.push(
      { id: 'experiment:1', workflowId: 'workflow:1', name: 'prompt', observedAt },
      { id: 'experiment:2', workflowId: 'workflow:2', name: 'prompt', observedAt }
    );
    previous.experimentAssignments.push(
      { id: 'assignment:valid', runId: previous.runs[0].id, experimentId: 'experiment:1', timestamp: observedAt },
      { id: 'assignment:invalid', runId: previous.runs[0].id, experimentId: 'experiment:2', timestamp: observedAt }
    );
    previous.graders.push(
      { id: 'grader:1', workflowId: 'workflow:1', name: 'quality', observedAt },
      { id: 'grader:2', workflowId: 'workflow:2', name: 'quality', observedAt }
    );
    previous.graderObservations.push(
      { id: 'grade:valid', runId: previous.runs[0].id, graderId: 'grader:1', timestamp: observedAt },
      { id: 'grade:invalid', runId: previous.runs[0].id, graderId: 'grader:2', timestamp: observedAt }
    );
    previous.evals.push(
      { id: 'eval:1', workflowId: 'workflow:1', name: 'correctness', observedAt },
      { id: 'eval:2', workflowId: 'workflow:2', name: 'correctness', observedAt }
    );
    previous.evalObservations.push(
      { id: 'eval-observation:valid', runId: previous.runs[0].id, evalId: 'eval:1', timestamp: observedAt },
      { id: 'eval-observation:invalid', runId: previous.runs[0].id, evalId: 'eval:2', timestamp: observedAt }
    );

    const merged = mergeRetainedRecords(previous, normalize([]), { now: NOW });

    expect((merged.experimentAssignments ?? []).map((record) => record.id)).toEqual(['assignment:valid']);
    expect((merged.graderObservations ?? []).map((record) => record.id)).toEqual(['grade:valid']);
    expect((merged.evalObservations ?? []).map((record) => record.id)).toEqual(['eval-observation:valid']);
    expect(relationshipErrors(merged)).toEqual([]);
  });

  it('expires retained records that carry no usable observation time', () => {
    const previous = batch([
      { eventId: 'event:untimed', timestamp: '2026-09-01T04:00:00Z' }
    ]);
    for (const event of previous.audits) {
      delete event.timestamp;
      delete event.observedAt;
    }
    const incoming = batch([
      { eventId: 'event:current', timestamp: '2026-09-09T04:00:00Z' }
    ]);

    const merged = mergeRetainedRecords(previous, incoming, { now: NOW });

    expect(merged.audits.map((event) => event.id)).toEqual(['event:current']);
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
      { eventId: 'event:1', timestamp: '2026-09-03T04:00:00Z' }
    ]);
    const incoming = normalize([]);

    const merged = mergeRetainedRecords(previous, incoming, { now: NOW });

    expect(merged.repositories.map((repository) => repository.id)).toEqual(['repository:1']);
    expect(merged.workflows.map((workflow) => workflow.id)).toEqual(['workflow:1']);
    expect(merged.runs.map((run) => run.id)).toEqual(['github:run:githubnext/gh-aw-cao:1']);
    expect(merged.audits.map((event) => event.id)).toEqual(['event:1']);
  });

  it('keeps retained operational values and their repository parents in partial collections', () => {
    const previous = batch([]);
    previous.operationalValues.push({
      id: 'operational-value:dependabot',
      repositoryId: 'repository:1',
      repository: 'githubnext/gh-aw-cao',
      campaign: 'dependabot',
      valueId: 'dependabot-vulnerability-alerts',
      value: 3,
      timestamp: '2026-09-01T04:00:00Z',
      observedAt: '2026-09-01T04:00:00Z'
    });
    const incoming = normalize([]);

    const merged = mergeRetainedRecords(previous, incoming, { now: NOW });

    expect(merged.operationalValues.map((value) => value.id)).toEqual(['operational-value:dependabot']);
    expect(merged.repositories.map((repository) => repository.id)).toEqual(['repository:1']);
  });

  it('drops the oldest whole run subtree to fit a byte cap', () => {
    const records = batch([
      { eventId: 'event:old', timestamp: '2026-09-01T04:00:00Z' }
    ]);
    records.runs[0].startedAt = '2026-09-01T04:00:00Z';
    records.runs.push({
      ...records.runs[0],
      id: 'run:new',
      startedAt: '2026-09-09T04:00:00Z'
    });
    records.audits.push({
      ...records.audits[0],
      id: 'event:new',
      runId: 'run:new',
      timestamp: '2026-09-09T04:00:00Z'
    });

    const capped = capCanonicalBatchSize(records, estimateCanonicalBatchBytes(records) - 1);

    expect(capped.runs.map((run) => run.id)).toEqual(['run:new']);
    expect(capped.audits.map((event) => event.id)).toEqual(['event:new']);
  });
});
