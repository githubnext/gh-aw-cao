import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';
import { executeDashboardQueries, executeDashboardQuery } from '../../src/data/queries/declarative.js';

const fixtureDirectory = dirname(fileURLToPath(import.meta.url));
const dashboard = JSON.parse(readFileSync(resolve(fixtureDirectory, '../../dashboard.json'), 'utf8')).dashboard;
const query = dashboard.queries.find(
  (/** @type {{ name?: string }} */ candidate) => candidate.name === 'overview-campaign-links'
);
const problemGroupsQuery = dashboard.queries.find(
  (/** @type {{ name?: string }} */ candidate) => candidate.name === 'campaign-problem-error-groups'
);
const campaignRunsQuery = dashboard.queries.find(
  (/** @type {{ name?: string }} */ candidate) => candidate.name === 'campaign-runs'
);
const targetErrorQueries = dashboard.queries.filter(
  (/** @type {{ name?: string }} */ candidate) => [
    'campaign-problem-latest-target-runs',
    'campaign-problem-error-groups',
    'campaign-current-problem-error-groups'
  ].includes(candidate.name ?? '')
);
const campaignDiagnosisQueries = dashboard.queries.filter(
  (/** @type {{ name?: string }} */ candidate) => [
    'run-incomplete-outcomes',
    'campaign-runs'
  ].includes(candidate.name ?? '')
);

/** @type {import('../../src/presenter.js').SourceMetadata} */
const metadata = {
  'source-id': 'fixture',
  'source-kind': 'fixture',
  'as-of': '2026-09-22T12:00:00Z',
  'retrieved-at': '2026-09-22T12:00:00Z',
  availability: 'available',
  completeness: 'complete',
  freshness: 'fresh'
};

it('opens campaigns with runtime problems on Problems and healthy campaigns on Insights', () => {
  const result = executeDashboardQuery(query, {
    campaigns: {
      source: 'campaigns',
      metadata,
      rows: [
        { campaign: 'aw-doctor', 'campaign-name': 'AW Doctor', 'campaign-icon': 'gear' },
        { campaign: 'dependabot', 'campaign-name': 'Dependabot', 'campaign-icon': 'dependabot' }
      ]
    },
    'campaign-runtime-problem-counts': {
      source: 'campaign-runtime-problem-counts',
      metadata,
      rows: [{ campaign: 'aw-doctor', 'problem-partitions': 2 }]
    }
  });

  expect(result.rows).toEqual([
    expect.objectContaining({
      campaign: 'aw-doctor',
      'problem-indicator': 'alert',
      'campaign-dashboard-link': expect.objectContaining({
        'dashboard-href': '#page-campaign-problems?campaign=aw-doctor'
      })
    }),
    expect.objectContaining({
      campaign: 'dependabot',
      'problem-indicator': '',
      'campaign-dashboard-link': expect.objectContaining({
        'dashboard-href': '#page-campaign-insights?campaign=dependabot'
      })
    })
  ]);
});

it('keeps campaign error groups scoped to their target repository', () => {
  expect(problemGroupsQuery).toMatchObject({
    aggregate: {
      by: expect.arrayContaining(['runtime-repository', 'target-repository', 'error-signature'])
    }
  });
  expect(campaignRunsQuery).toMatchObject({
    select: expect.arrayContaining([
      { field: 'target-repository' }
    ])
  });
});

it('keeps only the newest error signature for each target repository', () => {
  const rows = [
    {
      campaign: 'dependabot',
      workflow: '.github/workflows/dependabot-update-planner.md',
      'workflow-name': 'Dependabot / Update Planner',
      'runtime-repository': 'githubnext/gh-aw-cao',
      'target-repository': 'octo-org/service-api',
      'rollout-mode': 'live',
      'failure-count': 3,
      'problem-kind': 'failure',
      'error-signature': 'agent_logic',
      'error-signature-label': 'Agent Logic',
      run: '100'
    },
    {
      campaign: 'dependabot',
      workflow: '.github/workflows/dependabot-update-planner.md',
      'workflow-name': 'Dependabot / Update Planner',
      'runtime-repository': 'githubnext/gh-aw-cao',
      'target-repository': 'octo-org/service-api',
      'rollout-mode': 'live',
      'failure-count': 3,
      'problem-kind': 'failure',
      'error-signature': 'driver_exit',
      'error-signature-label': 'Driver Exit',
      run: '101'
    },
    {
      campaign: 'dependabot',
      workflow: '.github/workflows/dependabot-update-planner.md',
      'workflow-name': 'Dependabot / Update Planner',
      'runtime-repository': 'githubnext/gh-aw-cao',
      'target-repository': 'octo-org/web-app',
      'rollout-mode': 'review',
      'failure-count': 1,
      'problem-kind': 'failure',
      'error-signature': 'agent_logic',
      'error-signature-label': 'Agent Logic',
      run: '102'
    }
  ];
  const sources = executeDashboardQueries(
    targetErrorQueries,
    {
      'campaign-problem-run-evidence': {
        source: 'campaign-problem-run-evidence',
        metadata,
        rows
      }
    },
    ['campaign-current-problem-error-groups']
  );

  expect(sources['campaign-current-problem-error-groups'].rows).toEqual([
    expect.objectContaining({
      'target-repository': 'octo-org/service-api',
      'error-signature': 'driver_exit',
      'latest-run': 101,
      'rollout-mode': 'live'
    }),
    expect.objectContaining({
      'target-repository': 'octo-org/web-app',
      'error-signature': 'agent_logic',
      'latest-run': 102,
      'rollout-mode': 'review'
    })
  ]);
});

