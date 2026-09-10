import { test, expect } from '@playwright/test';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ingestGhAwLogs as ingestNodeGhAwLogs } from '../../src/data/ingest/coordinator.js';
import { readCanonicalBatch } from '../../src/data/storage/indexeddb.js';
import { createSqliteIndexedDB } from '../../src/data/storage/sqlite-indexeddb.js';

const siteRoot = fileURLToPath(new URL('../..', import.meta.url));
const databaseName = 'gh-aw-cao-dashboard-data';
const canonicalEntityTables = ['events', 'jobs', 'packages', 'repositories', 'runs', 'sessions', 'workflows'];

function ghAwLogInput() {
  const fixtureRoot = join(siteRoot, 'test', 'fixtures', 'gh-aw-logs');
  const context = JSON.parse(readFileSync(join(fixtureRoot, 'context.json'), 'utf8'));
  const paths = [
    'run-303/mcp-logs/gateway.jsonl',
    'run-303/sandbox/firewall/audit/audit.jsonl',
    'run-303/sandbox/agent/logs/copilot-session-state/session-505/events.jsonl'
  ];
  return {
    ...context,
    files: paths.map((path) => ({ path, content: readFileSync(join(fixtureRoot, path), 'utf8') }))
  };
}

function canonicalSources(generation = 'browser-generation', run = '12345') {
  return {
    packages: {
      rows: [{
        package: 'dashboard',
        'package-name': 'CAO Dashboard',
        'package-description': 'Deploy the CAO dashboard.',
        'package-icon': 'graph',
        'package-mode': 'review',
        'package-enabled': true,
        'package-worker-count': 1,
        'package-min-version': 'v0.89.2',
        'package-experimental': true,
        'observed-at': '2026-09-09T05:00:00Z'
      }],
      metadata: { 'as-of': '2026-09-09T05:00:00Z', 'artifact-generation': generation }
    },
    repositories: {
      rows: [{ organization: 'githubnext', repository: 'gh-aw-cao', 'observed-at': '2026-09-09T05:00:00Z' }],
      metadata: { 'as-of': '2026-09-09T05:00:00Z', 'artifact-generation': generation }
    },
    workflows: {
      rows: [{
        organization: 'githubnext',
        repository: 'gh-aw-cao',
        workflow: '.github/workflows/dashboard.md',
        package: 'dashboard',
        'package-name': 'Dashboard',
        'workflow-role': 'worker',
        'rollout-mode': 'review',
        'workflow-active': 'true',
        'observed-at': '2026-09-09T05:00:00Z'
      }],
      metadata: { 'as-of': '2026-09-09T05:00:00Z', 'artifact-generation': generation }
    },
    runs: {
      rows: [{
        organization: 'githubnext',
        repository: 'gh-aw-cao',
        workflow: '.github/workflows/dashboard.md',
        run,
        'run-attempt': 2,
        'run-status': 'completed',
        'run-conclusion': 'failure',
        'started-at': '2026-09-09T04:00:00Z',
        'rollout-mode': 'review',
        engine: 'copilot',
        'engine-version': '1.2.3',
        'requested-model': 'model-a',
        'resolved-model': 'model-b',
        'run-link': { href: `https://github.com/githubnext/gh-aw-cao/actions/runs/${run}` }
      }],
      metadata: { 'as-of': '2026-09-09T05:00:00Z', 'artifact-generation': generation }
    },
    sessions: {
      rows: [{
        organization: 'githubnext', repository: 'gh-aw-cao', workflow: '.github/workflows/dashboard.md', run,
        'run-attempt': 2, session: `session-${run}`, 'session-kind': 'unified-operational-log',
        'session-status': 'completed', 'started-at': '2026-09-09T04:00:00Z',
        'observed-at': '2026-09-09T05:00:00Z'
      }],
      metadata: { 'as-of': '2026-09-09T05:00:00Z', 'artifact-generation': generation }
    },
    events: {
      rows: [
        {
          organization: 'githubnext', repository: 'gh-aw-cao', workflow: '.github/workflows/dashboard.md', run,
          'run-attempt': 2, session: `session-${run}`, event: `event-${run}`,
          'event-timestamp': '2026-09-09T04:01:00Z', 'event-source': 'agent',
          'event-type': 'agent_turn', 'event-summary': 'Processed the dashboard request',
          'observed-at': '2026-09-09T05:00:00Z'
        },
        {
          organization: 'githubnext', repository: 'gh-aw-cao', workflow: '.github/workflows/dashboard.md', run,
          'run-attempt': 2, session: `session-${run}`, event: `tool-call-${run}`,
          'event-timestamp': '2026-09-09T04:02:00Z', 'event-source': 'mcp',
          'event-type': 'tool.call', 'event-summary': 'github/search_issues', 'correlation-id': `call-${run}`,
          'observed-at': '2026-09-09T05:00:00Z'
        },
        {
          organization: 'githubnext', repository: 'gh-aw-cao', workflow: '.github/workflows/dashboard.md', run,
          'run-attempt': 2, session: `session-${run}`, event: `tool-result-${run}`,
          'event-timestamp': '2026-09-09T04:02:01Z', 'event-source': 'mcp',
          'event-type': 'tool.result', 'event-status': 'success', 'correlation-id': `call-${run}`,
          'observed-at': '2026-09-09T05:00:00Z'
        },
        {
          organization: 'githubnext', repository: 'gh-aw-cao', workflow: '.github/workflows/dashboard.md', run,
          'run-attempt': 2, session: `session-${run}`, event: `github-api-${run}`,
          'event-timestamp': '2026-09-09T04:02:00Z', 'event-source': 'github-api',
          'event-type': 'github-api.response', 'event-summary': 'GET /rate_limit',
          'event-status': '200', 'correlation-id': 'request-123',
          'observed-at': '2026-09-09T05:00:00Z'
        }
      ],
      metadata: { 'as-of': '2026-09-09T05:00:00Z', 'artifact-generation': generation }
    },
    'job-performance': {
      rows: [{
        organization: 'githubnext',
        repository: 'gh-aw-cao',
        workflow: '.github/workflows/dashboard.md',
        run,
        'run-attempt': 2,
        'job-id': `${run}9`,
        job: 'build',
        'started-at': '2026-09-09T04:01:00Z'
      }],
      metadata: { 'as-of': '2026-09-09T05:00:00Z', 'artifact-generation': generation }
    },
    'work-items': {
      rows: [{
        'work-item-id': 'githubnext/gh-aw-cao:.github/workflows/dashboard.md',
        organization: 'githubnext', repository: 'gh-aw-cao', workflow: '.github/workflows/dashboard.md',
        'lifecycle-state': 'blocked', reason: 'Build failed', 'observed-at': '2026-09-09T04:00:00Z'
      }],
      metadata: { 'as-of': '2026-09-09T05:00:00Z', 'artifact-generation': generation }
    },
    'security-findings': {
      rows: [{
        organization: 'githubnext', repository: 'gh-aw-cao', workflow: '.github/workflows/dashboard.md', run,
        'smell-observation-id': `threat-detection:${run}`, 'smell-id': 'threat-detection-secret-leak',
        'smell-name': 'Secret leak detected', 'smell-severity': 'high',
        'observed-at': '2026-09-09T04:01:00Z'
      }],
      metadata: { 'as-of': '2026-09-09T05:00:00Z', 'artifact-generation': generation }
    },
    'firewall-observations': {
      rows: [
        {
          organization: 'githubnext', repository: 'gh-aw-cao',
          workflow: '.github/workflows/dashboard.md', run,
          domain: 'api.github.com', decision: 'allowed', 'request-count': 4
        },
        {
          organization: 'githubnext', repository: 'gh-aw-cao',
          workflow: '.github/workflows/dashboard.md', run,
          domain: 'api.github.com', decision: 'denied', 'request-count': 2
        },
        {
          organization: 'githubnext', repository: 'gh-aw-cao',
          workflow: '.github/workflows/dashboard.md', run,
          domain: 'removed.example', decision: 'unknown', 'request-count': null
        }
      ],
      metadata: { 'as-of': '2026-09-09T05:00:00Z', 'artifact-generation': generation }
    },
    usage: {
      rows: [{
        organization: 'githubnext', repository: 'gh-aw-cao', workflow: '.github/workflows/dashboard.md', run,
        engine: 'copilot', 'engine-version': '1.2.3', 'requested-model': 'model-a',
        'resolved-model': 'model-b', 'rollout-mode': 'review', aic: 17,
        'observed-at': '2026-09-09T04:00:00Z',
        'run-link': { href: `https://github.com/githubnext/gh-aw-cao/actions/runs/${run}` }
      }],
      metadata: { 'as-of': '2026-09-09T05:00:00Z', 'artifact-generation': generation }
    },
    outcomes: {
      rows: [{ organization: 'githubnext', repository: 'gh-aw-cao', workflow: '.github/workflows/dashboard.md', 'safe-output': 'report-1' }],
      metadata: { 'as-of': '2026-09-09T05:00:00Z', 'artifact-generation': generation }
    },
    'operational-values': {
      rows: [{ organization: 'githubnext', repository: 'gh-aw-cao', workflow: '.github/workflows/dashboard.md', 'operational-value': 1 }],
      metadata: { 'as-of': '2026-09-09T05:00:00Z', 'artifact-generation': generation }
    }
  };
}

