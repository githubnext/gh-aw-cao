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

it('excludes zero and missing AIC from per-run averages without changing run counts or token statistics', () => {
  const names = [
    'workflow-aic-run-totals', 'cost-per-workflow-run', 'workflow-aic-per-run',
    'workflow-aic-totals', 'workflow-inventory', 'entity-workflow-run-totals',
    'entity-workflows', 'engines-models-usage', 'campaign-performance-baseline-totals'
  ];
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
  const rows = [
    { organization: 'example', repository: 'one', workflow: 'worker', run: '1', 'run-attempt': '1', 'aic-total': 12, 'run-conclusion': 'success', 'agent-id': 'agent', 'model-id': 'model', 'input-tokens': 100 },
    { organization: 'example', repository: 'one', workflow: 'worker', run: '2', 'run-attempt': '1', 'aic-total': 0, 'run-conclusion': 'success', 'agent-id': 'agent', 'model-id': 'model', 'input-tokens': 200 },
    { organization: 'example', repository: 'one', workflow: 'worker', run: '3', 'run-attempt': '1', 'aic-total': null, 'run-conclusion': 'failure', 'agent-id': 'agent', 'model-id': 'model', 'input-tokens': 300 },
    { organization: 'example', repository: 'two', workflow: 'worker', run: '4', 'run-attempt': '1', 'aic-total': 0, 'run-conclusion': 'success', 'agent-id': 'other', 'model-id': 'model', 'input-tokens': 50 }
  ];
  /** @param {string} name @param {Record<string, unknown>[]} sourceRows */
  const source = (name, sourceRows) => ({ source: name, metadata, rows: sourceRows });
  const result = executeDashboardQueries(definitions, {
    runs: source('runs', rows),
    workflows: source('workflows', [
      { organization: 'example', repository: 'one', workflow: 'worker' },
      { organization: 'example', repository: 'two', workflow: 'worker' }
    ]),
    'workflow-run-totals': source('workflow-run-totals', [
      { organization: 'example', repository: 'one', workflow: 'worker', runs: 3 },
      { organization: 'example', repository: 'two', workflow: 'worker', runs: 1 }
    ]),
    'campaign-runs': source('campaign-runs', rows.map((row) => ({
      ...row, campaign: row.repository, status: row['run-conclusion']
    })))
  }, [
    'cost-per-workflow-run', 'workflow-aic-per-run', 'workflow-inventory',
    'entity-workflows', 'engines-models-usage', 'campaign-performance-baseline-totals'
  ]);

  /** @param {string} name @param {string} field @param {string} value */
  const rowFor = (name, field, value) => result[name].rows.find((row) => row[field] === value);
  expect(rowFor('cost-per-workflow-run', 'repository-coordinate', 'example/one')).toMatchObject({
    'observed-runs': 3, 'aic-per-run': 12
  });
  expect(rowFor('cost-per-workflow-run', 'repository-coordinate', 'example/two')).toMatchObject({
    'observed-runs': 1, 'aic-per-run': null
  });
  expect(rowFor('workflow-aic-per-run', 'workflow-label', 'example/one:worker')).toMatchObject({ 'aic-per-run': 12 });
  expect(rowFor('workflow-inventory', 'repository', 'example/one')).toMatchObject({ runs: 3, aic: 12, 'aic-per-run': 12 });
  expect(rowFor('entity-workflows', 'repository', 'one')).toMatchObject({ runs: 3, 'successful-runs': 2, 'aic-per-run': 12 });
  expect(rowFor('entity-workflows', 'repository', 'two')).toMatchObject({ runs: 1, 'aic-per-run': null });
  expect(rowFor('engines-models-usage', 'summary', 'agent / model')).toMatchObject({
    runs: 3, 'minimum-aic-per-run': 12, 'average-aic-per-run': 12,
    'maximum-aic-per-run': 12, 'average-input-tokens-per-run': 200
  });
  expect(rowFor('engines-models-usage', 'summary', 'other / model')).toMatchObject({
    runs: 1, 'average-aic-per-run': null, 'average-input-tokens-per-run': 50
  });
  expect(rowFor('campaign-performance-baseline-totals', 'campaign', 'one')).toMatchObject({
    'concluded-runs': 3, 'successful-runs': 2, 'aic-per-successful-run': 12
  });
  expect(rowFor('campaign-performance-baseline-totals', 'campaign', 'two')).toMatchObject({
    'successful-runs': 1, 'aic-per-successful-run': null
  });
});
