import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  analyzeDashboardQueries,
  pruneDashboardDocument,
  scoreDashboardQuerySimilarity
} from '../../activity/dashboard-prune.mjs';
import { runCli } from '../../activity/cao.mjs';

function dashboard(overrides = {}) {
  return {
    'language-version': '0.1.0',
    dashboard: {
      id: 'test-dashboard',
      title: 'Test dashboard',
      description: 'Test dashboard.',
      queries: [],
      pages: [],
      navigation: [],
      ...overrides
    }
  };
}

const SIMILARITY_STAGE_KEYS = [
  'from',
  'union',
  'time',
  'joins',
  'filter',
  'compute',
  'temporal-series',
  'aggregate',
  'predict',
  'select',
  'order-by',
  'limit'
];
const FIELD_REFERENCE_KEYS = new Set(['field', 'left', 'right', 'as']);

function seededRandom(seed) {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 0x1_0000_0000;
  };
}

function mutateStageValue(value, seed) {
  if (Array.isArray(value)) return [...structuredClone(value), { mutation: seed }];
  if (value && typeof value === 'object') return { ...structuredClone(value), mutation: seed };
  if (typeof value === 'string') return `${value}-mutation-${seed}`;
  if (typeof value === 'number') return value + seed + 1;
  if (typeof value === 'boolean') return !value;
  return `mutation-${seed}`;
}

function remapFields(value, mapping = new Map(), key) {
  if (FIELD_REFERENCE_KEYS.has(key) && typeof value === 'string') {
    if (!mapping.has(value)) mapping.set(value, `mapped-${mapping.size}-${value}`);
    return mapping.get(value);
  }
  if (Array.isArray(value)) return value.map((item) => remapFields(item, mapping, key));
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([childKey, child]) => [
      childKey,
      remapFields(child, mapping, childKey)
    ]));
  }
  return value;
}

async function productionQueries() {
  const document = JSON.parse(await readFile(new URL('../../dashboard/site/dashboard.json', import.meta.url), 'utf8'));
  return document.dashboard.queries;
}

test('consolidates compatible query projections and rewrites every query reference', () => {
  const input = dashboard({
    queries: [
      {
        name: 'failed-runs',
        from: 'runs',
        filter: { predicates: [{ field: 'conclusion', equals: 'failure' }] },
        select: [{ field: 'run' }]
      },
      {
        name: 'failed-run-repositories',
        description: 'The same rows with another projection.',
        from: 'runs',
        filter: { predicates: [{ equals: 'failure', field: 'conclusion' }] },
        select: [{ field: 'repository' }]
      },
      { name: 'failure-summary', from: 'failed-run-repositories' },
      { name: 'unused', from: 'runs' }
    ],
    pages: [{
      id: 'overview',
      kind: 'custom',
      views: [
        { id: 'failures', data: { source: 'failed-run-repositories' } },
        { id: 'summary', data: { source: 'failure-summary' } }
      ]
    }],
    navigation: [{ pages: ['overview'] }]
  });

  const { document, report } = pruneDashboardDocument(input);

  assert.deepEqual(document.dashboard.queries, [
    {
      name: 'failed-runs',
      from: 'runs',
      filter: { predicates: [{ field: 'conclusion', equals: 'failure' }] },
      select: [{ field: 'run' }, { field: 'repository' }]
    },
    { name: 'failure-summary', from: 'failed-runs' }
  ]);
  assert.equal(document.dashboard.pages[0].views[0].data.source, 'failed-runs');
  assert.equal(report.queries.before, 4);
  assert.equal(report.queries.after, 2);
  assert.deepEqual(report.queries.consolidated, [{
    retained: 'failed-runs',
    replaced: ['failed-run-repositories']
  }]);
  assert.deepEqual(report.queries.chains, []);
  assert.deepEqual(report.queries.removed, ['unused']);
  assert.deepEqual(report.queries.stats.before, {
    queries: 4,
    'dependency-edges': 1,
    'root-queries': 3,
    'nested-queries': 1,
    'max-depth': 1,
    'average-depth': 0.25,
    'stage-counts': {
      from: 4,
      union: 0,
      time: 0,
      joins: 0,
      filter: 2,
      compute: 0,
      'temporal-series': 0,
      aggregate: 0,
      predict: 0,
      select: 2,
      'order-by': 0,
      limit: 0
    }
  });
  assert.equal(report.queries.stats.after.queries, 2);
  assert.equal(report.queries.stats.similarity['pairs-compared'], 6);
  assert.equal(report.queries.inventory.length, 2);
  const failedRunsInventory = report.queries.inventory.find((query) => query.name === 'failed-runs');
  assert.deepEqual({ ...failedRunsInventory, similarities: [] }, {
    name: 'failed-runs',
    index: 0,
    from: 'runs',
    stages: ['from', 'filter', 'select'],
    dependencies: [],
    dependents: ['failure-summary'],
    consumers: ['page:overview/view:failures', 'query:failure-summary'],
    depth: 0,
    'fan-in': 0,
    'fan-out': 1,
    similarities: []
  });
  assert.equal(failedRunsInventory.similarities[0].query, 'failed-run-repositories');
  assert.ok(failedRunsInventory.similarities[0].score >= 0.95);
  assert.equal(report.queries.similar[0].query, 'failed-run-repositories');
  assert.equal(report.queries.similar[0].candidate, 'failed-runs');
  assert.ok(report.queries.similar[0].score >= 0.95);
  assert.deepEqual(report.queries.similar[0]['field-mapping'], { run: 'repository' });
});

