import { test, expect } from '@playwright/test';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const siteRoot = fileURLToPath(new URL('../..', import.meta.url));
const databaseName = 'gh-aw-cao-dashboard-data';
const generation = 'query-scenarios';
const asOf = '2026-09-09T05:00:00Z';

/**
 * @param {{ repository: string, workflow: string }} workflow
 * @param {string} run
 * @param {string} conclusion
 * @param {string} startedAt
 */
const workflowRun = (workflow, run, conclusion, startedAt) => ({
  organization: 'githubnext',
  repository: workflow.repository,
  workflow: workflow.workflow,
  run,
  'run-attempt': 1,
  'run-status': 'completed',
  'run-conclusion': conclusion,
  'started-at': startedAt
});

const dashboardWorkflow = { repository: 'gh-aw-cao', workflow: '.github/workflows/dashboard.md' };
const doctorWorkflow = { repository: 'gh-aw-cao', workflow: '.github/workflows/doctor.md' };
const auditWorkflow = { repository: 'control-plane', workflow: '.github/workflows/audit.md' };
const idleWorkflow = { repository: 'control-plane', workflow: '.github/workflows/idle.md' };

/**
 * A fixture with two repositories, three workflows, mixed run outcomes, and a
 * workflow that has no runs at all, so joins, aggregations, and null handling
 * are all observable.
 */
function queryScenarioSources() {
  const metadata = { 'as-of': asOf, 'artifact-generation': generation };
  return {
    repositories: {
      rows: [
        { organization: 'githubnext', repository: 'gh-aw-cao', 'observed-at': asOf },
        { organization: 'githubnext', repository: 'control-plane', 'observed-at': asOf }
      ],
      metadata
    },
    workflows: {
      rows: [dashboardWorkflow, doctorWorkflow, auditWorkflow, idleWorkflow].map((workflow) => ({
        organization: 'githubnext',
        repository: workflow.repository,
        workflow: workflow.workflow,
        'observed-at': asOf
      })),
      metadata
    },
    runs: {
      rows: [
        workflowRun(dashboardWorkflow, '1001', 'success', '2026-09-09T01:00:00Z'),
        workflowRun(dashboardWorkflow, '1002', 'failure', '2026-09-09T02:00:00Z'),
        workflowRun(dashboardWorkflow, '1003', 'failure', '2026-09-09T03:00:00Z'),
        workflowRun(doctorWorkflow, '1004', 'success', '2026-09-09T04:00:00Z'),
        workflowRun(auditWorkflow, '1005', 'success', '2026-09-09T04:30:00Z')
      ],
      metadata
    },
    'security-findings': {
      rows: [
        {
          organization: 'githubnext',
          repository: 'gh-aw-cao',
          workflow: dashboardWorkflow.workflow,
          run: '1002',
          'smell-observation-id': 'threat-detection:1002',
          'smell-id': 'threat-detection-secret-leak',
          'smell-name': 'Secret leak detected',
          'smell-severity': 'high',
          'observed-at': '2026-09-09T02:05:00Z'
        },
        {
          organization: 'githubnext',
          repository: 'gh-aw-cao',
          workflow: dashboardWorkflow.workflow,
          run: '1003',
          'smell-observation-id': 'threat-detection:1003',
          'smell-id': 'threat-detection-network-egress',
          'smell-name': 'Unexpected egress',
          'smell-severity': 'medium',
          'observed-at': '2026-09-09T03:05:00Z'
        }
      ],
      metadata
    }
  };
}

test.beforeEach(async ({ context, page }) => {
  await context.route('http://dashboard.test/**', async (route) => {
    const pathname = new URL(route.request().url()).pathname;
    if (pathname === '/' || pathname === '/index.html') {
      await route.fulfill({ contentType: 'text/html', body: '<main>Declarative query test</main>' });
      return;
    }
    if (pathname === '/sources/manifest.json') {
      await route.fulfill({ status: 404, body: 'Not found' });
      return;
    }
    if (pathname === '/sources.json') {
      await route.fulfill({ contentType: 'application/json', body: JSON.stringify(queryScenarioSources()) });
      return;
    }
    const filePath = join(siteRoot, pathname);
    if (existsSync(filePath)) {
      await route.fulfill({
        contentType: pathname.endsWith('.json') ? 'application/json' : 'application/javascript',
        body: readFileSync(filePath)
      });
    } else {
      await route.fulfill({ contentType: 'text/html', body: '<main>Declarative query test</main>' });
    }
  });
  await page.goto('http://dashboard.test/');
  await page.evaluate((name) => new Promise((resolve, reject) => {
    const request = indexedDB.deleteDatabase(name);
    request.onsuccess = () => resolve(undefined);
    request.onerror = () => reject(request.error);
  }), databaseName);
});

