// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { renderMeasureHistory } from '../../src/components/measure-history.js';

const metadata = {
  'source-id': 'operational-value-fixture',
  'source-kind': 'fixture',
  'as-of': '2026-09-24T20:56:21Z',
  'retrieved-at': '2026-09-24T20:57:00Z',
  completeness: /** @type {'complete'} */ ('complete'),
  freshness: /** @type {'fresh'} */ ('fresh'),
  availability: /** @type {'available'} */ ('available')
};

describe('Measure history', () => {
  it('marks interim repository operational value as dubious', () => {
    const rendered = renderMeasureHistory({
      title: 'Repository operational value',
      sourceNames: ['value-series', 'campaign-runs'],
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
        'campaign-runs': {
          source: 'campaign-runs',
          metadata,
          rows: [
            { 'started-at': '2026-09-18T12:00:00Z', status: 'success' },
            { 'started-at': '2026-09-20T12:00:00Z', status: 'failure' }
          ]
        }
      },
      elementConfig: { 'measure-source': 'operational-value' },
      pageId: 'test-page',
      contextDetails: [],
      headingTag: 'h3'
    });

    expect(rendered.querySelector('h2')?.textContent).toBe('Repository operational-value history');
    expect(rendered.querySelector('.insights-dubious-flag')?.textContent).toContain('Dubious');
    expect(rendered.querySelector('.insights-dubious-flag .status')?.textContent).toBe('interim');
    expect(rendered.textContent).toContain('Interim evidence remains visible and marked dubious');
    expect(rendered.querySelector('.temporal-plot-title')?.textContent)
      .toBe('Optimization / Token Optimizer value over time');
    expect(rendered.querySelector('[data-chart-temporal-marker="2026-09-15T23:30:36Z"]')).not.toBeNull();
    expect(rendered.textContent).toContain('Workflow adopted');
    expect(rendered.textContent).toContain('Pre-adoption baseline');
    expect(rendered.textContent).toContain('Post-adoption history');
    expect(rendered.querySelectorAll('.temporal-plot-run-success')).toHaveLength(2);
    expect(rendered.querySelectorAll('.temporal-plot-run-failure')).toHaveLength(2);
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
    expect(rendered.querySelector('[data-temporal-metric^="optimization-token-optimizer.recommendation-acceptance-share"]'))
      .not.toBeNull();
    expect(rendered.textContent).toContain('Recommendation acceptance share');
    expect(rendered.textContent).toContain('Post-adoption attainment');
  });
});
