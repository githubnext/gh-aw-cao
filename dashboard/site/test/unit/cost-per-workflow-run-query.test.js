import { expect, it } from 'vitest';
import { executeDashboardQueries } from '../../src/data/queries/declarative.js';
import { authoritativeDashboard } from '../authoritative-dashboard.js';

it('computes cost per distinct run attempt without loading imported event coverage', () => {
  const definitions = authoritativeDashboard.dashboard.queries.filter(
    (/** @type {{ name?: string }} */ query) =>
      ['workflow-aic-run-totals', 'cost-per-workflow-run'].includes(query.name ?? '')
  );
  const cost = definitions.find((/** @type {{ name?: string }} */ query) => query.name === 'cost-per-workflow-run');
  expect(cost).toMatchObject({ from: 'workflow-aic-run-totals' });
  expect(cost.joins).toBeUndefined();

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
  const result = executeDashboardQueries(definitions, {
    runs: {
      source: 'runs',
      metadata,
      rows: [
        { organization: 'example', repository: 'one', workflow: 'worker', run: '1', 'run-attempt': '1', 'aic-total': 10 },
        { organization: 'example', repository: 'one', workflow: 'worker', run: '1', 'run-attempt': '2', 'aic-total': 20 },
        { organization: 'example', repository: 'two', workflow: 'worker', run: '2', 'run-attempt': '1', 'aic-total': 9 }
      ]
    }
  }, ['cost-per-workflow-run']);

  expect(result['cost-per-workflow-run'].rows).toEqual(expect.arrayContaining([
    expect.objectContaining({ 'repository-coordinate': 'example/one', 'observed-runs': 2, 'aic-per-run': 15 }),
    expect.objectContaining({ 'repository-coordinate': 'example/two', 'observed-runs': 1, 'aic-per-run': 9 })
  ]));
  expect(result['cost-per-workflow-run'].rows).toHaveLength(2);
});
