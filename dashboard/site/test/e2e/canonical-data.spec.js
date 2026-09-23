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
const canonicalEntityTables = [
  'audits', 'campaigns', 'domains', 'issues', 'repositories', 'runs', 'tools', 'workflows'
];

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
    campaigns: {
      rows: [{
        campaign: 'dashboard',
        'campaign-name': 'CAO Dashboard',
        'campaign-description': 'Deploy the CAO dashboard.',
        'campaign-icon': 'graph',
        'campaign-mode': 'review',
        'campaign-enabled': true,
        'campaign-worker-count': 1,
        'campaign-min-version': 'v0.89.3',
        'campaign-experimental': true,
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
        campaign: 'dashboard',
        'campaign-name': 'CAO Dashboard',
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
        'agent-id': 'copilot',
        'model-id': 'model-b',
        engine: 'copilot',
        'engine-version': '1.2.3',
        'requested-model': 'model-a',
        'resolved-model': 'model-b',
        'aic-total': 17,
        'repository-link': { href: 'https://github.com/githubnext/gh-aw-cao' },
        'run-link': { href: `https://github.com/githubnext/gh-aw-cao/actions/runs/${run}` }
      }],
      metadata: { 'as-of': '2026-09-09T05:00:00Z', 'artifact-generation': generation }
    },
    audits: {
      rows: [
        {
          organization: 'githubnext', repository: 'gh-aw-cao', workflow: '.github/workflows/dashboard.md', run,
          'run-attempt': 2, event: `event-${run}`,
          'event-timestamp': '2026-09-09T04:01:00Z', 'event-source': 'agent',
          'event-type': 'agent_turn', 'event-summary': 'Processed the dashboard request',
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
    domains: {
      rows: [],
      metadata: { 'as-of': '2026-09-09T05:00:00Z', 'artifact-generation': generation }
    },
    tools: {
      rows: [
        {
          organization: 'githubnext', repository: 'gh-aw-cao', workflow: '.github/workflows/dashboard.md', run,
          'run-attempt': 2, event: `tool-call-${run}`,
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
        }
      ],
      metadata: { 'as-of': '2026-09-09T05:00:00Z', 'artifact-generation': generation }
    },
    issues: {
      rows: [],
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
          domain: 'api.github.com', decision: 'allowed', 'decision-label': 'Allowed by policy',
          'request-count': 4, engine: 'copilot', 'resolved-model': 'gpt-5.1',
          'policy-domain-pattern': 'api.github.com', 'policy-rule-description': 'GitHub API access'
        },
        {
          organization: 'githubnext', repository: 'gh-aw-cao',
          workflow: '.github/workflows/dashboard.md', run,
          domain: 'api.github.com', decision: 'denied', 'decision-label': 'Denied by policy',
          'request-count': 2, engine: 'copilot', 'resolved-model': 'gpt-5.1',
          'policy-domain-pattern': 'api.github.com', 'policy-rule-description': 'Unapproved request'
        },
        {
          organization: 'githubnext', repository: 'gh-aw-cao',
          workflow: '.github/workflows/dashboard.md', run,
          domain: 'removed.example', decision: 'unknown', 'request-count': null
        }
      ],
      metadata: { 'as-of': '2026-09-09T05:00:00Z', 'artifact-generation': generation }
    },
    'firewall-policy-rules': {
      rows: [
        {
          organization: 'githubnext', repository: 'gh-aw-cao',
          workflow: '.github/workflows/dashboard.md', run,
          action: 'allow', protocol: 'https', 'domain-pattern': 'api.github.com',
          description: 'GitHub API access', 'hit-count': 4,
          engine: 'copilot', 'resolved-model': 'gpt-5.1'
        },
        {
          organization: 'githubnext', repository: 'gh-aw-cao',
          workflow: '.github/workflows/dashboard.md', run,
          action: 'deny', protocol: 'both', 'domain-pattern': 'all',
          description: 'Default deny', 'hit-count': 2,
          engine: 'copilot', 'resolved-model': 'gpt-5.1'
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

function canonicalWarningSources() {
  const sources = canonicalSources();
  for (const sourceName of [
    'usage',
    'outcomes',
    'work-items',
    'security-findings',
    'graders',
    'experiments',
    'evals',
    'eval-observations',
    'admissions',
    'safe-output-performance'
  ]) {
    Reflect.deleteProperty(sources, sourceName);
  }
  const issueRows = /** @type {Array<Record<string, unknown>>} */ (sources.issues.rows);
  issueRows.push(
    {
      organization: 'githubnext',
      repository: 'gh-aw-cao',
      workflow: '.github/workflows/dashboard.md',
      run: '12345',
      'run-attempt': 2,
      session: 'session-12345',
      event: 'safe-output-12345',
      'event-timestamp': '2026-09-09T04:03:00Z',
      'event-source': 'safe-output',
      'event-type': 'safe_output.created',
      'event-summary': 'Created issue',
      'event-status': 'created',
      'correlation-id': 'https://github.com/githubnext/gh-aw-cao/issues/7',
      'safe-output-type': 'create_issue',
      'github-entity-type': 'issue',
      'is-pull-request': false,
      'observed-at': '2026-09-09T05:00:00Z'
    }
  );
  const auditRows = /** @type {Array<Record<string, unknown>>} */ (sources.audits.rows);
  auditRows.push({
      organization: 'githubnext',
      repository: 'gh-aw-cao',
      workflow: '.github/workflows/dashboard.md',
      run: '12345',
      'run-attempt': 2,
      session: 'session-12345',
      event: 'finding-12345',
      'event-timestamp': '2026-09-09T04:04:00Z',
      'event-source': 'audit',
      'event-type': 'audit.finding',
      'event-summary': 'Prompt injection detected',
      'event-status': 'high',
      'observed-at': '2026-09-09T05:00:00Z'
  });
  return sources;
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
    if (pathname === '/inventory-sources.json') {
      const sources = canonicalSources();
      sources.campaigns.rows.push({
        campaign: 'repo-assist',
        'campaign-name': 'Repo Assist',
        'campaign-description': 'Review-first repository assistance.',
        'campaign-icon': 'gear',
        'campaign-mode': 'review',
        'campaign-enabled': true,
        'campaign-worker-count': 4,
        'campaign-min-version': 'v0.89.17',
        'campaign-experimental': true,
        'observed-at': '2026-09-09T05:00:00Z'
      });
      await route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify({
          campaigns: sources.campaigns,
          repositories: sources.repositories,
          workflows: sources.workflows
        })
      });
      return;
    }
    if (pathname === '/payload-hashes.json') {
      await route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify({ 'gh-aw-logs-shards/logs-1.jsonl': 'a'.repeat(64) })
      });
      return;
    }
    if (pathname === '/gh-aw-logs-shards/logs-1.jsonl') {
      await route.fulfill({
        contentType: 'application/x-ndjson',
        body: `${JSON.stringify({ schema_version: 2, kind: 'run', run: {
          run_id: 12345,
          run_attempt: 1,
          organization: 'githubnext',
          repository: 'gh-aw-cao',
          workflow_name: 'Dashboard',
          workflow_path: '.github/workflows/dashboard.md',
          status: 'completed',
          conclusion: 'success',
          created_at: '2026-09-09T04:00:00Z',
          updated_at: '2026-09-09T04:05:00Z',
          url: 'https://github.com/githubnext/gh-aw-cao/actions/runs/12345',
          audit: {
            mcp_tool_usage: {
              tool_calls: [
                {
                  tool_call_id: 'call-12345-1',
                  timestamp: '2026-09-09T04:02:00Z',
                  server_name: 'github',
                  tool_name: 'search_issues',
                  input_size: 42,
                  output_size: 128,
                  status: 'success'
                },
                {
                  tool_call_id: 'call-12345-2',
                  timestamp: '2026-09-09T04:03:00Z',
                  server_name: 'github',
                  tool_name: 'search_issues',
                  input_size: 42,
                  output_size: 128,
                  status: 'success'
                },
                {
                  tool_call_id: 'call-12345-3',
                  timestamp: '2026-09-09T04:04:00Z',
                  server_name: 'safe_outputs',
                  tool_name: 'create_issue',
                  input_size: 42,
                  output_size: 128,
                  status: 'success'
                }
              ]
            },
            firewall_analysis: {
              requests_by_domain: {
                'api.github.com:443': { allowed: 4, blocked: 2 },
                'objects.githubusercontent.com:443': { allowed: 3, blocked: 0 }
              }
            }
          }
        } })}\n`
      });
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
    return { result, repositories, workflows, runs };
  }, sources);

  expect(first.result).toMatchObject({ updated: true });
  expect(first.repositories).toHaveLength(1);
  expect(first.workflows).toHaveLength(1);
  expect(first.runs[0].id).toBe('github:run:githubnext/gh-aw-cao:12345');

  await page.reload();
  const retained = await page.evaluate(async () => {
    const queriesUrl = `${location.origin}/src/data/queries/index.js`;
    const { createCanonicalQueries } = await import(queriesUrl);
    const queries = createCanonicalQueries(indexedDB);
    return queries.runs.recentFailures();
  });
  expect(retained).toEqual([expect.objectContaining({ id: 'github:run:githubnext/gh-aw-cao:12345' })]);

  const viewSources = await page.evaluate(async (sourceDocument) => {
    const databaseUrl = `${location.origin}/src/data/queries/database.js`;
    const { loadDatabaseQuerySources } = await import(databaseUrl);
    return loadDatabaseQuerySources(indexedDB, sourceDocument, {
      sourceNames: ['failed-runs', 'runs'],
      queries: [{
        name: 'failed-runs',
        from: 'runs',
        filter: { predicates: [{ field: 'run-conclusion', equals: 'failure' }] }
      }]
    });
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
      'source-kind': 'derived',
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
      'source-kind': 'database-query',
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
    const context = {
      githubUrlBase: 'https://github.com',
      pages: [],
      queries: [{
        name: 'failed-runs',
        from: 'runs',
        filter: { predicates: [{ field: 'run-conclusion', equals: 'failure' }] }
      }]
    };
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
      metadata: { 'source-kind': 'derived' }
    });
  }
});

