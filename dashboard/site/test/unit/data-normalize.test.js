import { describe, expect, it } from 'vitest'
import { normalize } from '../../src/data/normalize/index.js'

const generation = '2026-09-09T05:00:00.000Z'

/**
 * @param {import('../../src/data/model/schema.js').EntityKind} kind
 * @param {string} sourceId
 * @param {string} observedAt
 * @param {Record<string, unknown>} data
 * @param {string} [source]
 * @returns {import('../../src/data/model/schema.js').CanonicalObservation}
 */
function observation(kind, sourceId, observedAt, data, source = 'dashboard-source') {
  return { kind, source, sourceId, observedAt, data }
}

describe('canonical normalization', () => {
  it('enriches renamed entities without duplicating stable identities', () => {
    const observations = [
      observation('repository', 'repo-old', '2026-09-08T00:00:00Z', {
        githubId: 123,
        owner: 'githubnext',
        name: 'old-name',
        fullName: 'githubnext/old-name',
      }),
      observation('repository', 'repo-new', '2026-09-09T00:00:00Z', {
        githubId: 123,
        name: 'gh-aw-cao',
        fullName: 'githubnext/gh-aw-cao',
      }),
    ]

    const batch = normalize(observations.reverse(), { generation })

    expect(batch.repositories).toHaveLength(1)
    expect(batch.repositories[0]).toMatchObject({
      id: 'github:repository:123',
      owner: 'githubnext',
      name: 'gh-aw-cao',
      fullName: 'githubnext/gh-aw-cao',
    })
  })

  it('is idempotent and distinguishes run attempts', () => {
    const first = observation('run', 'run-1', '2026-09-09T01:00:00Z', {
      githubRunId: 456,
      attempt: 1,
      workflowId: 'github:workflow:9',
      repositoryId: 'github:repository:123',
      status: 'completed',
    })
    const rerun = observation('run', 'run-2', '2026-09-09T02:00:00Z', {
      ...first.data,
      attempt: 2,
    })

    const batch = normalize([first, first, rerun], { generation })

    expect(batch.runs.map((run) => run.id)).toEqual(['github:run:456:attempt:1', 'github:run:456:attempt:2'])
  })

  it('orders heterogeneous session events independently of ingestion order', () => {
    const events = [
      ['result', '2026-09-09T03:00:03Z', 'tool.result', 30],
      ['firewall', '2026-09-09T03:00:02Z', 'firewall.request.allowed', 20],
      ['call', '2026-09-09T03:00:01Z', 'tool.call', 10],
      ['future', '2026-09-09T03:00:04Z', 'vendor.new-event', 40],
    ].map(([sourceId, timestamp, type, sourceSequence]) =>
      observation(
        'event',
        String(sourceId),
        String(timestamp),
        {
          sessionId: 'session:gh-aw-log:session-1',
          timestamp: String(timestamp),
          type: String(type),
          source: 'runtime',
          sourceSequence: Number(sourceSequence),
        },
        'gh-aw-log',
      ),
    )

    const batch = normalize(events.reverse(), { generation })

    expect(batch.events.map((event) => [event.sequence, event.type])).toEqual([
      [0, 'tool.call'],
      [1, 'firewall.request.allowed'],
      [2, 'tool.result'],
      [3, 'vendor.new-event'],
    ])
  })

  it('uses explicit source precedence rather than input order for conflicts', () => {
    const lower = observation('job', 'job-dashboard', '2026-09-09T04:00:00Z', {
      githubJobId: 99,
      status: 'in_progress',
    })
    const authoritative = observation(
      'job',
      'job-github',
      '2026-09-09T03:00:00Z',
      {
        githubJobId: 99,
        status: 'completed',
        conclusion: 'success',
      },
      'github',
    )

    const batch = normalize([authoritative, lower], {
      generation,
      sourcePrecedence: { 'dashboard-source': 10, github: 100 },
    })

    expect(batch.jobs[0]).toMatchObject({
      status: 'completed',
      conclusion: 'success',
    })
  })
})
