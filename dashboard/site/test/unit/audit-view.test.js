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
  it('reuses package-filtered Audit views for the package Insights facet', () => {
    const insights = dashboard.pages.find((/** @type {{ id: string }} */ candidate) => candidate.id === 'package-insights');
    const issues = dashboard.pages.find((/** @type {{ id: string }} */ candidate) => candidate.id === 'package-issues');

    expect(insights.views.map((/** @type {{ id: string }} */ view) => view.id)).toEqual([
      'package-insights-navigation',
      'package-audit-event-summary-buckets',
      'package-audit-events-table'
    ]);
    expect(insights.views.slice(1).map((/** @type {{ data: Record<string, string> }} */ view) => view.data)).toEqual([
      expect.objectContaining({ source: 'audit-event-summary-buckets', 'route-field': 'package' }),
      expect.objectContaining({ source: 'audit-events', 'route-field': 'package' })
    ]);
    expect(issues.views
      .filter((/** @type {{ data?: { source?: string } }} */ view) => view.data?.source === 'package-worker-issues')
      .map((/** @type {{ data: Record<string, string> }} */ view) => view.data['route-field'])).toEqual([
      'package',
      'package'
    ]);
  });

  it('projects only issue outcomes produced by package workers', () => {
    const result = /** @type {Record<string, import('../../src/presenter.js').LogicalSourceInput>} */ (processDataRequest({
      operation: 'execute-dashboard-queries',
      queries: dashboard.queries,
      sourceNames: ['package-worker-issues'],
      sources: {
        outcomes: {
          source: 'outcomes',
          rows: [
            { organization: 'githubnext', repository: 'gh-aw-cao', package: 'ambient-context', workflow: '.github/workflows/orchestrator.md', 'safe-output': 'orchestrator-issue', 'outcome-category': 'issue' },
            { organization: 'githubnext', repository: 'gh-aw-cao', package: 'ambient-context', workflow: '.github/workflows/worker.md', 'safe-output': 'worker-issue', 'outcome-category': 'issue' },
            { organization: 'githubnext', repository: 'gh-aw-cao', package: 'ambient-context', workflow: '.github/workflows/worker.md', 'safe-output': 'worker-pr', 'outcome-category': 'pull-request' }
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

    expect(result['package-worker-issues'].rows).toEqual([
      expect.objectContaining({ package: 'ambient-context', 'safe-output': 'worker-issue' })
    ]);
  });

  it('declares an aggregate chart before the reorganized event table', () => {
    const page = dashboard.pages.find((/** @type {{ id: string }} */ candidate) => candidate.id === 'audit');

    expect(page.views.map((/** @type {{ id: string }} */ view) => view.id)).toEqual([
      'audit-event-summary-buckets',
      'audit-events-table'
    ]);
    expect(page.views[0]).toMatchObject({
      mark: 'chart',
      chart: 'bar',
      encoding: {
        x: { field: 'workflow', format: 'workflow-relative-path' },
        y: { field: 'events' },
        color: { field: 'event-summary' }
      }
    });
    expect(page.views[1].encoding.columns.slice(0, 4)).toEqual([
      expect.objectContaining({ field: 'event-summary' }),
      expect.objectContaining({ field: 'event-status', display: 'status' }),
      expect.objectContaining({ field: 'workflow', format: 'workflow-relative-path' }),
      expect.objectContaining({ field: 'audit-kind', display: 'label' })
    ]);
    expect(page.views[1].encoding.columns).toContainEqual(
      expect.objectContaining({ field: 'run', display: 'run-link' })
    );
    expect(dashboard.queries.find(
      (/** @type {{ name: string }} */ query) => query.name === 'audit-event-summary-buckets'
    )).toMatchObject({ limit: 20 });
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
            { organization: 'githubnext', repository: 'gh-aw-cao', workflow: '.github/workflows/audit.md', package: 'audit-package' },
            { organization: 'githubnext', repository: 'gh-aw-cao', workflow: '.github/workflows/review.md', package: 'review-package' }
          ],
          metadata
        }
      }
    }));

    expect(result['audit-event-summary-buckets'].rows).toEqual([
      {
        package: 'audit-package',
        workflow: '.github/workflows/audit.md',
        'event-summary': 'Repeated finding',
        events: 2
      },
      {
        package: 'audit-package',
        workflow: '.github/workflows/audit.md',
        'event-summary': 'Skill activation',
        events: 1
      },
      {
        package: 'review-package',
        workflow: '.github/workflows/review.md',
        'event-summary': 'Repeated finding',
        events: 1
      }
    ]);
  });
});