test('data worker avoids unavailable legacy boundaries on initial and navigated requests', async ({ context, page }) => {
  await context.route('http://dashboard.test/canonical-warning-sources.json', async (route) => {
    await route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify(canonicalWarningSources())
    });
  });

  const result = await page.evaluate(async () => {
    const processorUrl = `${location.origin}/src/data-processor.js`;
    const { loadCanonicalDashboardSources, loadCanonicalDashboardPage } = await import(processorUrl);
    const dashboard = await fetch(`${location.origin}/dashboard.json`).then((response) => response.json());
    const sourceNames = [
      'usage',
      'outcomes',
      'findings',
      'security-findings',
      'detection-observations',
      'work-items',
      'graders',
      'experiments',
      'evals',
      'eval-observations',
      'admissions',
      'safe-output-performance',
      'data-health-collections',
      'data-health-coverage'
    ];
    const dashboardContext = {
      githubUrlBase: dashboard.dashboard['github-url-base'],
      pages: dashboard.dashboard.pages,
      queries: dashboard.dashboard.queries
    };
    const initial = await loadCanonicalDashboardSources(
      `${location.origin}/canonical-warning-sources.json`,
      sourceNames,
      dashboardContext
    );
    const navigated = await loadCanonicalDashboardPage(sourceNames, dashboardContext);
    return { initial, navigated, sourceNames };
  });

  for (const payload of [result.initial, result.navigated]) {
    expect(Object.keys(payload).sort()).toEqual([...result.sourceNames].sort());
    for (const source of Object.values(payload)) {
      expect(source.metadata.availability).not.toBe('unavailable');
    }
    // `outcomes` is derived from the `issues` canonical source, so deleting the
    // published `outcomes` boundary still yields the issue row pushed above.
    expect(payload.outcomes.rows).toHaveLength(1);
    expect(payload.outcomes.rows[0]).toMatchObject({
      organization: 'githubnext',
      repository: 'gh-aw-cao',
      run: '12345',
      'outcome-category': 'issue'
    });
    expect(payload['security-findings'].rows).toEqual([]);
    expect(payload['work-items'].rows).toEqual([]);
    expect(payload['data-health-collections'].metadata.availability).toBe('available');
    expect(payload['data-health-coverage'].metadata.availability).toBe('available');
  }
});