test.beforeEach(async ({ context, page }) => {
  await context.route('http://dashboard.test/**', async (route) => {
    const pathname = new URL(route.request().url()).pathname;
    if (pathname === '/' || pathname === '/index.html') {
      await route.fulfill({ contentType: 'text/html', body: '<main>Canonical data test</main>' });
      return;
    }
    if (pathname === '/sources/manifest.json') {
      await route.fulfill({ status: 404, body: 'Not found' });
      return;
    }
    if (pathname === '/sources.json') {
      await route.fulfill({ contentType: 'application/json', body: JSON.stringify(canonicalSources()) });
      return;
    }
    const filePath = join(siteRoot, pathname);
    if (existsSync(filePath)) {
      await route.fulfill({
        contentType: pathname.endsWith('.json') ? 'application/json' : 'application/javascript',
        body: readFileSync(filePath)
      });
    } else {
      await route.fulfill({ contentType: 'text/html', body: '<main>Canonical data test</main>' });
    }
  });
  await page.goto('http://dashboard.test/');
  await page.evaluate((name) => new Promise((resolve, reject) => {
    const request = indexedDB.deleteDatabase(name);
    request.onsuccess = () => resolve(undefined);
    request.onerror = () => reject(request.error);
  }), databaseName);
});

test('native IndexedDB directly upserts and retains canonical data across reload', async ({ page }) => {
  test.slow();
  const sources = canonicalSources();

  const first = await page.evaluate(async (sourceDocument) => {
    const coordinatorUrl = `${location.origin}/src/data/ingest/coordinator.js`;
    const queriesUrl = `${location.origin}/src/data/queries/index.js`;
    const [{ ingestDashboardSources }, { createCanonicalQueries }] = await Promise.all([
      import(coordinatorUrl),
      import(queriesUrl)
    ]);
    const result = await ingestDashboardSources(indexedDB, sourceDocument);
    const queries = createCanonicalQueries(indexedDB);
    const repositories = await queries.repositories.list();
    const workflows = await queries.workflows.forRepository(String(repositories[0].id));
    const runs = await queries.runs.forWorkflow(String(workflows[0].id));
    const jobs = await queries.jobs.forRun(String(runs[0].id));
    return { result, repositories, workflows, runs, jobs };
  }, sources);

  expect(first.result).toMatchObject({ updated: true });
  expect(first.repositories).toHaveLength(1);
  expect(first.workflows).toHaveLength(1);
  expect(first.runs[0].id).toBe('github:run:12345:attempt:2');
  expect(first.jobs[0].id).toBe('github:job:123459');

  await page.reload();
  const retained = await page.evaluate(async () => {
    const queriesUrl = `${location.origin}/src/data/queries/index.js`;
    const { createCanonicalQueries } = await import(queriesUrl);
    const queries = createCanonicalQueries(indexedDB);
    return queries.runs.recentFailures();
  });
  expect(retained).toEqual([expect.objectContaining({ id: 'github:run:12345:attempt:2' })]);

  const viewSources = await page.evaluate(async (sourceDocument) => {
    const viewSourcesUrl = `${location.origin}/src/data/queries/view-sources.js`;
    const { loadCanonicalViewSources } = await import(viewSourcesUrl);
    return loadCanonicalViewSources(indexedDB, sourceDocument);
  }, sources);
  expect(viewSources['failed-runs']).toMatchObject({
    source: 'failed-runs',
    rows: [{
      organization: 'githubnext',
      repository: 'gh-aw-cao',
      run: '12345',
      'run-attempt': 2,
      'run-conclusion': 'failure'
    }],
    metadata: {
      'source-kind': 'canonical-query',
      availability: 'available'
    }
  });
  expect(viewSources.runs).toMatchObject({
    source: 'runs',
    rows: [{
      organization: 'githubnext',
      repository: 'gh-aw-cao',
      run: '12345',
      'run-attempt': 2,
      'run-conclusion': 'failure'
    }],
    metadata: {
      'source-kind': 'canonical-query',
      availability: 'available'
    }
  });
  expect(viewSources.repositories.rows).toMatchObject([{
    organization: 'githubnext', repository: 'gh-aw-cao'
  }]);
  expect(viewSources.workflows.rows).toMatchObject([{
    organization: 'githubnext', repository: 'gh-aw-cao',
    workflow: '.github/workflows/dashboard.md'
  }]);
  expect(viewSources['job-performance'].rows).toMatchObject([{
    organization: 'githubnext', repository: 'gh-aw-cao', run: '12345',
    'run-attempt': 2, 'job-id': '123459', job: 'build'
  }]);
});

