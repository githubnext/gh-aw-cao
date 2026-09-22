import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';
import { executeDashboardQuery } from '../../src/data/queries/declarative.js';

const fixtureDirectory = dirname(fileURLToPath(import.meta.url));
const dashboard = JSON.parse(readFileSync(resolve(fixtureDirectory, '../../dashboard.json'), 'utf8')).dashboard;
const query = dashboard.queries.find(
  (/** @type {{ name?: string }} */ candidate) => candidate.name === 'overview-campaign-links'
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
