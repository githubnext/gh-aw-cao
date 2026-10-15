// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { renderTemporalMetricPlot } from '../../src/components/temporal-metric-plot.js';
import { chartStyles } from '../../src/styles-charts.js';

describe('Temporal metric plot', () => {
  it('distinguishes retained history from verified coverage, freshness and trend assessment', () => {
    const root = renderTemporalMetricPlot({
      title: 'Retained value', mode: 'baseline-comparable',
      adoptionAt: '2026-09-15T00:00:00Z',
      comparisonNote: 'Comparison unavailable: measurement version was not retained.',
      metrics: [{ id: 'value', label: 'Repository', points: [
        { x: '2026-09-14T00:00:00Z', y: 20 },
        { x: '2026-09-28T00:00:00Z', y: 90 }
      ] }]
    });
    expect(root.textContent).toContain('Retained observations: 2026-09-14 to 2026-09-28 (UTC)');
    expect(root.textContent).toContain('Latest observation is not a live measurement');
    expect(root.textContent).toContain('complete baseline-window coverage is not verified');
    expect(root.textContent).toContain('measurement version was not retained');
    expect(root.textContent).toContain('stored observations do not identify the reason');
    expect(root.textContent).not.toContain('No trend yet');
    const details = root.querySelector('details');
    expect(details?.open).toBe(false);
    expect(details?.querySelector('summary')?.textContent).toBe('Evidence details');
    expect(details?.contains(root.querySelector('.temporal-plot-coverage-note'))).toBe(true);
    expect(root.querySelector('.temporal-plot-trend')?.textContent).toBe('Trend not assessed');
  });

  it('connects consecutive observations separately per series and breaks at missing cadence periods', () => {
    const root = renderTemporalMetricPlot({
      title: 'Native history', mode: 'attainment-only', adoptionAt: '',
      maxGapDays: 1,
      metrics: [
        { id: 'one', label: 'One', points: [
          { x: '2026-09-20T00:00:00Z', y: 4 },
          { x: '2026-09-21T00:00:00Z', y: 3 },
          { x: '2026-09-23T00:00:00Z', y: 2 },
          { x: '2026-09-24T00:00:00Z', y: 1 }
        ] },
        { id: 'two', label: 'Two', points: [
          { x: '2026-09-20T00:00:00Z', y: 8 },
          { x: '2026-09-21T00:00:00Z', y: 7 }
        ] }
      ]
    });
    const lines = [...root.querySelectorAll('polyline')];
    expect(lines).toHaveLength(3);
    expect(lines.map((line) => line.getAttribute('data-temporal-metric'))).toEqual(['one', 'one', 'two']);
    expect(lines.every((line) => line.getAttribute('points')?.split(' ').length === 2)).toBe(true);
    expect(root.querySelectorAll('.temporal-plot-point')).toHaveLength(6);
  });

  it('keeps isolated points disconnected and supports weekly cadence', () => {
    const options = {
      title: 'Weekly', mode: /** @type {const} */ ('attainment-only'), adoptionAt: '',
      metrics: [{ id: 'one', label: 'One', points: [
        { x: '2026-09-01T00:00:00Z', y: 3 },
        { x: '2026-09-08T00:00:00Z', y: 2 },
        { x: '2026-09-22T00:00:00Z', y: 1 }
      ] }]
    };
    expect(renderTemporalMetricPlot({ ...options, maxGapDays: 7 }).querySelectorAll('polyline')).toHaveLength(1);
    expect(renderTemporalMetricPlot({ ...options, maxGapDays: 1 }).querySelectorAll('polyline')).toHaveLength(0);
    expect(renderTemporalMetricPlot({ ...options, connectPoints: false }).querySelectorAll('polyline')).toHaveLength(0);
  });

  it('keeps adoption visible before retained history without inventing baseline points', () => {
    const rendered = renderTemporalMetricPlot({
      title: 'Retained outcome',
      mode: 'baseline-comparable',
      adoptionAt: '2026-09-01T00:00:00Z',
      metrics: [{ id: 'value', label: 'Repository', points: [{ x: '2026-09-23T00:00:00Z', y: 4 }] }],
      outcomes: [{ 'run-day': '2026-09-20', 'successful-runs': 2, 'failed-runs': 1, 'concluded-runs': 3 }]
    });
    expect(rendered.textContent).toContain('Adopted 2026-09-01 (UTC)');
    expect(rendered.textContent).toContain('Baseline unavailable: no retained pre-adoption observations');
    expect(rendered.textContent).toContain('1 observation; trend unavailable');
    expect(rendered.querySelector('[data-chart-temporal-marker]')).not.toBeNull();
    expect(rendered.querySelectorAll('.temporal-plot-point')).toHaveLength(1);
    expect(rendered.querySelectorAll('.temporal-plot-run-outcome')).toHaveLength(1);
  });

  it('counts distinct observation times without claiming a trend from duplicate points', () => {
    const render = (/** @type {string[]} */ times) => renderTemporalMetricPlot({
      title: 'Alerts', mode: 'baseline-comparable', adoptionAt: '2026-09-01T00:00:00Z',
      metrics: [{ id: 'alerts', label: 'Repository', points: times.map((x) => ({ x, y: 4 })) }]
    });
    expect(render(['2026-09-23T00:00:00Z', '2026-09-23T00:00:00Z']).textContent)
      .toContain('1 observation; trend unavailable');
    const history = render(['2026-08-23T00:00:00Z', '2026-09-23T00:00:00Z']);
    expect(history.textContent).toContain('2 observation times');
    expect(history.textContent).toContain('Pre-adoption observations retained; complete baseline-window coverage is not verified');
    expect(history.textContent).not.toContain('Baseline unavailable');
  });

  it('exposes the observation run report in an accessible point tooltip', () => {
    const rendered = renderTemporalMetricPlot({
      title: 'Repository value',
      mode: 'attainment-only',
      adoptionAt: '',
      provisional: true,
      metrics: [{
        id: 'value',
        label: 'githubnext/gh-aw',
        points: [
          { x: '2026-09-22T00:00:00Z', y: 12.5, link: { href: 'https://github.com/githubnext/gh-aw-cao/actions/runs/101', label: 'View run 101' } },
          { x: '2026-09-24T00:00:00Z', y: 8.25 }
        ]
      }]
    });
    const trigger = rendered.querySelector('.temporal-plot-point-trigger');
    const tooltip = rendered.querySelector('[role="tooltip"]');
    expect(trigger?.getAttribute('aria-label')).toContain('12.5');
    expect(trigger?.getAttribute('aria-describedby')).toBe(tooltip?.id);
    expect(tooltip?.textContent).toContain('not yet mature interim observation');
    const link = tooltip?.querySelector('a');
    expect(link?.textContent).toBe('View run report');
    expect(link?.getAttribute('href')).toBe('https://github.com/githubnext/gh-aw-cao/actions/runs/101');
    expect(link?.getAttribute('aria-label')).toBe('View run 101');
    expect(link?.getAttribute('rel')).toBe('noopener noreferrer');
    expect(rendered.querySelectorAll('.temporal-plot-point-tooltip')).toHaveLength(1);
    expect(rendered.querySelectorAll('.temporal-plot-point[tabindex="0"]')).toHaveLength(1);
  });

  it('matches the deterministic timeline SVG structure', () => {
    const rendered = renderTemporalMetricPlot({
      title: 'Example Workflow',
      mode: 'baseline-comparable',
      adoptionAt: '2025-11-15T13:36:21Z',
      metrics: [
        {
          id: 'primary-measure',
          label: 'Primary measure',
          unit: 'count',
          direction: 'decrease',
          points: [
            { x: '2025-10-25T13:36:21Z', y: 1640 },
            { x: '2025-11-15T13:36:21Z', y: 1480 },
            { x: '2025-12-06T13:36:21Z', y: 1380 }
          ]
        },
        {
          id: 'diagnostic-measure',
          label: 'Diagnostic measure',
          points: [
            { x: '2025-10-25T13:36:21Z', y: 0.82 },
            { x: '2025-12-06T13:36:21Z', y: 0.91 }
          ]
        }
      ]
    });

    expect(rendered.querySelector('svg')?.getAttribute('aria-label'))
      .toBe('Example Workflow workflow value timeline');
    expect(rendered.querySelectorAll('.temporal-plot-grid')).toHaveLength(7);
    expect(rendered.querySelectorAll('.temporal-plot-metric')).toHaveLength(2);
    expect(rendered.querySelectorAll('.temporal-plot-point')).toHaveLength(5);
    expect(rendered.querySelector('.temporal-plot-baseline')).not.toBeNull();
    expect(rendered.querySelector('[data-chart-temporal-marker="2025-11-15T13:36:21Z"]')).not.toBeNull();
    expect(rendered.textContent).toContain('native value');
  });

  it('uses a native dynamic axis without clamping values to one', () => {
    const rendered = renderTemporalMetricPlot({
      title: 'Optimizer',
      mode: 'attainment-only',
      adoptionAt: '2026-09-15T23:30:36Z',
      metrics: [{
        id: 'aic-per-successful-run',
        label: 'AI Credit per successful run',
        unit: 'aic-per-run',
        direction: 'decrease',
        points: [
          { x: '2026-09-16T00:00:00Z', y: 12.5 },
          { x: '2026-09-24T00:00:00Z', y: 8.25 }
        ]
      }]
    });

    expect(rendered.textContent).toContain('Lower is better');
    expect(rendered.textContent).toContain('8.25AIC/run');
    expect(rendered.textContent).toContain('12.93');
    const points = [...rendered.querySelectorAll('.temporal-plot-point')];
    expect(points.map((point) => point.getAttribute('cy'))).not.toEqual(['110', '110']);
    expect(points[0]?.getAttribute('aria-label')).toContain('12.5 aic-per-run');
  });

  it('labels intraday observations with UTC times instead of repeating the date', () => {
    const rendered = renderTemporalMetricPlot({
      title: 'Security alerts',
      mode: 'attainment-only',
      adoptionAt: '',
      metrics: [{
        id: 'alerts',
        label: 'Alerts',
        points: [
          { x: '2026-09-29T08:15:00Z', y: 6 },
          { x: '2026-09-29T17:45:00Z', y: 6 }
        ]
      }]
    });

    expect([...rendered.querySelectorAll('.temporal-plot-axis')]
      .map((axis) => axis.textContent).filter((label) => label?.endsWith(' UTC')))
      .toEqual(['08:15 UTC', '17:45 UTC']);
  });

  it('renders attainment-only history without a pre-adoption band', () => {
    const rendered = renderTemporalMetricPlot({
      title: 'Optimizer',
      mode: 'attainment-only',
      adoptionAt: '2026-09-15T23:30:36Z',
      metrics: [{
        id: 'verified-share',
        label: 'Verified opportunities',
        unit: 'percent',
        direction: 'increase',
        points: [
          { x: '2026-09-15T23:30:36Z', y: 0 },
          { x: '2026-09-24T20:56:21Z', y: 0.5 }
        ]
      }]
    });

    expect(rendered.querySelector('.temporal-plot-heading h3')?.textContent).toBe('Optimizer');
    expect(rendered.querySelector('.temporal-plot-baseline')).toBeNull();
  });

  it('marks provisional observations with a not-yet-mature chart state', () => {
    const rendered = renderTemporalMetricPlot({
      title: 'Optimizer',
      mode: 'baseline-comparable',
      adoptionAt: '2026-09-15T23:30:36Z',
      provisional: true,
      metrics: [{
        id: 'guarded-net-gain',
        label: 'Guarded net-gain magnitude',
        unit: 'percent',
        direction: 'increase',
        points: [
          { x: '2026-09-24T20:56:21Z', y: 0 },
          { x: '2026-09-25T13:24:26Z', y: 0 }
        ]
      }]
    });

    expect(rendered.classList.contains('temporal-metric-plot-provisional')).toBe(true);
    expect(rendered.getAttribute('data-maturity-state')).toBe('not-yet-mature');
    expect(rendered.querySelector('svg')?.getAttribute('aria-label'))
      .toBe('Optimizer workflow value timeline, not yet mature');
    expect(rendered.querySelector('.temporal-plot-point')?.getAttribute('aria-label'))
      .toContain('not yet mature interim observation');
  });

  it('renders direction-aware selected-horizon trend metadata', () => {
    const rendered = renderTemporalMetricPlot({
      title: 'Optimizer',
      mode: 'attainment-only',
      adoptionAt: '2026-09-15T23:30:36Z',
      trend: {
        startValue: 12.5,
        endValue: 8.25,
        delta: -4.25,
        relativePercent: -34,
        observedDirection: 'down',
        assessment: 'improving',
        observationCount: 9
      },
      metrics: [{
        id: 'aic-per-successful-run',
        label: 'AI Credit per successful run',
        unit: 'aic-per-run',
        direction: 'decrease',
        points: [
          { x: '2026-09-16T00:00:00Z', y: 12.5 },
          { x: '2026-09-24T00:00:00Z', y: 8.25 }
        ]
      }]
    });

    const trend = rendered.querySelector('.temporal-plot-trend-improving');
    expect(trend?.textContent).toContain('↓Improving-34%');
    expect(trend?.getAttribute('aria-label')).toContain('Improving: down');
    expect(trend?.getAttribute('title')).toContain('-4.25 AIC/run across 9 observations');
  });

  it('renders daily run outcomes as an unconnected success and failure rail', () => {
    const rendered = renderTemporalMetricPlot({
      title: 'Optimizer',
      mode: 'attainment-only',
      adoptionAt: '2025-11-15T00:00:00Z',
      metrics: [{
        id: 'aic-per-successful-run',
        label: 'AI Credit per successful run',
        unit: 'aic-per-run',
        direction: 'decrease',
        points: [
          { x: '2025-11-15T00:00:00Z', y: 12 },
          { x: '2025-12-06T23:59:59Z', y: 9 }
        ]
      }],
      outcomes: [
        { 'run-day': '2025-11-15', 'successful-runs': 8, 'failed-runs': 2, 'concluded-runs': 10 },
        { 'run-day': '2025-12-06', 'successful-runs': 3, 'failed-runs': 2, 'concluded-runs': 5 }
      ]
    });

    expect(rendered.querySelectorAll('.temporal-plot-run-outcome')).toHaveLength(2);
    expect(rendered.querySelectorAll('.temporal-plot-run-outcome-track')).toHaveLength(1);
    expect(rendered.querySelectorAll('.temporal-plot-run-outcome .temporal-plot-run-outcome-success')).toHaveLength(2);
    expect(rendered.querySelectorAll('.temporal-plot-run-outcome .temporal-plot-run-outcome-failure')).toHaveLength(2);
    expect(rendered.querySelectorAll('.temporal-plot-run-outcome .temporal-plot-run-outcome-failure-inset')).toHaveLength(2);
    expect(rendered.querySelector('.temporal-plot-success-context polyline')).toBeNull();
    expect([...rendered.querySelectorAll('.temporal-plot-axis')]
      .some((element) => element.textContent === '-0')).toBe(false);
    expect(rendered.querySelector('.temporal-plot-success-axis')).toBeNull();
    expect(rendered.querySelector('.temporal-plot-run-outcome-legend')?.textContent)
      .toBe('Runs:successfailed');
    expect(rendered.querySelector('.temporal-plot-run-outcome-legend .temporal-plot-run-outcome-success')).not.toBeNull();
    expect(rendered.querySelector('.temporal-plot-run-outcome-legend .temporal-plot-run-outcome-failure-inset')).not.toBeNull();
    expect(rendered.querySelector('svg desc')?.textContent)
      .toContain('solid success and hollow failure segments');
    expect(rendered.querySelector('.temporal-plot-run-outcome title')?.textContent)
      .toBe('2025-11-15: 8 successful, 2 failed (10 concluded)');
    const success = rendered.querySelector('.temporal-plot-run-outcome .temporal-plot-run-outcome-success');
    const failure = rendered.querySelector('.temporal-plot-run-outcome .temporal-plot-run-outcome-failure');
    const failureInset = rendered.querySelector('.temporal-plot-run-outcome .temporal-plot-run-outcome-failure-inset');
    expect(Number(success?.getAttribute('x2')) - Number(success?.getAttribute('x1')))
      .toBeGreaterThan(Number(failure?.getAttribute('x2')) - Number(failure?.getAttribute('x1')));
    expect([failureInset?.getAttribute('x1'), failureInset?.getAttribute('x2')])
      .toEqual([failure?.getAttribute('x1'), failure?.getAttribute('x2')]);
    expect(chartStyles).toContain('.temporal-plot-run-outcome-success { stroke: var(--success); }');
    expect(chartStyles).toContain('.temporal-plot-run-outcome-failure { stroke: var(--danger); }');
    expect(chartStyles).toContain('.temporal-plot-run-outcome-legend-success { fill: var(--success); }');
    expect(chartStyles).toContain('.temporal-plot-run-outcome-legend-failure { fill: var(--danger); }');
    expect(chartStyles).toContain('.temporal-plot-run-outcome-failure-inset { stroke: var(--canvas); stroke-width: 4; }');
    expect(chartStyles).toContain('stroke-width: 10; stroke-linecap: butt; vector-effect: non-scaling-stroke;');
  });
});