it('diagnoses report-incomplete outcomes instead of presenting driver exit as the problem', () => {
  const sources = executeDashboardQueries(
    campaignDiagnosisQueries,
    {
      runs: {
        source: 'runs',
        metadata,
        rows: [{
          organization: 'githubnext',
          repository: 'gh-aw-cao',
          workflow: '.github/workflows/dependabot-update-planner.lock.yml',
          run: '35754799033',
          'run-attempt': 1,
          'run-status': 'completed',
          'run-conclusion': 'failure',
          'failure-kind': 'driver_exit'
        }]
      },
      workflows: {
        source: 'workflows',
        metadata,
        rows: [{
          organization: 'githubnext',
          repository: 'gh-aw-cao',
          workflow: '.github/workflows/dependabot-update-planner.lock.yml',
          campaign: 'dependabot',
          'campaign-name': 'Dependabot',
          'workflow-name': 'Dependabot / Update Planner',
          'workflow-role': 'worker'
        }]
      },
      audits: {
        source: 'audits',
        metadata,
        rows: [{
          organization: 'githubnext',
          repository: 'gh-aw-cao',
          workflow: '.github/workflows/dependabot-update-planner.lock.yml',
          run: '35754799033',
          'run-attempt': 1,
          'event-type': 'safe_output.created',
          'safe-output-type': 'report_incomplete',
          'event-summary': 'Dependabot alert evidence was unavailable for the target repository.'
        }]
      }
    },
    ['campaign-runs']
  );

  expect(sources['campaign-runs'].rows).toEqual([
    expect.objectContaining({
      'error-signature': 'incomplete_evidence',
      'error-signature-label': 'Incomplete Evidence',
      'status-detail': 'Dependabot alert evidence was unavailable for the target repository.',
      'outcome-kind': 'report_incomplete'
    })
  ]);
});

it('diagnoses report-incomplete tool evidence when the safe-output payload is unavailable', () => {
  const sources = executeDashboardQueries(
    campaignDiagnosisQueries,
    {
      runs: {
        source: 'runs',
        metadata,
        rows: [{
          organization: 'githubnext',
          repository: 'gh-aw-cao',
          workflow: '.github/workflows/dependabot-update-planner.lock.yml',
          run: '35818772349',
          'run-attempt': 1,
          'run-status': 'completed',
          'run-conclusion': 'failure',
          'failure-kind': 'driver_exit',
          'terminal-outcome': 'report_incomplete',
          'terminal-outcome-detail': 'The agent reported that required evidence or access was unavailable.'
        }]
      },
      workflows: {
        source: 'workflows',
        metadata,
        rows: [{
          organization: 'githubnext',
          repository: 'gh-aw-cao',
          workflow: '.github/workflows/dependabot-update-planner.lock.yml',
          campaign: 'dependabot',
          'campaign-name': 'Dependabot',
          'workflow-name': 'Dependabot / Update Planner',
          'workflow-role': 'worker'
        }]
      },
      audits: {
        source: 'audits',
        metadata,
        rows: []
      },
      tools: { source: 'tools', metadata, rows: [] }
    },
    ['campaign-runs']
  );

  expect(sources['campaign-runs'].rows).toEqual([
    expect.objectContaining({
      'error-signature': 'incomplete_evidence',
      'error-signature-label': 'Incomplete Evidence',
      'status-detail': 'The agent reported that required evidence or access was unavailable.'
    })
  ]);
});