test('data worker reports an already ingested payload as unchanged', async ({ page }) => {
  const refreshes = await page.evaluate(async () => {
    const processorUrl = `${location.origin}/src/data-processor.js`;
    const { refreshCanonicalDashboardSources } = await import(processorUrl);
    const context = {
      githubUrlBase: 'https://github.com',
      pages: [],
      queries: [{
        name: 'failed-runs',
        from: 'runs',
        filter: { predicates: [{ field: 'run-conclusion', equals: 'failure' }] }
      }]
    };
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

  expect(refreshes.map((refresh) => refresh.changed)).toEqual([true, false]);
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
      {
        githubUrlBase: 'https://github.com',
        pages: [],
        queries: [{
          name: 'failed-runs',
          from: 'runs',
          filter: { predicates: [{ field: 'run-conclusion', equals: 'failure' }] }
        }]
      }
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
        name: 'failed-runs',
        from: 'runs',
        filter: { predicates: [{ field: 'run-conclusion', equals: 'failure' }] }
      }, {
        name: 'cached-run-totals',
        from: 'runs',
        aggregate: { values: [{ field: 'run', as: 'runs', reducer: 'distinct-count' }] }
      }, {
        name: 'overview-attention-domains',
        from: 'source-metadata',
        select: [
          { field: 'source', as: 'domain' },
          { field: 'row-count', as: 'value' }
        ]
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
    metadata: { 'source-kind': 'derived' }
  });
  expect(result.retained['cached-run-totals']).toMatchObject({
    rows: [{ runs: 1 }],
    metadata: { 'source-kind': 'derived', 'query-name': 'cached-run-totals' }
  });
  expect(result.retained['overview-attention-domains']).toMatchObject({
    rows: [],
    metadata: { availability: 'empty', 'source-kind': 'derived' }
  });
  expect(result.refreshed.changed).toBe(false);
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
        summary: 'copilot / model-b',
        events: 1
      }],
      metadata: { 'source-kind': 'derived', 'query-name': 'engines-models-usage' }
    });
  }
});