test('does not consolidate projections with conflicting output aliases', () => {
  const input = dashboard({
    queries: [
      { name: 'first', from: 'runs', select: [{ field: 'run', as: 'value' }] },
      { name: 'second', from: 'runs', select: [{ field: 'repository', as: 'value' }] }
    ],
    pages: [{
      id: 'overview',
      kind: 'custom',
      views: [
        { id: 'first', data: { source: 'first' } },
        { id: 'second', data: { source: 'second' } }
      ]
    }],
    navigation: [{ pages: ['overview'] }]
  });

  const { document, report } = pruneDashboardDocument(input);

  assert.equal(document.dashboard.queries.length, 2);
  assert.deepEqual(report.queries.consolidated, []);
});

test('scores compute-equivalent queries modulo field mappings', () => {
  const suggestions = analyzeDashboardQueries([
    {
      name: 'run-cost',
      from: 'runs',
      compute: [{ as: 'cost', function: 'multiply', args: [{ field: 'tokens' }, { field: 'price' }] }]
    },
    {
      name: 'job-duration',
      from: 'runs',
      compute: [{ as: 'duration', function: 'multiply', args: [{ field: 'seconds' }, { field: 'factor' }] }]
    }
  ]);

  assert.equal(suggestions.length, 1);
  assert.equal(suggestions[0].relation, 'same-shape-with-field-mapping');
  assert.ok(suggestions[0].score >= 0.85);
  assert.deepEqual(suggestions[0]['field-mapping'], {
    cost: 'duration',
    tokens: 'seconds',
    price: 'factor'
  });

  test('scores renamed clones as exact duplicates regardless of metadata', async () => {
    for (const [index, query] of (await productionQueries()).entries()) {
      const clone = {
        ...structuredClone(query),
        name: `${query.name}-clone-${index}`,
        intent: `Cloned intent ${index}`,
        description: `Cloned description ${index}`
      };
      assert.deepEqual(
        scoreDashboardQuerySimilarity(query, clone),
        {
          score: 1,
          relation: 'duplicate',
          'exact-stages': SIMILARITY_STAGE_KEYS.filter((stage) => query[stage] !== undefined),
          'mapped-stages': [],
          'field-mapping': {},
          'chainable-prefix': scoreDashboardQuerySimilarity(query, clone)['chainable-prefix']
        },
        `query ${query.name}`
      );
    }
  });

  test('scores consistent field remaps as the same query shape', async () => {
    const queries = (await productionQueries()).filter((query) => {
      const mapping = new Map();
      remapFields(query, mapping);
      return mapping.size > 0;
    });
    assert.ok(queries.length > 20);

    for (const [index, query] of queries.entries()) {
      const mapping = new Map();
      const clone = remapFields(structuredClone(query), mapping);
      clone.name = `${query.name}-mapped-${index}`;
      const comparison = scoreDashboardQuerySimilarity(query, clone);
      assert.equal(comparison.relation, 'same-shape-with-field-mapping', query.name);
      assert.ok(comparison.score >= 0.85 && comparison.score < 1, `${query.name}: ${comparison.score}`);
      assert.deepEqual(comparison['field-mapping'], Object.fromEntries(mapping), query.name);
    }
  });

  test('random single-stage query mutations reduce similarity deterministically', async () => {
    const queries = (await productionQueries()).filter((query) => (
      SIMILARITY_STAGE_KEYS.filter((stage) => query[stage] !== undefined).length >= 2
    ));
    assert.ok(queries.length > 40);

    for (let seed = 1; seed <= 250; seed += 1) {
      const random = seededRandom(seed);
      const query = queries[Math.floor(random() * queries.length)];
      const stages = SIMILARITY_STAGE_KEYS.filter((stage) => query[stage] !== undefined);
      const stage = stages[Math.floor(random() * stages.length)];
      const mutated = structuredClone(query);
      mutated.name = `${query.name}-mutation-${seed}`;
      mutated[stage] = mutateStageValue(mutated[stage], seed);

      const exact = scoreDashboardQuerySimilarity(query, { ...structuredClone(query), name: `${query.name}-clone` });
      const comparison = scoreDashboardQuerySimilarity(query, mutated);
      const reverse = scoreDashboardQuerySimilarity(mutated, query);

      assert.equal(exact.score, 1, `${query.name}: exact clone`);
      assert.ok(comparison.score >= 0 && comparison.score < exact.score, `${query.name}.${stage}: ${comparison.score}`);
      assert.equal(comparison.score, reverse.score, `${query.name}.${stage}: symmetry`);
      assert.deepEqual(
        comparison,
        scoreDashboardQuerySimilarity(query, mutated),
        `${query.name}.${stage}: deterministic`
      );
    }
  });

  test('ranks exact clones ahead of field mappings and structural mutations', () => {
    const base = {
      name: 'base',
      from: 'runs',
      filter: { predicates: [{ field: 'conclusion', equals: 'failure' }] },
      compute: [{ as: 'cost', function: 'multiply', args: [{ field: 'tokens' }, { field: 'price' }] }]
    };
    const mapped = remapFields(structuredClone(base));
    mapped.name = 'mapped';
    const mutated = structuredClone(base);
    mutated.name = 'mutated';
    mutated.compute = mutateStageValue(mutated.compute, 7);
    const exact = { ...structuredClone(base), name: 'exact' };

    const suggestions = analyzeDashboardQueries([base, mapped, mutated, exact])
      .filter((suggestion) => suggestion.query === 'exact');

    assert.equal(suggestions[0].candidate, 'base');
    assert.equal(suggestions[0].score, 1);
    assert.ok(suggestions[1].score <= suggestions[0].score);
    assert.ok(suggestions[2].score <= suggestions[1].score);
  });
});