test('data worker returns only the canonical payload requested by a view', async ({ page }) => {
  const result = await page.evaluate(async () => {
    const processorUrl = `${location.origin}/src/data-processor.js`;
    const { loadCanonicalDashboardSources, loadCanonicalDashboardPage } = await import(processorUrl);
    const context = { githubUrlBase: 'https://github.com', pages: [] };
    const initial = await loadCanonicalDashboardSources(
      `${location.origin}/sources.json`,
      ['failed-runs'],
      context
    );
    const navigated = await loadCanonicalDashboardPage(['failed-runs'], context);
    return { initial, navigated };
  });

  for (const payload of [result.initial, result.navigated]) {
    expect(Object.keys(payload)).toEqual(['failed-runs']);
    expect(payload['failed-runs']).toMatchObject({
      source: 'failed-runs',
      rows: [{ repository: 'gh-aw-cao', run: '12345', 'run-conclusion': 'failure' }],
      metadata: { 'source-kind': 'canonical-query' }
    });
  }
});

test('data worker reports every fresh database update', async ({ page }) => {
  const refreshes = await page.evaluate(async () => {
    const processorUrl = `${location.origin}/src/data-processor.js`;
    const { refreshCanonicalDashboardSources } = await import(processorUrl);
    const context = { githubUrlBase: 'https://github.com', pages: [] };
    return [
      await refreshCanonicalDashboardSources(
        `${location.origin}/sources.json`,
        ['failed-runs'],
        context
      ),
      await refreshCanonicalDashboardSources(
        `${location.origin}/sources.json`,
        ['failed-runs'],
        context
      )
    ];
  });

  expect(refreshes.map((refresh) => refresh.changed)).toEqual([true, true]);
  expect(refreshes[0].sources['failed-runs'].rows).toMatchObject([
    { repository: 'gh-aw-cao', run: '12345' }
  ]);
});

