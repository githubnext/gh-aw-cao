// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { processDataRequest } from '../../src/data-worker.js';
import { authoritativeDashboard } from '../authoritative-dashboard.js';

const dashboard = authoritativeDashboard.dashboard;
const metadata = {
  'source-id': 'friction-fixture',
  'source-kind': 'fixture',
  'as-of': '2026-09-28T12:00:00Z',
  'retrieved-at': '2026-09-28T12:01:00Z',
  completeness: /** @type {'complete'} */ ('complete'),
  freshness: /** @type {'fresh'} */ ('fresh'),
  availability: /** @type {'available'} */ ('available')
};

const rows = [
  {
    organization: 'githubnext',
    repository: 'gh-aw-cao',
    workflow: '.github/workflows/dashboard.md',
    run: '102',
    'event-timestamp': '2026-09-28T11:00:00Z',
    'measurement-state': 'measured',
    aic: 1.5,
    'total-run-aic': 6,
    'friction-ratio': 0.25,
    'counted-occurrences': 3,
    'suppressed-occurrences': 1,
    'unattributed-occurrences': 0,
    'run-link': { href: 'https://github.com/githubnext/gh-aw-cao/actions/runs/102' }
  },
  {
    organization: 'githubnext',
    repository: 'gh-aw-cao',
    workflow: '.github/workflows/dashboard.md',
    run: '101',
    'event-timestamp': '2026-09-28T10:00:00Z',
    'measurement-state': 'measured',
    aic: 0.5,
    'total-run-aic': 5,
    'friction-ratio': 0.1
  },
  {
    organization: 'githubnext',
    repository: 'control-plane',
    workflow: '.github/workflows/doctor.md',
    run: '100',
    'event-timestamp': '2026-09-28T09:00:00Z',
    'measurement-state': 'statistical',
    aic: 0.75,
    'total-run-aic': 3,
    'friction-ratio': 0.25
  }
];

describe('Friction dashboard view', () => {
  it('starts with a friction-cost summary and follows with run evidence', () => {
    const page = dashboard.pages.find((/** @type {{ id: string }} */ candidate) => candidate.id === 'friction');
    const dataSection = dashboard.navigation.find(
      (/** @type {{ label?: string }} */ section) => section.label === 'Data'
    );

    expect(dataSection.pages).toContain('friction');
    expect(page.views).toMatchObject([
      {
        id: 'friction-by-workflow',
        data: { source: 'friction-by-workflow' },
        mark: 'chart',
        chart: 'pie'
      },
      {
        id: 'friction-observations',
        data: { source: 'friction-observations' },
        mark: 'table',
        controls: 'interactive',
        'lazy-list': true
      }
    ]);
  });

  it('aggregates native audit cost and preserves run-level attribution evidence', () => {
    const result = /** @type {Record<string, import('../../src/presenter.js').LogicalSourceInput>} */ (
      processDataRequest({
        operation: 'execute-dashboard-queries',
        queries: dashboard.queries,
        sourceNames: ['friction-by-workflow', 'friction-observations'],
        sources: {
          friction: {
            source: 'friction',
            rows,
            metadata
          }
        }
      })
    );

    expect(result['friction-by-workflow'].rows).toEqual([
      {
        'workflow-coordinate': 'githubnext/gh-aw-cao:.github/workflows/dashboard.md',
        'repository-coordinate': 'githubnext/gh-aw-cao',
        workflow: '.github/workflows/dashboard.md',
        'friction-aic': 2,
        runs: 2
      },
      {
        'workflow-coordinate': 'githubnext/control-plane:.github/workflows/doctor.md',
        'repository-coordinate': 'githubnext/control-plane',
        workflow: '.github/workflows/doctor.md',
        'friction-aic': 0.75,
        runs: 1
      }
    ]);
    expect(result['friction-observations'].rows[0]).toMatchObject({
      run: '102',
      'measurement-state': 'measured',
      aic: 1.5,
      'friction-percent': '25%',
      'counted-occurrences': 3,
      'suppressed-occurrences': 1,
      'unattributed-occurrences': 0
    });
  });
});