/**
 * Loads the requested sources through the real data worker, so every scenario
 * exercises dependency resolution, worker-only query execution, and the
 * page-scoped projection boundary together.
 */
/**
 * @param {import('@playwright/test').Page} page
 * @param {unknown[]} queries
 * @param {string[]} requested
 * @returns {Promise<Record<string, { rows: Record<string, unknown>[], metadata: Record<string, unknown> }>>}
 */
function loadThroughWorker(page, queries, requested) {
  return page.evaluate(async (/** @type {{ queries: unknown[], requested: string[] }} */ { queries, requested }) => {
    const { loadCanonicalDashboardSources } = await import(`${location.origin}/src/data-processor.js`);
    return loadCanonicalDashboardSources(
      `${location.origin}/sources.json`,
      requested,
      { githubUrlBase: 'https://github.com', pages: [], queries }
    );
  }, { queries, requested });
}

/** Aggregates runs per workflow so joins have a many-to-one right side. */
const runTotals = {
  name: 'run-totals',
  from: 'runs',
  aggregate: {
    by: ['organization', 'repository', 'workflow'],
    values: [
      { field: 'run', as: 'runs', reducer: 'distinct-count' },
      { field: 'run', as: 'latest-run', reducer: 'max' }
    ]
  }
};

/** Aggregates only failed runs per workflow. */
const failureTotals = {
  name: 'failure-totals',
  from: 'runs',
  filter: { predicates: [{ field: 'run-conclusion', equals: 'failure' }] },
  aggregate: {
    by: ['organization', 'repository', 'workflow'],
    values: [{ field: 'run', as: 'failures', reducer: 'distinct-count' }]
  }
};

/** Joins both totals onto the workflow inventory. */
/** @param {'inner'|'left'} type */
const workflowJoins = (type) => [
  {
    source: 'run-totals',
    type,
    on: [
      { left: 'organization', right: 'organization' },
      { left: 'repository', right: 'repository' },
      { left: 'workflow', right: 'workflow' }
    ],
    fields: [{ field: 'runs', as: 'observed-runs' }, { field: 'latest-run', as: 'last-run' }]
  },
  {
    source: 'failure-totals',
    type: 'left',
    on: [
      { left: 'organization', right: 'organization' },
      { left: 'repository', right: 'repository' },
      { left: 'workflow', right: 'workflow' }
    ],
    fields: [{ field: 'failures', as: 'observed-failures' }]
  }
];

test('scenario 1: projects, renames, orders, and limits a single source', async ({ page }) => {
  const payload = await loadThroughWorker(page, [{
    name: 'recent-runs',
    from: 'runs',
    select: [
      { field: 'run', as: 'run-id' },
      { field: 'run-conclusion', as: 'outcome' },
      { field: 'started-at' }
    ],
    'order-by': [{ field: 'started-at', direction: 'desc' }],
    limit: 2
  }], ['recent-runs']);

  expect(payload['recent-runs'].rows).toEqual([
    { 'run-id': '1005', outcome: 'success', 'started-at': '2026-09-09T04:30:00Z' },
    { 'run-id': '1004', outcome: 'success', 'started-at': '2026-09-09T04:00:00Z' }
  ]);
  expect(payload['recent-runs'].metadata).toMatchObject({
    'source-kind': 'derived',
    'query-name': 'recent-runs',
    'as-of': asOf,
    availability: 'available'
  });
});