test('data worker queries retained canonical data before downloading sources', async ({ page }) => {
  await page.evaluate(async () => {
    const processorUrl = `${location.origin}/src/data-processor.js`;
    const { loadCanonicalDashboardSources } = await import(processorUrl);
    await loadCanonicalDashboardSources(
      `${location.origin}/sources.json`,
      ['failed-runs'],
      { githubUrlBase: 'https://github.com', pages: [] }
    );
  });

  await page.reload();
  const result = await page.evaluate(async () => {
    const processorUrl = `${location.origin}/src/data-processor.js`;
    const { loadCanonicalDashboardPage, refreshCanonicalDashboardSources } = await import(processorUrl);
    const context = {
      githubUrlBase: 'https://github.com',
      pages: [],
      queries: [{
        name: 'cached-run-totals',
        from: 'runs',
        aggregate: { values: [{ field: 'run', as: 'runs', reducer: 'distinct-count' }] }
      }]
    };
    const retained = await loadCanonicalDashboardPage(
      ['failed-runs', 'cached-run-totals', 'overview-attention-domains'],
      context
    );
    const refreshed = await refreshCanonicalDashboardSources(
      `${location.origin}/sources.json`,
      ['failed-runs', 'cached-run-totals', 'overview-attention-domains'],
      context
    );
    return { retained, refreshed };
  });

  expect(result.retained['failed-runs']).toMatchObject({
    rows: [{ repository: 'gh-aw-cao', run: '12345', 'run-conclusion': 'failure' }],
    metadata: { 'source-kind': 'canonical-query' }
  });
  expect(result.retained['cached-run-totals']).toMatchObject({
    rows: [{ runs: 1 }],
    metadata: { 'source-kind': 'derived', 'query-name': 'cached-run-totals' }
  });
  expect(result.retained['overview-attention-domains']).toBeUndefined();
  expect(result.refreshed.changed).toBe(true);
  expect(result.refreshed.sources['overview-attention-domains']).toBeDefined();
});

