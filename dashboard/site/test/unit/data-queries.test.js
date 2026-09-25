import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  DASHBOARD_QUERY_LIMITS,
  DashboardQueryCancelledError,
  createDashboardQueryBudget,
  dashboardQueryDefects,
  dashboardQueryOutputFields,
  executeDashboardQueries,
  executeDashboardQuery,
  paginateDashboardSources,
  resolveDashboardQuerySources
} from '../../src/data/queries/declarative.js';
import { computeValue, tidy } from '../../src/data-operations.js';
import { processDataRequest } from '../../src/data-worker.js';

/**
 * @param {string} id
 * @param {Partial<Record<string, string>>} [overrides]
 * @returns {import('../../src/presenter.js').SourceMetadata}
 */
function metadata(id, overrides = {}) {
  return /** @type {import('../../src/presenter.js').SourceMetadata} */ ({
    'source-id': id,
    'source-kind': 'published',
    'as-of': '2026-09-01T00:00:00Z',
    'retrieved-at': '2026-09-01T01:00:00Z',
    completeness: 'complete',
    freshness: 'fresh',
    availability: 'available',
    ...overrides
  });
}

/** @type {import('../../src/presenter.js').LogicalSourceInput} */
const workflows = {
  source: 'workflows',
  rows: [
    { id: 'workflow:a', organization: 'githubnext', repository: 'gh-aw-cao', workflow: 'a.md', campaign: 'aw-doctor' },
    { id: 'workflow:b', organization: 'githubnext', repository: 'gh-aw-cao', workflow: 'b.md' }
  ],
  metadata: metadata('workflows')
};

/** @type {import('../../src/presenter.js').LogicalSourceInput} */
const usage = {
  source: 'usage',
  rows: [
    {
      organization: 'githubnext', repository: 'gh-aw-cao', workflow: 'a.md', run: '1',
      engine: 'copilot', 'engine-version': '1.2.3', 'agent-id': 'copilot', 'model-id': 'model-b',
      'requested-model': 'model-a', 'resolved-model': 'model-b', 'rollout-mode': 'review', aic: 4,
      'observed-at': '2026-09-01T00:00:00Z', 'run-link': { href: 'run-1' }
    },
    {
      organization: 'githubnext', repository: 'gh-aw-cao', workflow: 'a.md', run: '2',
      engine: 'copilot', 'engine-version': '1.2.4', 'agent-id': 'copilot', 'model-id': 'model-b',
      'requested-model': 'model-b', 'resolved-model': 'model-b', 'rollout-mode': 'live', aic: 6,
      'observed-at': '2026-09-02T00:00:00Z', 'run-link': { href: 'run-2' }
    }
  ],
  metadata: metadata('usage', { freshness: 'stale' })
};
const dashboardDocument = JSON.parse(readFileSync(`${process.cwd()}/dashboard.json`, 'utf8'));
const dashboardQueries = dashboardDocument.dashboard.queries;
const emptyRunRecordSources = Object.fromEntries(['domains', 'tools', 'audits', 'issues'].map((source) => [
  source,
  { source, rows: [], metadata: metadata(source) }
]));