test('scenario 2: filters with the declarative predicate vocabulary', async ({ page }) => {
  const payload = await loadThroughWorker(page, [{
    name: 'failed-dashboard-runs',
    from: 'runs',
    filter: {
      predicates: [
        { field: 'run-conclusion', equals: 'failure' },
        { field: 'repository', in: ['gh-aw-cao'] },
        { field: 'workflow', includes: 'dashboard' }
      ]
    },
    select: [{ field: 'run' }],
    'order-by': [{ field: 'run', direction: 'asc' }]
  }], ['failed-dashboard-runs']);

  expect(payload['failed-dashboard-runs'].rows).toEqual([{ run: '1002' }, { run: '1003' }]);
});

test('scenario 3: aggregates with grouped, deterministic reducers', async ({ page }) => {
  const payload = await loadThroughWorker(page, [runTotals], ['run-totals']);

  expect(payload['run-totals'].rows).toEqual(expect.arrayContaining([
    expect.objectContaining({
      repository: 'gh-aw-cao',
      workflow: '.github/workflows/dashboard.md',
      runs: 3,
      'latest-run': 1003
    }),
    expect.objectContaining({ workflow: '.github/workflows/doctor.md', runs: 1 }),
    expect.objectContaining({ workflow: '.github/workflows/audit.md', runs: 1 })
  ]));
  expect(payload['run-totals'].rows).toHaveLength(3);
});

test('scenario 4: a left join keeps unmatched rows and fills joined fields with null', async ({ page }) => {
  const payload = await loadThroughWorker(page, [runTotals, failureTotals, {
    name: 'workflow-inventory',
    from: 'workflows',
    joins: workflowJoins('left'),
    select: [
      { field: 'workflow' },
      { field: 'observed-runs', as: 'runs' },
      { field: 'observed-failures', as: 'failures' }
    ],
    'order-by': [{ field: 'workflow', direction: 'asc' }]
  }], ['workflow-inventory']);

  expect(payload['workflow-inventory'].rows).toEqual([
    { workflow: '.github/workflows/audit.md', runs: 1, failures: null },
    { workflow: '.github/workflows/dashboard.md', runs: 3, failures: 2 },
    { workflow: '.github/workflows/doctor.md', runs: 1, failures: null },
    { workflow: '.github/workflows/idle.md', runs: null, failures: null }
  ]);
});

test('scenario 5: an inner join drops rows without a match', async ({ page }) => {
  const payload = await loadThroughWorker(page, [runTotals, failureTotals, {
    name: 'active-workflows',
    from: 'workflows',
    joins: workflowJoins('inner'),
    select: [{ field: 'workflow' }, { field: 'observed-runs', as: 'runs' }],
    'order-by': [{ field: 'workflow', direction: 'asc' }]
  }], ['active-workflows']);

  expect(payload['active-workflows'].rows.map((/** @type {Record<string, unknown>} */ row) => row.workflow))
    .toEqual(['.github/workflows/audit.md', '.github/workflows/dashboard.md', '.github/workflows/doctor.md']);
});

test('scenario 6: computes allowlisted fields with null and divide-by-zero handling', async ({ page }) => {
  const payload = await loadThroughWorker(page, [runTotals, failureTotals, {
    name: 'workflow-reliability',
    from: 'workflows',
    joins: workflowJoins('left'),
    compute: [
      { as: 'total-runs', function: 'coalesce', args: [{ field: 'observed-runs' }, { value: 0 }] },
      { as: 'total-failures', function: 'coalesce', args: [{ field: 'observed-failures' }, { value: 0 }] },
      { as: 'failure-rate', function: 'quotient', args: [{ field: 'total-failures' }, { field: 'total-runs' }] },
      { as: 'label', function: 'concat', args: [{ field: 'repository' }, { value: '/' }, { field: 'workflow' }] }
    ],
    select: [
      { field: 'workflow' },
      { field: 'total-runs' },
      { field: 'failure-rate' },
      { field: 'label' }
    ],
    'order-by': [{ field: 'workflow', direction: 'asc' }]
  }], ['workflow-reliability']);

  expect(payload['workflow-reliability'].rows).toEqual([
    {
      workflow: '.github/workflows/audit.md',
      'total-runs': 1,
      'failure-rate': 0,
      label: 'control-plane/.github/workflows/audit.md'
    },
    {
      workflow: '.github/workflows/dashboard.md',
      'total-runs': 3,
      'failure-rate': 2 / 3,
      label: 'gh-aw-cao/.github/workflows/dashboard.md'
    },
    {
      workflow: '.github/workflows/doctor.md',
      'total-runs': 1,
      'failure-rate': 0,
      label: 'gh-aw-cao/.github/workflows/doctor.md'
    },
    {
      workflow: '.github/workflows/idle.md',
      'total-runs': 0,
      'failure-rate': null,
      label: 'control-plane/.github/workflows/idle.md'
    }
  ]);
});

