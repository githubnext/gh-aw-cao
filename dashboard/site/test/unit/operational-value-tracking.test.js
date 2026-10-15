import { describe, expect, it } from 'vitest';
import { processDataRequest } from '../../src/data-worker.js';
import { compileDashboardViewPayloadQueries } from '../../src/data/queries/view-payload-compiler.js';
import { authoritativeDashboard } from '../authoritative-dashboard.js';
import fixture from '../fixtures/operational-value-tracking.json' with { type: 'json' };

const dashboard = authoritativeDashboard.dashboard;
const page = dashboard.pages.find((/** @type {{ id: string }} */ entry) => entry.id === 'operational-value');
/** @type {import('../../src/presenter.js').SourceMetadata} */
const metadata = {
  'source-id': 'operational-value-contract', 'source-kind': 'fixture',
  'as-of': '2026-09-24T10:00:00Z', 'retrieved-at': '2026-09-24T10:00:00Z',
  completeness: 'complete', freshness: 'unknown', availability: 'available'
};

/** @param {Record<string, unknown>[]} rows @param {string} [viewId] @param {string} [pageId] @param {Record<string, string>} [routeParameters] */
function query(rows, viewId = 'operational-value-latest', pageId = 'operational-value', routeParameters = {}) {
  const selectedPage = dashboard.pages.find((/** @type {{ id: string }} */ entry) => entry.id === pageId);
  const payload = compileDashboardViewPayloadQueries(selectedPage, pageId, {
    viewId, queries: dashboard.queries, views: dashboard.views, routeParameters
  });
  const result = /** @type {Record<string, import('../../src/presenter.js').LogicalSourceInput>} */ (processDataRequest({
    operation: 'execute-dashboard-queries',
    queries: payload.queries, sourceNames: payload.aliases,
    sources: {
      campaigns: { source: 'campaigns', metadata, rows: fixture.campaigns },
      runs: { source: 'runs', metadata, rows: fixture.runs },
      workflows: { source: 'workflows', metadata, rows: fixture.workflows },
      'operational-values': { source: 'operational-values', metadata, rows }
    }
  }));
  expect(payload.aliases.length).toBeGreaterThan(0);
  for (const alias of payload.aliases) {
    expect(result[alias], 'the production worker must produce every declared view source').toBeTruthy();
    expect(result[alias].metadata?.availability, JSON.stringify(result[alias].metadata)).not.toBe('unavailable');
  }
  const source = result[payload.aliases[0]];
  expect(source, 'the production worker must produce the declared view payload').toBeDefined();
  expect(source.metadata?.availability, JSON.stringify(source.metadata)).not.toBe('unavailable');
  return source.rows;
}