describe('declarative dashboard queries', () => {

  it('unions specialized run records before applying query clauses', () => {
    const result = executeDashboardQuery(
      {
        name: 'run-records',
        from: 'audits',
        union: ['domains', 'tools', 'issues'],
        select: [{ field: 'event' }],
        'order-by': [{ field: 'event', direction: 'asc' }]
      },
      Object.fromEntries(['audits', 'domains', 'tools', 'issues'].map((source, index) => [
        source,
        { source, rows: [{ event: `${index + 1}` }], metadata: metadata(source) }
      ]))
    );

    expect(result.rows).toEqual([{ event: '1' }, { event: '2' }, { event: '3' }, { event: '4' }]);
  });

  it('counts every specialized record kind when identifying imported runs', () => {
    const run = (/** @type {string} */ id) => ({
      organization: 'githubnext',
      repository: 'gh-aw-cao',
      workflow: 'activity.md',
      run: id,
      'run-attempt': 1
    });
    const sources = {
      runs: { source: 'runs', rows: ['1', '2', '3', '4'].map(run), metadata: metadata('runs') },
      audits: { source: 'audits', rows: [{ ...run('1'), event: 'audit-1' }], metadata: metadata('audits') },
      domains: { source: 'domains', rows: [{ ...run('2'), event: 'domain-1' }], metadata: metadata('domains') },
      tools: { source: 'tools', rows: [{ ...run('3'), event: 'tool-1' }], metadata: metadata('tools') },
      issues: { source: 'issues', rows: [{ ...run('4'), event: 'issue-1' }], metadata: metadata('issues') }
    };

    const result = executeDashboardQueries(dashboardQueries, sources, ['run-import-status']);

    expect(result['run-import-status'].rows).toHaveLength(4);
    expect(result['run-import-status'].rows.every((row) => row.imported === true)).toBe(true);
  });

  it.each([
    ['delivering value', { successes: 0, failures: 0, active: 0, graders: 1 }, 'Your campaigns are delivering value.'],
    ['active', { successes: 0, failures: 2, active: 1, graders: 0 }, 'Your campaigns are humming.'],
    ['under strain', { successes: 1, failures: 2, active: 0, graders: 0 }, 'Your campaigns are under strain.'],
    ['needs attention', { successes: 2, failures: 1, active: 0, graders: 0 }, 'Your campaigns need attention.'],
    ['successful', { successes: 1, failures: 0, active: 0, graders: 0 }, 'Your campaigns are humming.'],
    ['idle', { successes: 0, failures: 0, active: 0, graders: 0 }, 'Your campaigns are idle.']
  ])('classifies factory status as %s in Dashboard Language', (_state, counts, expected) => {
    const runs = [
      ...Array.from({ length: counts.successes }, (_, index) => ({ run: `success-${index}`, 'run-conclusion': 'success', 'run-status': 'completed' })),
      ...Array.from({ length: counts.failures }, (_, index) => ({ run: `failure-${index}`, 'run-conclusion': 'failure', 'run-status': 'completed' })),
      ...Array.from({ length: counts.active }, (_, index) => ({ run: `active-${index}`, 'run-conclusion': '', 'run-status': 'in_progress' }))
    ];
    const graders = Array.from({ length: counts.graders }, (_, index) => ({ grader: `grader-${index}` }));
    const result = executeDashboardQueries(
      dashboardQueries,
      {
        runs: { source: 'runs', rows: runs, metadata: metadata('runs') },
        workflows: { source: 'workflows', rows: [], metadata: metadata('workflows') },
        'grader-observations': { source: 'grader-observations', rows: graders, metadata: metadata('grader-observations') }
      },
      ['overview-factory-status']
    );

    expect(result['overview-factory-status'].rows).toEqual([{ 'factory-heading': expected }]);
  });

  it('retains run classification when optional value evidence is unavailable', () => {
    const result = executeDashboardQueries(
      dashboardQueries,
      {
        runs: { source: 'runs', rows: [{ run: '1', 'run-conclusion': 'success', 'run-status': 'completed' }], metadata: metadata('runs') },
        workflows: { source: 'workflows', rows: [], metadata: metadata('workflows') },
        'grader-observations': { source: 'grader-observations', rows: [], metadata: metadata('grader-observations', { availability: 'unavailable' }) }
      },
      ['overview-factory-status']
    );

    expect(result['overview-factory-status'].metadata.availability).toBe('available');
    expect(result['overview-factory-status'].rows).toEqual([{ 'factory-heading': 'Your campaigns are humming.' }]);
  });

  it('uses retained failure descriptions as campaign problem titles', () => {
    const result = executeDashboardQueries(
      dashboardQueries,
      {
        runs: {
          source: 'runs',
          rows: [{
            organization: 'githubnext',
            repository: 'gh-aw-cao',
            workflow: '.github/workflows/dashboard.md',
            run: '42',
            'run-attempt': 1,
            'run-status': 'completed',
            'run-conclusion': 'failure',
            'started-at': '2026-09-09T04:00:00Z',
            'failure-message': 'Dependency update failed',
            'failure-detail': 'Dependency update failed',
            'target-repository': 'github/gh-aw',
            'rollout-mode': 'review'
          }],
          metadata: metadata('runs')
        },
        workflows: {
          source: 'workflows',
          rows: [{
            organization: 'githubnext',
            repository: 'gh-aw-cao',
            workflow: '.github/workflows/dashboard.md',
            campaign: 'dashboard',
            'campaign-name': 'CAO Dashboard',
            'workflow-name': 'Dashboard',
            'workflow-role': 'worker'
          }],
          metadata: metadata('workflows')
        }
      },
      ['campaign-problem-items']
    );

    expect(result['campaign-problem-items'].rows).toEqual([
      expect.objectContaining({
        'problem-title': 'Dependency update failed',
        'failure-message': 'Dependency update failed',
        'status-detail': 'Dependency update failed'
      })
    ]);
  });

  it('produces presentation-ready Overview header and station payloads', () => {
    const result = executeDashboardQueries(
      dashboardQueries,
      {
        campaigns: {
          source: 'campaigns',
          rows: [
            { id: 'campaign:one', campaign: 'one' },
            { id: 'campaign:two', campaign: 'two' }
          ],
          metadata: metadata('campaigns')
        },
        runs: { source: 'runs', rows: [], metadata: metadata('runs') },
        workflows: { source: 'workflows', rows: [], metadata: metadata('workflows') },
        'grader-observations': {
          source: 'grader-observations',
          rows: [{ grader: 'value-created' }],
          metadata: metadata('grader-observations')
        }
      },
      ['overview-header-presentation', 'overview-campaign-station']
    );

    expect(result['overview-header-presentation'].rows).toEqual([{
      heading: 'Your campaigns are delivering value.'
    }]);
    expect(result['overview-campaign-station'].rows).toEqual([{
      value: 1,
      'display-value': '100%',
      detail: '2/2 healthy campaigns',
      description: '100% campaign health',
      active: false
    }]);
  });

  it('counts canonical repository identities registered in the resolved control-plane scope', () => {
    const repositories = [
      ['github', 'gh-aw'],
      ['github', 'gh-aw-firewall'],
      ['github', 'gh-aw-mcpg'],
      ['github', 'gh-aw-actions'],
      ['github', 'gh-aw-threat-detection'],
      ['githubnext', 'gh-aw-cao']
    ].map(([organization, repository], index) => ({
      id: `repository:${index}`,
      organization,
      repository
    }));

    const result = executeDashboardQueries(
      dashboardQueries,
      { repositories: { source: 'repositories', rows: repositories, metadata: metadata('repositories') } },
      ['overview-registered-repository-summary']
    );

    expect(result['overview-registered-repository-summary'].rows).toEqual([
      { 'registered-repositories': 6 }
    ]);
  });

  it('executes built-in aggregate-local filters with the same filtered totals', () => {
    const result = executeDashboardQueries(
      dashboardQueries,
      {
        runs: {
          source: 'runs',
          rows: [
            { organization: 'githubnext', repository: 'gh-aw-cao', workflow: 'a.md', run: '1', 'run-attempt': 1, event: 'workflow_dispatch', 'run-conclusion': 'success', 'run-status': 'completed', 'rollout-mode': 'live' },
            { organization: 'githubnext', repository: 'gh-aw-cao', workflow: 'a.md', run: '2', 'run-attempt': 1, event: 'workflow_dispatch', 'run-conclusion': 'failure', 'run-status': 'completed', 'rollout-mode': 'review' },
            { organization: 'githubnext', repository: 'gh-aw-cao', workflow: 'a.md', run: '3', 'run-attempt': 1, event: 'workflow_dispatch', 'run-conclusion': 'timed-out', 'run-status': 'queued', 'rollout-mode': 'live', 'aic-total': 3 },
            { organization: 'githubnext', repository: 'gh-aw-cao', workflow: 'a.md', run: '4', 'run-attempt': 1, event: 'workflow_dispatch', 'run-conclusion': 'startup-failure', 'run-status': 'in_progress', 'rollout-mode': 'review', 'aic-total': 5 },
            { organization: 'githubnext', repository: 'gh-aw-cao', workflow: 'a.md', run: '5', 'run-attempt': 1, event: 'push', 'run-conclusion': 'success', 'run-status': 'in-progress', 'rollout-mode': 'review', 'aic-total': 7 },
            { organization: 'githubnext', repository: 'gh-aw-cao', workflow: 'a.md', run: '6', 'run-attempt': 1, event: 'push', 'run-conclusion': 'action-required', 'run-status': 'completed', 'rollout-mode': 'review' },
            { organization: 'githubnext', repository: 'other', workflow: 'c.md', run: '7', 'run-attempt': 1, event: 'push', 'run-conclusion': 'success', 'run-status': 'completed', 'rollout-mode': 'review' }
          ],
          metadata: metadata('runs')
        },
        workflows: {
          source: 'workflows',
          rows: [
            { organization: 'githubnext', repository: 'gh-aw-cao', workflow: 'a.md', campaign: 'dashboard', 'workflow-active': 'false' },
            { organization: 'githubnext', repository: 'gh-aw-cao', workflow: 'b.md', 'workflow-active': false },
            { organization: 'githubnext', repository: 'other', workflow: 'c.md', 'workflow-active': 'true' }
          ],
          metadata: metadata('workflows')
        },
        'firewall-observations': {
          source: 'firewall-observations',
          rows: [
            { domain: 'api.github.com', organization: 'githubnext', repository: 'gh-aw-cao', workflow: 'a.md', run: '1', decision: 'allowed', 'request-count': 2, 'workflow-link': { href: 'https://github.com/githubnext/gh-aw-cao/blob/HEAD/a.md' } },
            { domain: 'api.github.com', organization: 'githubnext', repository: 'gh-aw-cao', workflow: 'a.md', run: '2', decision: 'denied', 'request-count': 5, 'workflow-link': { href: 'https://github.com/githubnext/gh-aw-cao/blob/HEAD/a.md' } },
            { domain: 'api.github.com', organization: 'githubnext', repository: 'gh-aw-cao', workflow: 'a.md', run: '2', decision: 'denied', 'request-count': 3, 'workflow-link': { href: 'https://github.com/githubnext/gh-aw-cao/blob/HEAD/a.md' } },
            { domain: 'uploads.github.com', organization: 'githubnext', repository: 'other', workflow: 'c.md', run: '3', decision: 'allowed', 'request-count': 7, 'workflow-link': { href: 'https://github.example.com/githubnext/other/blob/HEAD/c.md' } }
          ],
          metadata: metadata('firewall-observations')
        },
        audits: {
          source: 'audits',
          rows: [
            { organization: 'githubnext', repository: 'gh-aw-cao', workflow: 'a.md', run: '1', 'run-attempt': 1, event: 'event-1' },
            { organization: 'githubnext', repository: 'gh-aw-cao', workflow: 'a.md', run: '2', 'run-attempt': 1, event: 'event-2' }
          ],
          metadata: metadata('audits')
        },
        domains: emptyRunRecordSources.domains,
        tools: emptyRunRecordSources.tools,
        issues: emptyRunRecordSources.issues
      },
      [
        'overview-run-summary',
        'firewall-domain-totals',
        'firewall-domain-workflows',
        'repository-workflow-totals',
        'repository-run-totals'
      ]
    );

    expect(result['overview-run-summary'].rows).toEqual([
      { 'successful-runs': 3, 'failed-runs': 3, 'active-runs': 3, 'active-live': 1, 'active-review': 2 }
    ]);
    expect(result['firewall-domain-totals'].rows).toEqual([
      { domain: 'api.github.com', run: 2, accepted: 2, blocked: 8 },
      { domain: 'uploads.github.com', run: 1, accepted: 7, blocked: 0 }
    ]);
    expect(result['firewall-domain-workflows'].rows).toEqual([
      {
        domain: 'api.github.com',
        organization: 'githubnext',
        repository: 'gh-aw-cao',
        workflow: 'a.md',
        'workflow-source-url': 'https://github.com/githubnext/gh-aw-cao/blob/HEAD/a.md',
        runs: 2,
        accepted: 2,
        blocked: 8
      },
      {
        domain: 'uploads.github.com',
        organization: 'githubnext',
        repository: 'other',
        workflow: 'c.md',
        'workflow-source-url': 'https://github.example.com/githubnext/other/blob/HEAD/c.md',
        runs: 1,
        accepted: 7,
        blocked: 0
      }
    ]);
    expect(result['repository-workflow-totals'].rows).toEqual([
      { organization: 'githubnext', repository: 'gh-aw-cao', workflows: 2, disabled: 2 },
      { organization: 'githubnext', repository: 'other', workflows: 1, disabled: 0 }
    ]);
    expect(result['repository-run-totals'].rows).toEqual([
      { organization: 'githubnext', repository: 'gh-aw-cao', runs: 6, failed: 3, 'action-required': 1, 'imported-runs': 2 },
      { organization: 'githubnext', repository: 'other', runs: 1, failed: 0, 'action-required': 0, 'imported-runs': 0 }
    ]);
  });

  it('counts distinct targets from successful worker dispatches only', () => {
    const runRows = [
      { organization: 'githubnext', repository: 'gh-aw-cao', workflow: 'worker.md', run: '1', event: 'workflow_dispatch', 'run-conclusion': 'success', 'target-repository': 'github/gh-aw' },
      { organization: 'githubnext', repository: 'gh-aw-cao', workflow: 'worker.md', run: '2', event: 'workflow_dispatch', 'run-conclusion': 'success', 'target-repository': 'github/gh-aw' },
      { organization: 'githubnext', repository: 'gh-aw-cao', workflow: 'worker.md', run: '3', event: 'workflow_dispatch', 'run-conclusion': 'success', 'target-repository': 'github/gh-aw-firewall' },
      { organization: 'githubnext', repository: 'gh-aw-cao', workflow: 'worker.md', run: '4', event: 'workflow_dispatch', 'run-conclusion': 'failure', 'target-repository': 'github/failed' },
      { organization: 'githubnext', repository: 'gh-aw-cao', workflow: 'orchestrator.md', run: '5', event: 'workflow_dispatch', 'run-conclusion': 'success', 'target-repository': 'github/orchestrated' },
      { organization: 'githubnext', repository: 'gh-aw-cao', workflow: 'worker.md', run: '6', event: 'push', 'run-conclusion': 'success', 'target-repository': 'github/pushed' },
      { organization: 'githubnext', repository: 'gh-aw-cao', workflow: 'worker.md', run: '7', event: 'workflow_dispatch', 'run-conclusion': 'success' },
      { organization: 'githubnext', repository: 'gh-aw-cao', workflow: 'worker.md', run: '8', event: 'workflow_dispatch', 'run-conclusion': 'success', 'target-repository': 'outside/not-registered' }
    ];
    const workflowRows = [
      { organization: 'githubnext', repository: 'gh-aw-cao', workflow: 'worker.md', 'workflow-role': 'worker' },
      { organization: 'githubnext', repository: 'gh-aw-cao', workflow: 'orchestrator.md', 'workflow-role': 'orchestrator' }
    ];

    const result = executeDashboardQueries(
      dashboardQueries,
      {
        runs: { source: 'runs', rows: runRows, metadata: metadata('runs') },
        workflows: { source: 'workflows', rows: workflowRows, metadata: metadata('workflows') },
        repositories: {
          source: 'repositories',
          rows: [
            { 'repository-coordinate': 'github/gh-aw' },
            { 'repository-coordinate': 'github/gh-aw-firewall' }
          ],
          metadata: metadata('repositories')
        }
      },
      ['overview-delivery-summary']
    );

    expect(result['overview-delivery-summary'].rows).toEqual([
      { 'delivered-repositories': 2 }
    ]);
  });

  it('counts campaigns used by the Overview presentation queries', () => {
    const sources = {
      campaigns: {
        source: 'campaigns',
        rows: [{ id: 'campaign:activity', campaign: 'activity' }, { id: 'campaign:dashboard', campaign: 'dashboard' }],
        metadata: metadata('campaigns')
      }
    };

    const result = executeDashboardQueries(
      dashboardQueries,
      sources,
      ['database-campaign-count']
    );

    expect(result['database-campaign-count'].rows).toEqual([{ campaigns: 2 }]);
  });

  it('derives one compiler upgrade decision per repository', () => {
    const compilerWorkflows = {
      source: 'workflows',
      rows: [
        {
          organization: 'acme',
          repository: 'service',
          workflow: 'a.md',
          'gh-aw-version': 'v0.88.0',
          'gh-aw-current-version': 'v0.89.0',
          'gh-aw-update-state': 'update-available'
        },
        {
          organization: 'acme',
          repository: 'service',
          workflow: 'b.md',
          'gh-aw-version': 'v0.89.0',
          'gh-aw-current-version': 'v0.89.0',
          'gh-aw-update-state': 'current'
        },
        {
          organization: 'acme',
          repository: 'current',
          workflow: 'c.md',
          'gh-aw-version': 'v0.89.0',
          'gh-aw-current-version': 'v0.89.0',
          'gh-aw-update-state': 'current'
        },
        {
          organization: 'acme',
          repository: 'current',
          workflow: 'ci.yml',
          'gh-aw-version': null,
          'gh-aw-current-version': null,
          'gh-aw-update-state': 'unknown'
        },
        {
          organization: 'acme',
          repository: 'unknown',
          workflow: 'd.md',
          'gh-aw-version': null,
          'gh-aw-current-version': null,
          'gh-aw-update-state': 'unknown'
        }
      ],
      metadata: metadata('workflows')
    };

    const result = executeDashboardQueries(
      dashboardQueries,
      { workflows: compilerWorkflows },
      ['maintenance-repositories']
    );

    expect(result['maintenance-repositories'].rows).toEqual([
      {
        repository: 'acme/current',
        'gh-aw-version': 'v0.89.0',
        'gh-aw-current-version': 'v0.89.0',
        'upgrade-required': 0,
        'upgrade-state': 'Current'
      },
      {
        repository: 'acme/service',
        'gh-aw-version': 'v0.88.0, v0.89.0',
        'gh-aw-current-version': 'v0.89.0',
        'upgrade-required': 1,
        'upgrade-state': 'Upgrade recommended'
      },
      {
        repository: 'acme/unknown',
        'gh-aw-version': '',
        'gh-aw-current-version': '',
        'upgrade-required': 0,
        'upgrade-state': 'Upgrade status unavailable'
      }
    ]);
  });

  it('continues query results without exposing cursors in query definitions', () => {
    const sources = {
      runs: {
        source: 'runs',
        rows: ['1005', '1004', '1003', '1002', '1001'].map((run) => ({ run })),
        metadata: metadata('runs')
      }
    };
    const definitions = [{
      name: 'recent-runs',
      from: 'runs',
      'order-by': [{ field: 'run', direction: 'desc' }]
    }];

    const first = executeDashboardQueries(definitions, sources, ['recent-runs'], {
      pagination: { 'recent-runs': { limit: 2 } }
    })['recent-runs'];
    const second = executeDashboardQueries(definitions, sources, ['recent-runs'], {
      pagination: {
        'recent-runs': { limit: 2, continuationToken: first.continuationToken }
      }
    })['recent-runs'];
    const third = executeDashboardQueries(definitions, sources, ['recent-runs'], {
      pagination: {
        'recent-runs': { limit: 2, continuationToken: second.continuationToken }
      }
    })['recent-runs'];

    expect(first.rows).toEqual([{ run: '1005' }, { run: '1004' }]);
    expect(second.rows).toEqual([{ run: '1003' }, { run: '1002' }]);
    expect(third.rows).toEqual([{ run: '1001' }]);
    expect(first.metadata['total-row-count']).toBe(5);
    expect(first.continuationToken).toEqual(expect.any(String));
    expect(second.continuationToken).toEqual(expect.any(String));
    expect(third.continuationToken).toBeUndefined();
    expect(definitions[0]).not.toHaveProperty('cursor');
  });

  it('uses the last monotonic run id to resume after newer runs arrive', () => {
    const first = paginateDashboardSources({
      runs: {
        source: 'runs',
        rows: ['1005', '1004', '1003'].map((run) => ({ run })),
        metadata: metadata('runs')
      }
    }, { runs: { limit: 2 } }).runs;
    const continued = paginateDashboardSources({
      runs: {
        source: 'runs',
        rows: ['1007', '1006', '1005', '1004', '1003'].map((run) => ({ run })),
        metadata: metadata('runs')
      }
    }, {
      runs: { limit: 2, continuationToken: first.continuationToken }
    }).runs;

    expect(continued.rows).toEqual([{ run: '1003' }]);
    expect(continued.continuationToken).toBeUndefined();
  });

  it('rejects invalid and cross-source continuation tokens', () => {
    const page = paginateDashboardSources({
      runs: {
        source: 'runs',
        rows: ['2', '1'].map((run) => ({ run })),
        metadata: metadata('runs')
      }
    }, { runs: { limit: 1 } }).runs;

    expect(() => paginateDashboardSources({
      usage: { source: 'usage', rows: [{ run: '2' }, { run: '1' }], metadata: metadata('usage') }
    }, {
      usage: { limit: 1, continuationToken: page.continuationToken }
    })).toThrow('Invalid or stale continuation token for "usage".');
    expect(() => paginateDashboardSources({
      runs: { source: 'runs', rows: [], metadata: metadata('runs') }
    }, {
      runs: { limit: 1, continuationToken: 'not-a-token' }
    })).toThrow('Invalid or stale continuation token for "runs".');
  });

  it('rejects continuations after query or data revisions change', () => {
    const query = [{ name: 'recent-runs', from: 'runs' }];
    const source = {
      runs: {
        source: 'runs',
        rows: ['3', '2', '1'].map((run) => ({ run })),
        metadata: metadata('runs')
      }
    };
    const first = executeDashboardQueries(query, source, ['recent-runs'], {
      pagination: { 'recent-runs': { limit: 1 } }
    })['recent-runs'];

    expect(() => executeDashboardQueries(
      [{ ...query[0], select: [{ field: 'run' }] }],
      source,
      ['recent-runs'],
      { pagination: { 'recent-runs': { limit: 1, continuationToken: first.continuationToken } } }
    )['recent-runs']).toThrow('Invalid or stale continuation token');
    expect(() => executeDashboardQueries(
      query,
      {
        runs: {
          ...source.runs,
          metadata: metadata('runs', { 'as-of': '2026-09-02T00:00:00Z' })
        }
      },
      ['recent-runs'],
      { pagination: { 'recent-runs': { limit: 1, continuationToken: first.continuationToken } } }
    )['recent-runs']).toThrow('Invalid or stale continuation token');
  });

  it('projects, renames, and orders rows deterministically', () => {
    const result = executeDashboardQuery(
      {
        name: 'workflow-projection',
        from: 'workflows',
        select: [{ field: 'workflow', as: 'name' }, { field: 'campaign' }],
        'order-by': [{ field: 'name', direction: 'desc' }]
      },
      { workflows }
    );

    expect(result.rows).toEqual([{ name: 'b.md' }, { name: 'a.md', campaign: 'aw-doctor' }]);
    expect(result.metadata['source-kind']).toBe('derived');
    expect(result.metadata.availability).toBe('available');
  });

  it('compiles prediction after aggregation and exposes its output field', () => {
    const result = executeDashboardQuery({
      name: 'workflow-forecast',
      from: 'usage',
      aggregate: {
        by: ['workflow', 'run'],
        values: [{ field: 'aic', as: 'aic', reducer: 'sum' }]
      },
      predict: [{
        field: 'aic',
        on: 'run',
        method: 'linear',
        groupby: ['workflow'],
        as: 'predicted-aic'
      }],
      select: [{ field: 'workflow' }, { field: 'run' }, { field: 'aic' }, { field: 'predicted-aic' }]
    }, { usage });

    expect(result.rows.map(({ workflow, run, aic }) => ({ workflow, run, aic }))).toEqual([
      { workflow: 'a.md', run: '1', aic: 4 },
      { workflow: 'a.md', run: '2', aic: 6 }
    ]);
    expect(result.rows[0]['predicted-aic']).toBeCloseTo(4, 10);
    expect(result.rows[1]['predicted-aic']).toBeCloseTo(6, 10);
    expect(dashboardQueryOutputFields(
      {
        name: 'forecast',
        from: 'usage',
        predict: [{ field: 'aic', on: 'run', as: 'predicted-aic' }]
      },
      () => ['run', 'aic']
    )).toEqual(['run', 'aic', 'predicted-aic']);
  });

  it('rejects oversized prediction lists without requiring a join', () => {
    const prediction = { field: 'aic', on: 'run', as: 'predicted-aic' };
    const defects = dashboardQueryDefects([{
      name: 'oversized-prediction',
      from: 'usage',
      predict: Array.from({ length: 9 }, () => prediction)
    }]);
    expect(defects.get('oversized-prediction')).toContain('between 1 and 8');
  });

  it('aggregates, joins, and computes derived fields across sources', () => {
    const derived = executeDashboardQueries(
      [
        {
          name: 'aic-totals',
          from: 'usage',
          aggregate: {
            by: ['organization', 'repository', 'workflow'],
            values: [{ field: 'aic', as: 'aic', reducer: 'sum' }]
          }
        },
        {
          name: 'inventory',
          from: 'workflows',
          joins: [{
            source: 'aic-totals',
            type: 'left',
            on: [
              { left: 'organization', right: 'organization' },
              { left: 'repository', right: 'repository' },
              { left: 'workflow', right: 'workflow' }
            ],
            fields: [{ field: 'aic', as: 'observed-aic' }]
          }],
          compute: [
            { as: 'total-aic', function: 'coalesce', args: [{ field: 'observed-aic' }, { value: 0 }] },
            { as: 'slug', function: 'concat', args: [{ field: 'organization' }, { value: '/' }, { field: 'repository' }] }
          ],
          select: [{ field: 'slug', as: 'repository' }, { field: 'workflow' }, { field: 'total-aic', as: 'aic' }],
          'order-by': [{ field: 'workflow', direction: 'asc' }]
        }
      ],
      { workflows, usage }
    );

    expect(derived.inventory.rows).toEqual([
      { repository: 'githubnext/gh-aw-cao', workflow: 'a.md', aic: 10 },
      { repository: 'githubnext/gh-aw-cao', workflow: 'b.md', aic: 0 }
    ]);
    expect(derived.inventory.metadata.freshness).toBe('stale');
    expect(derived['aic-totals'].metadata['query-name']).toBe('aic-totals');
  });

  it('filters each aggregate independently without changing groups or sibling values', () => {
    const events = {
      source: 'audits',
      rows: [
        { repository: 'api', event: '1', 'event-type': 'firewall.request.blocked', 'request-count': 2 },
        { repository: 'api', event: '2', 'event-type': 'firewall.request.allowed', 'request-count': 0 },
        { repository: 'api', event: null, 'event-type': 'firewall.request.blocked', 'request-count': null },
        { repository: 'web', event: '3', 'event-type': 'gateway.request', 'request-count': 4 },
        { repository: 'web', event: '4', 'event-type': null, 'request-count': 3 }
      ],
      metadata: metadata('audits')
    };
    const result = executeDashboardQuery({
      name: 'event-counts',
      from: 'audits',
      aggregate: {
        by: ['repository'],
        values: [
          { field: 'event', as: 'all-events', reducer: 'count' },
          {
            field: 'event',
            as: 'matched-blocked-records',
            reducer: 'count',
            filter: { predicates: [{ field: 'event-type', equals: 'firewall.request.blocked' }] }
          },
          {
            field: 'request-count',
            as: 'blocked-requests',
            reducer: 'sum',
            filter: { predicates: [{ field: 'event-type', equals: 'firewall.request.blocked' }] }
          },
          {
            field: 'event',
            as: 'firewall-events',
            reducer: 'count',
            filter: {
              predicates: [{
                field: 'event-type',
                in: ['firewall.request.allowed', 'firewall.request.blocked']
              }, {
                field: 'repository',
                equals: 'api'
              }]
            }
          },
          {
            field: 'request-count',
            as: 'missing-mean',
            reducer: 'mean',
            filter: { predicates: [{ field: 'event-type', equals: 'not-observed' }] }
          },
          {
            field: 'event',
            as: 'unknown-types',
            reducer: 'count',
            filter: { predicates: [{ field: 'event-type', equals: 'unknown' }] }
          }
        ]
      },
      'order-by': [{ field: 'repository', direction: 'asc' }]
    }, { audits: events });

    expect(result.rows).toEqual([
      {
        repository: 'api',
        'all-events': 2,
        'matched-blocked-records': 1,
        'blocked-requests': 2,
        'firewall-events': 2,
        'missing-mean': null,
        'unknown-types': 0
      },
      {
        repository: 'web',
        'all-events': 2,
        'matched-blocked-records': 0,
        'blocked-requests': 0,
        'firewall-events': 0,
        'missing-mean': null,
        'unknown-types': 1
      }
    ]);
  });

  it('rejects malformed aggregate filters before reading source rows', () => {
    const aggregateValue = {
      field: 'event',
      as: 'blocked-events',
      reducer: 'count'
    };
    const malformedValues = [
      { ...aggregateValue, filter: null },
      { ...aggregateValue, filter: { predicates: [], extra: true } },
      { ...aggregateValue, filter: { predicates: [null] } },
      { ...aggregateValue, filter: { predicates: [{ field: 'event-type' }] } },
      { ...aggregateValue, filter: { predicates: [{ field: 'event-type', equals: 'blocked', in: ['blocked'] }] } },
      { ...aggregateValue, filter: { predicates: [{ field: 'event-type', equals: null }] } },
      { ...aggregateValue, filter: { predicates: [{ field: 'event-type', equals: Number.NaN }] } },
      { ...aggregateValue, filter: { predicates: [{ field: 'event-type', equals: Number.POSITIVE_INFINITY }] } },
      { ...aggregateValue, filter: { predicates: [{ field: 'event-type', in: [] }] } },
      {
        ...aggregateValue,
        filter: {
          predicates: [{
            field: 'event-type',
            in: Array.from(
              { length: DASHBOARD_QUERY_LIMITS['max-predicate-alternatives'] + 1 },
              (_, index) => `type-${index}`
            )
          }]
        }
      },
      {
        ...aggregateValue,
        filter: {
          predicates: Array.from(
            { length: DASHBOARD_QUERY_LIMITS['max-aggregate-filter-predicates'] + 1 },
            () => ({ field: 'event-type', equals: 'blocked' })
          )
        }
      }
    ];

    for (const [index, value] of malformedValues.entries()) {
      let reads = 0;
      const source = {
        source: 'audits',
        get rows() {
          reads += 1;
          return [{ event: '1', 'event-type': 'firewall.request.blocked' }];
        },
        metadata: metadata('audits')
      };
      const result = executeDashboardQueries([{
        name: `blocked-events-${index}`,
        from: 'audits',
        aggregate: { values: [value] }
      }], { audits: source }, [`blocked-events-${index}`])[`blocked-events-${index}`];

      expect(result.metadata.availability).toBe('unavailable');
      expect(result.metadata['query-diagnostic']).toEqual(expect.any(String));
      expect(reads).toBe(0);
    }
  });

  it('rejects an oversized aggregate value list before reading source rows', () => {
    let reads = 0;
    const source = {
      source: 'audits',
      get rows() {
        reads += 1;
        return [{ event: '1' }];
      },
      metadata: metadata('audits')
    };
    const result = executeDashboardQueries([{
      name: 'event-counts',
      from: 'audits',
      aggregate: {
        values: Array.from(
          { length: DASHBOARD_QUERY_LIMITS['max-aggregate-values'] + 1 },
          (_, index) => ({ field: 'event', as: `events-${index}`, reducer: 'count' })
        )
      }
    }], { audits: source }, ['event-counts'])['event-counts'];

    expect(result.metadata.availability).toBe('unavailable');
    expect(result.metadata['query-diagnostic']).toContain('aggregate values must contain between');
    expect(reads).toBe(0);
  });

  it('charges aggregate-local predicate scans to the query operation budget', () => {
    const query = /** @type {Parameters<typeof executeDashboardQuery>[0]} */ ({
      name: 'blocked-events',
      from: 'audits',
      aggregate: {
        values: [{
          field: 'event',
          as: 'blocked-events',
          reducer: 'count',
          filter: { predicates: [{ field: 'event-type', equals: 'firewall.request.blocked' }] }
        }]
      }
    });
    const events = {
      source: 'audits',
      rows: [
        { event: '1', 'event-type': 'firewall.request.blocked' },
        { event: '2', 'event-type': 'firewall.request.allowed' }
      ],
      metadata: metadata('audits')
    };

    expect(() => executeDashboardQuery(
      query,
      { audits: events },
      undefined,
      createDashboardQueryBudget({ maxOperations: 5 })
    ).rows).toThrow(DashboardQueryCancelledError);
  });

  it('projects the Models & agents view from canonical run metadata', () => {
    expect(resolveDashboardQuerySources(
      dashboardQueries,
      ['engines-models-usage']
    )).toEqual(['engines-models-usage', 'runs']);

    const runs = {
      source: 'runs',
      rows: usage.rows.map((row) => ({
        ...row,
        'aic-total': row.aic,
        ...(row.run === '1'
          ? {
              'input-tokens': 10,
              'output-tokens': 20,
              'cache-write-tokens': 5
            }
          : {
              'input-tokens': 30,
              'cache-read-tokens': 40,
              'cache-write-tokens': 10,
              'reasoning-tokens': 50
            }),
        'run-attempt': 1,
        'repository-link': { href: 'repo' },
        'run-link': { href: `run-${row.run}` }
      })),
      metadata: metadata('runs')
    };
    const derived = executeDashboardQueries(
      dashboardQueries,
      { runs },
      ['engines-models-usage']
    );

    expect(Object.keys(derived)).toEqual(['engines-models-usage']);
    expect(derived['engines-models-usage']).toMatchObject({
      source: 'engines-models-usage',
      rows: [
        {
          summary: 'copilot / model-b',
          runs: 2,
          'minimum-aic-per-run': 4,
          'average-aic-per-run': 5,
          'maximum-aic-per-run': 6,
          'minimum-input-tokens-per-run': 10,
          'average-input-tokens-per-run': 20,
          'maximum-input-tokens-per-run': 30,
          'minimum-output-tokens-per-run': 20,
          'average-output-tokens-per-run': 20,
          'maximum-output-tokens-per-run': 20,
          'minimum-cache-read-tokens-per-run': 40,
          'average-cache-read-tokens-per-run': 40,
          'maximum-cache-read-tokens-per-run': 40,
          'minimum-cache-write-tokens-per-run': 5,
          'average-cache-write-tokens-per-run': 7.5,
          'maximum-cache-write-tokens-per-run': 10,
          'minimum-reasoning-tokens-per-run': 50,
          'average-reasoning-tokens-per-run': 50,
          'maximum-reasoning-tokens-per-run': 50
        }
      ],
      metadata: { 'source-kind': 'derived', 'query-name': 'engines-models-usage' }
    });
  });


  it('groups MCP activity by tool and excludes the safe outputs server', () => {
      const mcpCalls = {
        source: 'mcp-calls',
        rows: [
          {
            organization: 'githubnext', repository: 'gh-aw-cao', workflow: 'a.md',
            'mcp-observation': 'call-1', 'mcp-server': 'github', 'mcp-tool': 'search_issues'
          },
          {
            organization: 'githubnext', repository: 'gh-aw-cao', workflow: 'b.md',
            'mcp-observation': 'call-2', 'mcp-server': 'github', 'mcp-tool': 'search_issues'
          },
          {
            organization: 'githubnext', repository: 'gh-aw-cao', workflow: 'a.md',
            'mcp-observation': 'call-3', 'mcp-server': 'github', 'mcp-tool': 'create_issue'
          },
          {
            organization: 'githubnext', repository: 'gh-aw-cao', workflow: 'a.md',
            'mcp-observation': 'call-4', 'mcp-server': 'safe_outputs', 'mcp-tool': 'create_issue'
          }
        ],
        metadata: metadata('mcp-calls')
      };

      const derived = executeDashboardQueries(dashboardQueries, { 'mcp-calls': mcpCalls }, ['mcp-tool-totals', 'mcp-top-tools']);

      expect(Object.keys(derived)).toEqual(['mcp-tool-totals', 'mcp-top-tools']);
      expect(derived['mcp-tool-totals']).toMatchObject({
        rows: [
          { 'mcp-tool-label': 'github/search_issues', 'mcp-tool': 'search_issues', 'mcp-server': 'github', calls: 2, workflows: 2 },
          { 'mcp-tool-label': 'github/create_issue', 'mcp-tool': 'create_issue', 'mcp-server': 'github', calls: 1, workflows: 1 }
        ],
        metadata: { 'source-kind': 'derived', 'query-name': 'mcp-tool-totals' }
      });
      expect(derived['mcp-top-tools']).toMatchObject({
        rows: [
          { 'mcp-tool-label': 'github/search_issues', 'mcp-tool': 'search_issues', 'mcp-server': 'github', calls: 2, workflows: 2 },
          { 'mcp-tool-label': 'github/create_issue', 'mcp-tool': 'create_issue', 'mcp-server': 'github', calls: 1, workflows: 1 }
        ],
        metadata: { 'source-kind': 'derived', 'query-name': 'mcp-top-tools' }
    });
  });




  it('computes Repositories, Workflows, and Campaigns view payloads from dashboard queries', () => {
    const repositories = {
      source: 'repositories',
      rows: [{
        id: 'repository:githubnext/gh-aw-cao',
        organization: 'githubnext',
        repository: 'gh-aw-cao',
        'repository-coordinate': 'githubnext/gh-aw-cao',
        'repository-link': { href: 'repo' }
      }],
      metadata: metadata('repositories')
    };
    const queryWorkflows = {
      source: 'workflows',
      rows: [
        {
          organization: 'githubnext', repository: 'gh-aw-cao', workflow: 'a.md',
          campaign: 'aw-doctor', 'campaign-name': 'AW Doctor', 'workflow-role': 'orchestrator',
          'rollout-mode': 'review', 'workflow-active': 'true'
        },
        {
          organization: 'githubnext', repository: 'gh-aw-cao', workflow: 'b.md',
          campaign: 'aw-doctor', 'campaign-name': 'AW Doctor', 'workflow-role': 'worker',
          'rollout-mode': 'review', 'workflow-active': 'false'
        },
        {
          organization: 'githubnext', repository: 'gh-aw-cao', workflow: 'c.md',
          campaign: 'aw-doctor', 'campaign-name': 'AW Doctor', 'workflow-role': 'worker',
          'rollout-mode': 'review', 'workflow-active': 'true'
        }
      ],
      metadata: metadata('workflows')
    };
    const campaigns = {
      source: 'campaigns',
      rows: [{
        campaign: 'aw-doctor',
        'campaign-name': 'AW Doctor',
        'campaign-mode': 'review',
        'campaign-registration': 'true'
      }],
      metadata: metadata('campaigns')
    };
    const runs = {
      source: 'runs',
      rows: [
        { organization: 'githubnext', repository: 'gh-aw-cao', workflow: 'a.md', run: '1', 'run-attempt': 1, event: 'workflow_dispatch', 'run-conclusion': 'failure', 'aic-total': 4, 'started-at': '2026-09-01T01:00:00Z' },
        { organization: 'githubnext', repository: 'gh-aw-cao', workflow: 'a.md', run: '2', 'run-attempt': 1, event: 'schedule', 'run-conclusion': 'success', 'aic-total': 6, 'started-at': '2026-09-02T01:00:00Z' },
        { organization: 'githubnext', repository: 'gh-aw-cao', workflow: 'c.md', run: '3', 'run-attempt': 1, event: 'workflow_dispatch', 'run-conclusion': 'success', 'aic-total': 0, 'target-repository': 'githubnext/gh-aw-cao', 'started-at': '2026-09-03T01:00:00Z' }
      ],
      metadata: metadata('runs')
    };
    const events = {
      source: 'audits',
      rows: [
        { organization: 'githubnext', repository: 'gh-aw-cao', workflow: 'a.md', run: '1', 'run-attempt': 1, event: 'event-1' },
        { organization: 'githubnext', repository: 'gh-aw-cao', workflow: 'a.md', run: 'unobserved', 'run-attempt': 1, event: 'event-2' },
        { organization: 'githubnext', repository: 'gh-aw-cao', workflow: 'c.md', run: '3', 'run-attempt': 1, event: 'event-3' }
      ],
      metadata: metadata('audits')
    };
    const outcomes = {
      source: 'outcomes',
      rows: [{ organization: 'githubnext', repository: 'gh-aw-cao', 'safe-output': 'report-1' }],
      metadata: metadata('outcomes')
    };
    const derived = executeDashboardQueries(
      dashboardQueries,
      { ...emptyRunRecordSources, campaigns, repositories, workflows: queryWorkflows, runs, audits: events, outcomes, usage },
      ['entity-workflows', 'repository-activity', 'workflow-inventory', 'campaign-repository-coverage', 'campaign-inventory']
    );

    expect(derived['entity-workflows'].rows).toEqual([
      expect.objectContaining({ workflow: 'a.md', runs: 2, 'successful-runs': 1, 'failed-runs': 1, 'aic-per-run': 5 }),
      expect.objectContaining({ workflow: 'b.md', runs: 0, 'successful-runs': 0, 'failed-runs': 0, 'aic-per-run': null }),
      expect.objectContaining({ workflow: 'c.md', runs: 1, 'successful-runs': 1, 'failed-runs': 0, 'aic-per-run': 0 })
    ]);
    expect(derived['repository-activity'].rows).toEqual([expect.objectContaining({
      repository: 'githubnext/gh-aw-cao',
      workflows: 3,
      reports: 1,
      runs: 3,
      ingestion: '66.7%',
      'failure-summary': '33.3% · 1 failed',
      aic: 10,
      status: 'Needs attention'
    })]);
    expect(derived['workflow-inventory'].rows).toEqual([
      expect.objectContaining({ workflow: 'a.md', runs: 2, 'successful-runs': 1, 'failed-runs': 1, 'aic-per-run': 5, ingestion: '50%' }),
      expect.objectContaining({ workflow: 'b.md', runs: 0, 'successful-runs': 0, 'failed-runs': 0, 'aic-per-run': null, ingestion: null }),
      expect.objectContaining({ workflow: 'c.md', runs: 1, 'successful-runs': 1, 'failed-runs': 0, 'aic-per-run': 0, ingestion: '100%' })
    ]);
    expect(derived['campaign-repository-coverage'].rows).toEqual([{
      campaign: 'aw-doctor',
      'covered-repositories': 1
    }]);
    expect(derived['campaign-inventory'].rows).toEqual([{
      campaign: 'aw-doctor',
      'campaign-name': 'AW Doctor',
      'campaign-dashboard-link': {
        'dashboard-href': '#page-campaign-insights?campaign=aw-doctor',
        'dashboard-label': 'View AW Doctor campaign dashboard'
      },
      workflows: 3,
      roles: 'orchestrator, worker',
      modes: 'review',
      registration: 'false, true',
      runs: 3,
      dispatches: 2,
      'covered-repositories': 1,
      aic: 10,
    }]);
  });

  it('includes rerun attempts in workflow run counts and average AIC', () => {
    const rerunWorkflows = {
      source: 'workflows',
      rows: [{ organization: 'githubnext', repository: 'gh-aw-cao', workflow: 'a.md' }],
      metadata: metadata('workflows')
    };
    const reruns = {
      source: 'runs',
      rows: [
        { organization: 'githubnext', repository: 'gh-aw-cao', workflow: 'a.md', run: '1', 'run-attempt': 1, 'run-conclusion': 'failure', 'aic-total': 4 },
        { organization: 'githubnext', repository: 'gh-aw-cao', workflow: 'a.md', run: '1', 'run-attempt': 2, 'run-conclusion': 'success', 'aic-total': 6 }
      ],
      metadata: metadata('runs')
    };

    const derived = executeDashboardQueries(
      dashboardQueries,
      { workflows: rerunWorkflows, runs: reruns },
      ['entity-workflows']
    );

    expect(derived['entity-workflows'].rows).toEqual([
      expect.objectContaining({ runs: 2, 'successful-runs': 1, 'failed-runs': 1, 'aic-per-run': 5 })
    ]);
  });

  it('keeps unavailable repository report and evaluation metrics unknown', () => {
    const repositories = {
      source: 'repositories',
      rows: [{ organization: 'githubnext', repository: 'gh-aw-cao' }],
      metadata: metadata('repositories')
    };
    const queryWorkflows = {
      source: 'workflows',
      rows: [{
        organization: 'githubnext', repository: 'gh-aw-cao', workflow: 'a.md',
        'workflow-active': 'true'
      }],
      metadata: metadata('workflows')
    };
    const runs = {
      source: 'runs',
      rows: [{
        organization: 'githubnext', repository: 'gh-aw-cao', workflow: 'a.md',
        run: '1', 'run-conclusion': 'success', 'aic-total': 4
      }],
      metadata: metadata('runs')
    };

    const derived = executeDashboardQueries(
      dashboardQueries,
      { repositories, workflows: queryWorkflows, runs },
      ['repository-activity']
    );

    expect(derived['repository-activity'].rows).toEqual([expect.objectContaining({
      repository: 'githubnext/gh-aw-cao',
      reports: null,
      runs: 1,
      aic: 4
    })]);
  });

  it('drops unmatched rows for inner joins and keeps them for left joins', () => {
    const join = {
      source: 'usage-totals',
      on: [{ left: 'workflow', right: 'workflow' }],
      fields: [{ field: 'aic', as: 'aic' }]
    };
    /** @type {Record<string, import('../../src/presenter.js').LogicalSourceInput>} */
    const sources = {
      workflows,
      'usage-totals': { source: 'usage-totals', rows: [{ workflow: 'a.md', aic: 10 }], metadata: metadata('usage-totals') }
    };

    expect(executeDashboardQuery({ name: 'inner', from: 'workflows', joins: [{ ...join, type: 'inner' }] }, sources).rows)
      .toHaveLength(1);
    const left = executeDashboardQuery({ name: 'left', from: 'workflows', joins: [{ ...join, type: 'left' }] }, sources).rows;
    expect(left).toHaveLength(2);
    expect(left[1].aic).toBeNull();
  });

  it('keeps base rows when a left-join enrichment source is unavailable', () => {
    const result = executeDashboardQuery({
      name: 'inventory',
      from: 'workflows',
      joins: [{
        source: 'usage-totals',
        type: 'left',
        on: [{ left: 'workflow', right: 'workflow' }],
        fields: [{ field: 'aic', as: 'aic' }]
      }]
    }, {
      workflows,
      'usage-totals': {
        source: 'usage-totals',
        rows: [],
        metadata: metadata('usage-totals', { availability: 'unavailable', completeness: 'partial' })
      }
    });

    expect(result.rows).toEqual([
      expect.objectContaining({ workflow: 'a.md', aic: null }),
      expect.objectContaining({ workflow: 'b.md', aic: null })
    ]);
    expect(result.metadata).toMatchObject({ availability: 'available', completeness: 'partial' });
    expect(result.metadata['query-diagnostic']).toBeUndefined();
  });

  it('rejects many-to-many expansion with an explicit query diagnostic', () => {
    const result = executeDashboardQuery(
      {
        name: 'expanding',
        from: 'workflows',
        joins: [{
          source: 'usage',
          type: 'left',
          on: [{ left: 'workflow', right: 'workflow' }],
          fields: [{ field: 'aic', as: 'aic' }]
        }]
      },
      { workflows, usage }
    );

    expect(result.rows).toEqual([]);
    expect(result.metadata.availability).toBe('unavailable');
    expect(result.metadata['query-diagnostic']).toBe(
      '$.dashboard.queries[expanding]: joined source "usage" contains more than one row per join key.'
    );
  });

  it('never matches null, blank, or object join keys', () => {
    /** @type {Record<string, import('../../src/presenter.js').LogicalSourceInput>} */
    const sources = {
      workflows: {
        source: 'workflows',
        rows: [{ workflow: null }, { workflow: '  ' }, { workflow: { href: 'x' } }],
        metadata: metadata('workflows')
      },
      totals: { source: 'totals', rows: [{ workflow: null, aic: 3 }], metadata: metadata('totals') }
    };

    expect(executeDashboardQuery(
      {
        name: 'null-keys',
        from: 'workflows',
        joins: [{ source: 'totals', type: 'inner', on: [{ left: 'workflow', right: 'workflow' }], fields: [{ field: 'aic', as: 'aic' }] }]
      },
      sources
    ).rows).toEqual([]);
  });

  describe('join operator edge cases', () => {
    /**
     * @typedef {{ source: string, type?: 'inner'|'left', on: Array<{ left: string, right: string }>, fields: Array<{ field: string, as: string }> }} TestJoin
     */
    /** @param {TestJoin[]} joins */
    const query = (joins) => ({ name: 'join-test', from: 'left', joins });
    /**
     * @param {Partial<TestJoin>} [overrides]
     * @returns {TestJoin}
     */
    const join = (overrides = {}) => ({
      source: 'right',
      type: 'inner',
      on: [{ left: 'id', right: 'id' }],
      fields: [{ field: 'value', as: 'joined-value' }],
      ...overrides
    });
    /**
     * @param {string} name
     * @param {Array<Record<string, unknown>>} rows
     * @param {Partial<Record<string, string>>} [overrides]
     * @returns {import('../../src/presenter.js').LogicalSourceInput}
     */
    const source = (name, rows, overrides = {}) => ({
      source: name,
      rows,
      metadata: metadata(name, overrides)
    });

    it('matches composite keys without collisions and preserves base-row order', () => {
      const result = executeDashboardQuery(query([join({
        on: [
          { left: 'organization', right: 'owner' },
          { left: 'repository', right: 'repo' }
        ]
      })]), {
        left: source('left', [
          { organization: 'githubnext', repository: 'gh-aw-cao', ordinal: 2 },
          { organization: 'github', repository: 'next/gh-aw-cao', ordinal: 1 },
          { organization: 'githubnext/github', repository: 'aw-cao', ordinal: 3 }
        ]),
        right: source('right', [
          { owner: 'github', repo: 'next/gh-aw-cao', value: 'second' },
          { owner: 'githubnext/github', repo: 'aw-cao', value: 'third' },
          { owner: 'githubnext', repo: 'gh-aw-cao', value: 'first' }
        ])
      });

      expect(result.rows.map((row) => [row.ordinal, row['joined-value']])).toEqual([
        [2, 'first'],
        [1, 'second'],
        [3, 'third']
      ]);
    });

    it('normalizes primitive key values without conflating composite key parts', () => {
      const result = executeDashboardQuery(query([join({
        on: [
          { left: 'major', right: 'major' },
          { left: 'minor', right: 'minor' }
        ]
      })]), {
        left: source('left', [
          { major: ' 7 ', minor: true },
          { major: 7, minor: false },
          { major: '7,true', minor: 'x' }
        ]),
        right: source('right', [
          { major: 7, minor: 'true', value: 'normalized' },
          { major: '7', minor: false, value: 'boolean-false' },
          { major: '7,true', minor: 'x', value: 'punctuation' }
        ])
      });

      expect(result.rows.map((row) => row['joined-value']))
        .toEqual(['normalized', 'boolean-false', 'punctuation']);
    });

    it('allows repeated base keys without multiplying them by the joined side', () => {
      const leftRows = Array.from({ length: 10000 }, (_, index) => ({ id: 'shared', index }));
      const result = executeDashboardQuery(query([join()]), {
        left: source('left', leftRows),
        right: source('right', [{ id: 'shared', value: 'one enrichment' }])
      });

      expect(result.rows).toHaveLength(leftRows.length);
      expect(result.rows[0]).toMatchObject({ index: 0, 'joined-value': 'one enrichment' });
      expect(result.rows.at(-1)).toMatchObject({ index: leftRows.length - 1, 'joined-value': 'one enrichment' });
    });

    it('can chain joins using a field produced by an earlier join', () => {
      const result = executeDashboardQuery(query([
        join({
          source: 'owners',
          fields: [{ field: 'team-id', as: 'resolved-team-id' }]
        }),
        join({
          source: 'teams',
          on: [{ left: 'resolved-team-id', right: 'team-id' }],
          fields: [{ field: 'name', as: 'team-name' }]
        })
      ]), {
        left: source('left', [{ id: 'repo-1' }, { id: 'repo-2' }]),
        owners: source('owners', [{ id: 'repo-1', 'team-id': 'team-1' }]),
        teams: source('teams', [{ 'team-id': 'team-1', name: 'CAO' }])
      });

      expect(result.rows).toEqual([{
        id: 'repo-1',
        'resolved-team-id': 'team-1',
        'team-name': 'CAO'
      }]);
    });

    it('handles empty base and joined inputs for inner and left joins', () => {
      const emptyBase = {
        left: source('left', []),
        right: source('right', [{ id: 'one', value: 1 }])
      };
      expect(executeDashboardQuery(query([join()]), emptyBase).rows).toEqual([]);

      const emptyRight = {
        left: source('left', [{ id: 'one' }]),
        right: source('right', [])
      };
      expect(executeDashboardQuery(query([join()]), emptyRight).rows).toEqual([]);
      expect(executeDashboardQuery(query([join({ type: 'left' })]), emptyRight).rows)
        .toEqual([{ id: 'one', 'joined-value': null }]);
    });

    it('does not match missing, structured, or whitespace-only key parts', () => {
      const invalidKeys = [
        undefined,
        null,
        '',
        ' \t\n ',
        {},
        [],
        new Date('2026-09-01T00:00:00Z')
      ];
      const result = executeDashboardQuery(query([join({ type: 'left' })]), {
        left: source('left', invalidKeys.map((id, index) => ({ id, index }))),
        right: source('right', invalidKeys.map((id, index) => ({ id, value: index })))
      });

      expect(result.rows).toHaveLength(invalidKeys.length);
      expect(result.rows.every((row) => row['joined-value'] === null)).toBe(true);
    });

    it('rejects duplicate joined keys after key normalization even when no base row matches', () => {
      const result = executeDashboardQuery(query([join()]), {
        left: source('left', [{ id: 'unrelated' }]),
        right: source('right', [
          { id: 7, value: 'number' },
          { id: ' 7 ', value: 'string' }
        ])
      });

      expect(result.rows).toEqual([]);
      expect(result.metadata.availability).toBe('unavailable');
      expect(result.metadata['query-diagnostic'])
        .toContain('joined source "right" contains more than one row per join key');
    });

    it('fails closed before indexing an oversized joined source', () => {
      const rows = Array.from(
        { length: DASHBOARD_QUERY_LIMITS['max-input-rows'] + 1 },
        (_, index) => ({ id: index, value: index })
      );
      const result = executeDashboardQuery(query([join()]), {
        left: source('left', [{ id: 1 }]),
        right: source('right', rows)
      });

      expect(result.rows).toEqual([]);
      expect(result.metadata.availability).toBe('unavailable');
      expect(result.metadata['query-diagnostic']).toContain(
        `"right" exceeds the max-input-rows limit of ${DASHBOARD_QUERY_LIMITS['max-input-rows']} rows`
      );
    });

    it('treats absent and non-array left-join inputs as optional missing data', () => {
      const definition = query([join({ type: 'left' })]);
      const missing = executeDashboardQuery(definition, {
        left: source('left', [{ id: 'one' }])
      });
      const corrupt = executeDashboardQuery(definition, {
        left: source('left', [{ id: 'one' }]),
        right: { source: 'right', rows: /** @type {never} */ (null), metadata: metadata('right') }
      });

      for (const result of [missing, corrupt]) {
        expect(result.rows).toEqual([{ id: 'one', 'joined-value': null }]);
        expect(result.metadata).toMatchObject({ availability: 'available', completeness: 'partial' });
        expect(result.metadata['query-diagnostic']).toBeUndefined();
      }
    });

    it('fails closed for absent, unavailable, or non-array required join inputs', () => {
      const inputs = [
        undefined,
        source('right', [], { availability: 'unavailable' }),
        { source: 'right', rows: /** @type {never} */ ('corrupt'), metadata: metadata('right') }
      ];

      for (const right of inputs) {
        const result = executeDashboardQuery(query([join()]), {
          left: source('left', [{ id: 'one' }]),
          ...(right ? { right } : {})
        });
        expect(result.rows).toEqual([]);
        expect(result.metadata.availability).toBe('unavailable');
        expect(result.metadata['query-diagnostic']).toContain('input source "right" is unavailable');
      }
    });

    it('turns corrupted rows and join projections into diagnostics instead of throwing', () => {
      const corruptRow = executeDashboardQuery(query([join()]), {
        left: source('left', [{ id: 'one' }]),
        right: source('right', [/** @type {never} */ (null)])
      });
      const corruptProjection = executeDashboardQuery(query([join({
        fields: /** @type {never} */ (null)
      })]), {
        left: source('left', [{ id: 'one' }]),
        right: source('right', [{ id: 'one', value: 1 }])
      });

      for (const result of [corruptRow, corruptProjection]) {
        expect(result.rows).toEqual([]);
        expect(result.metadata.availability).toBe('unavailable');
        expect(result.metadata['query-diagnostic']).toMatch(/^\$\.dashboard\.queries\[join-test\]: /);
      }
    });
  });

  it('reports an unavailable state when an input source is missing or unavailable', () => {
    const missing = executeDashboardQuery({ name: 'missing-input', from: 'runs' }, { workflows });
    expect(missing.metadata.availability).toBe('unavailable');
    expect(missing.metadata['query-diagnostic']).toBe(
      '$.dashboard.queries[missing-input]: input source "runs" is unavailable.'
    );

    const unavailable = executeDashboardQuery(
      { name: 'unavailable-input', from: 'runs' },
      { runs: { source: 'runs', rows: [], metadata: metadata('runs', { availability: 'unavailable' }) } }
    );
    expect(unavailable.metadata.availability).toBe('unavailable');
    expect(unavailable.metadata['query-diagnostic']).toContain('input source "runs" is unavailable');
  });

  it('fails closed when a query exceeds a documented row limit', () => {
    const rows = Array.from({ length: DASHBOARD_QUERY_LIMITS['max-input-rows'] + 1 }, (_, index) => ({ workflow: `w-${index}` }));
    const result = executeDashboardQuery(
      { name: 'oversized', from: 'workflows' },
      { workflows: { source: 'workflows', rows, metadata: metadata('workflows') } }
    );

    expect(result.rows).toEqual([]);
    expect(result.metadata.availability).toBe('unavailable');
    expect(result.metadata['query-diagnostic']).toContain('max-input-rows');
  });

  it('marks an empty derived projection as empty rather than unavailable', () => {
    const result = executeDashboardQuery(
      { name: 'empty-projection', from: 'workflows', filter: { predicates: [{ field: 'workflow', equals: 'missing.md' }] } },
      { workflows }
    );

    expect(result.rows).toEqual([]);
    expect(result.metadata.availability).toBe('empty');
    expect(result.metadata['query-diagnostic']).toBeUndefined();
  });

  it('resolves the query dependency graph without pulling unrelated sources', () => {
    const definitions = [
      { name: 'totals', from: 'usage' },
      { name: 'inventory', from: 'workflows', joins: [{ source: 'totals', on: [], fields: [] }] },
      { name: 'unrelated', from: 'findings' }
    ];

    expect(resolveDashboardQuerySources(definitions, ['inventory']).sort())
      .toEqual(['inventory', 'totals', 'usage', 'workflows']);
    expect(resolveDashboardQuerySources(definitions, ['inventory'])).not.toContain('findings');
  });

  it('executes only the requested queries and their inputs', () => {
    const derived = executeDashboardQueries(
      [
        { name: 'totals', from: 'usage', aggregate: { by: ['workflow'], values: [{ field: 'aic', as: 'aic', reducer: 'sum' }] } },
        { name: 'unrelated', from: 'workflows' }
      ],
      { workflows, usage },
      ['totals']
    );

    expect(Object.keys(derived)).toEqual(['totals']);
  });

  it('defers every requested query until its result is consumed', () => {
    const budget = createDashboardQueryBudget();
    const derived = executeDashboardQueries(
      [
        { name: 'totals', from: 'usage', aggregate: { by: ['workflow'], values: [{ field: 'aic', as: 'aic', reducer: 'sum' }] } },
        { name: 'inventory', from: 'workflows', select: [{ field: 'workflow' }] }
      ],
      { workflows, usage },
      undefined,
      { budget }
    );

    expect(Object.keys(derived)).toEqual(['totals', 'inventory']);
    expect(budget.operations).toBe(0);

    expect(derived.totals.rows).toEqual([{ workflow: 'a.md', aic: 10 }]);
    expect(budget.operations).toBe(4);

    expect(derived.totals.metadata.availability).toBe('available');
    expect(budget.operations).toBe(4);

    expect(derived.inventory.rows).toEqual([{ workflow: 'a.md' }, { workflow: 'b.md' }]);
    expect(budget.operations).toBe(8);
  });

  it('defers a single query until its rows or metadata are consumed', () => {
    const budget = createDashboardQueryBudget();
    const result = executeDashboardQuery(
      { name: 'totals', from: 'usage', aggregate: { by: ['workflow'], values: [{ field: 'aic', as: 'aic', reducer: 'sum' }] } },
      { usage },
      undefined,
      budget
    );

    expect(result.source).toBe('totals');
    expect(budget.operations).toBe(0);

    expect(result.metadata.availability).toBe('available');
    expect(budget.operations).toBe(4);

    const rows = result.rows;
    const resultMetadata = result.metadata;
    expect(rows).toEqual([{ workflow: 'a.md', aic: 10 }]);
    expect(result.rows).toBe(rows);
    expect(result.metadata).toBe(resultMetadata);
    expect(budget.operations).toBe(4);
  });

  it('does not read source rows or metadata while creating or enumerating queries', () => {
    const rows = vi.fn(() => usage.rows);
    const sourceMetadata = vi.fn(() => usage.metadata);
    const source = {
      source: 'usage',
      get rows() {
        return rows();
      },
      get metadata() {
        return sourceMetadata();
      }
    };

    const derived = executeDashboardQueries(
      [{ name: 'totals', from: 'usage', aggregate: { by: ['workflow'], values: [{ field: 'aic', as: 'aic', reducer: 'sum' }] } }],
      { usage: source },
      ['totals']
    );

    expect(Object.keys(derived)).toEqual(['totals']);
    expect(Object.getOwnPropertyDescriptor(derived, 'totals')?.get).toEqual(expect.any(Function));
    expect(rows).not.toHaveBeenCalled();
    expect(sourceMetadata).not.toHaveBeenCalled();

    expect(derived.totals.rows).toEqual([{ workflow: 'a.md', aic: 10 }]);
    const rowReads = rows.mock.calls.length;
    const metadataReads = sourceMetadata.mock.calls.length;
    expect(rowReads).toBeGreaterThan(0);
    expect(metadataReads).toBeGreaterThan(0);
    derived.totals.metadata;
    expect(rows).toHaveBeenCalledTimes(rowReads);
    expect(sourceMetadata).toHaveBeenCalledTimes(metadataReads);
  });

  it('never consumes unrequested or unobserved queries', () => {
    const usageRows = vi.fn(() => usage.rows);
    const workflowRows = vi.fn(() => workflows.rows);
    const workflowMetadata = vi.fn(() => workflows.metadata);
    const sources = {
      usage: { ...usage, get rows() { return usageRows(); } },
      workflows: {
        ...workflows,
        get rows() { return workflowRows(); },
        get metadata() { return workflowMetadata(); }
      }
    };
    const definitions = [
      { name: 'totals', from: 'usage', select: [{ field: 'workflow' }] },
      { name: 'inventory', from: 'workflows', select: [{ field: 'workflow' }] }
    ];

    const requested = executeDashboardQueries(definitions, sources, ['totals']);
    expect(Object.keys(requested)).toEqual(['totals']);
    expect(workflowRows).not.toHaveBeenCalled();
    expect(workflowMetadata).not.toHaveBeenCalled();

    requested.totals.rows;
    expect(usageRows).toHaveBeenCalled();
    expect(workflowRows).not.toHaveBeenCalled();
    expect(workflowMetadata).not.toHaveBeenCalled();

    const all = executeDashboardQueries(definitions, sources);
    all.totals.rows;
    expect(workflowRows).not.toHaveBeenCalled();
    expect(workflowMetadata).not.toHaveBeenCalled();
  });

  it('materializes shared dependencies only once as lazy results are consumed', () => {
    const budget = createDashboardQueryBudget();
    const derived = executeDashboardQueries(
      [
        { name: 'base', from: 'usage', select: [{ field: 'workflow' }] },
        { name: 'dependent', from: 'base', select: [{ field: 'workflow' }] }
      ],
      { usage },
      undefined,
      { budget }
    );

    expect(derived.dependent.rows).toEqual([{ workflow: 'a.md' }, { workflow: 'a.md' }]);
    expect(derived.base.rows).toEqual([{ workflow: 'a.md' }, { workflow: 'a.md' }]);
    expect(budget.operations).toBe(8);
  });

  it('keeps repeated query batches lazy and isolated from earlier materializations', () => {
    const definition = [{ name: 'inventory', from: 'workflows', select: [{ field: 'workflow' }] }];
    const firstBudget = createDashboardQueryBudget();
    const secondBudget = createDashboardQueryBudget();
    const first = executeDashboardQueries(definition, { workflows }, undefined, { budget: firstBudget });

    expect(first.inventory.rows).toEqual([{ workflow: 'a.md' }, { workflow: 'b.md' }]);
    expect(firstBudget.operations).toBe(4);

    workflows.rows.push({ organization: 'githubnext', repository: 'gh-aw-cao', workflow: 'c.md' });
    try {
      const second = executeDashboardQueries(definition, { workflows }, undefined, { budget: secondBudget });

      expect(secondBudget.operations).toBe(0);
      expect(first.inventory.rows).toEqual([{ workflow: 'a.md' }, { workflow: 'b.md' }]);
      expect(firstBudget.operations).toBe(4);
      expect(second.inventory.rows).toEqual([
        { workflow: 'a.md' },
        { workflow: 'b.md' },
        { workflow: 'c.md' }
      ]);
      expect(secondBudget.operations).toBe(6);
    } finally {
      workflows.rows.pop();
    }
  });

  it('memoizes a lazy execution failure instead of rerunning the query', () => {
    const budget = createDashboardQueryBudget({ maxOperations: 1 });
    const result = executeDashboardQueries(
      [{ name: 'totals', from: 'usage', aggregate: { by: ['workflow'], values: [{ field: 'aic', as: 'aic', reducer: 'sum' }] } }],
      { usage },
      undefined,
      { budget }
    ).totals;

    let firstError;
    try {
      result.rows;
    } catch (error) {
      firstError = error;
    }
    expect(firstError).toBeInstanceOf(DashboardQueryCancelledError);
    expect(budget.operations).toBe(2);

    expect(() => result.metadata).toThrow(firstError);
    expect(budget.operations).toBe(2);
  });

  it('isolates a lazy query failure from unconsumed sibling queries', () => {
    const derived = executeDashboardQueries(
      [
        { name: 'broken', from: 'broken-source', select: [{ field: 'workflow' }] },
        { name: 'inventory', from: 'workflows', select: [{ field: 'workflow' }] }
      ],
      {
        workflows,
        'broken-source': {
          source: 'broken-source',
          /** @returns {Record<string, unknown>[]} */
          get rows() {
            throw new Error('source read failed');
          },
          metadata: metadata('broken-source')
        }
      }
    );

    expect(() => derived.broken.rows).toThrow('source read failed');
    expect(Object.keys(derived)).toEqual(['broken', 'inventory']);
    expect(derived.inventory.rows).toEqual([{ workflow: 'a.md' }, { workflow: 'b.md' }]);
  });

  it('defers structural rejection until the rejected query is consumed', () => {
    const rows = vi.fn(() => workflows.rows);
    const result = executeDashboardQueries(
      [{ name: 'invalid', from: 'workflows', joins: [{ source: 'usage', on: [], fields: [] }] }],
      {
        workflows: { ...workflows, get rows() { return rows(); } },
        usage
      }
    );

    expect(rows).not.toHaveBeenCalled();
    expect(result.invalid.metadata).toMatchObject({
      availability: 'unavailable',
      'query-diagnostic': expect.stringContaining('declares no equality keys')
    });
    expect(rows).not.toHaveBeenCalled();
  });

  it('defers continuation validation and re-execution until a page is consumed', () => {
    const definitions = [{ name: 'recent-runs', from: 'runs', 'order-by': [{ field: 'run', direction: 'desc' }] }];
    const sources = {
      runs: {
        source: 'runs',
        rows: ['3', '2', '1'].map((run) => ({ run })),
        metadata: metadata('runs')
      }
    };
    const first = executeDashboardQueries(definitions, sources, ['recent-runs'], {
      pagination: { 'recent-runs': { limit: 1 } }
    })['recent-runs'];
    const budget = createDashboardQueryBudget();
    const continued = executeDashboardQueries(definitions, sources, ['recent-runs'], {
      budget,
      pagination: { 'recent-runs': { limit: 1, continuationToken: first.continuationToken } }
    });

    expect(budget.operations).toBe(0);
    expect(continued['recent-runs'].rows).toEqual([{ run: '2' }]);
    expect(budget.operations).toBe(6);
  });

  it('does not read unrelated source metadata for a paginated query', () => {
    const definitions = [{ name: 'recent-runs', from: 'runs', 'order-by': [{ field: 'run', direction: 'desc' }] }];
    const result = executeDashboardQueries(definitions, {
      runs: {
        source: 'runs',
        rows: ['2', '1'].map((run) => ({ run })),
        metadata: metadata('runs')
      },
      unrelated: {
        source: 'unrelated',
        rows: [],
        /** @returns {import('../../src/presenter.js').SourceMetadata} */
        get metadata() {
          throw new Error('unrelated metadata was consumed');
        }
      }
    }, ['recent-runs'], {
      pagination: { 'recent-runs': { limit: 1 } }
    });

    expect(result['recent-runs'].rows).toEqual([{ run: '2' }]);
  });

  it('consumes each lazy query once when the batch crosses the structured-clone boundary', () => {
    const budget = createDashboardQueryBudget();
    const derived = executeDashboardQueries(
      [
        { name: 'base', from: 'usage', select: [{ field: 'workflow' }] },
        { name: 'dependent', from: 'base', select: [{ field: 'workflow' }] }
      ],
      { usage },
      undefined,
      { budget }
    );

    expect(budget.operations).toBe(0);
    const cloned = structuredClone(derived);
    expect(cloned.base.rows).toEqual([{ workflow: 'a.md' }, { workflow: 'a.md' }]);
    expect(cloned.dependent.rows).toEqual([{ workflow: 'a.md' }, { workflow: 'a.md' }]);
    expect(budget.operations).toBe(8);

    structuredClone(derived);
    expect(budget.operations).toBe(8);
  });

  it('reuses shared nested query materializations across a dependency diamond', () => {
    let sourceReads = 0;
    const budget = createDashboardQueryBudget();
    const definitions = [
      {
        name: 'base',
        from: 'usage',
        select: [{ field: 'workflow' }, { field: 'aic' }]
      },
      {
        name: 'higher-cost',
        from: 'base',
        filter: { predicates: [{ field: 'aic', gte: 5 }] }
      },
      {
        name: 'lower-cost',
        from: 'base',
        filter: { predicates: [{ field: 'aic', lt: 5 }] }
      },
      {
        name: 'combined',
        from: 'higher-cost',
        union: ['lower-cost'],
        'order-by': [{ field: 'aic', direction: 'asc' }]
      },
      {
        name: 'summary',
        from: 'combined',
        aggregate: {
          values: [{ field: 'workflow', as: 'workflows', reducer: 'count' }]
        }
      }
    ];
    const derived = executeDashboardQueries(
      definitions,
      {
        usage: {
          ...usage,
          get rows() {
            sourceReads += 1;
            return usage.rows;
          }
        }
      },
      definitions.map((definition) => definition.name),
      { budget }
    );

    expect(sourceReads).toBe(0);
    expect(budget.operations).toBe(0);
    expect(derived.summary.rows).toEqual([{ workflows: 2 }]);
    const readsAfterSummary = sourceReads;
    const operationsAfterSummary = budget.operations;
    expect(readsAfterSummary).toBeGreaterThan(0);

    expect(derived.combined.rows).toEqual([
      { workflow: 'a.md', aic: 4 },
      { workflow: 'a.md', aic: 6 }
    ]);
    expect(derived['higher-cost'].rows).toEqual([{ workflow: 'a.md', aic: 6 }]);
    expect(derived['lower-cost'].rows).toEqual([{ workflow: 'a.md', aic: 4 }]);
    expect(derived.base.rows).toEqual([
      { workflow: 'a.md', aic: 4 },
      { workflow: 'a.md', aic: 6 }
    ]);
    expect(sourceReads).toBe(readsAfterSummary);
    expect(budget.operations).toBe(operationsAfterSummary);
  });

  it.each(['constructor', '__proto__'])('lazily executes a query named %s', (name) => {
    const budget = createDashboardQueryBudget();
    const derived = executeDashboardQueries(
      [{ name, from: 'workflows', select: [{ field: 'workflow' }] }],
      { workflows },
      undefined,
      { budget }
    );

    expect(budget.operations).toBe(0);
    expect(derived[name].rows).toEqual([{ workflow: 'a.md' }, { workflow: 'b.md' }]);
    expect(budget.operations).toBe(4);
    expect(structuredClone(derived)[name].rows).toEqual([{ workflow: 'a.md' }, { workflow: 'b.md' }]);
    expect(budget.operations).toBe(4);
  });

  it('rejects cyclic, self-referencing, and forward query dependencies', () => {
    const defects = dashboardQueryDefects([
      { name: 'self', from: 'self' },
      { name: 'early', from: 'late' },
      { name: 'late', from: 'workflows' },
      { name: 'left-cycle', from: 'workflows', joins: [{ source: 'right-cycle', on: [{ left: 'workflow', right: 'workflow' }], fields: [{ field: 'workflow', as: 'joined' }] }] },
      { name: 'right-cycle', from: 'left-cycle' }
    ]);

    expect(defects.get('self')).toBe('query "self" reads itself');
    expect(defects.get('early')).toBe('input source "late" is declared after "early"');
    expect(defects.get('left-cycle')).toBe('query "left-cycle" and input source "right-cycle" form a dependency cycle');
    expect(defects.get('right-cycle')).toBe('input source "left-cycle" is a rejected query');
    expect(defects.has('late')).toBe(false);
  });

  it('reports a requested cyclic query as unavailable without recursing', () => {
    const result = executeDashboardQueries(
      [{ name: 'cyclic', from: 'cyclic' }],
      {},
      ['cyclic']
    );

    expect(result.cyclic.metadata.availability).toBe('unavailable');
    expect(result.cyclic.metadata['query-diagnostic']).toContain('reads itself');
  });

  it('rejects duplicate query names instead of resolving one arbitrarily', () => {
    const definitions = [
      { name: 'inventory', from: 'workflows' },
      { name: 'inventory', from: 'usage' }
    ];

    expect(dashboardQueryDefects(definitions).get('inventory'))
      .toBe('query name "inventory" is declared more than once');
    expect(executeDashboardQueries(definitions, { workflows, usage }).inventory.metadata.availability)
      .toBe('unavailable');
  });

  it('rejects keyless joins that would expand without bound', () => {
    const result = executeDashboardQuery(
      { name: 'cartesian', from: 'workflows', joins: [{ source: 'usage', on: [], fields: [{ field: 'aic', as: 'aic' }] }] },
      { workflows, usage }
    );

    expect(result.rows).toEqual([]);
    expect(result.metadata.availability).toBe('unavailable');
    expect(result.metadata['query-diagnostic'])
      .toBe('$.dashboard.queries[cartesian]: join on "usage" declares no equality keys.');
  });

  it('rejects join chains and limits beyond the documented bounds', () => {
    const join = { source: 'usage', on: [{ left: 'workflow', right: 'workflow' }], fields: [{ field: 'aic', as: 'aic' }] };
    const chained = executeDashboardQuery(
      { name: 'chained', from: 'workflows', joins: Array.from({ length: DASHBOARD_QUERY_LIMITS['max-joins'] + 1 }, () => join) },
      { workflows, usage }
    );
    expect(chained.metadata['query-diagnostic']).toContain('max-joins');

    const oversized = executeDashboardQuery(
      { name: 'oversized-limit', from: 'workflows', limit: DASHBOARD_QUERY_LIMITS['max-output-rows'] + 1 },
      { workflows }
    );
    expect(oversized.metadata['query-diagnostic']).toContain('limit must be a positive integer');
  });

  it('executes a query graph containing a rejected query without failing the others', () => {
    const derived = executeDashboardQueries(
      [
        { name: 'cyclic', from: 'cyclic' },
        { name: 'inventory', from: 'workflows', select: [{ field: 'workflow' }] }
      ],
      { workflows }
    );

    expect(derived.cyclic.metadata.availability).toBe('unavailable');
    expect(derived.cyclic.metadata['query-diagnostic']).toContain('reads itself');
    expect(derived.inventory.rows).toEqual([{ workflow: 'a.md' }, { workflow: 'b.md' }]);
  });

  it('derives the static output field schema before execution', () => {
    const fields = dashboardQueryOutputFields(
      {
        name: 'inventory',
        from: 'workflows',
        joins: [{ source: 'totals', on: [], fields: [{ field: 'aic', as: 'observed-aic' }] }],
        compute: [{ as: 'total-aic', function: 'coalesce', args: [{ field: 'observed-aic' }, { value: 0 }] }],
        select: [{ field: 'workflow' }, { field: 'total-aic', as: 'aic' }]
      },
      (source) => (source === 'workflows' ? ['organization', 'repository', 'workflow'] : undefined)
    );

    expect(fields).toEqual(['workflow', 'aic']);
    expect(dashboardQueryOutputFields({ name: 'unknown-input', from: 'mystery' }, () => undefined)).toBeUndefined();
  });
});