test('data worker returns MCP tool totals without safe outputs calls on initial and navigated requests', async ({ page }) => {
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
      `${location.origin}/payload-hashes.json`,
      ['mcp-tool-totals', 'mcp-top-tools'],
      context
    );
    const navigated = await loadCanonicalDashboardPage(['mcp-tool-totals', 'mcp-top-tools'], context);
    const base = await loadCanonicalDashboardPage(['mcp-calls'], context);
    const { executeDashboardQueries } = await import(`${location.origin}/src/data/queries/declarative.js`);
    const direct = executeDashboardQueries(dashboard.dashboard.queries, base, ['mcp-tool-calls', 'mcp-tool-totals']);
    return { initial, navigated, base, direct };
  });

  expect(result.base['mcp-calls'].rows).toHaveLength(3);
  expect(result.base['mcp-calls'].rows[0]).toMatchObject({
    'mcp-server': 'github',
    'mcp-tool': 'search_issues'
  });
  expect(result.direct['mcp-tool-calls'].rows).toHaveLength(3);
  expect(result.direct['mcp-tool-totals'].rows).toHaveLength(1);
  for (const payload of [result.initial, result.navigated]) {
    expect(Object.keys(payload)).toEqual(['mcp-tool-totals', 'mcp-top-tools']);
    expect(payload['mcp-tool-totals']).toMatchObject({
      source: 'mcp-tool-totals',
      rows: [{
        'mcp-tool-label': 'github/search_issues',
        'mcp-tool': 'search_issues',
        'mcp-server': 'github',
        calls: 2,
        workflows: 1
      }],
      metadata: { 'source-kind': 'derived', 'query-name': 'mcp-tool-totals' }
    });
    expect(payload['mcp-top-tools']).toMatchObject({
      source: 'mcp-top-tools',
      rows: [{ 'mcp-tool-label': 'github/search_issues', 'mcp-tool': 'search_issues', 'mcp-server': 'github', calls: 2, workflows: 1 }],
      metadata: { 'source-kind': 'derived', 'query-name': 'mcp-top-tools' }
    });
  }
});


