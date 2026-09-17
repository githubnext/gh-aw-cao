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
        events: {
          source: 'events',
          rows: [
            { workflow: '.github/workflows/audit.md', event: '1', 'event-type': 'audit.finding', 'event-status': 'high', 'event-summary': 'Repeated finding' },
            { workflow: '.github/workflows/audit.md', event: '2', 'event-type': 'audit.recommendation', 'event-status': 'medium', 'event-summary': 'Repeated finding' },
            { workflow: '.github/workflows/audit.md', event: '3', 'event-type': 'audit.finding', 'event-status': 'info', 'event-summary': 'Repeated finding' },
            { workflow: '.github/workflows/review.md', event: '4', 'event-type': 'audit.finding', 'event-status': 'high', 'event-summary': 'Repeated finding' },
            { workflow: '.github/workflows/audit.md', event: '5', 'event-type': 'tool.call', 'event-status': 'high', 'event-summary': 'Repeated finding' }
          ],
          metadata
        }
      }
    }));

    expect(result['audit-event-summary-buckets'].rows).toEqual([
      {
        workflow: '.github/workflows/audit.md',
        'event-summary': 'Repeated finding',
        events: 2
      },
      {
        workflow: '.github/workflows/review.md',
        'event-summary': 'Repeated finding',
        events: 1
      }
    ]);
  });
});
