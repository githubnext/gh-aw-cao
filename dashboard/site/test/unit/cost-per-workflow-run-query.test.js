import 'fake-indexeddb/auto';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { executeDashboardQueries } from '../../src/data/queries/declarative.js';
import { processDataRequest } from '../../src/data-worker.js';
import { compileDashboardViewPayloadQueries } from '../../src/data/queries/view-payload-compiler.js';
import { authoritativeDashboard } from '../authoritative-dashboard.js';
import contract from '../fixtures/workflow-aic-ranking-contract.json' with { type: 'json' };

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-10-15T12:00:00Z'));
});

afterEach(() => vi.useRealTimers());

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
    'entity-workflows', 'engines-models-usage', 'campaign-performance-baseline-totals',
    'repository-run-statistics', 'repository-aic-totals', 'campaign-cost-totals', 'cost-by-campaign', 'cost-by-repository', 'cost-by-workflow'
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
      { organization: 'example', repository: 'one', workflow: 'worker', campaign: 'one', 'workflow-role': 'orchestrator' },
      { organization: 'example', repository: 'two', workflow: 'worker', campaign: 'two', 'workflow-role': 'orchestrator' }
    ]),
    campaigns: source('campaigns', [
      { campaign: 'one', 'campaign-name': 'One' },
      { campaign: 'two', 'campaign-name': 'Two' }
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
    'entity-workflows', 'engines-models-usage', 'campaign-performance-baseline-totals',
    'cost-by-campaign', 'cost-by-repository', 'cost-by-workflow'
  ]);

  /** @param {string} name @param {string} field @param {string} value */
  const rowFor = (name, field, value) => result[name].rows.find((row) => row[field] === value);
  expect(rowFor('cost-per-workflow-run', 'repository-coordinate', 'example/one')).toMatchObject({
    'observed-runs': 3, 'aic-per-run': 12
  });
  expect(rowFor('cost-per-workflow-run', 'repository-coordinate', 'example/two')).toBeUndefined();
  expect(rowFor('workflow-aic-per-run', 'workflow-label', 'example/one:worker')).toMatchObject({ 'aic-per-run': 12 });
  expect(result['workflow-aic-per-run'].rows).toHaveLength(1);
  expect(result['cost-by-campaign'].rows).toEqual([
    expect.objectContaining({ 'campaign-name': 'One', aic: 12 })
  ]);
  expect(result['cost-by-repository'].rows).toEqual([
    expect.objectContaining({ 'repository-coordinate': 'example/one', aic: 12 })
  ]);
  expect(result['cost-by-workflow'].rows).toEqual([
    expect.objectContaining({ 'workflow-coordinate': 'example/one:worker', aic: 12 })
  ]);
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

it('ranks measured workflow costs through canonical ingestion and the worker view-payload boundary', async () => {
  const dashboard = authoritativeDashboard.dashboard;
  const page = dashboard.pages.find((/** @type {{ id: string }} */ candidate) => candidate.id === contract.page);
  const view = page.definition.views.find((/** @type {{ id: string }} */ candidate) => candidate.id === contract.view);
  expect(view.data).toMatchObject({ source: contract.source, limit: contract.limit, 'order-by': contract.order });
  const compiled = compileDashboardViewPayloadQueries(page, contract.page, {
    queries: dashboard.queries, viewId: contract.view
  });
  const metadata = {
    'source-id': 'workflow-aic-ranking', 'source-kind': 'fixture',
    'as-of': '2026-10-15T12:00:00Z', 'retrieved-at': '2026-10-15T12:00:00Z',
    availability: 'available', completeness: 'complete', freshness: 'fresh'
  };
  const workflows = Array.from({ length: contract.unpricedWorkflows + contract.recordedCosts.length }, (_, index) => ({
    organization: 'example', repository: 'control', workflow: `.github/workflows/worker-${index}.md`
  }));
  const runs = workflows.flatMap(/** @returns {Record<string, unknown>[]} */ (workflow, index) => {
    const base = { ...workflow, run: String(index + 1), 'run-attempt': 1, 'started-at': metadata['as-of'] };
    if (index < contract.unpricedWorkflows) {
      return [{ ...base, ...(index % 2 === 0 ? { 'aic-total': 0 } : {}) }];
    }
    return [
      { ...base, 'aic-total': contract.recordedCosts[index - contract.unpricedWorkflows] },
      { ...base, run: String(index + 1000), 'aic-total': 0 },
      { ...base, run: String(index + 2000), 'aic-total': null }
    ];
  });
  const sources = /** @type {Record<string, import('../../src/presenter.js').LogicalSourceInput>} */ (
    await processDataRequest({
      operation: 'load-dashboard-query-sources', ingest: true,
      sourceNames: ['repositories', 'workflows', 'runs'], queries: [],
      sources: {
        repositories: { source: 'repositories', rows: [{ organization: 'example', repository: 'control' }], metadata },
        workflows: { source: 'workflows', rows: workflows, metadata },
        runs: { source: 'runs', rows: runs, metadata }
      }
    })
  );
  expect(sources.workflows.rows).toHaveLength(workflows.length);
  expect(sources.runs.rows).toHaveLength(runs.length);
  const result = /** @type {Record<string, import('../../src/presenter.js').LogicalSourceInput>} */ (processDataRequest({
    operation: 'execute-dashboard-queries', sources,
    queries: [...dashboard.queries, ...compiled.queries], sourceNames: compiled.aliases
  }));
  const payload = result[compiled.aliases[0]];
  expect(payload.metadata.availability).toBe('available');
  expect(payload.rows.map((row) => row['aic-per-run'])).toEqual(contract.rankedCosts);
  expect(payload.rows).toHaveLength(contract.limit);
  expect(payload.rows.every((row) => row['workflow-link'] && row['workflow-label'])).toBe(true);
});