describe('operational-value tracking contract', () => {
  it('shows only repository summaries before native evidence drill-down', () => {
    const campaignPage = dashboard.pages.find((/** @type {{ id: string }} */ entry) => entry.id === 'operational-value-campaign');
    expect(campaignPage.views).toHaveLength(1);
    expect(campaignPage.views[0]).toMatchObject({
      id: fixture.campaignSummaryContract.view, mark: 'list',
      data: { source: fixture.campaignSummaryContract.source },
      list: { drill: { page: 'operational-value-repository' } }
    });
  });

  it('explains unavailable comparison without treating a versioned history as a validated trend', () => {
    const route = { campaign: 'alpha', organization: 'octo', repository: 'api' };
    for (const [digest, note] of [
      [undefined, 'Comparison unavailable: measurement version was not retained.'],
      ['a'.repeat(64), 'Observed history only: a validated trend assessment is not supplied for this panel.']
    ]) {
      const plots = query(fixture.observations.slice(0, 2).map((row) => ({
        ...row, 'evaluator-digest': digest
      })), 'repository-outcome-history', 'operational-value-repository', route);
      expect(plots[0]['plot-comparison-note']).toBe(note);
    }
  });

  it('uses arbitrary contract cadence metadata without inferring it from metric names', () => {
    const route = { campaign: 'alpha', organization: 'octo', repository: 'api' };
    for (const [metric, cadence] of [
      ['custom-workflow.remaining-risk', 2.5],
      ['another-workflow.acceptance', 14],
      ['optimization-token-optimizer.aic-per-successful-run', undefined]
    ]) {
      const plots = query(fixture.observations.slice(0, 2).map((row) => ({
        ...row, 'operational-value-definition': metric, 'cadence-days': cadence
      })), 'repository-outcome-history', 'operational-value-repository', route);
      expect(plots).toHaveLength(1);
      expect(plots[0]['plot-cadence-days']).toBe(cadence ?? 0);
      expect(plots[0]['plot-max-gap-days']).toBe(cadence ?? 1);
    }
  });

  it('separates different native measures and cadence versions within the same campaign', () => {
    const base = fixture.observations[0];
    const plots = query([
      { ...base, 'cadence-days': 1 },
      { ...base, 'cadence-days': 7 },
      { ...base, 'cadence-days': 1, 'operational-value-definition': 'worker.accepted',
        'operational-value-name': 'Accepted changes', 'operational-value-unit': 'changes',
        'operational-value-direction': 'increase' }
    ], 'repository-outcome-history', 'operational-value-repository',
    { campaign: 'alpha', organization: 'octo', repository: 'api' });
    expect(plots).toHaveLength(3);
    expect(plots.map((row) => row['plot-cadence-days']).sort()).toEqual([1, 1, 7]);
    expect(new Set(plots.map((row) => row['operational-value-unit']))).toEqual(new Set(['alerts', 'changes']));
  });

  it('resolves every declared view through the production worker/query boundary', () => {
    expect(page.definition.views.map((/** @type {{ id: string, data: { source?: string, sources?: string[] } }} */ view) =>
      ({ id: view.id, ...(view.data.sources ? { sources: view.data.sources } : { source: view.data.source }) }))).toEqual(fixture.views);
    for (const view of fixture.views) expect(query(fixture.observations, view.id)).not.toHaveLength(0);
  });

  it('drills into native history for exactly one campaign and subject repository without central run attribution', () => {
    const plots = query(fixture.observations, 'repository-outcome-history', 'operational-value-repository', {
      campaign: 'alpha', organization: 'octo', repository: 'api'
    });
    expect(plots).toHaveLength(1);
    expect(plots[0]).toMatchObject({
      campaign: 'alpha', 'maturity-status': 'matured', 'adoption-at': '2026-09-01T00:00:00Z',
      series: [{ label: 'octo/api', points: [{ y: 4 }, { y: 0 }] }]
    });
    expect(plots[0]).not.toHaveProperty('run-days');
  });

  it('keeps evaluator versions and maturity in separate timeline panels', () => {
    const plots = query([
      ...fixture.observations.slice(0, 2),
      { ...fixture.observations[1], 'evaluator-digest': 'b'.repeat(64), 'maturity-status': 'interim' }
    ], 'repository-outcome-history', 'operational-value-repository', { campaign: 'alpha', organization: 'octo', repository: 'api' });
    expect(plots).toHaveLength(2);
    expect(plots.map((row) => row['maturity-status']).sort()).toEqual(['interim', 'matured']);
  });

  it('counts repositories once, includes gaps and exposes evidence dates without averaging native measures', () => {
    expect(query(fixture.observations, 'operational-value-signals')).toMatchObject([
      { campaign: 'alpha', signal: 'Improving', 'measured-repositories': 1, 'comparable-repositories': 1, 'improving-repositories': 1,
        'oldest-evidence-at': '2026-09-24T10:00:00Z', 'newest-evidence-at': '2026-09-24T10:00:00Z' },
      { campaign: 'beta', signal: 'Improving', 'measured-repositories': 1, 'comparable-repositories': 1 },
      { campaign: 'unmeasured', signal: 'Not measured', 'measured-repositories': 0, 'comparable-repositories': 0 }
    ]);
  });

  it('keeps campaign payloads bounded by campaign count rather than retained report volume', () => {
    const rows = Array.from({ length: 1000 }, (_, repository) =>
      fixture.observations.slice(0, 2).map((row, index) => ({
        ...row, id: `${repository}:${index}`, repository: `repo-${repository}`
      }))).flat();
    const signals = query(rows, 'operational-value-signals');
    expect(signals).toHaveLength(fixture.campaigns.length);
    expect(signals[0]).toMatchObject({
      campaign: 'alpha', 'measured-repositories': 1000, 'comparable-repositories': 1000,
      'improving-repositories': 1000, 'insufficient-repositories': 0
    });
    expect(query(rows, 'operational-value-direction-chart')).toHaveLength(1);
  });

  it('ranks worsening first and represents opposing repository movement as mixed, not an averaged all-clear', () => {
    const rows = [
      ...fixture.observations,
      ...fixture.observations.slice(2).map((row, index) => ({
        ...row, id: `w${index}`, repository: 'web', 'operational-value': index === 0 ? 8 : 4
      }))
    ];
    expect(query(rows, 'operational-value-signals').slice(0, 2)).toMatchObject([
      { campaign: 'beta', signal: 'Mixed', 'measured-repositories': 2, 'improving-repositories': 1, 'worsening-repositories': 1 },
      { campaign: 'alpha', signal: 'Improving' }
    ]);
  });

  it('classifies multiple primary goals conservatively and never counts them as multiple repositories', () => {
    const opposite = fixture.observations.slice(0, 2).map((row, index) => ({
      ...row, id: `second${index}`, 'operational-value-definition': 'worker.other', 'operational-value': index === 0 ? 1 : 8
    }));
    const mixed = [...fixture.observations.slice(0, 2), ...opposite];
    expect(query(mixed, 'operational-value-signals')[0]).toMatchObject({
      campaign: 'alpha', signal: 'Mixed', 'mixed-repositories': 1, 'measured-repositories': 1
    });
    expect(query([...mixed, { ...opposite[1], id: 'interim', 'observed-at': '2026-09-25T10:00:00Z', 'maturity-status': 'interim' }],
      'operational-value-signals')[0]).toMatchObject({
      campaign: 'alpha', signal: 'Insufficient evidence', 'insufficient-repositories': 1, 'comparable-repositories': 0
    });
  });

  it('plots daily repository assessments, deduplicates intraday observations and leaves absent days missing', () => {
    const rows = [...fixture.observations, {
      ...fixture.observations[1], id: 'a3', 'observed-at': '2026-09-24T12:00:00Z', 'operational-value': 8
    }];
    const plot = query(rows, 'operational-value-direction-chart');
    expect(plot).toEqual(expect.arrayContaining([
      expect.objectContaining({
        'campaign-label': 'Alpha', signal: 'Worsening', repositories: 1,
        'outcome-drill-link': { 'dashboard-href': '#page-operational-value-campaign?campaign=alpha', 'dashboard-label': 'Alpha' }
      }),
      expect.objectContaining({ 'campaign-label': 'Beta', signal: 'Improving', repositories: 1 })
    ]));
  });

  it('produces campaign-scoped repository summaries through the production worker without loading history', () => {
    const base = fixture.observations[0];
    const rows = [
      ...fixture.observations,
      { ...base, id: 'other-repo', repository: 'other', 'observed-at': '2026-09-25T10:00:00Z', 'evaluator-digest': undefined }
    ];
    const contract = fixture.campaignSummaryContract;
    const result = query(rows, contract.view, contract.page, { campaign: 'alpha' });
    expect(result).toHaveLength(2);
    for (const panel of result) {
      expect(Object.keys(panel)).toEqual(expect.arrayContaining(contract.fields));
      expect(panel.campaign).toBe('alpha');
      expect(panel).not.toHaveProperty('cells');
      expect(panel).not.toHaveProperty('series');
    }
    expect(result.map(row => row['repository-coordinate']).sort()).toEqual(['octo/api', 'octo/other']);
  });

  it('lists all campaigns and measures coverage rather than report volume or outcome scores', () => {
    expect(query(fixture.observations, 'operational-value-coverage')).toMatchObject([
      { campaign: 'alpha', 'measured-goals': 1, 'mature-goals': 1, 'measurement-state': 'Mature evidence available' },
      { campaign: 'beta', 'measured-goals': 1, 'mature-goals': 1, 'measurement-state': 'Mature evidence available' },
      { campaign: 'unmeasured', 'measured-goals': 0, 'mature-goals': 0, 'measurement-state': 'Not measured' }
    ]);
  });

  it('preserves native zero and separates campaign units, directions and movement', () => {
    expect(query(fixture.observations)).toMatchObject([
      { campaign: 'alpha', 'operational-value': 0, 'operational-value-unit': 'alerts', 'previous-native-change': -4, movement: 'Improving' },
      { campaign: 'beta', 'operational-value': 3, 'operational-value-unit': 'changes', 'previous-native-change': 3, movement: 'Improving' }
    ]);
  });

  it.each([
    ['evaluator-digest', 'b'.repeat(64)],
    ['operational-value-unit', 'percent'],
    ['operational-value-direction', 'increase'],
    ['adoption-at', '2026-09-02T00:00:00Z'],
    ['evaluation-mode', 'baseline-comparable'],
    ['repository', 'other'],
    ['organization', 'other']
  ])('does not compare across a changed %s', (field, value) => {
    const rows = fixture.observations.slice(0, 2).map((row, index) => index === 1 ? { ...row, [field]: value } : row);
    const latest = query(rows);
    expect(latest.every((row) => row.movement === 'Insufficient comparable history')).toBe(true);
  });

  it('shows newer interim evidence instead of an older mature result', () => {
    const rows = fixture.observations.slice(0, 2).map((row, index) =>
      index === 1 ? { ...row, 'maturity-status': 'interim' } : row);
    expect(query(rows)).toMatchObject([{ 'operational-value': 0, movement: 'Provisional or unavailable' }]);
    expect(query(rows, 'operational-value-coverage')[0]).toMatchObject({
      'measured-goals': 1, 'mature-goals': 0, 'measurement-state': 'Provisional evidence only'
    });
  });

  it.each([
    ['evaluator-digest', 'Unversioned evidence'],
    ['operational-value-unit', 'Native unit unavailable']
  ])('does not claim movement without %s', (field, movement) => {
    const rows = fixture.observations.slice(0, 2).map((row) => {
      const observation = /** @type {Record<string, unknown>} */ ({ ...row });
      delete observation[field];
      return observation;
    });
    expect(query(rows)).toMatchObject([{ movement }]);
  });

  it('does not replace missing evidence with zero or treat a diagnostic as coverage', () => {
    const diagnostic = { ...fixture.observations[0], 'operational-value-role': 'diagnostic' };
    expect(query([diagnostic])).toEqual([]);
    expect(query([diagnostic], 'operational-value-coverage')[0]).toMatchObject({
      'measured-goals': 0, 'measurement-state': 'Not measured'
    });
    expect(query([{ ...fixture.observations[1], 'operational-value': null }])).toMatchObject([
      { 'operational-value': null, movement: 'Insufficient comparable history' }
    ]);
  });

  it.each([
    [4, 'Unchanged'], [8, 'Worsening']
  ])('interprets decrease goals at %i in their native direction', (value, movement) => {
    expect(query([fixture.observations[0], { ...fixture.observations[1], 'operational-value': value }]))
      .toMatchObject([{ movement }]);
  });

  it.each(['maintain', 'target'])('requires target assessment for a %s goal', (direction) => {
    const rows = fixture.observations.slice(0, 2).map((row) => ({ ...row, 'operational-value-direction': direction }));
    expect(query(rows)).toMatchObject([{ movement: 'Target assessment required' }]);
    expect(query(rows.map((row) => ({ ...row, 'operational-value': 4 })))).toMatchObject([{ movement: 'Target assessment required' }]);
  });

  it('fails closed when the native outcome source cannot be produced', () => {
    const result = /** @type {Record<string, import('../../src/presenter.js').LogicalSourceInput>} */ (processDataRequest({
      operation: 'execute-dashboard-queries', queries: dashboard.queries,
      sourceNames: ['operational-value-latest'], sources: {}
    }));
    expect(result['operational-value-latest'].metadata?.availability).toBe('unavailable');
  });
});