test('data worker executes declarative queries and returns only the derived projection', async ({ page }) => {
  const result = await page.evaluate(async () => {
    const processorUrl = `${location.origin}/src/data-processor.js`;
    const { loadCanonicalDashboardSources, loadCanonicalDashboardPage } = await import(processorUrl);
    const context = {
      githubUrlBase: 'https://github.com',
      pages: [],
      queries: [
        {
          name: 'run-totals',
          from: 'runs',
          aggregate: {
            by: ['organization', 'repository', 'workflow'],
            values: [{ field: 'run', as: 'runs', reducer: 'distinct-count' }]
          }
        },
        {
          name: 'workflow-run-inventory',
          from: 'workflows',
          joins: [{
            source: 'run-totals',
            type: 'left',
            on: [
              { left: 'organization', right: 'organization' },
              { left: 'repository', right: 'repository' },
              { left: 'workflow', right: 'workflow' }
            ],
            fields: [{ field: 'runs', as: 'observed-runs' }]
          }],
          compute: [{ as: 'total-runs', function: 'coalesce', args: [{ field: 'observed-runs' }, { value: 0 }] }],
          select: [{ field: 'workflow' }, { field: 'total-runs', as: 'runs' }],
          'order-by': [{ field: 'workflow', direction: 'asc' }]
        }
      ]
    };
    const initial = await loadCanonicalDashboardSources(
      `${location.origin}/sources.json`,
      ['workflow-run-inventory'],
      context
    );
    const navigated = await loadCanonicalDashboardPage(['workflow-run-inventory'], context);
    return { initial, navigated };
  });

  for (const payload of [result.initial, result.navigated]) {
    expect(Object.keys(payload)).toEqual(['workflow-run-inventory']);
    expect(payload['workflow-run-inventory']).toMatchObject({
      source: 'workflow-run-inventory',
      rows: [{ workflow: '.github/workflows/dashboard.md', runs: 1 }],
      metadata: { 'source-kind': 'derived', 'query-name': 'workflow-run-inventory', availability: 'available' }
    });
  }
});

test('data worker returns the Models & agents query on initial and navigated requests', async ({ page }) => {
  const result = await page.evaluate(async () => {
    const processorUrl = `${location.origin}/src/data-processor.js`;
    const { loadCanonicalDashboardSources, loadCanonicalDashboardPage } = await import(processorUrl);
    const dashboard = await fetch(`${location.origin}/dashboard.json`).then((response) => response.json());
    const context = {
      githubUrlBase: 'https://github.com',
      pages: dashboard.dashboard.pages,
      queries: dashboard.dashboard.queries
    };
    const initial = await loadCanonicalDashboardSources(
      `${location.origin}/sources.json`,
      ['engines-models-usage'],
      context
    );
    const navigated = await loadCanonicalDashboardPage(['engines-models-usage'], context);
    return { initial, navigated };
  });

  for (const payload of [result.initial, result.navigated]) {
    expect(Object.keys(payload)).toEqual(['engines-models-usage']);
    expect(payload['engines-models-usage']).toMatchObject({
      source: 'engines-models-usage',
      rows: [{
        engine: 'copilot',
        'engine-version': '1.2.3',
        'requested-model': 'model-a',
        'resolved-model': 'model-b',
        'rollout-mode': 'review',
        'event-type': 'agent_turn',
        'event-summary': 'Processed the dashboard request',
        repository: 'gh-aw-cao',
        workflow: '.github/workflows/dashboard.md',
        'observed-at': '2026-09-09T04:01:00Z'
      }],
      metadata: { 'source-kind': 'derived', 'query-name': 'engines-models-usage' }
    });
  }
});