test('scenario 7: a derived source composes another derived source', async ({ page }) => {
  const payload = await loadThroughWorker(page, [runTotals, failureTotals, {
    name: 'workflow-inventory',
    from: 'workflows',
    joins: workflowJoins('left'),
    compute: [{ as: 'total-runs', function: 'coalesce', args: [{ field: 'observed-runs' }, { value: 0 }] }]
  }, {
    name: 'repository-run-totals',
    from: 'workflow-inventory',
    aggregate: {
      by: ['repository'],
      values: [
        { field: 'total-runs', as: 'runs', reducer: 'sum' },
        { field: 'workflow', as: 'workflows', reducer: 'distinct-count' }
      ]
    },
    'order-by': [{ field: 'repository', direction: 'asc' }]
  }], ['repository-run-totals']);

  expect(payload['repository-run-totals'].rows).toEqual([
    { repository: 'control-plane', runs: 1, workflows: 2 },
    { repository: 'gh-aw-cao', runs: 4, workflows: 2 }
  ]);
});

test('scenario 8: dependency resolution returns only the requested derived projection', async ({ page }) => {
  const payload = await loadThroughWorker(page, [runTotals, failureTotals, {
    name: 'finding-inventory',
    from: 'security-findings',
    select: [{ field: 'smell-id' }, { field: 'smell-severity', as: 'severity' }],
    'order-by': [{ field: 'smell-id', direction: 'asc' }]
  }], ['finding-inventory']);

  expect(Object.keys(payload)).toEqual(['finding-inventory']);
  expect(payload['finding-inventory'].rows).toEqual([
    { 'smell-id': 'threat-detection-network-egress', severity: 'medium' },
    { 'smell-id': 'threat-detection-secret-leak', severity: 'high' }
  ]);
});

test('scenario 9: many-to-many join expansion fails closed with a payload-free diagnostic', async ({ page }) => {
  const payload = await loadThroughWorker(page, [{
    name: 'expanded-workflows',
    from: 'workflows',
    joins: [{
      source: 'runs',
      type: 'left',
      on: [
        { left: 'organization', right: 'organization' },
        { left: 'repository', right: 'repository' },
        { left: 'workflow', right: 'workflow' }
      ],
      fields: [{ field: 'run', as: 'run' }]
    }]
  }], ['expanded-workflows']);

  expect(payload['expanded-workflows'].rows).toEqual([]);
  expect(payload['expanded-workflows'].metadata).toMatchObject({
    'source-kind': 'derived',
    availability: 'unavailable',
    completeness: 'unknown',
    freshness: 'unknown',
    'query-diagnostic': '$.dashboard.queries[expanded-workflows]: joined source "runs" contains more than one row per join key.'
  });
});

test('scenario 10: empty results and unavailable inputs report distinct data states', async ({ page }) => {
  const payload = await loadThroughWorker(page, [{
    name: 'cancelled-runs',
    from: 'runs',
    filter: { predicates: [{ field: 'run-conclusion', equals: 'cancelled' }] },
    select: [{ field: 'run' }]
  }, {
    name: 'undeclared-inventory',
    from: 'not-a-declared-source',
    select: [{ field: 'run' }]
  }], ['cancelled-runs', 'undeclared-inventory']);

  expect(payload['cancelled-runs'].rows).toEqual([]);
  expect(payload['cancelled-runs'].metadata).toMatchObject({
    'source-kind': 'derived',
    availability: 'empty'
  });
  expect(payload['cancelled-runs'].metadata).not.toHaveProperty('query-diagnostic');

  expect(payload['undeclared-inventory'].rows).toEqual([]);
  expect(payload['undeclared-inventory'].metadata).toMatchObject({
    availability: 'unavailable',
    'query-diagnostic': '$.dashboard.queries[undeclared-inventory]: input source "not-a-declared-source" is unavailable.'
  });
});

