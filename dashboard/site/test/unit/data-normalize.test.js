import { describe, expect, it } from 'vitest';
import { normalize } from '../../src/data/normalize/index.js';

/**
 * @param {import('../../src/data/model/schema.js').EntityKind} kind
 * @param {string} sourceId
 * @param {string} observedAt
 * @param {Record<string, unknown>} data
 * @param {string} [source]
 * @returns {import('../../src/data/model/schema.js').CanonicalObservation}
 */
function observation(kind, sourceId, observedAt, data, source = 'dashboard-source') {
  return { kind, source, sourceId, observedAt, data };
}

describe('canonical normalization', () => {
  it('enriches renamed entities without duplicating stable identities', () => {
    const observations = [
      observation('repository', 'repo-old', '2026-09-08T00:00:00Z', {
        githubId: 123,
        owner: 'githubnext',
        name: 'old-name',
        fullName: 'githubnext/old-name'
      }),
      observation('repository', 'repo-new', '2026-09-09T00:00:00Z', {
        githubId: 123,
        name: 'gh-aw-cao',
        fullName: 'githubnext/gh-aw-cao'
      })
    ];

    const batch = normalize(observations.reverse());

    expect(batch.repositories).toHaveLength(1);
    expect(batch.repositories[0]).toMatchObject({
      id: 'github:repository:123',
      owner: 'githubnext',
      name: 'gh-aw-cao',
      fullName: 'githubnext/gh-aw-cao'
    });
  });

  it('is idempotent and collapses run attempts under the repository run key', () => {
    const first = observation('run', 'run-1', '2026-09-09T01:00:00Z', {
      githubRunId: 456,
      attempt: 1,
      owner: 'githubnext',
      repository: 'gh-aw-cao',
      workflowId: 'github:workflow:9',
      repositoryId: 'github:repository:123',
      status: 'completed'
    });
    const rerun = observation('run', 'run-2', '2026-09-09T02:00:00Z', {
      ...first.data,
      attempt: 2
    });

    const batch = normalize([first, first, rerun]);

    expect(batch.runs).toHaveLength(1);
    expect(batch.runs[0]).toMatchObject({
      id: 'github:run:githubnext/gh-aw-cao:456',
      attempt: 2
    });
  });

  it('collapses repeated safe outputs under the repository issue key', () => {
    const first = observation('issue', 'run-1:issue', '2026-09-09T01:00:00Z', {
      runId: 'github:run:githubnext/gh-aw-cao:456',
      url: 'https://github.com/GitHubNext/GH-AW-CAO/issues/42',
      status: 'created'
    });
    const repeated = observation('issue', 'run-2:issue', '2026-09-09T02:00:00Z', {
      runId: 'github:run:githubnext/gh-aw-cao:789',
      url: 'https://github.com/githubnext/gh-aw-cao/issues/42',
      status: 'updated'
    });

    const batch = normalize([first, repeated]);

    expect(batch.issues).toHaveLength(1);
    expect(batch.issues[0]).toMatchObject({
      id: 'github:issue:githubnext/gh-aw-cao:42',
      status: 'updated'
    });
  });

  it('orders run-linked records independently of ingestion order', () => {
    const records = [
      ['result', '2026-09-09T03:00:03Z', 'tool.result', 30],
      ['call', '2026-09-09T03:00:01Z', 'tool.call', 10]
    ].map(([sourceId, timestamp, type, sourceSequence]) => observation('tool', String(sourceId), String(timestamp), {
      runId: 'github:run:456:attempt:1',
      timestamp: String(timestamp),
      type: String(type),
      source: 'runtime',
      sourceSequence: Number(sourceSequence)
    }, 'gh-aw-log'));

    const batch = normalize(records.reverse());

    expect(batch.tools.map((event) => [event.sequence, event.type])).toEqual([
      [0, 'tool.call'],
      [1, 'tool.result']
    ]);
  });

  it('uses explicit source precedence rather than input order for conflicts', () => {
    const lower = observation('run', 'run-dashboard', '2026-09-09T04:00:00Z', {
      githubRunId: 99,
      attempt: 1,
      owner: 'githubnext',
      repository: 'gh-aw-cao',
      status: 'in_progress'
    });
    const authoritative = observation('run', 'run-github', '2026-09-09T03:00:00Z', {
      githubRunId: 99,
      attempt: 1,
      owner: 'githubnext',
      repository: 'gh-aw-cao',
      status: 'completed',
      conclusion: 'success'
    }, 'github');

    const batch = normalize([authoritative, lower], {
      sourcePrecedence: { 'dashboard-source': 10, github: 100 }
    });

    expect(batch.runs[0]).toMatchObject({ status: 'completed', conclusion: 'success' });
  });
});