test('data worker returns declarative MCP activity on initial and navigated requests', async ({ page }) => {
  const result = await page.evaluate(async () => {
    const processorUrl = `${location.origin}/src/data-processor.js`;
    const { loadCanonicalDashboardSources, loadCanonicalDashboardPage } = await import(processorUrl);
    const dashboard = await fetch(`${location.origin}/dashboard.json`).then((response) => response.json());
    const context = {
      githubUrlBase: 'https://github.com',
      pages: dashboard.dashboard.pages,
      queries: dashboard.dashboard.queries
    };
    const initial = await loadCanonicalDashboardSources(
      `${location.origin}/sources.json`,
      ['mcp-tool-activity'],
      context
    );
    const navigated = await loadCanonicalDashboardPage(['mcp-tool-activity'], context);
    return { initial, navigated };
  });

  for (const payload of [result.initial, result.navigated]) {
    expect(Object.keys(payload)).toEqual(['mcp-tool-activity']);
    expect(payload['mcp-tool-activity']).toMatchObject({
      source: 'mcp-tool-activity',
      rows: [{
        'mcp-tool': 'github/search_issues',
        'mcp-status': 'success',
        repository: 'gh-aw-cao',
        run: '12345'
      }],
      metadata: { 'source-kind': 'derived', 'query-name': 'mcp-tool-activity' }
    });
  }
});

test('data worker returns GitHub API events on initial and navigated requests', async ({ page }) => {
  const result = await page.evaluate(async () => {
    const processorUrl = `${location.origin}/src/data-processor.js`;
    const { loadCanonicalDashboardSources, loadCanonicalDashboardPage } = await import(processorUrl);
    const dashboard = await fetch(`${location.origin}/dashboard.json`).then((response) => response.json());
    const context = {
      githubUrlBase: 'https://github.com',
      pages: dashboard.dashboard.pages,
      queries: dashboard.dashboard.queries
    };
    const initial = await loadCanonicalDashboardSources(
      `${location.origin}/sources.json`,
      ['github-api-events'],
      context
    );
    const navigated = await loadCanonicalDashboardPage(['github-api-events'], context);
    return { initial, navigated };
  });

  for (const payload of [result.initial, result.navigated]) {
    expect(Object.keys(payload)).toEqual(['github-api-events']);
    expect(payload['github-api-events']).toMatchObject({
      source: 'github-api-events',
      rows: [{
        'event-type': 'github-api.response',
        'event-summary': 'GET /rate_limit',
        'event-status': '200',
        repository: 'gh-aw-cao',
        run: '12345',
        'correlation-id': 'request-123',
        'observed-at': '2026-09-09T04:02:00Z'
      }],
      metadata: { 'source-kind': 'derived', 'query-name': 'github-api-events' }
    });
  }
});

test('data worker queries firewall domain totals on initial and navigated requests', async ({ page }) => {
  const result = await page.evaluate(async () => {
    const processorUrl = `${location.origin}/src/data-processor.js`;
    const { loadCanonicalDashboardSources, loadCanonicalDashboardPage } = await import(processorUrl);
    const dashboard = await fetch(`${location.origin}/dashboard.json`).then((response) => response.json());
    const context = {
      githubUrlBase: 'https://github.com',
      pages: dashboard.dashboard.pages,
      queries: dashboard.dashboard.queries
    };
    const initial = await loadCanonicalDashboardSources(
      `${location.origin}/sources.json`,
      ['firewall-domain-totals'],
      context
    );
    const navigated = await loadCanonicalDashboardPage(['firewall-domain-totals'], context);
    return { initial, navigated };
  });

  for (const payload of [result.initial, result.navigated]) {
    expect(Object.keys(payload)).toEqual(['firewall-domain-totals']);
    expect(payload['firewall-domain-totals']).toMatchObject({
      rows: [{ domain: 'api.github.com', run: 1, accepted: 4, blocked: 2 }],
      metadata: { 'source-kind': 'derived', 'query-name': 'firewall-domain-totals' }
    });
  }
});

