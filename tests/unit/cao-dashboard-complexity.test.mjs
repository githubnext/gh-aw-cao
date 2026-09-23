import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  analyzeDashboardComplexity,
  formatDashboardComplexityMarkdown
} from '../../activity/dashboard-complexity.mjs';
import { runCli } from '../../activity/cao.mjs';

function dashboard() {
  return {
    'language-version': '0.1.0',
    dashboard: {
      id: 'test-dashboard',
      title: 'Test dashboard',
      description: 'Test dashboard.',
      queries: [
        {
          name: 'base',
          from: 'runs',
          filter: { predicates: [{ field: 'conclusion', equals: 'failure' }] },
          select: [{ field: 'run' }, { field: 'repository' }]
        },
        {
          name: 'summary',
          from: 'base',
          aggregate: { values: [{ field: 'run', as: 'runs', reducer: 'count' }] }
        },
        {
          name: 'joined',
          from: 'base',
          joins: [{
            source: 'repositories',
            type: 'left',
            on: [{ left: 'repository', right: 'repository' }],
            fields: [{ field: 'organization', as: 'organization' }]
          }],
          select: [{ field: 'run' }, { field: 'organization' }]
        }
      ],
      views: [
        { id: 'joined-view', data: { source: 'joined' } }
      ],
      pages: [{
        id: 'overview',
        kind: 'custom',
        views: [
          { id: 'summary-card', data: { source: 'summary' } },
          'joined-view'
        ]
      }],
      navigation: []
    }
  };
}

test('estimates row reads and ranks queries by dependency-amortized pressure', () => {
  const analysis = analyzeDashboardComplexity(dashboard());
  const byName = Object.fromEntries(analysis.inventory.map((query) => [query.name, query]));

  assert.deepEqual(byName.base, {
    name: 'base',
    rank: 3,
    'used-by': ['query:joined', 'query:summary'],
    model: 'normalized-upper-bound',
    assumptions: 'Each external source has one row; selectivity is 1; query dependencies materialize once per batch.',
    class: 'linear-row-reads',
    'direct-row-read-units': 3,
    'dependency-row-read-units': 0,
    'total-row-read-units': 3,
    'output-row-units': 1,
    'source-coefficients': { runs: 3 },
    'direct-source-coefficients': { runs: 3 },
    'stage-row-reads': {
      from: { runs: 1 },
      filter: { runs: 1 },
      select: { runs: 1 }
    }
  });
  assert.equal(byName.summary['total-row-read-units'], 5);
  assert.deepEqual(byName.summary['used-by'], ['page:overview/view:summary-card']);
  assert.equal(byName.joined['total-row-read-units'], 7);
  assert.deepEqual(byName.joined['used-by'], ['view:joined-view']);
  assert.deepEqual(analysis.ranking.map(({ rank, name, score }) => ({ rank, name, score })), [
    { rank: 1, name: 'joined', score: 7 },
    { rank: 2, name: 'summary', score: 5 },
    { rank: 3, name: 'base', score: 3 }
  ]);
  assert.equal(analysis.summary['materialize-all-row-read-units'], 9);
});

test('formats a bounded markdown complexity ranking', () => {
  const markdown = formatDashboardComplexityMarkdown(analyzeDashboardComplexity(dashboard()), {
    limit: 2
  });

  assert.match(markdown, /^## Dashboard query complexity/m);
  assert.match(markdown, /\| Rank \| Query \| Used by \| Total \|/);
  assert.match(markdown, /\| 1 \| `joined` \| `view:joined-view` \| 7 \| 4 \| 3 \| linear \|/);
  assert.match(markdown, /\| 2 \| `summary` \| `page:overview\/view:summary-card` \| 5 \| 2 \| 3 \| linear \|/);
  assert.doesNotMatch(markdown, /\| 3 \| `base`/);
  assert.match(markdown, /Showing 2 of 3 queries/);
});

test('cao dashboard-complexity reports the full graph or one query id', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'cao-dashboard-complexity-'));
  const inputPath = path.join(directory, 'dashboard.json');
  try {
    await writeFile(inputPath, JSON.stringify(dashboard()));

    const report = await runCli(['dashboard-complexity', '--input', inputPath]);
    assert.equal(report.command, 'dashboard-complexity');
    assert.equal(report.queries, 3);
    assert.equal(report.ranking[0].name, 'joined');

    const selected = await runCli(['dashboard-complexity', 'summary', '--input', inputPath]);
    assert.equal(selected.command, 'dashboard-complexity');
    assert.equal(selected.query.name, 'summary');
    assert.equal(selected.query.rank, 2);
    assert.deepEqual(selected.query['used-by'], ['page:overview/view:summary-card']);
    assert.equal(selected.query['total-row-read-units'], 5);

    const markdown = await runCli([
      'dashboard-complexity',
      'summary',
      '--input',
      inputPath,
      '--format',
      'markdown'
    ]);
    assert.match(markdown, /Selected query: `summary`/);
    assert.match(markdown, /\| 2 \| `summary` \|/);
    assert.doesNotMatch(markdown, /\| 1 \| `joined` \|/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('cao dashboard-complexity rejects unknown queries and invalid limits', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'cao-dashboard-complexity-errors-'));
  const inputPath = path.join(directory, 'dashboard.json');
  try {
    await writeFile(inputPath, JSON.stringify(dashboard()));
    await assert.rejects(
      runCli(['dashboard-complexity', 'missing', '--input', inputPath]),
      /Unknown dashboard query: missing/
    );
    await assert.rejects(
      runCli(['dashboard-complexity', '--input', inputPath, '--limit', '0']),
      /--limit must be a positive integer/
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