test('data worker queries firewall summaries on initial and navigated requests', async ({ page }) => {
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
      ['firewall-domain-totals', 'firewall-most-blocked-domains'],
      context
    );
    const navigated = await loadCanonicalDashboardPage(
      ['firewall-domain-totals', 'firewall-most-blocked-domains'],
      context
    );
    return { initial, navigated };
  });

  for (const payload of [result.initial, result.navigated]) {
    expect(Object.keys(payload)).toEqual([
      'firewall-domain-totals',
      'firewall-most-blocked-domains'
    ]);
    expect(payload['firewall-domain-totals']).toMatchObject({
      rows: [{ domain: 'api.github.com', run: 1, accepted: 4, blocked: 2 }],
      metadata: { 'source-kind': 'derived', 'query-name': 'firewall-domain-totals' }
    });
    expect(payload['firewall-most-blocked-domains']).toMatchObject({
      rows: [{ domain: 'api.github.com', run: 1, accepted: 4, blocked: 2 }],
      metadata: { 'source-kind': 'derived', 'query-name': 'firewall-most-blocked-domains' }
    });
  }
});

test('gh-aw logs audit populates the firewall domain query from canonical events', async ({ page }) => {
  const result = await page.evaluate(async () => {
    const processorUrl = `${location.origin}/src/data-processor.js`;
    const { loadCanonicalDashboardSources } = await import(processorUrl);
    const dashboard = await fetch(`${location.origin}/dashboard.json`).then((response) => response.json());
    return loadCanonicalDashboardSources(
      `${location.origin}/payload-hashes.json`,
      ['firewall-domain-totals'],
      {
        githubUrlBase: 'https://github.com',
        pages: dashboard.dashboard.pages,
        queries: dashboard.dashboard.queries
      }
    );
  });

  expect(result['firewall-domain-totals']).toMatchObject({
    rows: [
      { domain: 'api.github.com', run: 1, accepted: 4, blocked: 2 },
      { domain: 'objects.githubusercontent.com', run: 1, accepted: 3, blocked: 0 }
    ],
    metadata: { 'source-kind': 'derived', 'query-name': 'firewall-domain-totals' }
  });
});