describe('query cancellation, deadlines, and operation budgets', () => {
  /** @type {import('../../src/data/queries/declarative.js').DashboardQuery} */
  const totals = {
    name: 'totals',
    from: 'usage',
    aggregate: { by: ['workflow'], values: [{ field: 'aic', as: 'aic', reducer: 'sum' }] }
  };

  it('stops execution when the caller aborts the signal', () => {
    const controller = new AbortController();
    controller.abort();

    expect(() => executeDashboardQueries([totals], { usage }, undefined, { signal: controller.signal }).totals.rows)
      .toThrow(DashboardQueryCancelledError);
  });

  it('reports an abort as a cancellation rather than a query fault', () => {
    const controller = new AbortController();
    controller.abort();
    try {
      executeDashboardQueries([totals], { usage }, undefined, { signal: controller.signal }).totals.rows;
      expect.unreachable('cancelled execution must not return a projection');
    } catch (error) {
      expect(/** @type {DashboardQueryCancelledError} */ (error).kind).toBe('aborted');
      expect(/** @type {Error} */ (error).message).toBe('dashboard queries were cancelled');
    }
  });

  it('stops execution once the deadline elapses', () => {
    let clock = 0;
    const budget = createDashboardQueryBudget({ timeout: 60000, now: () => (clock += 40000) });

    expect(() => executeDashboardQueries([totals], { usage }, undefined, { budget }).totals.rows)
      .toThrow(/max-duration-ms limit of 60000/);
  });

  it('stops a runaway computation once the operation budget is spent', () => {
    const budget = createDashboardQueryBudget({ maxOperations: 1 });

    expect(() => executeDashboardQueries([totals], { usage }, undefined, { budget }).totals.rows)
      .toThrow(/max-operations budget of 1/);
  });

  it('counts the row operations a query performs', () => {
    const budget = createDashboardQueryBudget();
    executeDashboardQueries([totals], { usage }, undefined, { budget }).totals.rows;

    expect(budget.operations).toBe(4);
  });

  it('defaults to the documented one-minute deadline and operation cap', () => {
    expect(DASHBOARD_QUERY_LIMITS['max-duration-ms']).toBe(60000);
    expect(DASHBOARD_QUERY_LIMITS['max-operations']).toBe(5000000);
  });

  it('cancels an in-flight worker request through the data worker handler', () => {
    const controller = new AbortController();
    controller.abort();

    expect(() => /** @type {Record<string, import('../../src/presenter.js').LogicalSourceInput>} */ (processDataRequest({
      operation: 'execute-dashboard-queries',
      queries: [totals],
      sources: { usage }
    }, controller.signal)).totals.rows).toThrow(DashboardQueryCancelledError);
  });
});

