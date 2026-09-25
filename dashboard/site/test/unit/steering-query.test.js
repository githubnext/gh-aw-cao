import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';
import { executeDashboardQueries } from '../../src/data/queries/declarative.js';

const fixtureDirectory = dirname(fileURLToPath(import.meta.url));
const dashboard = JSON.parse(readFileSync(resolve(fixtureDirectory, '../../dashboard.json'), 'utf8')).dashboard;
const steeringQueries = dashboard.queries.filter(
  (/** @type {{ name?: string }} */ candidate) => [
    'steering-events',
    'steering-type-totals',
    'steering-workflow-totals',
    'steering-workflows',
    'steering-top-workflows'
  ].includes(candidate.name ?? '')
);

/** @type {import('../../src/presenter.js').SourceMetadata} */
const metadata = {
  'source-id': 'fixture',
  'source-kind': 'fixture',
  'as-of': '2026-09-24T12:00:00Z',
  'retrieved-at': '2026-09-24T12:00:00Z',
  availability: 'available',
  completeness: 'complete',
  freshness: 'fresh'
};

/**
 * @param {string} id
 * @param {string} code
 * @param {string} workflow
 * @param {string} run
 */
function steeringAudit(id, code, workflow, run) {
  return {
    id,
    organization: 'githubnext',
    repository: 'gh-aw-cao',
    workflow,
    run,
    code,
    'event-type': 'audit.gateway_steering',
    'event-status': code,
    'event-summary': `${code} warning`,
    'observed-at': '2026-09-24T11:00:00Z'
  };
}

const sources = {
  audits: {
    source: 'audits',
    metadata,
    rows: [
      steeringAudit('a1', 'token_steering', '.github/workflows/doctor.md', '1'),
      steeringAudit('a2', 'token_steering', '.github/workflows/doctor.md', '2'),
      steeringAudit('a3', 'timeout_steering', '.github/workflows/doctor.md', '2'),
      steeringAudit('a4', 'timeout_steering', '.github/workflows/triage.md', '3'),
      {
        id: 'a5',
        organization: 'githubnext',
        repository: 'gh-aw-cao',
        workflow: '.github/workflows/doctor.md',
        run: '1',
        code: 'high_token_usage',
        'event-type': 'audit.finding',
        'event-status': 'medium',
        'event-summary': 'Slow response',
        'observed-at': '2026-09-24T11:00:00Z'
      }
    ]
  },
  workflows: {
    source: 'workflows',
    metadata,
    rows: [
      {
        organization: 'githubnext',
        repository: 'gh-aw-cao',
        workflow: '.github/workflows/doctor.md',
        'workflow-name': 'AW Doctor',
        campaign: 'aw-doctor'
      }
    ]
  }
};

it('groups steering warnings by steering type without other audit events', () => {
  const results = executeDashboardQueries(steeringQueries, sources);

  expect(results['steering-type-totals'].rows).toEqual([
    expect.objectContaining({
      'steering-type': 'Running out of time',
      'steering-code': 'timeout_steering',
      events: 2,
      runs: 2,
      workflows: 2
    }),
    expect.objectContaining({
      'steering-type': 'Running out of tokens',
      'steering-code': 'token_steering',
      events: 2,
      runs: 2,
      workflows: 1
    })
  ]);
});

it('ranks workflows by steering warnings and links each one to its runtime page', () => {
  const results = executeDashboardQueries(steeringQueries, sources);

  expect(results['steering-top-workflows'].rows).toEqual([
    expect.objectContaining({
      'workflow-coordinate': 'githubnext/gh-aw-cao:.github/workflows/doctor.md',
      'workflow-label': 'AW Doctor',
      events: 3,
      runs: 2,
      'token-events': 2,
      'time-events': 1,
      'workflow-dashboard-link': expect.objectContaining({
        'dashboard-href': '#page-workflow-runtime?workflow=githubnext%2Fgh-aw-cao%3A.github%2Fworkflows%2Fdoctor.md'
      })
    }),
    expect.objectContaining({
      'workflow-coordinate': 'githubnext/gh-aw-cao:.github/workflows/triage.md',
      'workflow-label': 'githubnext/gh-aw-cao:.github/workflows/triage.md',
      events: 1,
      'token-events': 0,
      'time-events': 1
    })
  ]);
});