test('extracts shared query prefixes into reusable JSON query chains', () => {
  const input = dashboard({
    queries: [
      {
        name: 'failed-run-cost',
        from: 'runs',
        filter: { predicates: [{ field: 'conclusion', equals: 'failure' }] },
        compute: [{ as: 'cost', function: 'multiply', args: [{ field: 'tokens' }, { value: 2 }] }]
      },
      {
        name: 'failed-run-duration',
        from: 'runs',
        filter: { predicates: [{ field: 'conclusion', equals: 'failure' }] },
        compute: [{ as: 'minutes', function: 'divide', args: [{ field: 'duration' }, { value: 60 }] }]
      }
    ],
    pages: [{
      id: 'overview',
      kind: 'custom',
      views: [
        { id: 'cost', data: { source: 'failed-run-cost' } },
        { id: 'duration', data: { source: 'failed-run-duration' } }
      ]
    }],
    navigation: [{ pages: ['overview'] }]
  });

  const { document, report } = pruneDashboardDocument(input);

  assert.deepEqual(document.dashboard.queries, [
    {
      name: 'failure-run-base',
      intent: 'Reuse shared query stages for failed-run-cost, failed-run-duration',
      from: 'runs',
      filter: { predicates: [{ field: 'conclusion', equals: 'failure' }] }
    },
    {
      name: 'failed-run-cost',
      from: 'failure-run-base',
      compute: [{ as: 'cost', function: 'multiply', args: [{ field: 'tokens' }, { value: 2 }] }]
    },
    {
      name: 'failed-run-duration',
      from: 'failure-run-base',
      compute: [{ as: 'minutes', function: 'divide', args: [{ field: 'duration' }, { value: 60 }] }]
    }
  ]);
  assert.deepEqual(report.queries.chains, [{
    base: 'failure-run-base',
    reusedBy: ['failed-run-cost', 'failed-run-duration'],
    stages: ['from', 'filter']
  }]);
});

test('names shared chains from normalized query concepts and source stages', () => {
  const input = dashboard({
    queries: [
      {
        name: 'entity-events',
        from: 'audits',
        union: ['domains', 'tools'],
        compute: [{ as: 'event-url', function: 'coalesce', args: [{ field: 'event-link' }, { value: '' }] }]
      },
      {
        name: 'event-runs',
        from: 'audits',
        union: ['domains', 'tools'],
        aggregate: { by: ['run'], values: [{ field: 'run', as: 'events', reducer: 'count' }] }
      },
      {
        name: 'alpha',
        from: 'runs',
        filter: { predicates: [{ field: 'status', equals: 'queued' }] },
        compute: [{ as: 'label', function: 'coalesce', args: [{ field: 'run' }, { value: '' }] }]
      },
      {
        name: 'beta',
        from: 'runs',
        filter: { predicates: [{ field: 'status', equals: 'queued' }] },
        aggregate: { by: ['repository'], values: [{ field: 'run', as: 'runs', reducer: 'count' }] }
      }
    ],
    pages: [{
      id: 'overview',
      kind: 'custom',
      views: [
        { id: 'events', data: { source: 'entity-events' } },
        { id: 'event-runs', data: { source: 'event-runs' } },
        { id: 'alpha', data: { source: 'alpha' } },
        { id: 'beta', data: { source: 'beta' } }
      ]
    }],
    navigation: [{ pages: ['overview'] }]
  });

  const { report } = pruneDashboardDocument(input);

  assert.deepEqual(report.queries.chains.map((chain) => chain.base), [
    'event-base',
    'run-filter-base'
  ]);
  assert.ok(report.queries.chains.every((chain) => !chain.base.startsWith('shared-query-')));
});

