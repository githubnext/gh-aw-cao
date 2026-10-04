import { expect, it } from 'vitest';
import { executeDashboardQueries } from '../../src/data/queries/declarative.js';
import { authoritativeDashboard } from '../authoritative-dashboard.js';

it('counts events per run across sources without materializing the raw-event union', () => {
  const names = ['audit-event-runs', 'domain-event-runs', 'tool-event-runs', 'issue-event-runs', 'event-runs'];
  const definitions = authoritativeDashboard.dashboard.queries.filter(
    (/** @type {{ name?: string }} */ query) => names.includes(query.name ?? '')
  );
  /** @type {import('../../src/presenter.js').SourceMetadata} */
  const metadata = {
    'source-id': 'fixture',
    'source-kind': 'fixture',
    'as-of': '2026-09-22T12:00:00Z',
    'retrieved-at': '2026-09-22T12:00:00Z',
    availability: 'available',
    completeness: 'complete',
    freshness: 'fresh'
  };
  /**
   * @param {string} run
   * @param {string} [attempt]
   */
  const event = (run, attempt = '1') => ({
    organization: 'example', repository: 'repo', workflow: 'workflow', run,
    'run-attempt': attempt, event: 'created', 'event-count': 1
  });
  const input = {
    audits: { source: 'audits', metadata, rows: [event('1'), event('1'), event('2')] },
    domains: { source: 'domains', metadata, rows: [event('1'), event('1', '2')] },
    tools: { source: 'tools', metadata, rows: [event('1'), event('1')] },
    issues: { source: 'issues', metadata, rows: [] }
  };

  const result = executeDashboardQueries(definitions, input, ['event-runs']);
  expect(result['event-runs'].rows).toEqual(expect.arrayContaining([
    expect.objectContaining({ run: '1', 'run-attempt': '1', events: 5 }),
    expect.objectContaining({ run: '1', 'run-attempt': '2', events: 1 }),
    expect.objectContaining({ run: '2', 'run-attempt': '1', events: 1 })
  ]));
  expect(result['event-runs'].rows).toHaveLength(3);
});
