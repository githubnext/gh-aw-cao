// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderBoundMeasureHistory, renderMeasureHistory } from '../../src/components/measure-history.js';
import { configureSourceLoader, resetSourceStore } from '../../src/source-store.js';

const metadata = {
  'source-id': 'operational-value-fixture',
  'source-kind': 'fixture',
  'as-of': '2026-09-24T20:56:21Z',
  'retrieved-at': '2026-09-24T20:57:00Z',
  completeness: /** @type {'complete'} */ ('complete'),
  freshness: /** @type {'fresh'} */ ('fresh'),
  availability: /** @type {'available'} */ ('available')
};

afterEach(() => {
  document.body.replaceChildren();
  resetSourceStore();
});

describe('Measure history', () => {
  it('does not query all campaigns before a campaign is selected', () => {
    const loader = vi.fn();
    configureSourceLoader(loader);
    const root = renderBoundMeasureHistory({
      title: 'Repository operational value',
      sourceNames: ['value-series'],
      sources: {},
      pageId: 'test-page',
      routeParameter: 'campaign',
      contextDetails: [],
      headingTag: 'h3'
    });
    expect(root.textContent).toContain('Select a campaign');
    expect(loader).not.toHaveBeenCalled();
  });

  it('isolates pending campaign plot sources from another route and cached unscoped rows', async () => {
    /** @type {Record<string, (source: import('../../src/presenter.js').LogicalSourceInput) => void>} */
    const pending = {};
    configureSourceLoader((name, options) => new Promise((resolve) => {
      pending[options?.routeParameters?.campaign ?? ''] = resolve;
    }));
    const context = {
      title: 'Repository operational value',
      sourceNames: ['value-series'],
      sources: {
        'value-series': {
          source: 'value-series',
          metadata,
          rows: [{ metric: 'other-campaign', points: [{ x: '2026-09-24T00:00:00Z', y: 42, color: 'other/repo' }] }]
        }
      },
      elementConfig: { 'measure-source': /** @type {const} */ ('operational-value') },
      pageId: 'test-page',
      viewId: 'value-history',
      routeParameter: 'campaign',
      contextDetails: [],
      headingTag: /** @type {'h3'} */ ('h3')
    };
    const first = renderBoundMeasureHistory({ ...context, routeParameters: { campaign: 'first' } });
    const second = renderBoundMeasureHistory({ ...context, routeParameters: { campaign: 'second' } });
    document.body.append(first, second);
    expect(second.textContent).not.toContain('other-campaign');
    expect(second.textContent).toContain('Loading repository operational value');
    pending.first({ source: 'value-series', metadata, rows: [] });
    await vi.waitFor(() => expect(first.textContent).toContain('No measure history was observed'));
    expect(second.textContent).toContain('Loading repository operational value');
    pending.second({ source: 'value-series', metadata, rows: [] });
    await vi.waitFor(() => expect(second.textContent).toContain('No measure history was observed'));
  });

  it('updates the operational-value plot as each declared query resolves and stops on detachment', async () => {
    /** @type {Record<string, (source: import('../../src/presenter.js').LogicalSourceInput) => void>} */
    const resolve = {};
    const loader = vi.fn((name) => new Promise((done) => {
      resolve[name] = done;
    }));
    configureSourceLoader(loader);
    const names = ['value-series', 'campaign-run-days', 'evidence-state'];
    const root = renderBoundMeasureHistory({
      title: 'Repository operational value',
      sourceNames: names,
      sources: {},
      elementConfig: { 'measure-source': 'operational-value' },
      pageId: 'test-page',
      viewId: 'value-history',
      routeParameter: 'campaign',
      routeParameters: { campaign: 'sample' },
      contextDetails: [],
      headingTag: 'h3'
    });
    document.body.append(root);
    expect(root.textContent).toContain('Loading repository operational value');
    expect(loader.mock.calls.map(([name]) => name)).toEqual(names);

    resolve['value-series']({
      source: 'value-series',
      metadata,
      rows: [{
        metric: 'sample.value',
        'operational-value-name': 'Sample value',
        'operational-value-unit': 'percent',
        points: [{ x: '2026-09-24T00:00:00Z', y: 42, color: 'github/repo' }]
      }]
    });
    await vi.waitFor(() => expect(root.querySelector('.temporal-metric-plot')).not.toBeNull());
    const plot = root.querySelector('.temporal-metric-plot');
    resolve['campaign-run-days']({
      source: 'campaign-run-days',
      metadata,
      rows: [{ 'run-day': '2026-09-24', 'successful-runs': 1, 'failed-runs': 0, 'concluded-runs': 1, 'success-rate-percent': 100 }]
    });
    await vi.waitFor(() => expect(root.querySelector('.temporal-plot-run-outcome')).not.toBeNull());
    expect(root.querySelector('.temporal-metric-plot')).toBe(plot);

    root.remove();
    await Promise.resolve();
    resolve['evidence-state']({
      source: 'evidence-state',
      metadata,
      rows: [{ 'evidence-state': 'interim-evidence', 'observation-count': 1, 'matured-observation-count': 0 }]
    });
    await Promise.resolve();
    expect(root.querySelector('.temporal-metric-plot')).toBe(plot);
  });

  it('labels interim repository operational value without a heading badge', () => {
    const rendered = renderMeasureHistory({
      title: 'Repository operational value',
      sourceNames: [
        'value-series',
        'campaign-run-days',
        'evidence-state'
      ],
      sources: {
        'value-series': {
          source: 'value-series',
          metadata,
          rows: [{
            metric: 'optimization-token-optimizer.verified-opportunity-share',
            'metric-name': 'optimization-token-optimizer.verified-opportunity-share',
            'metric-kind': 'primary',
            'operational-value-role': 'primary',
            'operational-value-name': 'Verified opportunity share',
            'operational-value-unit': 'percent',
            'operational-value-direction': 'increase',
            'maturity-status': 'interim',
            'adoption-at': '2026-09-15T23:30:36Z',
            'evaluation-mode': 'baseline-comparable',
            'workflow-name': 'Optimization / Token Optimizer',
            points: [{
              x: '2026-09-15T23:30:36Z',
              y: 0,
              color: 'gh-aw',
              key: 'primary:value:0'
            }, {
              x: '2026-09-24T20:56:21Z',
              y: 0.5,
              color: 'gh-aw',
              key: 'primary:value:1'
            }]
          }]
        },
        'campaign-run-days': {
          source: 'campaign-run-days',
          metadata,
          rows: [
            { 'run-day': '2026-09-18', 'successful-runs': 8, 'failed-runs': 2, 'success-rate-percent': 80, 'concluded-runs': 10 },
            { 'run-day': '2026-09-20', 'successful-runs': 4, 'failed-runs': 4, 'success-rate-percent': 50, 'concluded-runs': 8 }
          ]
        },
        'evidence-state': {
          source: 'evidence-state',
          metadata,
          rows: [{ 'evidence-state': 'interim-evidence' }]
        }
      },
      elementConfig: { 'measure-source': 'operational-value' },
      pageId: 'test-page',
      contextDetails: [],
      headingTag: 'h3'
    });

    expect(rendered.querySelector('h2')?.textContent).toBe('Operational value');
    expect(rendered.querySelector('.insights-section-heading .insights-dubious-flag')).toBeNull();
    expect(rendered.textContent).toContain('2 interim observations');
    expect(rendered.querySelector('.temporal-plot-heading h3')?.textContent)
      .toBe('Verified opportunity share');
    expect(rendered.querySelector('.temporal-plot-heading-copy p')?.textContent)
      .toBe('Higher is better');
    expect(rendered.querySelector('[data-chart-temporal-marker="2026-09-15T23:30:36Z"]')).not.toBeNull();
    expect(rendered.querySelectorAll('.temporal-plot-run-outcome')).toHaveLength(2);
    expect(rendered.querySelectorAll('.temporal-plot-run-outcome-success')).toHaveLength(2);
    expect(rendered.querySelectorAll('.temporal-plot-run-outcome-failure')).toHaveLength(2);
    expect(rendered.textContent).toContain('Runs');
  });

  it('uses operational-value metadata to label diagnostic plots', () => {
    const rendered = renderMeasureHistory({
      title: 'Repository operational value',
      sourceNames: ['value-series'],
      sources: {
        'value-series': {
          source: 'value-series',
          metadata,
          rows: [{
            metric: 'optimization-token-optimizer.recommendation-acceptance-share',
            'metric-name': 'optimization-token-optimizer.recommendation-acceptance-share',
            'metric-kind': 'primary',
            'operational-value-role': 'diagnostic',
            'operational-value-name': 'Recommendation acceptance share',
            'operational-value-unit': 'percent',
            'operational-value-direction': 'increase',
            'maturity-status': 'interim',
            'evaluation-mode': 'attainment-only',
            points: [
              { x: '2026-09-16T00:00:00Z', y: 0.5, color: 'gh-aw', key: 'value:0' },
              { x: '2026-09-24T00:00:00Z', y: 1, color: 'gh-aw', key: 'value:1' }
            ]
          }]
        }
      },
      elementConfig: { 'measure-source': 'operational-value' },
      pageId: 'test-page',
      contextDetails: [],
      headingTag: 'h3'
    });
    expect(rendered.querySelector('.temporal-plot-point[aria-label^="gh-aw:"]'))
      .not.toBeNull();
    expect(rendered.textContent).toContain('Recommendation acceptance share');
  });

  it('plots interim evidence with an explicit not-yet-mature state', () => {
    const rendered = renderMeasureHistory({
      title: 'Repository operational value',
      sourceNames: [
        'value-series',
        'campaign-runs',
        'value-evidence-state'
      ],
      sources: {
        'value-series': {
          source: 'value-series',
          metadata,
          rows: [{
            metric: 'optimization-token-optimizer.guarded-net-gain-magnitude',
            'metric-name': 'optimization-token-optimizer.guarded-net-gain-magnitude',
            'metric-kind': 'primary',
            'operational-value-role': 'primary',
            'operational-value-name': 'Guarded net gain magnitude',
            'operational-value-unit': 'percent',
            'operational-value-direction': 'increase',
            'maturity-status': 'interim',
            'adoption-at': '2026-09-15T23:30:36Z',
            'evaluation-mode': 'baseline-comparable',
            'workflow-name': 'Optimization / Token Optimizer',
            points: [{
              x: '2026-09-24T20:56:21Z',
              y: 0,
              color: 'gh-aw',
              key: 'primary:value:0'
            }]
          }]
        },
        'campaign-runs': {
          source: 'campaign-runs',
          metadata,
          rows: []
        },
        'value-evidence-state': {
          source: 'value-evidence-state',
          metadata,
          rows: [{
            'observation-count': 261,
            'matured-observation-count': 0,
            'evidence-state': 'interim-evidence'
          }]
        }
      },
      elementConfig: { 'measure-source': 'operational-value' },
      pageId: 'test-page',
      contextDetails: [],
      headingTag: 'h3'
    });

    expect(rendered.querySelector('[data-operational-value-state="interim-evidence"]')).not.toBeNull();
    expect(rendered.textContent).toContain('261 interim observations');
    expect(rendered.textContent).toContain('Amber points are not mature evidence');
    expect(rendered.querySelector('.temporal-metric-plot-provisional')).not.toBeNull();
    expect(rendered.querySelector('.temporal-plot-metric')).toBeNull();
    expect(rendered.querySelector('.temporal-plot-point')).not.toBeNull();
    expect(rendered.querySelector('svg')?.getAttribute('aria-label')).toContain('repository daily change timeline');
    expect(rendered.querySelector('.temporal-metric-plot-provisional')).not.toBeNull();
  });

  it('plots repositories together by metric and never exposes a campaign rollup', () => {
    const repositoryRows = [{
      metric: 'optimization-token-optimizer.verified-efficiency-improvement-share',
      'operational-value-name': 'Verified efficiency improvement share',
      'operational-value-unit': 'percent',
      'operational-value-direction': 'increase',
      'maturity-status': 'matured',
      'evaluation-mode': 'attainment-only',
      'workflow-name': 'Optimization / Token Optimizer',
      points: [
        { x: '2026-09-24T00:00:00Z', y: 0.5, color: 'github/gh-aw', key: 'gh-aw' },
        { x: '2026-09-24T00:00:00Z', y: 1, color: 'githubnext/gh-aw-cao', key: 'gh-aw-cao' }
      ]
    }];
    const rendered = renderMeasureHistory({
      title: 'Repository operational value',
      sourceNames: ['value-series', 'campaign-runs', 'evidence-state'],
      sources: {
        'value-series': { source: 'value-series', metadata, rows: repositoryRows },
        'campaign-runs': { source: 'campaign-runs', metadata, rows: [] },
        'evidence-state': {
          source: 'evidence-state',
          metadata,
          rows: [{ 'evidence-state': 'observed-value' }]
        }
      },
      elementConfig: { 'measure-source': 'operational-value' },
      pageId: 'test-page',
      contextDetails: [],
      headingTag: 'h3'
    });

    expect(rendered.querySelector('[aria-label="Operational value repository scope"]')).toBeNull();
    expect(rendered.querySelector('[data-operational-value-scope="campaign-rollup"]')).toBeNull();
    expect(rendered.querySelectorAll('.temporal-metric-plot')).toHaveLength(1);
    expect(rendered.querySelectorAll('.temporal-plot-metric')).toHaveLength(0);
    expect(rendered.querySelectorAll('.temporal-plot-point')).toHaveLength(2);
    expect(rendered.querySelector('.chart-legend')?.textContent).toContain('github/gh-aw');
    expect(rendered.querySelector('.chart-legend-dot')).not.toBeNull();
    expect(rendered.querySelector('.chart-legend')?.textContent).toContain('githubnext/gh-aw-cao');
    expect(rendered.textContent).toContain('2repositories');
    expect(rendered.textContent).toContain('campaign rollups are omitted');
  });

  it('renders incompatible native units on separate metric plots', () => {
    const rows = [{
      metric: 'optimization-token-optimizer.aic-per-successful-run',
      'operational-value-name': 'AI Credit per successful run',
      'operational-value-unit': 'aic-per-run',
      'operational-value-direction': 'decrease',
      'maturity-status': 'matured',
      'evaluation-mode': 'attainment-only',
      'workflow-name': 'Optimization / Token Optimizer',
      points: [
        { x: '2026-09-23T00:00:00Z', y: 16.25, color: 'githubnext/gh-aw-cao' },
        { x: '2026-09-24T00:00:00Z', y: 14.75, color: 'githubnext/gh-aw-cao' }
      ]
    }, {
      metric: 'optimization-token-optimizer.failure-rate-percent',
      'operational-value-name': 'Failure rate',
      'operational-value-unit': 'percent',
      'operational-value-direction': 'decrease',
      'maturity-status': 'matured',
      'evaluation-mode': 'attainment-only',
      'workflow-name': 'Optimization / Token Optimizer',
      points: [
        { x: '2026-09-23T00:00:00Z', y: 4.5, color: 'githubnext/gh-aw-cao' },
        { x: '2026-09-24T00:00:00Z', y: 3.5, color: 'githubnext/gh-aw-cao' }
      ]
    }];
    const rendered = renderMeasureHistory({
      title: 'Repository operational value',
      sourceNames: ['value-series'],
      sources: {
        'value-series': { source: 'value-series', metadata, rows }
      },
      elementConfig: { 'measure-source': 'operational-value' },
      pageId: 'test-page',
      contextDetails: [],
      headingTag: 'h3'
    });

    expect(rendered.querySelectorAll('.temporal-metric-plot')).toHaveLength(2);
    expect(rendered.querySelectorAll('.temporal-plot-point')).toHaveLength(4);
    expect(rendered.textContent).toContain('Lower is better');
    expect(rendered.textContent).toContain('14.75AIC/run/day');
    expect(rendered.textContent).toContain('3.5pp/day');
  });

  it('toggles an operational-grader chart point selection and its readout on repeated activation', () => {
    const rendered = renderMeasureHistory({
      title: 'Package operational grader',
      sourceNames: ['value-series'],
      sources: {
        'value-series': {
          source: 'value-series',
          metadata,
          rows: [{
            metric: 'sample-grader.primary',
            'metric-name': 'sample-grader.primary',
            'metric-kind': 'primary',
            points: [
              { x: '2026-09-23T00:00:00Z', y: 12, color: 'gh-aw', key: 'primary:0' },
              { x: '2026-09-24T00:00:00Z', y: 18, color: 'gh-aw', key: 'primary:1' }
            ]
          }]
        }
      },
      pageId: 'test-page',
      contextDetails: [],
      headingTag: 'h3'
    });

    const readout = rendered.querySelector('.insights-point-readout');
    expect(readout?.textContent).toBe('Select a point to inspect that observation.');

    const marks = [...rendered.querySelectorAll('.chart-point[data-chart-point-key]')];
    expect(marks.length).toBeGreaterThan(0);
    const [firstMark, secondMark] = marks;

    firstMark.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(firstMark.getAttribute('aria-pressed')).toBe('true');
    expect(firstMark.getAttribute('data-selected')).toBe('true');
    expect(readout?.textContent).toContain('12');

    if (secondMark) {
      secondMark.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
      expect(firstMark.getAttribute('aria-pressed')).toBe('false');
      expect(firstMark.hasAttribute('data-selected')).toBe(false);
      expect(secondMark.getAttribute('aria-pressed')).toBe('true');
      expect(readout?.textContent).toContain('18');
    }

    // Re-activating the pressed mark clears the selection back to the prompt.
    const pressedMark = secondMark ?? firstMark;
    pressedMark.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(pressedMark.getAttribute('aria-pressed')).toBe('false');
    expect(readout?.textContent).toBe('Select a point to inspect that observation.');
  });
});