test('prunes reusable views that are not referenced by a page or route behavior', () => {
  const input = dashboard({
    queries: [
      {
        name: 'overview-query',
        from: 'runs',
        filter: { predicates: [{ field: 'conclusion', equals: 'success' }] }
      },
      {
        name: 'detail-query',
        from: 'runs',
        filter: { predicates: [{ field: 'conclusion', equals: 'failure' }] }
      },
      {
        name: 'orphan-query',
        from: 'runs',
        filter: { predicates: [{ field: 'status', equals: 'queued' }] }
      }
    ],
    views: [
      { id: 'detail-view', data: { source: 'detail-query' } },
      { id: 'orphan-view', data: { source: 'orphan-query' } }
    ],
    pages: [
      {
        id: 'overview',
        kind: 'custom',
        views: [{
          id: 'overview',
          data: { source: 'overview-query' },
          list: { 'view-all': { page: 'detail', label: 'View all' } }
        }]
      },
      {
        id: 'detail',
        kind: 'custom',
        route: { 'navigation-page': 'overview', 'hash-query-parameter': 'run' },
        views: ['detail-view']
      },
    ],
    navigation: [{ pages: ['overview'] }]
  });

  const { document, report } = pruneDashboardDocument(input);

  assert.deepEqual(document.dashboard.pages.map((page) => page.id), ['overview', 'detail']);
  assert.deepEqual(document.dashboard.views.map((view) => view.id), ['detail-view']);
  assert.deepEqual(document.dashboard.queries.map((query) => query.name), ['overview-query', 'detail-query']);
  assert.deepEqual(report.pages.removed, []);
  assert.deepEqual(report.views.removed, ['orphan-view']);
  assert.deepEqual(report.queries.removed, ['orphan-query']);
});

test('cao prune-dashboard writes the optimized document and returns an analysis report', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'cao-prune-dashboard-'));
  const inputPath = path.join(directory, 'dashboard.json');
  const outputPath = path.join(directory, 'dashboard.pruned.json');
  try {
    await writeFile(inputPath, JSON.stringify(dashboard({
      queries: [
        { name: 'used', from: 'runs' },
        {
          name: 'unused',
          from: 'runs',
          filter: { predicates: [{ field: 'status', equals: 'queued' }] }
        }
      ],
      pages: [{ id: 'overview', kind: 'custom', views: [{ id: 'used', data: { source: 'used' } }] }],
      navigation: [{ pages: ['overview'] }]
    })));

    const report = await runCli(['prune-dashboard', '--input', inputPath, '--output', outputPath]);
    const output = JSON.parse(await readFile(outputPath, 'utf8'));

    assert.equal(report.command, 'prune-dashboard');
    assert.deepEqual(report.queries.removed, ['unused']);
    assert.deepEqual(output.dashboard.queries.map((query) => query.name), ['used']);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('cao prune-dashboard can analyze without writing an output file', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'cao-analyze-dashboard-'));
  const inputPath = path.join(directory, 'dashboard.json');
  try {
    await writeFile(inputPath, JSON.stringify(dashboard({
      queries: [{ name: 'used', from: 'runs' }],
      pages: [{ id: 'overview', kind: 'custom', views: [{ id: 'used', data: { source: 'used' } }] }],
      navigation: [{ pages: ['overview'] }]
    })));

    const report = await runCli(['prune-dashboard', '--input', inputPath]);

    assert.equal(report.command, 'prune-dashboard');
    assert.equal(report.output, undefined);
    assert.equal(report.queries.after, 1);
    assert.deepEqual(report.queries.inventory[0], {
      name: 'used',
      index: 0,
      from: 'runs',
      stages: ['from'],
      dependencies: [],
      dependents: [],
      consumers: ['page:overview/view:used'],
      depth: 0,
      'fan-in': 0,
      'fan-out': 0,
      similarities: []
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