test('data worker computes repository and package pages with request-scoped dashboard queries', async ({ page }) => {
  const result = await page.evaluate(async () => {
    const processorUrl = `${location.origin}/src/data-processor.js`;
    const { loadCanonicalDashboardSources, loadCanonicalDashboardPage } = await import(processorUrl);
    const dashboard = await fetch(`${location.origin}/dashboard.json`).then((response) => response.json());
    const context = {
      githubUrlBase: 'https://github.com',
      pages: dashboard.dashboard.pages,
      queries: dashboard.dashboard.queries
    };
    const initial = await loadCanonicalDashboardSources(
      `${location.origin}/sources.json`,
      ['repository-activity'],
      context
    );
    const navigated = await loadCanonicalDashboardPage(['package-inventory'], context);
    return { initial, navigated };
  });

  expect(Object.keys(result.initial)).toEqual(['repository-activity']);
  expect(result.initial['repository-activity']).toMatchObject({
    rows: [{
      repository: 'githubnext/gh-aw-cao',
      workflows: 1,
      reports: 1,
      runs: 1,
      'failure-summary': '100% · 1 failed',
      aic: 17,
      status: 'Needs attention'
    }],
    metadata: { 'source-kind': 'derived', 'query-name': 'repository-activity' }
  });
  expect(Object.keys(result.navigated)).toEqual(['package-inventory']);
  expect(result.navigated['package-inventory']).toMatchObject({
    rows: [{
      package: 'dashboard',
      'package-name': 'Dashboard',
      workflows: 1,
      roles: 'worker',
      modes: 'review',
      registration: 'true',
      runs: 1,
      aic: 17
    }],
    metadata: { 'source-kind': 'derived', 'query-name': 'package-inventory' }
  });
});

test('data worker serves work items and security findings without dedicated canonical stores', async ({ page }) => {
  const result = await page.evaluate(async () => {
    const processorUrl = `${location.origin}/src/data-processor.js`;
    const { loadCanonicalDashboardSources, loadCanonicalDashboardPage } = await import(processorUrl);
    const context = { githubUrlBase: 'https://github.com', pages: [] };
    await loadCanonicalDashboardSources(`${location.origin}/sources.json`, ['work-items'], context);
    return loadCanonicalDashboardPage(['work-items', 'security-findings'], context);
  });

  expect(Object.keys(result)).toEqual(['work-items', 'security-findings']);
  expect(result['work-items']).toMatchObject({
    rows: [{ 'work-item-id': 'githubnext/gh-aw-cao:.github/workflows/dashboard.md', 'lifecycle-state': 'blocked' }]
  });
  expect(result['security-findings']).toMatchObject({
    rows: [{ 'smell-observation-id': 'threat-detection:12345', 'smell-severity': 'high' }]
  });
});

test('Chromium ingests gh-aw artifacts as Run, Session, and ordered Events', async ({ page }) => {
  const result = await page.evaluate(async (input) => {
    const coordinatorUrl = `${location.origin}/src/data/ingest/coordinator.js`;
    const queriesUrl = `${location.origin}/src/data/queries/index.js`;
    const [{ ingestGhAwLogs }, { createCanonicalQueries }] = await Promise.all([
      import(coordinatorUrl),
      import(queriesUrl)
    ]);
    const ingestion = await ingestGhAwLogs(indexedDB, input);
    const queries = createCanonicalQueries(indexedDB);
    const runs = await queries.runs.list();
    const sessions = await queries.sessions.forRun(String(runs[0].id));
    const events = await queries.events.forSession(String(sessions[0].id));
    return { ingestion, runs, sessions, events };
  }, ghAwLogInput());

  expect(result.ingestion).toMatchObject({ updated: true });
  expect(result.runs[0].id).toBe('github:run:303:attempt:1');
  expect(result.sessions[0].kind).toBe('unified-operational-log');
  expect(result.events.map((/** @type {Record<string, unknown>} */ event) => [event.sequence, event.source, event.type])).toEqual([
    [0, 'agent', 'agent_turn'],
    [1, 'gateway', 'tool_call'],
    [2, 'agent', 'agent_tool_start'],
    [3, 'agent', 'agent_tool_done'],
    [4, 'firewall', 'net_allowed'],
    [5, 'agent', 'assistant_message']
  ]);
});

