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
  it('labels interim repository operational value without a heading badge', () => {
    const rendered = renderMeasureHistory({
      title: 'Repository operational value',
      sourceNames: [
        'value-series',
        'rollup-series',
        'campaign-run-days',
        'repository-run-days',
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
        'repository-run-days': {
          source: 'repository-run-days',
          metadata,
          rows: [
            {
              repository: 'gh-aw',
              'run-day': '2026-09-18',
              'successful-runs': 8,
              'failed-runs': 2,
              'success-rate-percent': 80,
              'concluded-runs': 10
            },
            {
              repository: 'gh-aw',
              'run-day': '2026-09-20',
              'successful-runs': 4,
              'failed-runs': 4,
              'success-rate-percent': 50,
              'concluded-runs': 8
            }
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
      sourceNames: ['value-series', 'rollup-series'],
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
    expect(rendered.querySelector('[data-temporal-metric^="optimization-token-optimizer.recommendation-acceptance-share"]'))
      .not.toBeNull();
    expect(rendered.textContent).toContain('Recommendation acceptance share');
  });

  it('plots interim evidence with an explicit not-yet-mature state', () => {
    const rendered = renderMeasureHistory({
      title: 'Repository operational value',
      sourceNames: [
        'value-series',
        'rollup-series',
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
    expect(rendered.textContent).toContain('Dashed amber lines are not mature evidence');
    expect(rendered.querySelector('.temporal-metric-plot-provisional')).not.toBeNull();
    expect(rendered.querySelector('.temporal-plot-metric')).not.toBeNull();
    expect(rendered.querySelector('.temporal-metric-plot-provisional')).not.toBeNull();
  });

  it('defaults to a weighted campaign rollup and drills into one repository', () => {
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
    const rollupRows = [{
      ...repositoryRows[0],
      'contributing-repositories': 2,
      points: [{ x: '2026-09-24T00:00:00Z', y: 2 / 3, color: 'Campaign rollup', key: 'rollup' }]
    }];
    const rendered = renderMeasureHistory({
      title: 'Repository operational value',
      sourceNames: ['value-series', 'rollup-series', 'campaign-runs', 'evidence-state'],
      sources: {
        'value-series': { source: 'value-series', metadata, rows: repositoryRows },
        'rollup-series': { source: 'rollup-series', metadata, rows: rollupRows },
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

    const selector = /** @type {HTMLSelectElement} */ (
      rendered.querySelector('[aria-label="Operational value repository scope"]')
    );
    expect(selector.value).toBe('campaign-rollup');
    expect([...selector.options].map((option) => option.textContent)).toEqual([
      'Campaign rollup',
      'github/gh-aw',
      'githubnext/gh-aw-cao'
    ]);
    expect(rendered.querySelector('[data-operational-value-scope="campaign-rollup"]')?.hasAttribute('hidden')).toBe(false);
    expect(rendered.querySelector('.operational-value-scope-status')?.textContent)
      .toContain('2 repositories · weighted by eligible evidence');

    selector.value = 'repository:github/gh-aw';
    selector.dispatchEvent(new Event('change'));

    expect(rendered.querySelector('[data-operational-value-scope="campaign-rollup"]')?.hasAttribute('hidden')).toBe(true);
    expect(rendered.querySelector('[data-operational-value-scope="repository:github/gh-aw"]')?.hasAttribute('hidden')).toBe(false);
    expect(rendered.querySelector('.operational-value-scope-status')?.textContent)
      .toContain('github/gh-aw');
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
      sourceNames: ['value-series', 'rollup-series'],
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
    expect(rendered.textContent).toContain('14.75AIC/run');
    expect(rendered.textContent).toContain('3.5%');
  });
});
