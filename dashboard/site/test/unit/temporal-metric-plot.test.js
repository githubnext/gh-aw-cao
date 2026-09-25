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
          id: 'largest-file-health',
          label: 'Largest-file health',
          points: [
            { x: '2025-10-25T13:36:21Z', y: 0.64 },
            { x: '2025-11-15T13:36:21Z', y: 0.48 },
            { x: '2025-12-06T13:36:21Z', y: 0.38 }
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
      ],
      runs: [
        { createdAt: '2025-11-16T00:00:00Z', conclusion: 'success' },
        { createdAt: '2025-11-17T00:00:00Z', conclusion: 'failure' },
        { createdAt: '2025-11-18T00:00:00Z', conclusion: 'skipped' }
      ]
    });

    expect(rendered.querySelector('svg')?.getAttribute('aria-label'))
      .toBe('Daily File Diet workflow value timeline');
    expect(rendered.querySelectorAll('.temporal-plot-grid')).toHaveLength(8);
    expect(rendered.querySelectorAll('.temporal-plot-metric')).toHaveLength(2);
    expect(rendered.querySelectorAll('.temporal-plot-point')).toHaveLength(5);
    expect(rendered.querySelectorAll('.temporal-plot-legend-line')).toHaveLength(2);
    expect(rendered.querySelectorAll('.temporal-plot-run')).toHaveLength(3);
    expect(rendered.querySelector('.temporal-plot-baseline')).not.toBeNull();
    expect(rendered.querySelector('[data-chart-temporal-marker="2025-11-15T13:36:21Z"]')).not.toBeNull();
    expect(rendered.textContent).toContain('Goal measure');
    expect(rendered.textContent).toContain('Workflow runs');
    expect(rendered.textContent).toContain('Success');
    expect(rendered.textContent).toContain('Failure');
    expect(rendered.textContent).toContain('Other');
  });

  it('renders attainment-only history without a pre-adoption band', () => {
    const rendered = renderTemporalMetricPlot({
      title: 'Optimizer',
      mode: 'attainment-only',
      adoptionAt: '2026-09-15T23:30:36Z',
      metrics: [{
        id: 'verified-share',
        label: 'Verified opportunities',
        points: [
          { x: '2026-09-15T23:30:36Z', y: 0 },
          { x: '2026-09-24T20:56:21Z', y: 0.5 }
        ]
      }]
    });

    expect(rendered.textContent).toContain('Optimizer attainment over time');
    expect(rendered.textContent).toContain('Post-adoption attainment');
    expect(rendered.querySelector('.temporal-plot-baseline')).toBeNull();
  });
});
