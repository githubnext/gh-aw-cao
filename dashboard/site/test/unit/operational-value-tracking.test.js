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

/** @param {Record<string, unknown>[]} rows @param {string} [viewId] @param {string} [pageId] @param {Record<string, string>} [routeParameters] @param {Record<string, unknown>[]} [repositories] @param {import('../../src/data/queries/view-payload-compiler.js').GlobalQueryContext} [queryContext] */
function query(rows, viewId = 'operational-value-latest', pageId = fixture.views.find(view => view.id === viewId)?.page ?? 'operational-value', routeParameters = {}, repositories = fixture.repositories, queryContext) {
  const selectedPage = dashboard.pages.find((/** @type {{ id: string }} */ entry) => entry.id === pageId);
  const payload = compileDashboardViewPayloadQueries(selectedPage, pageId, {
    viewId, queries: dashboard.queries, views: dashboard.views, routeParameters,
    evaluatedAt: metadata['as-of'], queryContext
  });
  const result = /** @type {Record<string, import('../../src/presenter.js').LogicalSourceInput>} */ (processDataRequest({
    operation: 'execute-dashboard-queries',
    queries: payload.queries, sourceNames: payload.aliases,
    sources: {
      repositories: { source: 'repositories', metadata, rows: repositories },
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

/** @param {Record<string, unknown>} plot */
function plotPoints(plot) {
  return /** @type {Array<{points: Array<{x: string, y: number, metadata: Record<string, unknown>}>}>} */ (plot.series)
    .flatMap(series => series.points);
}

describe('operational-value tracking contract', () => {
  it('omits the Evidence tab while preserving the direct evidence route', () => {
    const evidence = dashboard.pages.find((/** @type {{ id: string }} */ entry) => entry.id === 'operational-value-evidence');
    for (const selected of [page, evidence]) {
      expect(selected.route.tabs).toEqual([
        { id: 'workflows', label: 'Workflow results', icon: 'trophy', page: 'value' },
        { id: 'measurements', label: 'Repository measurements', icon: 'repo', page: 'operational-value' }
      ]);
    }
  });

  it('shows only repository summaries before native evidence drill-down', () => {
    expect(dashboard.pages.some((/** @type {{ id: string }} */ entry) => entry.id === 'operational-value-campaign')).toBe(false);
    expect(page.views[1]).toMatchObject({
      id: fixture.repositorySummaryContract.view, mark: 'list',
      data: { source: fixture.repositorySummaryContract.source },
      list: { drill: { page: 'operational-value-repository' } }
    });
    expect(page.views[1].list.drill.arguments.map((/** @type {{ name: string }} */ entry) => entry.name))
      .toEqual(['organization', 'repository']);
  });

  it('explains unavailable comparison without treating a versioned history as a validated trend', () => {
    const route = { campaign: 'alpha', organization: 'octo', repository: 'api' };
    for (const digest of [undefined, 'a'.repeat(64)]) {
      const plots = query(fixture.observations.slice(0, 2).map((row) => ({
        ...row, 'evaluator-digest': digest
      })), 'repository-outcome-history', 'operational-value-repository', route);
      expect(plots[0]['plot-comparison-note']).toBe('Recorded measurements, not a combined trend or a verified impact assessment.');
      expect(plotPoints(plots[0])[0].metadata['plot-point-description']).toContain(`Evaluator: ${digest ?? 'unknown'}`);
    }
  });

  it('merges known and unknown evaluator history into one plot without dropping points', () => {
    const route = { campaign: 'alpha', organization: 'octo', repository: 'api' };
    const base = fixture.observations[0];
    const plots = query([
      { ...base, 'evaluator-digest': undefined },
      { ...base, 'evaluator-digest': 'a'.repeat(64) }
    ], 'repository-outcome-history', 'operational-value-repository', route);
    expect(plots).toHaveLength(1);
    expect(plots[0]['plot-title']).toBe(base['operational-value-name']);
    const points = plotPoints(plots[0]);
    expect(points).toHaveLength(2);
    expect(points.map(point => point.y)).toEqual([base['operational-value'], base['operational-value']]);
    expect(points[0].metadata['plot-context-key']).toBeNull();
    expect(points[1].metadata['plot-context-key']).toContain('a'.repeat(64));
    const definition = dashboard.queries.find((/** @type {{name:string}} */ query) => query.name === 'operational-value-plot-series');
    expect(definition['temporal-series']['point-carry']).toEqual(fixture.plotPresentationContract.pointMetadataFields);
  });

  it('prioritizes plots and discloses comparison detail without presentation controls', () => {
    const detail = dashboard.pages.find((/** @type {{id:string}} */ entry) => entry.id === 'operational-value-repository');
    expect(detail['view-mode-control']).toBe(false);
    expect(detail.views.map((/** @type {{id:string}} */ view) => view.id)).toEqual(fixture.plotPresentationContract.viewOrder);
    expect(detail.views[0]['show-title']).toBe(false);
    expect(detail.views[1]).toMatchObject({
      disclosure: 'supplemental', 'disclosure-label': fixture.plotPresentationContract.comparisonDisclosure
    });
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
      expect(plotPoints(plots[0])[0].metadata['cadence-days']).toBe(cadence);
      expect(plotPoints(plots[0])[0].metadata['plot-max-gap-days']).toBe(cadence ?? 0);
    }
  });

  it('separates native measures but retains cadence differences in point metadata', () => {
    const base = fixture.observations[0];
    const plots = query([
      { ...base, 'cadence-days': 1 },
      { ...base, 'cadence-days': 7 },
      { ...base, 'cadence-days': 1, 'operational-value-definition': 'worker.accepted',
        'operational-value-name': 'Accepted changes', 'operational-value-unit': 'changes',
        'operational-value-direction': 'increase' }
    ], 'repository-outcome-history', 'operational-value-repository',
    { campaign: 'alpha', organization: 'octo', repository: 'api' });
    expect(plots).toHaveLength(2);
    expect(plots.flatMap(plotPoints).map(point => point.metadata['cadence-days']).sort()).toEqual([1, 1, 7]);
    expect(new Set(plots.map((row) => row['operational-value-unit']))).toEqual(new Set(['alerts', 'changes']));
  });

  it('resolves every declared view through the production worker/query boundary', () => {
    const evidence = dashboard.pages.find((/** @type {{ id: string }} */ entry) => entry.id === 'operational-value-evidence');
    expect([page, evidence].flatMap(selected => selected.views.map((/** @type {{ id: string, data: { source: string } }} */ view) =>
      ({ page: selected.id, id: view.id, source: view.data.source })))).toEqual(fixture.views);
    for (const view of fixture.views) expect(query(fixture.observations, view.id, view.page)).not.toHaveLength(0);
  });

  it('drills directly into all native history for one subject repository without central run attribution', () => {
    const plots = query(fixture.observations, 'repository-outcome-history', 'operational-value-repository', {
      organization: 'octo', repository: 'api'
    });
    expect(plots).toHaveLength(2);
    expect(plots.find(plot => plot.campaign === 'alpha')).toMatchObject({
      campaign: 'alpha', 'plot-evidence-mode': 'per-observation',
      series: [{ label: 'octo/api', points: [
        { y: 4, metadata: { 'maturity-status': 'matured', 'adoption-at': '2026-09-01T00:00:00Z' } },
        { y: 0 }
      ] }]
    });
    expect(plots[0]).not.toHaveProperty('run-days');
  });

  it('keeps evaluator and maturity on individual points without duplicating the metric plot', () => {
    const plots = query([
      ...fixture.observations.slice(0, 2),
      { ...fixture.observations[1], 'evaluator-digest': 'b'.repeat(64), 'maturity-status': 'interim' }
    ], 'repository-outcome-history', 'operational-value-repository', { campaign: 'alpha', organization: 'octo', repository: 'api' });
    expect(plots).toHaveLength(1);
    expect(plotPoints(plots[0]).map(point => point.metadata['maturity-status']).sort()).toEqual(['interim', 'matured', 'matured']);
  });

  it('counts a repository once across campaigns and exposes evidence dates without averaging native measures', () => {
    expect(query(fixture.observations, 'operational-value-signals')).toMatchObject([
      { 'repository-coordinate': 'octo/api', signal: 'Improving', goals: 2, 'comparable-goals': 2,
        'oldest-evidence-at': '2026-09-24T10:00:00Z', 'newest-evidence-at': '2026-09-24T10:00:00Z' }
    ]);
    expect(query(fixture.observations, 'operational-value-unmeasured')).toMatchObject([
      { repository: 'unmeasured', signal: 'Not measured', 'measured-goals': 0, 'evidence-reason': 'No retained primary measurements.' }
    ]);
  });

  it('keeps repository payloads bounded by repository count rather than retained report volume', () => {
    const rows = Array.from({ length: 1000 }, (_, repository) =>
      fixture.observations.slice(0, 2).map((row, index) => ({
        ...row, id: `${repository}:${index}`, repository: `repo-${repository}`
      }))).flat();
    const signals = query(rows, 'operational-value-signals');
    expect(signals).toHaveLength(1000);
    expect(signals.every(row => row.goals === 1 && row.signal === 'Improving')).toBe(true);
    expect(query(rows, 'operational-value-direction-chart')).toHaveLength(100);
  });

  it('ranks worsening repositories before improving repositories without averaging native values', () => {
    const rows = [
      ...fixture.observations,
      ...fixture.observations.slice(2).map((row, index) => ({
        ...row, id: `w${index}`, repository: 'web', 'operational-value': index === 0 ? 8 : 4
      }))
    ];
    expect(query(rows, 'operational-value-signals').slice(0, 2)).toMatchObject([
      { repository: 'web', signal: 'Worsening', 'measured-goals': 1 },
      { repository: 'api', signal: 'Improving', 'measured-goals': 2 }
    ]);
  });

  it('classifies multiple primary goals conservatively and never counts them as multiple repositories', () => {
    const opposite = fixture.observations.slice(0, 2).map((row, index) => ({
      ...row, id: `second${index}`, 'operational-value-definition': 'worker.other', 'operational-value': index === 0 ? 1 : 8
    }));
    const mixed = [...fixture.observations.slice(0, 2), ...opposite];
    expect(query(mixed, 'operational-value-signals')[0]).toMatchObject({
      repository: 'api', signal: 'Mixed', 'measured-goals': 2
    });
    expect(query([...mixed, { ...opposite[1], id: 'interim', 'observed-at': '2026-09-25T10:00:00Z', 'maturity-status': 'interim' }],
      'operational-value-signals')[0]).toMatchObject({
      repository: 'api', signal: 'Insufficient evidence', 'comparable-goals': 1
    });
  });

  it('links comparable repository directions directly to repository history', () => {
    const rows = [...fixture.observations, {
      ...fixture.observations[1], id: 'a3', 'observed-at': '2026-09-24T12:00:00Z', 'operational-value': 8
    }];
    const plot = query(rows, 'operational-value-direction-chart', undefined, undefined, undefined, {
      timeWindow: { end: '2026-09-24T13:00:00Z' }
    });
    expect(plot).toEqual(expect.arrayContaining([
      expect.objectContaining({
        'repository-coordinate': 'octo/api', signal: 'Mixed', repositories: 1,
        'repository-dashboard-link': { 'dashboard-href': '#page-operational-value-repository?organization=octo&repository=api', 'dashboard-label': 'octo/api' }
      })
    ]));
  });

  it('produces repository summaries through the production worker without loading history', () => {
    const base = fixture.observations[0];
    const rows = [
      ...fixture.observations,
      { ...base, id: 'other-repo', repository: 'other', 'observed-at': '2026-09-25T10:00:00Z', 'evaluator-digest': undefined }
    ];
    const contract = fixture.repositorySummaryContract;
    const result = query(rows, contract.view, contract.page);
    expect(result).toHaveLength(2);
    for (const panel of result) {
      expect(Object.keys(panel)).toEqual(expect.arrayContaining(contract.fields));
      expect(panel).not.toHaveProperty('campaign');
      expect(panel).not.toHaveProperty('cells');
      expect(panel).not.toHaveProperty('series');
    }
    expect(result.map(row => row['repository-coordinate']).sort()).toEqual(['octo/api', 'octo/other']);
  });

  it('lists all repositories and measures coverage rather than report volume or outcome scores', () => {
    expect(query(fixture.observations, 'operational-value-coverage')).toMatchObject([
      { repository: 'api', 'measured-goals': 2, 'mature-goals': 2, 'measurement-state': 'Mature evidence available' },
      { repository: 'unmeasured', 'measured-goals': 0, 'mature-goals': 0, 'measurement-state': 'Not measured' }
    ]);
  });

  it('preserves native zero and separates campaign units, directions and movement', () => {
    expect(query(fixture.observations)).toMatchObject([
      { campaign: 'alpha', 'operational-value': 0, 'operational-value-unit': 'alerts', 'previous-native-change': -4, movement: 'Improving' },
      { campaign: 'beta', 'operational-value': 3, 'operational-value-unit': 'changes', 'previous-native-change': 3, movement: 'Improving' }
    ]);
  });

  it('summarizes distinct repositories and latest goals at their own grains', () => {
    expect(query(fixture.observations, 'operational-value-summary')).toMatchObject([{
      repositories: 2, 'measured-repositories': 1, 'measured-goals': 2, 'comparable-goals': 2,
      summary: '1 of 2 repositories measured · 2 comparable goals'
    }]);
    const secondGoal = fixture.observations.slice(0, 2).map(row => ({
      ...row, 'operational-value-definition': 'worker.other', 'evaluator-digest': undefined
    }));
    expect(query([...fixture.observations, ...secondGoal], 'operational-value-summary')).toMatchObject([{
      repositories: 2, 'measured-repositories': 1, 'measured-goals': 3, 'comparable-goals': 2
    }]);
  });

  it('explains version blockers even when no direction can be plotted, without hiding native values', () => {
    const rows = fixture.observations.map(row => ({ ...row, 'evaluator-digest': undefined }));
    expect(query(rows, 'operational-value-summary')).toMatchObject([{
      'measured-repositories': 1, 'measured-goals': 2, 'comparable-goals': 0,
      'summary-note': 'Measurements are available, but none supports a comparable movement yet. Inspect the reasons below.'
    }]);
    expect(query(rows, 'operational-value-signals')).toHaveLength(1);
    for (const signal of query(rows, 'operational-value-signals')) {
      expect(signal).toMatchObject({ signal: 'Insufficient evidence', 'evidence-reason': 'Measurement version missing. ' });
    }
    expect(query(rows, 'operational-value-direction-chart')).toEqual([]);
    expect(query(rows)[0]['operational-value']).toBe(0);
    const repositories = query(rows, 'operational-value-signals');
    expect(repositories[0]['evidence-reason']).toBe('Measurement version missing. ');
  });

  it('retains multiple comparison blockers without disguising a comparable goal as an entire comparable repository', () => {
    const base = fixture.observations[1];
    const rows = [...fixture.observations,
      { ...base, 'operational-value-definition': 'unversioned', 'evaluator-digest': undefined },
      { ...base, 'operational-value-definition': 'unitless', 'operational-value-unit': undefined },
      { ...base, 'operational-value-definition': 'provisional', 'maturity-status': 'interim' },
      { ...base, 'operational-value-definition': 'history-gap' },
      ...fixture.observations.slice(0, 2).map(row => ({
        ...row, 'operational-value-definition': 'target', 'operational-value-direction': 'target'
      }))
    ];
    const alpha = query(rows, 'operational-value-signals').find(row => row.repository === 'api');
    expect(alpha).toMatchObject({
      'measured-goals': 7, 'comparable-goals': 2,
      'evidence-reason': 'Measurement version missing. Native unit missing. Provisional or unavailable measurements. Comparable history missing. Target assessment needed. '
    });
  });

  it('treats diagnostics-only evidence as missing measurement availability, not zero value or a missing contract', () => {
    const rows = fixture.observations.map(row => ({ ...row, 'operational-value-role': 'diagnostic' }));
    expect(query(rows, 'operational-value-signals')).toEqual([]);
    expect(query(rows, 'operational-value-unmeasured')).toHaveLength(2);
    expect(query(rows, 'operational-value-summary')).toMatchObject([{
      repositories: 2, 'measured-repositories': 0, 'measured-goals': 0, 'comparable-goals': 0,
      'summary-note': 'No primary measurements are retained. Inspect collection and measurement coverage in Evidence; absence is not zero value.'
    }]);
  });

  it('keeps an empty repository inventory honest instead of rendering a missing count as a measurement', () => {
    const summary = query([], 'operational-value-summary', 'operational-value', {}, []);
    expect(summary).toMatchObject([{
      repositories: 0, 'measured-repositories': 0, 'measured-goals': 0, 'comparable-goals': 0,
      summary: '0 of 0 repositories measured · 0 comparable goals'
    }]);
  });

  it.each([undefined, null, ''])('includes standalone outcomes with campaign %s even without campaign or repository inventory', (campaign) => {
    const rows = fixture.observations.slice(0, 2).map(row => ({
      ...row, campaign, repository: 'standalone', workflow: '.github/workflows/standalone.md'
    }));
    expect(query(rows, 'operational-value-signals', undefined, {}, [])).toMatchObject([{
      'repository-coordinate': 'octo/standalone', signal: 'Improving', goals: 1
    }]);
    expect(query(rows, 'operational-value-summary', undefined, {}, [])).toMatchObject([{
      repositories: 1, 'measured-repositories': 1, 'comparable-goals': 1
    }]);
    const plots = query(rows, 'repository-outcome-history', 'operational-value-repository',
      { organization: 'octo', repository: 'standalone' }, []);
    expect(plots).toHaveLength(1);
    expect(plotPoints(plots[0]).map(point => point.y)).toEqual([4, 0]);
    expect(query(rows)).toMatchObject([{ 'operational-value': 0, 'native-change': -4, movement: 'Improving' }]);
  });

  it.each(['workflow', 'workflow-slug'])('keeps identical measure IDs separate by %s within the same repository', (workflowField) => {
    const rows = ['first', 'second'].flatMap((workflow, workflowIndex) =>
      fixture.observations.slice(0, 2).map((row, index) => ({
        ...row, id: `${workflow}-${index}`, campaign: undefined, [workflowField]: workflow,
        'operational-value': workflowIndex === 0 ? row['operational-value'] : 10 + index
      })));
    expect(query(rows)).toHaveLength(2);
    expect(query(rows).map(row => row.movement).sort()).toEqual(['Improving', 'Worsening']);
    expect(query(rows, 'operational-value-signals')).toMatchObject([{
      repository: 'api', signal: 'Mixed', goals: 2
    }]);
    const plots = query(rows, 'repository-outcome-history', 'operational-value-repository',
      { organization: 'octo', repository: 'api' });
    expect(plots).toHaveLength(2);
    expect(plots.map(plot => plot['value-workflow']).sort()).toEqual(['first', 'second']);
    expect(plots.map(plot => plot['plot-title'])).toEqual(['Remaining alerts - first', 'Remaining alerts - second']);
    expect(plots.map(plot => plotPoints(plot).map(point => point.y))).toEqual([[4, 0], [10, 11]]);
  });

  it('does not mix organizations or include another repository in direct history', () => {
    const rows = ['octo', 'other'].flatMap(organization =>
      fixture.observations.slice(0, 2).map(row => ({ ...row, campaign: undefined, organization })));
    expect(query(rows, 'operational-value-signals')).toHaveLength(2);
    const plots = query(rows, 'repository-outcome-history', 'operational-value-repository',
      { organization: 'other', repository: 'api' });
    expect(plots).toHaveLength(1);
    expect(plotPoints(plots[0])).toHaveLength(2);
    expect(plots[0].series).toMatchObject([{ label: 'other/api' }]);
  });

  it.each([
    ['evaluator-digest', 'b'.repeat(64)],
    ['operational-value-unit', 'percent'],
    ['operational-value-direction', 'increase'],
    ['repository', 'other'],
    ['organization', 'other']
  ])('does not compare across a changed %s', (field, value) => {
    const rows = fixture.observations.slice(0, 2).map((row, index) => index === 1 ? { ...row, [field]: value } : row);
    const latest = query(rows);
    expect(latest.every((row) => typeof row.movement === 'string'
      && ['Insufficient comparable history', 'Stale or future evidence'].includes(row.movement))).toBe(true);
  });

  it.each([
    ['adoption-at', '2026-09-02T00:00:00Z'],
    ['evaluation-mode', 'baseline-comparable']
  ])('keeps recent movement independent of %s when the frozen measurement is unchanged', (field, value) => {
    const rows = fixture.observations.slice(0, 2).map((row, index) => index === 1 ? { ...row, [field]: value } : row);
    expect(query(rows)).toMatchObject([{ movement: 'Improving', 'native-change': -4 }]);
  });

  /** @param {string} id @param {string} end @param {number | null} value @param {Record<string, unknown>} [extra] @returns {Record<string, unknown>} */
  const weekly = (id, end, value, extra = {}) => ({
    ...fixture.observations[0], id,
    'measurement-kind': 'interval', 'cadence-days': 1,
    'window-start': new Date(Date.parse(end) - 7 * 86_400_000).toISOString(),
    'window-end': end, 'observed-at': end, 'operational-value': value, ...extra
  });
  const recentWeek = () => [
    weekly('week-reference', '2026-09-17T10:00:00Z', 10),
    weekly('overlapping-yesterday', '2026-09-23T10:00:00Z', 1),
    weekly('week-current', '2026-09-24T10:00:00Z', 8)
  ];

  it('compares adjacent weeks rather than successive overlapping daily samples', () => {
    expect(query(recentWeek())).toMatchObject([{
      'reference-native-value': 10, 'native-change': -2, movement: 'Improving',
      'reference-window-end': '2026-09-17T10:00:00Z'
    }]);
  });

  it('shows recent deterioration even when the value remains better than adoption', () => {
    const rows = [
      weekly('baseline', '2026-09-01T10:00:00Z', 20),
      weekly('reference', '2026-09-17T10:00:00Z', 2),
      weekly('current', '2026-09-24T10:00:00Z', 8)
    ].map(row => ({ ...row, 'evaluation-mode': 'baseline-comparable' }));
    expect(query(rows)).toMatchObject([{ movement: 'Worsening', 'native-change': 6 }]);
  });

  it.each([
    ['missing reference', {}],
    ['different duration', { 'window-start': '2026-09-11T10:00:00Z' }],
    ['different cadence', { 'cadence-days': 7 }],
    ['different kind', { 'measurement-kind': 'snapshot' }],
    ['partial reference', { 'coverage-status': 'partial' }],
    ['unknown reference', { 'coverage-status': 'unknown' }]
  ])('does not substitute another observation for a %s', (reason, changes) => {
    const rows = recentWeek();
    if (reason === 'missing reference') rows.shift();
    else rows[0] = { ...rows[0], ...changes };
    expect(query(rows)).toMatchObject([{
      movement: 'Insufficient comparable history', 'native-change': null, 'operational-value': 8
    }]);
  });

  it.each([
    ['partial', { 'coverage-status': 'partial' }, 'Coverage incomplete or unknown'],
    ['unknown', { 'coverage-status': 'unknown' }, 'Coverage incomplete or unknown'],
    ['missing', { 'coverage-status': 'missing' }, 'Coverage incomplete or unknown'],
    ['interim', { 'maturity-status': 'interim' }, 'Provisional or unavailable'],
    ['absent period', { 'window-start': undefined }, 'Measurement period unavailable']
  ])('preserves the native value but withholds movement for %s current evidence', (_label, changes, movement) => {
    const rows = recentWeek();
    rows[2] = { ...rows[2], ...changes };
    expect(query(rows)).toMatchObject([{ movement, 'native-change': null, 'operational-value': 8 }]);
  });

  it.each(['2026-09-23T10:00:00Z', '2026-09-25T10:00:00Z'])('does not claim current movement for a stale or future cutoff %s', (end) => {
    const rows = [
      weekly('reference', new Date(Date.parse(end) - 7 * 86_400_000).toISOString(), 10),
      weekly('current', end, 8)
    ];
    expect(query(rows)).toMatchObject([{ movement: 'Stale or future evidence', 'native-change': null }]);
  });

  it('does not resurrect a finite value after a newer unavailable assessment of the same period', () => {
    const rows = recentWeek();
    rows.push({
      ...rows[2], id: 'new-unavailable', 'observed-at': '2026-09-24T10:30:00Z',
      'operational-value': null, 'maturity-status': 'unavailable',
      'coverage-status': 'missing', 'missing-reason': 'source-inaccessible'
    });
    expect(query(rows)).toMatchObject([{
      'operational-value': null, movement: 'Provisional or unavailable', 'native-change': null,
      'missing-reason': 'source-inaccessible'
    }]);
  });

  it('does not resurrect a reference invalidated by a newer unavailable assessment', () => {
    const rows = recentWeek();
    rows.push({
      ...rows[0], id: 'reference-retracted', 'observed-at': '2026-09-24T09:00:00Z',
      'operational-value': null, 'maturity-status': 'unavailable', 'coverage-status': 'missing',
      'missing-reason': 'source-correction'
    });
    expect(query(rows)).toMatchObject([{ movement: 'Insufficient comparable history', 'native-change': null }]);
  });

  it('withholds a reference whose latest correction was assessed after the analysis endpoint', () => {
    const rows = recentWeek();
    rows.push({
      ...rows[0], id: 'future-reference-correction', 'observed-at': '2026-09-25T10:00:00Z',
      'operational-value': 20
    });
    expect(query(rows)).toMatchObject([{ movement: 'Insufficient comparable history', 'native-change': null }]);
  });

  it.each([20, null])('does not resurrect a superseded reference under an explicit horizon after correction to %s', (value) => {
    const rows = recentWeek();
    rows.push({
      ...rows[0], id: 'future-reference-correction', 'observed-at': '2026-09-25T10:00:00Z',
      'operational-value': value,
      ...(value === null ? { 'maturity-status': 'unavailable', 'coverage-status': 'missing' } : {})
    });
    expect(query(rows, 'operational-value-latest', undefined, {}, undefined, {
      timeWindow: { start: '2026-09-17T10:00:00Z', end: '2026-09-24T11:00:00Z' }
    })).toMatchObject([{ movement: 'Insufficient comparable history', 'native-change': null }]);
  });

  it('plots every finite native value in the selected horizon independently of comparison eligibility', () => {
    const horizon = fixture.plotHorizonContract;
    expect(dashboard.pages.find((/** @type {{ id: string }} */ entry) => entry.id === horizon.page)?.['filter-bar']).toBe(horizon.filterBar);
    const rows = [
      weekly('outside-horizon', '2026-09-16T10:00:00Z', 100),
      weekly('unknown-coverage', '2026-09-21T10:00:00Z', 4, { 'coverage-status': 'unknown' }),
      weekly('interim-zero', '2026-09-22T10:00:00Z', 0, { 'maturity-status': 'interim' }),
      weekly('partial-coverage', '2026-09-23T10:00:00Z', 6, { 'coverage-status': 'partial' }),
      weekly('current-zero', '2026-09-24T10:00:00Z', 0),
      weekly('missing', '2026-09-24T10:00:00Z', null, { 'maturity-status': 'unavailable' })
    ];
    const plots = query(rows, 'repository-outcome-history', 'operational-value-repository',
      { campaign: 'alpha', organization: 'octo', repository: 'api' }, undefined,
      { timeWindow: { start: horizon.start, end: horizon.end } });
    expect(plots.every(plot => plot[horizon.startField] === Date.parse(horizon.start)
      && plot[horizon.endField] === Date.parse(horizon.end))).toBe(true);
    const values = plots.flatMap(plot => /** @type {{ points: { y: number }[] }[]} */ (plot.series)
      .flatMap(series => series.points.map(point => point.y)));
    expect(values.sort((a, b) => a - b)).toEqual([0, 0, 4, 6]);
  });

  it('does not attach campaign-wide execution to repository history', () => {
    const detail = dashboard.pages.find((/** @type {{ id: string }} */ entry) => entry.id === 'operational-value-repository');
    expect(detail.views[0].data.sources).toEqual(['operational-value-plot-series']);
    expect(detail.route.breadcrumbs.map((/** @type {{ page: string }} */ entry) => entry.page))
      .toEqual(['operational-value', 'operational-value-repository']);
  });

  it('exposes denominator and cohort changes without renormalizing the native measure', () => {
    const rows = recentWeek();
    rows[0] = { ...rows[0], 'population-digest': 'a'.repeat(64), 'rollup-denominator': 100 };
    rows[2] = { ...rows[2], 'population-digest': 'b'.repeat(64), 'rollup-denominator': 10 };
    expect(query(rows)).toMatchObject([{
      movement: 'Improving', 'native-change': -2, 'exposure-change': -90,
      'reference-denominator': 100, 'rollup-denominator': 10,
      'comparison-context': expect.stringContaining('changed')
    }]);
  });

  it('describes snapshot changes as cutoff states rather than interval flows', () => {
    const rows = recentWeek().map(row => ({ ...row, 'measurement-kind': 'snapshot' }));
    expect(query(rows)).toMatchObject([{
      movement: 'Improving', 'native-change': -2,
      'recent-comparison-period': expect.stringContaining('Cutoff'),
      'comparison-context': expect.stringContaining('state')
    }]);
  });

  it('retains the required reference outside the display horizon while honoring its analysis endpoint', () => {
    const context = { timeWindow: { start: '2026-09-17T11:00:00Z', end: '2026-09-24T11:00:00Z' } };
    expect(query(recentWeek(), undefined, undefined, undefined, undefined, context))
      .toMatchObject([{ movement: 'Improving', 'native-change': -2 }]);
  });

  it('does not confuse maturation lag with stale assessment or replace the current period with a historical correction', () => {
    const rows = [
      weekly('reference', '2026-09-15T10:00:00Z', 10),
      weekly('current', '2026-09-22T10:00:00Z', 8, { 'observed-at': '2026-09-24T09:00:00Z' }),
      weekly('correction', '2026-09-15T10:00:00Z', 9, { 'observed-at': '2026-09-24T09:30:00Z' })
    ];
    expect(query(rows)).toMatchObject([{
      movement: 'Improving', 'operational-value': 8, 'reference-native-value': 9, 'native-change': -1
    }]);
  });
  it('shows newer interim evidence instead of an older mature result', () => {
    const rows = fixture.observations.slice(0, 2).map((row, index) =>
      index === 1 ? { ...row, 'maturity-status': 'interim' } : row);
    expect(query(rows)).toMatchObject([{ 'operational-value': 0, movement: 'Provisional or unavailable' }]);
    expect(query(rows, 'operational-value-coverage')[0]).toMatchObject({
      'measured-goals': 1, 'mature-goals': 0, 'measurement-state': 'Interim or unavailable evidence'
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