test('scenario 11: catastrophic query patterns are rejected before any rows are read', async ({ page }) => {
  const payload = await loadThroughWorker(page, [
    { name: 'self-referencing', from: 'self-referencing' },
    {
      name: 'cartesian',
      from: 'workflows',
      joins: [{ source: 'runs', type: 'left', on: [], fields: [{ field: 'run', as: 'run' }] }]
    },
    { name: 'oversized-limit', from: 'runs', limit: 100001 },
    { name: 'healthy', from: 'runs', select: [{ field: 'run' }], 'order-by': [{ field: 'run', direction: 'asc' }], limit: 1 }
  ], ['self-referencing', 'cartesian', 'oversized-limit', 'healthy']);

  expect(payload['self-referencing'].metadata).toMatchObject({
    availability: 'unavailable',
    'query-diagnostic': '$.dashboard.queries[self-referencing]: query "self-referencing" reads itself.'
  });
  expect(payload.cartesian.metadata).toMatchObject({
    availability: 'unavailable',
    'query-diagnostic': '$.dashboard.queries[cartesian]: join on "runs" declares no equality keys.'
  });
  expect(payload['oversized-limit'].metadata['query-diagnostic'])
    .toBe('$.dashboard.queries[oversized-limit]: limit must be a positive integer no greater than 100000.');
  for (const name of ['self-referencing', 'cartesian', 'oversized-limit']) {
    expect(payload[name].rows).toEqual([]);
  }

  expect(payload.healthy.rows).toEqual([{ run: '1001' }]);
  expect(payload.healthy.metadata.availability).toBe('available');
});

test('scenario 12: a dependency cycle rejects every query in the cycle and everything downstream', async ({ page }) => {
  const payload = await loadThroughWorker(page, [
    {
      name: 'left-cycle',
      from: 'workflows',
      joins: [{
        source: 'right-cycle',
        type: 'left',
        on: [{ left: 'workflow', right: 'workflow' }],
        fields: [{ field: 'workflow', as: 'joined-workflow' }]
      }]
    },
    { name: 'right-cycle', from: 'left-cycle' },
    { name: 'downstream', from: 'right-cycle' }
  ], ['left-cycle', 'right-cycle', 'downstream']);

  expect(payload['left-cycle'].metadata['query-diagnostic'])
    .toBe('$.dashboard.queries[left-cycle]: query "left-cycle" and input source "right-cycle" form a dependency cycle.');
  expect(payload['right-cycle'].metadata['query-diagnostic'])
    .toBe('$.dashboard.queries[right-cycle]: input source "left-cycle" is a rejected query.');
  expect(payload.downstream.metadata['query-diagnostic'])
    .toBe('$.dashboard.queries[downstream]: input source "right-cycle" is a rejected query.');
  for (const name of ['left-cycle', 'right-cycle', 'downstream']) {
    expect(payload[name].rows).toEqual([]);
    expect(payload[name].metadata.availability).toBe('unavailable');
  }
});

test('scenario 13: cancels an in-flight computation and recovers for later work', async ({ page }) => {
  const outcome = await page.evaluate(async () => {
    const { cancelDataProcessing, loadCanonicalDashboardSources, processDashboardQueries } =
      await import(`${location.origin}/src/data-processor.js`);
    const queries = [{ name: 'workflow-list', from: 'workflows' }];
    await loadCanonicalDashboardSources(
      `${location.origin}/sources.json`,
      ['workflows'],
      { githubUrlBase: 'https://github.com', pages: [], queries: [] }
    );
    const sources = { workflows: { source: 'workflows', rows: [{ workflow: 'a.md' }], metadata: {} } };

    const pending = processDashboardQueries(queries, sources);
    const cancelled = cancelDataProcessing('Data processing was cancelled.');
    const settled = await pending.then(() => 'resolved', (/** @type {Error} */ error) => error.name);
    const recovered = await processDashboardQueries(queries, sources);

    return { cancelled, settled, recovered: recovered['workflow-list'].rows.length };
  });

  expect(outcome.cancelled).toBe(1);
  expect(['resolved', 'DataProcessingCancelledError']).toContain(outcome.settled);
  expect(outcome.recovered).toBe(1);
});