describe('computed field vocabulary', () => {
  /** @param {string} fn @param {unknown[]} args @param {Record<string, unknown>} [row] */
  const compute = (fn, args, row = {}) => computeValue(row, {
    as: 'value',
    function: /** @type {never} */ (fn),
    args: /** @type {never} */ (args)
  });

  it('evaluates every text function deterministically', () => {
    expect(compute('concat', [{ field: 'a' }, { value: '/' }, { field: 'b' }], { a: 'x', b: 'y' })).toBe('x/y');
    expect(compute('lower', [{ value: 'AbC' }])).toBe('abc');
    expect(compute('upper', [{ value: 'AbC' }])).toBe('ABC');
    expect(compute('title-case', [{ value: 'aw-doctor' }])).toBe('Aw Doctor');
    expect(compute('trim', [{ value: '  spaced  ' }])).toBe('spaced');
    expect(compute('url-encode', [{ value: 'a/b' }])).toBe('a%2Fb');
    expect(compute('concat', [{ field: 'missing' }, { value: 'tail' }])).toBe('tail');
    expect(compute('literal', [{ value: 'fixed label' }])).toBe('fixed label');
    expect(compute('format-count', [{ value: 1234 }])).toBe('1,234');
    expect(compute('format-percent', [{ value: 0.5 }])).toBe('50%');
  });

  it('evaluates conditional functions deterministically', () => {
    expect(compute('equals-any', [{ value: 'failure' }, { value: 'failure' }, { value: 'success' }])).toBe(true);
    expect(compute('greater-than', [{ value: 2 }, { value: 1 }])).toBe(true);
    expect(compute('if', [{ value: true }, { value: 'yes' }, { value: 'no' }])).toBe('yes');
  });

  it('builds dashboard links while preserving external link metadata', () => {
    expect(compute('dashboard-link', [
      { field: 'link' },
      { value: '#page-repository-detail?repository=octo%2Frepo' },
      { value: 'View octo/repo repository dashboard' },
      { value: 'octo/repo' }
    ], {
      link: { relation: 'repository', href: 'https://github.com/octo/repo', label: 'View octo/repo on GitHub' }
    })).toEqual({
      relation: 'repository',
      href: 'https://github.com/octo/repo',
      label: 'View octo/repo on GitHub',
      'dashboard-href': '#page-repository-detail?repository=octo%2Frepo',
      'dashboard-label': 'View octo/repo repository dashboard'
    });
    expect(compute('dashboard-link', [
      { field: 'missing' },
      { value: '#page-campaign-insights?campaign=' },
      { value: 'View campaign dashboard' },
      { value: '' }
    ])).toBeNull();
  });

  it('evaluates every numeric function and returns null for unusable inputs', () => {
    expect(compute('number', [{ value: '12' }])).toBe(12);
    expect(compute('sum', [{ value: 1 }, { value: 2 }, { value: 3 }])).toBe(6);
    expect(compute('difference', [{ value: 5 }, { value: 2 }])).toBe(3);
    expect(compute('product', [{ value: 2 }, { value: 3 }])).toBe(6);
    expect(compute('quotient', [{ value: 6 }, { value: 3 }])).toBe(2);
    expect(compute('quotient', [{ value: 6 }, { value: 0 }])).toBeNull();
    expect(compute('number', [{ value: 'not-a-number' }])).toBeNull();
    expect(compute('sum', [{ field: 'missing' }, { value: 2 }])).toBeNull();
    expect(compute('sum', [{ value: true }, { value: 2 }])).toBeNull();
    expect(compute('number', [{ value: { href: 'x' } }])).toBeNull();
  });

  it('coalesces past null, blank, and object values', () => {
    expect(compute('coalesce', [{ field: 'missing' }, { value: '' }, { value: 'fallback' }])).toBe('fallback');
    expect(compute('coalesce', [{ field: 'link' }, { value: 'fallback' }], { link: { href: 'x' } })).toBe('fallback');
    expect(compute('coalesce', [{ field: 'missing' }, { field: 'also-missing' }])).toBeNull();
  });

  it('rejects functions outside the closed vocabulary', () => {
    expect(() => compute('eval', [{ value: 1 }])).toThrow(TypeError);
  });

  it('computes and selects through the serializable operator pipeline', () => {
    expect(tidy([{ a: 'x', b: 'y', drop: 'me' }], [
      { op: 'compute', values: [{ as: 'joined', function: 'concat', args: [{ field: 'a' }, { field: 'b' }] }] },
      { op: 'select', fields: [{ field: 'joined', as: 'value' }] }
    ])).toEqual([{ value: 'xy' }]);
  });

  it('returns structured distinct values for worker-owned facet controls', () => {
    expect(tidy([{ state: 'Done' }, { state: 'Todo' }, { state: 'Done' }], [{
      op: 'summarize',
      values: [{ field: 'state', as: 'states', reducer: 'distinct-values' }]
    }])).toEqual([{ states: ['Done', 'Todo'] }]);
  });

  it('executes declared queries through the data worker request handler', () => {
    const response = /** @type {Record<string, import('../../src/presenter.js').LogicalSourceInput>} */ (processDataRequest({
      operation: 'execute-dashboard-queries',
      queries: [{ name: 'totals', from: 'usage', aggregate: { by: ['workflow'], values: [{ field: 'aic', as: 'aic', reducer: 'sum' }] } }],
      sources: { usage }
    }));

    expect(response.totals.rows).toEqual([{ workflow: 'a.md', aic: 10 }]);
  });
});