test('SQLite and browser IndexedDB ingestion produce identical populated tables', async ({ page }) => {
  const input = ghAwLogInput();
  const directory = mkdtempSync(join(tmpdir(), 'cao-ingestion-compliance-'));
  try {
    const sqliteIndexedDB = createSqliteIndexedDB(join(directory, 'dashboard.sqlite'));
    await ingestNodeGhAwLogs(sqliteIndexedDB, input);
    const sqliteRows = await readCanonicalBatch(sqliteIndexedDB);

    const downloadPromise = page.waitForEvent('download');
    await page.evaluate(async (browserInput) => {
      const coordinatorUrl = `${location.origin}/src/data/ingest/coordinator.js`;
      const storageUrl = `${location.origin}/src/data/storage/indexeddb.js`;
      const [{ ingestGhAwLogs }, { readCanonicalBatch }] = await Promise.all([
        import(coordinatorUrl),
        import(storageUrl)
      ]);
      await ingestGhAwLogs(indexedDB, browserInput);
      const rows = await readCanonicalBatch(indexedDB);
      const url = URL.createObjectURL(new Blob([JSON.stringify(rows)], { type: 'application/json' }));
      const link = document.createElement('a');
      link.href = url;
      link.download = 'indexeddb-canonical-data.json';
      link.click();
    }, input);
    const download = await downloadPromise;
    const browserExportPath = await download.path();
    expect(browserExportPath).not.toBeNull();
    const browserRows = JSON.parse(readFileSync(/** @type {string} */ (browserExportPath), 'utf8'));

    for (const [backend, tables] of Object.entries({ SQLite: sqliteRows, IndexedDB: browserRows })) {
      expect(Object.keys(tables).sort()).toEqual(canonicalEntityTables);
      for (const table of canonicalEntityTables) {
        if (table !== 'packages') {
          expect(tables[table].length, `${backend} ${table} should contain compliance fixture data`).toBeGreaterThan(0);
        }
      }
    }
    expect(browserRows).toEqual(sqliteRows);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('deletion rebuilds derived state and fresh data is directly upserted', async ({ page }) => {
  const result = await page.evaluate(async ({ firstSources, replacementSources, name }) => {
    const coordinatorUrl = `${location.origin}/src/data/ingest/coordinator.js`;
    const storageUrl = `${location.origin}/src/data/storage/indexeddb.js`;
    const [{ ingestDashboardSources }, storage] = await Promise.all([
      import(coordinatorUrl),
      import(storageUrl)
    ]);
    await ingestDashboardSources(indexedDB, firstSources);
    await new Promise((resolve, reject) => {
      const request = indexedDB.deleteDatabase(name);
      request.onsuccess = () => resolve(undefined);
      request.onerror = () => reject(request.error);
    });
    const rebuilt = await ingestDashboardSources(indexedDB, firstSources);
    const replaced = await ingestDashboardSources(indexedDB, replacementSources);
    return {
      rebuilt,
      replaced,
      repositories: await storage.readCollection(indexedDB, 'repositories'),
      runs: await storage.readCollection(indexedDB, 'runs')
    };
  }, {
    firstSources: canonicalSources('generation-a', '101'),
    replacementSources: canonicalSources('generation-b', '202'),
    name: databaseName
  });

  expect(result.rebuilt).toMatchObject({ updated: true });
  expect(result.replaced).toMatchObject({ updated: true });
  expect(result.repositories).toEqual([
    expect.objectContaining({
      id: 'repository:dashboard-sources:githubnext%2Fgh-aw-cao'
    })
  ]);
  expect(result.runs.map((/** @type {Record<string, unknown>} */ run) => run.id)).toEqual([
    'github:run:101:attempt:2',
    'github:run:202:attempt:2'
  ]);
});

test('invalid direct upserts are rejected before changing stored data', async ({ page }) => {
  const activeSources = canonicalSources('generation-a', '101');
  const result = await page.evaluate(async (active) => {
    const coordinatorUrl = `${location.origin}/src/data/ingest/coordinator.js`;
    const normalizeUrl = `${location.origin}/src/data/normalize/index.js`;
    const storageUrl = `${location.origin}/src/data/storage/indexeddb.js`;
    const [{ ingestDashboardSources }, { normalize }, storage] = await Promise.all([
      import(coordinatorUrl), import(normalizeUrl), import(storageUrl)
    ]);
    await ingestDashboardSources(indexedDB, active);

    const invalid = normalize([]);
    invalid.workflows.push({
      id: 'workflow:missing-parent',
      repositoryId: 'repository:missing'
    });
    let error = '';
    try {
      await storage.upsertCanonicalBatch(indexedDB, invalid);
    } catch (cause) {
      error = cause instanceof Error ? cause.message : String(cause);
    }
    return {
      error,
      repositories: await storage.readCollection(indexedDB, 'repositories'),
      workflows: await storage.readCollection(indexedDB, 'workflows')
    };
  }, activeSources);

  expect(result.error).toContain('Canonical relationship validation failed');
  expect(result.repositories).toHaveLength(1);
  expect(result.workflows).toHaveLength(1);
});