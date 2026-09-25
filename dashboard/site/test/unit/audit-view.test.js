// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { processDataRequest } from '../../src/data-worker.js';

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
      'campaign-audit-event-table'
    ]);
    expect(insights.views[0].data).toMatchObject({
      sources: [
        'workflows',
        'campaign-insight-tab-counts',
        'campaign-problem-tab-counts',
        'campaign-issue-tab-counts',
        'campaign-operational-value-primary-series',
        'campaign-runs'
      ],
      arguments: [{ name: 'campaign', field: 'campaign' }]
    });
    expect(insights.views.slice(1).map((/** @type {{ data: Record<string, string> }} */ view) => view.data)).toEqual([
      expect.objectContaining({ source: 'audit-event-summary-buckets', 'route-field': 'campaign' }),
      expect.objectContaining({ source: 'audit-event-summary-buckets', 'route-field': 'campaign' })
    ]);
    expect(insights.views.filter((/** @type {{ mark: string }} */ view) => view.mark !== 'element')
      .map((/** @type {{ mark: string }} */ view) => view.mark)).toEqual(['chart', 'list']);
    expect(insights.views[1]).toMatchObject({
      title: 'Severity audit events',
      chart: 'horizontal-bar',
      data: {
        limit: 20,
        'order-by': [
          { field: 'event-status', direction: 'asc' },
          { field: 'events', direction: 'desc' }
        ]
      },
      encoding: {
        x: { field: 'workflow', format: 'workflow-relative-path' },
        y: { field: 'events' },
        color: { field: 'event-status', title: 'Severity' }
      }
    });
    expect(issues.views
      .filter((/** @type {{ data?: { source?: string } }} */ view) => view.data?.source === 'campaign-worker-issues')
      .map((/** @type {{ data: Record<string, string> }} */ view) => view.data['route-field'])).toEqual([
      'campaign',
      'campaign'
    ]);
  });

  it('projects repository operational value with its maturity state', () => {
    const result = /** @type {Record<string, import('../../src/presenter.js').LogicalSourceInput>} */ (processDataRequest({
      operation: 'execute-dashboard-queries',
      queries: dashboard.queries,
      sourceNames: ['campaign-operational-value-primary-series'],
      sources: {
        'operational-values': {
          source: 'operational-values',
          rows: [{
            campaign: 'optimization',
            repository: 'gh-aw',
            'operational-value': 0.5,
            'operational-value-definition': 'optimization-token-optimizer.verified-opportunity-share',
            'operational-value-role': 'primary',
            'operational-value-name': 'Verified opportunity share',
            'maturity-status': 'interim',
            'adoption-at': '2026-09-15T23:30:36Z',
            'observed-at': '2026-09-24T20:56:21Z'
          }, {
            campaign: 'optimization',
            repository: 'gh-aw',
            'operational-value': 1,
            'operational-value-definition': 'optimization-token-optimizer.recommendation-acceptance-share',
            'operational-value-role': 'diagnostic',
            'operational-value-name': 'Recommendation acceptance share',
            'maturity-status': 'interim',
            'adoption-at': '2026-09-15T23:30:36Z',
            'observed-at': '2026-09-24T20:56:21Z'
          }],
          metadata
        }
      }
    }));

    expect(result['campaign-operational-value-primary-series'].rows).toEqual([
      expect.objectContaining({
        campaign: 'optimization',
        'maturity-status': 'interim',
        'operational-value-role': 'primary',
        'adoption-at': '2026-09-15T23:30:36Z',
        points: [expect.objectContaining({ x: '2026-09-24T20:56:21Z', y: 0.5, color: 'gh-aw' })]
      }),
      expect.objectContaining({
        'operational-value-role': 'diagnostic',
        points: [expect.objectContaining({ y: 1 })]
      })
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
        'event-status': 'high',
        workflow: '.github/workflows/audit.md',
        'event-summary': 'Repeated finding',
        events: 1
      },
      {
        campaign: 'review-campaign',
        'event-status': 'high',
        workflow: '.github/workflows/review.md',
        'event-summary': 'Repeated finding',
        events: 1
      },
      {
        campaign: 'audit-campaign',
        'event-status': 'medium',
        workflow: '.github/workflows/audit.md',
        'event-summary': 'Repeated finding',
        events: 1
      },
      {
        campaign: 'audit-campaign',
        'event-status': 'medium',
        workflow: '.github/workflows/audit.md',
        'event-summary': 'Skill activation',
        events: 1
      }
    ]);
  });

  it('counts every rendered Insights plot through the shared plot inventory', () => {
    const result = /** @type {Record<string, import('../../src/presenter.js').LogicalSourceInput>} */ (processDataRequest({
      operation: 'execute-dashboard-queries',
      queries: dashboard.queries,
      sourceNames: ['campaign-insight-tab-counts'],
      sources: {
        audits: {
          source: 'audits',
          rows: [
            { organization: 'githubnext', repository: 'gh-aw-cao', workflow: 'combined.md', event: '1', 'event-type': 'audit.finding', 'event-status': 'high', 'event-summary': 'Repeated finding' },
            { organization: 'githubnext', repository: 'gh-aw-cao', workflow: 'combined.md', event: '2', 'event-type': 'audit.recommendation', 'event-status': 'medium', 'event-summary': 'Repeated finding' },
            { organization: 'githubnext', repository: 'gh-aw-cao', workflow: 'audit-only.md', event: '3', 'event-type': 'audit.finding', 'event-status': 'high', 'event-summary': 'Audit-only finding' },
            ...Array.from({ length: 20 }, (_, index) => [0, 1].map((duplicate) => ({
              organization: 'githubnext',
              repository: 'gh-aw-cao',
              workflow: 'noise.md',
              event: `noise-${index}-${duplicate}`,
              'event-type': 'audit.finding',
              'event-status': 'high',
              'event-summary': `Noise finding ${index}`
            }))).flat()
          ],
          metadata
        },
        tools: { source: 'tools', rows: [], metadata },
        workflows: {
          source: 'workflows',
          rows: [
            { organization: 'githubnext', repository: 'gh-aw-cao', workflow: 'combined.md', campaign: 'combined' },
            { organization: 'githubnext', repository: 'gh-aw-cao', workflow: 'audit-only.md', campaign: 'audit-only' },
            { organization: 'githubnext', repository: 'gh-aw-cao', workflow: 'noise.md', campaign: 'noise' },
            { organization: 'githubnext', repository: 'gh-aw-cao', workflow: 'empty.md', campaign: 'empty' }
          ],
          metadata
        },
        'operational-values': {
          source: 'operational-values',
          rows: [{
            campaign: 'combined',
            repository: 'gh-aw-cao',
            'operational-value': 0.5,
            'operational-value-definition': 'combined.value',
            'operational-value-role': 'primary',
            'maturity-status': 'matured',
            'observed-at': '2026-09-16T10:00:00Z'
          }],
          metadata
        }
      }
    }));

    expect(result['campaign-insight-tab-counts'].rows).toHaveLength(3);
    expect(result['campaign-insight-tab-counts'].rows).toEqual(expect.arrayContaining([
      { campaign: 'combined', items: 2 },
      { campaign: 'audit-only', items: 1 },
      { campaign: 'noise', items: 1 }
    ]));
  });
});
