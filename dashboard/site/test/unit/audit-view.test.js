// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { processDataRequest } from '../../src/data-worker.js';
import { executeDashboardQueries } from '../../src/data/queries/declarative.js';
import { compileDashboardViewPayloadQueries } from '../../src/data/queries/view-payload-compiler.js';

const dashboard = JSON.parse(readFileSync(`${process.cwd()}/dashboard.json`, 'utf8')).dashboard;
const metadata = {
  'source-id': 'audit-fixture',
  'source-kind': 'fixture',
  'as-of': '2026-09-16T12:00:00Z',
  'retrieved-at': '2026-09-16T12:01:00Z',
  completeness: /** @type {'complete'} */ ('complete'),
  freshness: /** @type {'fresh'} */ ('fresh'),
  availability: /** @type {'available'} */ ('available')
};

describe('Audit dashboard view', () => {
  it('reuses campaign-filtered Audit views for the campaign Insights facet', () => {
    const insights = dashboard.pages.find((/** @type {{ id: string }} */ candidate) => candidate.id === 'campaign-insights');
    const issues = dashboard.pages.find((/** @type {{ id: string }} */ candidate) => candidate.id === 'campaign-issues');

    expect(insights.views.map((/** @type {{ id: string }} */ view) => view.id)).toEqual([
      'campaign-insights-navigation',
      'campaign-audit-event-summary-buckets',
      'campaign-audit-events-table'
    ]);
    expect(insights.views[0].data).toMatchObject({
      sources: ['workflows', 'campaign-operational-value-series'],
      arguments: [{ name: 'campaign', field: 'campaign' }]
    });
    expect(insights.views.slice(1).map((/** @type {{ data: Record<string, string> }} */ view) => view.data)).toEqual([
      expect.objectContaining({ source: 'audit-event-summary-buckets', 'route-field': 'campaign' }),
      expect.objectContaining({ source: 'audit-events', 'route-field': 'campaign' })
    ]);
    expect(insights.views[1]).toMatchObject({
      chart: 'horizontal-bar',
      data: { limit: 20 },
      encoding: {
        x: { field: 'workflow', format: 'workflow-relative-path' },
        y: { field: 'events' },
        color: { field: 'event-summary' }
      }
    });
    expect(issues.views
      .filter((/** @type {{ data?: { source?: string } }} */ view) => view.data?.source === 'campaign-worker-issues')
      .map((/** @type {{ data: Record<string, string> }} */ view) => view.data['route-field'])).toEqual([
      'campaign',
      'campaign'
    ]);
  });

  it('projects only issue outcomes produced by campaign workers', () => {
    const result = /** @type {Record<string, import('../../src/presenter.js').LogicalSourceInput>} */ (processDataRequest({
      operation: 'execute-dashboard-queries',
      queries: dashboard.queries,
      sourceNames: ['campaign-worker-issues'],
      sources: {
        outcomes: {
          source: 'outcomes',
          rows: [
            { organization: 'githubnext', repository: 'gh-aw-cao', campaign: 'ambient-context', workflow: '.github/workflows/orchestrator.md', 'safe-output': 'orchestrator-issue', 'outcome-category': 'issue' },
            { organization: 'githubnext', repository: 'gh-aw-cao', campaign: 'ambient-context', workflow: '.github/workflows/worker.md', 'safe-output': 'worker-issue', 'outcome-category': 'issue' },
            { organization: 'githubnext', repository: 'gh-aw-cao', campaign: 'ambient-context', workflow: '.github/workflows/worker.md', 'safe-output': 'worker-pr', 'outcome-category': 'pull-request' }
          ],
          metadata
        },
        workflows: {
          source: 'workflows',
          rows: [
            { organization: 'githubnext', repository: 'gh-aw-cao', workflow: '.github/workflows/orchestrator.md', 'workflow-role': 'orchestrator' },
            { organization: 'githubnext', repository: 'gh-aw-cao', workflow: '.github/workflows/worker.md', 'workflow-role': 'worker' }
          ],
          metadata
        }
      }
    }));

    expect(result['campaign-worker-issues'].rows).toEqual([
      expect.objectContaining({ campaign: 'ambient-context', 'safe-output': 'worker-issue' })
    ]);
  });

  it('attributes every operational-value extract using repository-qualified workflow identity', () => {
    const result = /** @type {Record<string, import('../../src/presenter.js').LogicalSourceInput>} */ (processDataRequest({
      operation: 'execute-dashboard-queries',
      queries: dashboard.queries,
      sourceNames: ['campaign-operational-values'],
      sources: {
        'operational-values': {
          source: 'operational-values',
          rows: [
            { organization: 'githubnext', repository: 'alpha', workflow: '.github/workflows/worker.md', run: '1', 'observed-at': '2026-09-01T00:00:00Z', 'operational-value': 40, diagnostics: { quality: 50 } },
            { organization: 'githubnext', repository: 'alpha', workflow: '.github/workflows/worker.md', run: '2', 'observed-at': '2026-09-02T00:00:00Z', 'operational-value': 70, diagnostics: { quality: 80 } },
            { organization: 'githubnext', repository: 'beta', workflow: '.github/workflows/worker.md', run: '3', 'observed-at': '2026-09-03T00:00:00Z', 'operational-value': 90 }
          ],
          metadata
        },
        workflows: {
          source: 'workflows',
          rows: [
            { organization: 'githubnext', repository: 'alpha', workflow: '.github/workflows/worker.md', campaign: 'alpha-campaign', 'campaign-name': 'Alpha campaign' },
            { organization: 'githubnext', repository: 'beta', workflow: '.github/workflows/worker.md', campaign: 'beta-campaign', 'campaign-name': 'Beta campaign' }
          ],
          metadata
        }
      }
    }));

    expect(result['campaign-operational-values'].rows).toEqual([
      expect.objectContaining({ campaign: 'alpha-campaign', run: '1', diagnostics: { quality: 50 } }),
      expect.objectContaining({ campaign: 'alpha-campaign', run: '2', diagnostics: { quality: 80 } }),
      expect.objectContaining({ campaign: 'beta-campaign', run: '3' })
    ]);
  });

  it('slices campaign operational-value extracts by route and selected horizon in the worker', () => {
    const insights = dashboard.pages.find((/** @type {{ id: string }} */ candidate) => candidate.id === 'campaign-insights');
    const payload = compileDashboardViewPayloadQueries(insights, 'campaign-insights', {
      viewId: 'campaign-insights-navigation',
      routeParameters: { campaign: 'alpha-campaign' },
      queryContext: { timeWindow: { start: '2026-09-02T00:00:00Z', end: '2026-09-04T00:00:00Z' } },
      queries: dashboard.queries
    });
    const result = executeDashboardQueries(payload.queries, {
      workflows: {
        source: 'workflows',
        rows: [
          { organization: 'githubnext', repository: 'alpha', workflow: 'worker.md', campaign: 'alpha-campaign' },
          { organization: 'githubnext', repository: 'beta', workflow: 'worker.md', campaign: 'beta-campaign' }
        ],
        metadata
      },
      'operational-values': {
        source: 'operational-values',
        rows: [
          { organization: 'githubnext', repository: 'alpha', workflow: 'worker.md', run: 'before', 'observed-at': '2026-09-01T00:00:00Z', 'operational-value': 20 },
          { organization: 'githubnext', repository: 'alpha', workflow: 'worker.md', run: 'inside-1', 'observed-at': '2026-09-02T00:00:00Z', 'operational-value': 40 },
          { organization: 'githubnext', repository: 'alpha', workflow: 'worker.md', run: 'inside-2', 'observed-at': '2026-09-03T00:00:00Z', 'operational-value': 70 },
          { organization: 'githubnext', repository: 'beta', workflow: 'worker.md', run: 'other-campaign', 'observed-at': '2026-09-03T00:00:00Z', 'operational-value': 90 }
        ],
        metadata
      }
    }, payload.aliases);
    const valueAlias = payload.aliases.find((alias) => alias.endsWith('campaign-operational-value-series-2'));

    expect(valueAlias).toBeDefined();
    expect(result[valueAlias ?? ''].rows).toEqual([
      expect.objectContaining({
        campaign: 'alpha-campaign',
        'metric-key': 'primary:operational-value',
        points: [
          expect.objectContaining({ x: '2026-09-02T00:00:00Z', y: 40 }),
          expect.objectContaining({ x: '2026-09-03T00:00:00Z', y: 70 })
        ]
      })
    ]);
  });

  it('filters info events before grouping shared summaries by workflow', () => {
    const result = /** @type {Record<string, import('../../src/presenter.js').LogicalSourceInput>} */ (processDataRequest({
      operation: 'execute-dashboard-queries',
      queries: dashboard.queries,
      sourceNames: ['audit-event-summary-buckets'],
      sources: {
        audits: {
          source: 'audits',
          rows: [
            { organization: 'githubnext', repository: 'gh-aw-cao', workflow: '.github/workflows/audit.md', event: '1', 'event-type': 'audit.finding', 'event-status': 'high', 'event-summary': 'Repeated finding' },
            { organization: 'githubnext', repository: 'gh-aw-cao', workflow: '.github/workflows/audit.md', event: '2', 'event-type': 'audit.recommendation', 'event-status': 'medium', 'event-summary': 'Repeated finding' },
            { organization: 'githubnext', repository: 'gh-aw-cao', workflow: '.github/workflows/audit.md', event: '3', 'event-type': 'audit.finding', 'event-status': 'info', 'event-summary': 'Repeated finding' },
            { organization: 'githubnext', repository: 'gh-aw-cao', workflow: '.github/workflows/review.md', event: '4', 'event-type': 'audit.finding', 'event-status': 'high', 'event-summary': 'Repeated finding' },
            { organization: 'githubnext', repository: 'gh-aw-cao', workflow: '.github/workflows/audit.md', event: '5', 'event-type': 'tool.call', 'event-status': 'high', 'event-summary': 'Repeated finding' }
          ],
          metadata
        },
        tools: {
          source: 'tools',
          rows: [
            { organization: 'githubnext', repository: 'gh-aw-cao', workflow: '.github/workflows/audit.md', event: '6', 'event-type': 'audit.skill_activation', 'event-status': 'medium', 'event-summary': 'Skill activation' }
          ],
          metadata
        },
        workflows: {
          source: 'workflows',
          rows: [
            { organization: 'githubnext', repository: 'gh-aw-cao', workflow: '.github/workflows/audit.md', campaign: 'audit-campaign' },
            { organization: 'githubnext', repository: 'gh-aw-cao', workflow: '.github/workflows/review.md', campaign: 'review-campaign' }
          ],
          metadata
        }
      }
    }));

    expect(result['audit-event-summary-buckets'].rows).toEqual([
      {
        campaign: 'audit-campaign',
        workflow: '.github/workflows/audit.md',
        'event-summary': 'Repeated finding',
        events: 2
      },
      {
        campaign: 'audit-campaign',
        workflow: '.github/workflows/audit.md',
        'event-summary': 'Skill activation',
        events: 1
      },
      {
        campaign: 'review-campaign',
        workflow: '.github/workflows/review.md',
        'event-summary': 'Repeated finding',
        events: 1
      }
    ]);
  });
});
