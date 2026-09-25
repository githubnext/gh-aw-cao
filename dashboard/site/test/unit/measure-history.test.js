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
      sourceNames: ['value-series'],
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
    expect(rendered.textContent).toContain('provisional lower bounds, not verified attainment');
    expect(rendered.querySelector('h3')?.textContent).toBe('Verified opportunity share');
    expect(rendered.querySelector('[data-chart-temporal-marker="2026-09-15T23:30:36Z"] text')?.textContent)
      .toBe('Workflow adopted');
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
    expect(rendered.querySelector('[data-metric-kind="diagnostic"] h3')?.textContent)
      .toBe('Recommendation acceptance share');
  });
});
