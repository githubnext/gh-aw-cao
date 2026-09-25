// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { renderTemporalMetricPlot } from '../../src/components/temporal-metric-plot.js';

describe('Temporal metric plot', () => {
  it('matches the deterministic timeline SVG structure', () => {
    const rendered = renderTemporalMetricPlot({
      title: 'Daily File Diet',
      mode: 'baseline-comparable',
      adoptionAt: '2025-11-15T13:36:21Z',
      metrics: [
        {
          id: 'largest-file-lines',
          label: 'Largest file lines',
          unit: 'lines',
          direction: 'decrease',
          points: [
            { x: '2025-10-25T13:36:21Z', y: 1640 },
            { x: '2025-11-15T13:36:21Z', y: 1480 },
            { x: '2025-12-06T13:36:21Z', y: 1380 }
          ]
        },
        {
          id: 'compliant-line-mass-share',
          label: 'Compliant line mass',
          points: [
            { x: '2025-10-25T13:36:21Z', y: 0.82 },
            { x: '2025-12-06T13:36:21Z', y: 0.91 }
          ]
        }
      ]
    });

    expect(rendered.querySelector('svg')?.getAttribute('aria-label'))
      .toBe('Daily File Diet workflow value timeline');
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
        { date: '2025-11-15', successfulRuns: 8, failedRuns: 2, successRate: 80, concludedRuns: 10 },
        { date: '2025-12-06', successfulRuns: 3, failedRuns: 2, successRate: 60, concludedRuns: 5 }
      ]
    });

    expect(rendered.querySelectorAll('.temporal-plot-run-outcome')).toHaveLength(2);
    expect(rendered.querySelectorAll('.temporal-plot-run-outcome-track')).toHaveLength(1);
    expect(rendered.querySelectorAll('.temporal-plot-run-outcome-success')).toHaveLength(2);
    expect(rendered.querySelectorAll('.temporal-plot-run-outcome-failure')).toHaveLength(2);
    expect(rendered.querySelector('.temporal-plot-success-context polyline')).toBeNull();
    expect([...rendered.querySelectorAll('.temporal-plot-axis')]
      .some((element) => element.textContent === '-0')).toBe(false);
    expect(rendered.querySelector('.temporal-plot-success-axis')).toBeNull();
    expect(rendered.querySelector('.temporal-plot-run-outcome-legend')?.textContent)
      .toBe('Runs: success · failed');
    expect(rendered.querySelector('.temporal-plot-run-outcome title')?.textContent)
      .toBe('2025-11-15: 8 successful, 2 failed (10 concluded)');
    const success = rendered.querySelector('.temporal-plot-run-outcome-success');
    const failure = rendered.querySelector('.temporal-plot-run-outcome-failure');
    expect(Number(success?.getAttribute('x2')) - Number(success?.getAttribute('x1')))
      .toBeGreaterThan(Number(failure?.getAttribute('x2')) - Number(failure?.getAttribute('x1')));
  });
});