test('data worker computes repository and campaign pages with request-scoped dashboard queries', async ({ page }) => {
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
    const horizon = await loadCanonicalDashboardSources(
      `${location.origin}/sources.json`,
      ['repository-activity'],
      context,
      undefined,
      {
        pageId: 'repositories',
        queryContext: {
          timeWindow: {
            start: '2026-09-10T00:00:00Z',
            end: '2026-10-01T00:00:00Z'
          }
        }
      }
    );
    const navigated = await loadCanonicalDashboardPage(['campaign-inventory'], context);
    return { initial, horizon, navigated };
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
  const horizonSource = result.horizon[Object.keys(result.horizon)[0]];
  expect(horizonSource.rows).toEqual([]);
  expect(Object.keys(result.navigated)).toEqual(['campaign-inventory']);
  expect(result.navigated['campaign-inventory']).toMatchObject({
    rows: [{
      campaign: 'dashboard',
      'campaign-name': 'CAO Dashboard',
      workflows: 1,
      roles: 'worker',
      modes: 'review',
      registration: 'true',
      runs: 1,
      dispatches: 0,
      aic: 17
    }],
    metadata: { 'source-kind': 'derived', 'query-name': 'campaign-inventory' }
  });
});

test('deployed JSONL ingestion includes the published campaign inventory', async ({ page }) => {
  const result = await page.evaluate(async () => {
    const { loadCanonicalDashboardSources } = await import(`${location.origin}/src/data-processor.js`);
    const dashboard = await fetch(`${location.origin}/dashboard.json`).then((response) => response.json());
    return loadCanonicalDashboardSources(
      `${location.origin}/payload-hashes.json`,
      ['campaigns', 'workflows', 'campaign-inventory'],
      {
        githubUrlBase: 'https://github.com',
        pages: dashboard.dashboard.pages,
        queries: dashboard.dashboard.queries
      }
    );
  });

  expect(result.campaigns.rows).toHaveLength(2);
  expect(result.workflows.rows).toHaveLength(1);
  expect(result['campaign-inventory']).toMatchObject({
    rows: [
      {
        campaign: 'dashboard',
        'campaign-name': 'CAO Dashboard',
        workflows: 1,
        runs: 1,
        dispatches: 0
      },
      {
        campaign: 'repo-assist',
        'campaign-name': 'Repo Assist',
        workflows: 0,
        runs: 0,
        dispatches: 0
      }
    ]
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

test('Chromium ingests gh-aw artifacts as a Run and ordered run records', async ({ page }) => {
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
    const runId = String(runs[0].id);
    const [domains, tools, audits, issues] = await Promise.all([
      queries.domains.forRun(runId),
      queries.tools.forRun(runId),
      queries.audits.forRun(runId),
      queries.issues.forRun(runId)
    ]);
    return { ingestion, runs, domains, tools, audits, issues };
  }, ghAwLogInput());

  expect(result.ingestion).toMatchObject({ updated: true });
  expect(result.runs[0].id).toBe('github:run:githubnext/gh-aw-cao:303');
  expect(result.domains.map((/** @type {Record<string, unknown>} */ record) => [record.sequence, record.source, record.type])).toEqual([
    [0, 'firewall', 'net_allowed']
  ]);
  expect(result.tools.map((/** @type {Record<string, unknown>} */ record) => [record.sequence, record.source, record.type])).toEqual([
    [0, 'gateway', 'tool_call'],
    [1, 'agent', 'agent_tool_start'],
    [2, 'agent', 'agent_tool_done']
  ]);
  expect(result.audits.map((/** @type {Record<string, unknown>} */ record) => [record.sequence, record.source, record.type])).toEqual([
    [0, 'agent', 'agent_turn'],
    [1, 'agent', 'assistant_message']
  ]);
  expect(result.issues).toEqual([]);
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
      for (const table of ['repositories', 'workflows', 'runs', 'domains', 'tools', 'audits']) {
        expect(tables[table].length, `${backend} ${table} should contain compliance fixture data`).toBeGreaterThan(0);
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
      id: 'repository:githubnext%2Fgh-aw-cao'
    })
  ]);
  expect(result.runs.map((/** @type {Record<string, unknown>} */ run) => run.id)).toEqual([
    'github:run:githubnext/gh-aw-cao:101',
    'github:run:githubnext/gh-aw-cao:202'
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