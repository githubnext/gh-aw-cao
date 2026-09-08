// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { chartSeriesClassName, groupChartSeries, listChartSeries, pieChartEntries, renderChartLegend, renderChartWidget, renderPieLegend } from '../../src/components/chart-elements.js';

describe('chart element helpers', () => {
  it('DLS-SAFE-009 groups chart series deterministically and lists reusable class names', () => {
    const points = [
      { x: '2026-08-29', y: 3, color: 'fail' },
      { x: '2026-08-28', y: 2, color: 'pass' },
      { x: '2026-08-30', y: 1, color: 'fail' },
      { x: '2026-08-27', y: 4, color: null }
    ];

    expect(groupChartSeries(points)).toEqual([
      ['fail', [points[0], points[2]]],
      ['pass', [points[1]]],
      ['value', [points[3]]]
    ]);
    expect(listChartSeries(points)).toEqual([
      { name: 'fail', className: 'chart-series-1 chart-series-semantic-failure' },
      { name: 'pass', className: 'chart-series-2 chart-series-semantic-success' },
      { name: 'value', className: 'chart-series-3' }
    ]);

    const expandedSeries = Array.from({ length: 13 }, (_, index) => ({
      x: String(index),
      y: index,
      color: `series-${String(index).padStart(2, '0')}`
    }));
    expect(listChartSeries(expandedSeries).map(({ className }) => className)).toEqual([
      'chart-series-1',
      'chart-series-2',
      'chart-series-3',
      'chart-series-4',
      'chart-series-5',
      'chart-series-6',
      'chart-series-7',
      'chart-series-8',
      'chart-series-9',
      'chart-series-10',
      'chart-series-11',
      'chart-series-12',
      'chart-series-1'
    ]);
  });

  it('assigns color-blind-safe semantic colors before falling back to the palette', () => {
    expect(chartSeriesClassName('startup-failure', 0)).toBe('chart-series-1 chart-series-semantic-failure');
    expect(chartSeriesClassName('timed_out', 1)).toBe('chart-series-2 chart-series-semantic-failure');
    expect(chartSeriesClassName('Success', 2)).toBe('chart-series-3 chart-series-semantic-success');
    expect(chartSeriesClassName('waiting for approval', 3)).toBe('chart-series-4 chart-series-semantic-waiting');
    expect(chartSeriesClassName('action_required', 4)).toBe('chart-series-5 chart-series-semantic-waiting');
    expect(chartSeriesClassName('in-progress', 5)).toBe('chart-series-6 chart-series-semantic-waiting');
    expect(chartSeriesClassName('cancelled', 6)).toBe('chart-series-7 chart-series-semantic-attention');
    expect(chartSeriesClassName('skipped', 7)).toBe('chart-series-8 chart-series-semantic-neutral');
    expect(chartSeriesClassName('repository', 8)).toBe('chart-series-9');
  });

  it('DLS-SAFE-009 renders reusable visual chart legends', () => {
    const legend = renderChartLegend([
      { name: 'fail', className: 'chart-series-1' },
      { name: 'pass', className: 'chart-series-2' }
    ], 'line');

    expect(legend.className).toBe('chart-legend chart-legend-line');
    expect(legend.getAttribute('data-chart-legend')).toBe('visual');
    expect(legend.querySelectorAll('li')).toHaveLength(2);
    expect(legend.textContent).toContain('fail');
    expect(legend.textContent).toContain('pass');
  });

  it('explains scatter chart scale guides in the legend', () => {
    const legend = renderChartLegend([
      { name: 'core · app · max 5000', className: 'chart-series-1' }
    ], 'scatter');

    expect(legend.querySelectorAll('li')).toHaveLength(2);
    expect(legend.querySelector('li:last-child i')?.className).toBe('chart-grid-key');
    expect(legend.querySelector('li:last-child')?.textContent).toBe('Dashed lines show scale guides');
  });

  it('DLS-SAFE-009 summarizes pie-chart entries and omits non-positive totals', () => {
    const summary = pieChartEntries([
      { x: 'open', y: 3, color: null },
      { x: 'closed', y: 0, color: null },
      { x: 'open', y: 2, color: null },
      { x: 'missing', y: -1, color: null }
    ]);

    expect(summary).toEqual({
      entries: [['open', 5]],
      total: 5
    });
  });

  it('DLS-SAFE-009 renders reusable pie legends including zero-total fallback percentages', () => {
    const links = new Map([['open', {
      href: 'https://github.com/octo-org/open',
      label: 'View octo-org/open on GitHub'
    }]]);
    const populated = renderPieLegend([
      ['open', 3],
      ['closed', 2]
    ], 5, links);
    const empty = renderPieLegend([], 0);

    expect(populated.className).toBe('chart-legend chart-legend-pie');
    expect(populated.querySelectorAll('li')).toHaveLength(2);
    expect(populated.textContent).toContain('open');
    expect(populated.textContent).toContain('3');
    expect(populated.textContent).toContain('60.0%');
    expect(populated.querySelector('a')?.getAttribute('href')).toBe('https://github.com/octo-org/open');
    expect(populated.querySelector('a')?.getAttribute('aria-label')).toBe('View octo-org/open on GitHub');
    expect(empty.querySelectorAll('li')).toHaveLength(0);

    const expanded = renderPieLegend(
      Array.from({ length: 12 }, (_, index) => [`category-${index}`, index + 1]),
      78
    );
    expect(expanded.querySelector('li:last-child i')?.className).toBe('chart-series-12');

    const semantic = renderPieLegend([
      ['failure', 1],
      ['success', 2],
      ['waiting for approval', 3]
    ], 6);
    expect(semantic.querySelector('li:nth-child(1) i')?.classList.contains('chart-series-semantic-failure')).toBe(true);
    expect(semantic.querySelector('li:nth-child(2) i')?.classList.contains('chart-series-semantic-success')).toBe(true);
    expect(semantic.querySelector('li:nth-child(3) i')?.classList.contains('chart-series-semantic-waiting')).toBe(true);
  });

  it('distinguishes missing chart data from an insufficient sample', () => {
    for (const chartType of ['bar', 'histogram', 'line', 'pie', 'scatter']) {
      const chart = renderChartWidget(chartType, [], []);

      expect(chart.getAttribute('data-chart-widget')).toBe(chartType);
      expect(chart.querySelector('svg')).toBeNull();
      expect(chart.querySelector('[role="status"]')?.textContent).toBe('No data is available for this visualization.');
    }

    const point = [{ x: 'only', y: 1, color: null }];
    for (const chartType of ['bar', 'histogram', 'line']) {
      const chart = renderChartWidget(chartType, point, listChartSeries(point));
      expect(chart.querySelector('[role="status"]')?.textContent).toBe('Not enough data to show this visualization.');
    }
  });

  it('renders a single-category pie distribution', () => {
    const singleCategoryPie = renderChartWidget('pie', [
      { x: 'only', y: 1, color: null },
      { x: 'only', y: 2, color: null }
    ], []);
    expect(singleCategoryPie.querySelector('[role="status"]')).toBeNull();
    expect(singleCategoryPie.querySelector('svg')).not.toBeNull();
    expect(singleCategoryPie.querySelector('[data-chart-category="only"]')).not.toBeNull();
    expect(singleCategoryPie.querySelector('.pie-chart-total-value')?.textContent).toBe('3');
  });

  it('renders compact heatmaps as accessible labeled tables without relying on color', () => {
    const chart = renderChartWidget('heatmap', [
      { x: 'build', y: 62, color: 'ubuntu', source: {} },
      { x: 'test', y: 125, color: 'ubuntu', source: {} },
      { x: 'build', y: 80, color: 'macos', source: {} }
    ], [], null, 'Mean job time', {
      name: 'Seconds',
      symbol: 's',
      significant: 1
    });

    expect(chart.getAttribute('data-chart-widget')).toBe('heatmap');
    expect(chart.querySelector('.heatmap-chart caption')?.textContent).toBe('Heatmap of Mean job time');
    expect([...chart.querySelectorAll('thead th')].map((cell) => cell.textContent)).toEqual(['build', 'test']);
    expect([...chart.querySelectorAll('tbody th')].map((cell) => cell.textContent)).toEqual(['macos', 'ubuntu']);
    expect(chart.querySelectorAll('.heatmap-cell')).toHaveLength(4);
    expect([...chart.querySelectorAll('.heatmap-cell[tabindex="0"]')].map((cell) => cell.getAttribute('aria-label'))).toContain('build, ubuntu, Mean job time: 62 s');
    expect(chart.querySelector('.heatmap-cell-empty')?.getAttribute('aria-label')).toBe('test, macos: no observation');
    expect(chart.querySelector('.heatmap-cell-empty')?.getAttribute('tabindex')).toBe('0');
    expect([...chart.querySelectorAll('.heatmap-cell[tabindex="0"]')].map((cell) => cell.textContent)).toContain('62 s');
  });

  it('rejects oversized heatmaps with a visible status instead of rendering a dense matrix', () => {
    const points = Array.from({ length: 13 }, (_, index) => ({
      x: `job-${index}`,
      y: index,
      color: 'ubuntu'
    }));
    const chart = renderChartWidget('heatmap', points, []);

    expect(chart.querySelector('.heatmap-chart')).toBeNull();
    expect(chart.querySelector('[role="status"]')?.textContent).toContain('12 categories per axis');
  });

  it('renders categorical workflow runs as accessible swimlanes without connecting marks', () => {
    const points = [
      {
        x: '2026-08-28T08:00:00Z',
        y: Number.NaN,
        category: 'action-required',
        color: 'action-required',
        source: { run: '1840', 'started-at': '2026-08-28T08:00:00Z', 'ended-at': '2026-08-28T08:03:18Z' }
      },
      {
        x: '2026-08-29T12:48:37Z',
        y: Number.NaN,
        category: 'failure',
        color: 'failure',
        source: { run: '1842', 'started-at': '2026-08-29T12:48:37Z', 'ended-at': '2026-08-29T12:51:55Z', branch: 'main' }
      },
      { x: '2026-08-30T08:00:00Z', y: Number.NaN, category: 'cancelled', color: 'cancelled', source: {} },
      { x: '2026-08-30T12:00:00Z', y: Number.NaN, category: 'skipped', color: 'skipped', source: {} },
      { x: '2026-08-31T08:00:00Z', y: Number.NaN, category: 'success', color: 'success', source: {} }
    ];
    const chart = renderChartWidget(
      'swimlane',
      points,
      listChartSeries(points),
      null,
      'Total',
      null,
      { start: '2026-08-28T00:00:00Z', end: '2026-09-01T00:00:00Z' }
    );

    expect(chart.getAttribute('data-chart-widget')).toBe('swimlane');
    expect(chart.querySelectorAll('.swimlane-label')).toHaveLength(5);
    expect([...chart.querySelectorAll('.swimlane-label')].map((label) => label.textContent)).toEqual([
      'Action required',
      'Failure',
      'Cancelled',
      'Skipped',
      'Success'
    ]);
    expect(chart.querySelectorAll('.swimlane-mark')).toHaveLength(5);
    expect(chart.querySelector('polyline')).toBeNull();
    expect(chart.querySelector('.swimlane-summary')?.textContent).toContain('5 runs');
    expect(chart.querySelector('.swimlane-summary')?.textContent).toContain('20.0% success');
    expect(chart.querySelector('.swimlane-mark-failure')?.getAttribute('aria-label')).toContain('Conclusion: failure');
    expect(chart.querySelector('.swimlane-mark-failure')?.getAttribute('aria-label')).toContain('Run #1842');
    expect(chart.querySelector('.swimlane-mark-failure')?.getAttribute('aria-label')).toContain('Branch: main');
    expect(chart.querySelector('.swimlane-mark-failure')?.getAttribute('aria-label')).toContain('Duration: 3m 18s');
    expect(chart.querySelectorAll('.swimlane-mark > *')).toHaveLength(0);
    expect(chart.querySelector('[data-chart-axis="swimlane"]')).toBeNull();
    expect(chart.textContent).toContain('Aug 28');
  });

  it('renders 100,000 swimlane observations as bounded line intervals', () => {
    const start = Date.parse('2026-08-01T00:00:00Z');
    const points = Array.from({ length: 100_000 }, (_, index) => {
      const lane = ['success', 'failure', 'skipped', 'cancelled', 'action-required'][index % 5];
      return {
        x: new Date(start + index).toISOString(),
        y: Number.NaN,
        category: lane,
        color: lane,
        source: { run: String(index) }
      };
    });
    const startedAt = performance.now();
    const chart = renderChartWidget('swimlane', points, [], null, 'Total', null, {
      start: new Date(start).toISOString(),
      end: new Date(start + points.length).toISOString()
    });
    const elapsedMilliseconds = performance.now() - startedAt;
    const marks = chart.querySelectorAll('.swimlane-mark');

    expect(elapsedMilliseconds).toBeLessThan(1_000);
    expect(marks).toHaveLength(5);
    expect(chart.querySelectorAll('svg *').length).toBeLessThan(30);
    expect([...marks].every((mark) => mark.tagName === 'line')).toBe(true);
    expect(marks[0].getAttribute('data-swimlane-count')).toBe('20000');
    expect(marks[0].getAttribute('aria-label')).toContain('20,000 action-required runs');
  });

  it('renders one swimlane observation without applying the multi-point chart empty state', () => {
    const chart = renderChartWidget('swimlane', [{
      x: '2026-08-31T12:48:37Z',
      y: Number.NaN,
      category: 'success',
      color: 'success',
      source: { run: '1842' }
    }], []);

    expect(chart.querySelectorAll('.swimlane-mark')).toHaveLength(1);
    expect(chart.querySelector('[role="status"]')).toBeNull();
  });

  it('renders an empty swimlane without invalid timeline dates', () => {
    const chart = renderChartWidget('swimlane', [], []);

    expect(chart.getAttribute('data-chart-widget')).toBe('swimlane');
    expect(chart.querySelector('[role="status"]')?.textContent).toBe('No workflow runs to show.');
    expect(chart.querySelector('svg')).toBeNull();
  });

  it('DLS-VIEW-005 DLS-VIEW-006 DLS-VIEW-007 renders JSON-selected chart marks through one generic helper', () => {
    const points = [
      { x: '2026-08-29', y: 3, color: 'success' },
      { x: '2026-08-30', y: 1, color: 'failure' }
    ];
    const series = listChartSeries(points);

    const bar = renderChartWidget('bar', [...points, { x: 'invalid', y: Number.NaN, color: null }], series);
    const line = renderChartWidget('line', points, series);
    const pie = renderChartWidget('pie', points, series);
    const histogram = renderChartWidget('histogram', [
      { x: 'run-1', y: 3, color: null },
      { x: 'run-2', y: 6, color: null },
      { x: 'run-3', y: 9, color: null },
      { x: 'run-4', y: 9, color: null }
    ], series, null, 'AIC per run', {
      name: 'AI Credits',
      symbol: 'AIC',
      significant: 1
    });
    const unitPie = renderChartWidget('pie', points, series, null, 'Total', {
      name: 'AI Credits',
      symbol: 'AIC',
      significant: 1
    });
    const fullPie = renderChartWidget('pie', [], [], {
      entries: [['success', 4], ['failure', 0]],
      total: 4
    });
    const chartHeight = String(38 - 4);

    expect(bar.getAttribute('data-chart-widget')).toBe('bar');
    expect(bar.querySelectorAll('.bar-chart-bar')).toHaveLength(3);
    expect(bar.querySelector('.bar-chart-bar')?.getAttribute('height')).toBe(chartHeight);
    expect(bar.querySelector('.bar-chart-bar')?.getAttribute('rx')).toBe('0.75');
    expect(bar.querySelector('.bar-chart-bar')?.getAttribute('style')).toContain('--chart-entry-index: 0');
    expect([...bar.querySelectorAll('.bar-chart-bar')].at(-1)?.getAttribute('height')).toBe('1');
    expect([...bar.querySelectorAll('.bar-chart-y-axis text')].map((tick) => tick.textContent)).toEqual(['3', '1.50', '0']);
    expect([...bar.querySelectorAll('.bar-chart-x-axis text')].map((tick) => tick.lastChild?.textContent)).toEqual([
      'Aug 29',
      'Aug 30',
      'invalid'
    ]);
    expect(bar.querySelectorAll('.bar-chart-grid')).toHaveLength(3);
    expect(bar.querySelector('[data-chart-axis="x"]')).not.toBeNull();
    expect(bar.querySelector('[data-chart-axis="y"]')).not.toBeNull();
    expect(line.getAttribute('data-chart-widget')).toBe('line');
    expect(line.querySelectorAll('.line-chart-series')).toHaveLength(2);
    expect(line.querySelector('.line-chart-series')?.getAttribute('pathLength')).toBe('1');
    expect(line.querySelector('.line-chart-series')?.getAttribute('style')).toContain('--chart-entry-index: 0');
    expect(line.querySelector('.line-chart-point')?.getAttribute('style')).toContain('--chart-point-size: 6px');
    expect(line.querySelector('.chart-point')?.getAttribute('style')).toContain('--chart-entry-index: 0');
    expect([...line.querySelectorAll('.timeline-chart-axis span')].map((tick) => tick.textContent)).toEqual([
      'Aug 29',
      'Aug 30'
    ]);
    expect(pie.getAttribute('data-chart-widget')).toBe('pie');
    expect(pie.querySelectorAll('.pie-chart-segment')).toHaveLength(2);
    expect(pie.querySelector('.pie-chart-mark')?.getAttribute('style')).toContain('--chart-entry-index: 0');
    expect(pie.querySelector('.pie-chart-track')?.getAttribute('stroke-width')).toBe('6');
    expect(pie.querySelector('.pie-chart-segment')?.tagName).toBe('path');
    expect(pie.querySelector('.pie-chart-segment')?.getAttribute('stroke-width')).toBe('6');
    expect(pie.querySelector('.pie-chart-segment')?.getAttribute('stroke-linecap')).toBe('round');
    expect([...pie.querySelectorAll('.pie-chart-segment')].map((segment) => segment.getAttribute('d'))).toEqual([
      'M 23.9823 5.3664 A 15.9155 15.9155 0 1 1 5.3664 23.9823',
      'M 5.3664 18.0177 A 15.9155 15.9155 0 0 1 18.0177 5.3664'
    ]);
    expect(pie.querySelector('.pie-chart-segment')?.hasAttribute('stroke-dasharray')).toBe(false);
    expect(pie.querySelectorAll('.pie-chart-mark .point-tooltip')).toHaveLength(2);
    expect(pie.querySelector('.pie-chart-mark')?.getAttribute('aria-label')).toBe('2026-08-29: 3');
    expect(pie.querySelector('.pie-chart-tooltip rect')?.getAttribute('width')).toBe('21.25');
    const firstPieMark = pie.querySelector('.pie-chart-mark');
    firstPieMark?.dispatchEvent(new Event('pointerenter'));
    expect(pie.querySelector('.pie-chart-mark:last-child')).toBe(firstPieMark);
    expect(histogram.getAttribute('data-chart-widget')).toBe('histogram');
    expect(histogram.querySelectorAll('.histogram-chart-bar')).toHaveLength(3);
    expect(histogram.querySelector('.histogram-chart-mark')?.getAttribute('style')).toContain('--chart-entry-index: 0');
    expect(histogram.querySelectorAll('.histogram-chart-mark .point-tooltip')).toHaveLength(3);
    expect(histogram.querySelectorAll('.histogram-chart-grid')).toHaveLength(3);
    expect([...histogram.querySelectorAll('.histogram-chart-y-label')].map((tick) => tick.textContent)).toEqual([
      '2',
      '1',
      '0'
    ]);
    expect([...histogram.querySelectorAll('[data-chart-axis="histogram"] span')].map((tick) => tick.textContent)).toEqual([
      '3 AIC',
      '5 AIC',
      '7 AIC',
      '9 AIC'
    ]);
    expect(histogram.querySelector('.histogram-chart-bar')?.classList.contains('chart-series-1')).toBe(true);
    expect(histogram.querySelector('.histogram-chart-bar')?.getAttribute('rx')).toBe('0.75');
    expect(histogram.querySelector('.histogram-chart-tooltip text')?.getAttribute('lengthAdjust')).toBe('spacingAndGlyphs');
    expect(histogram.querySelector('svg')?.getAttribute('aria-label')).toContain('automatically calculated bins');
    expect(histogram.querySelector('.histogram-chart-mark')?.getAttribute('aria-label')).toContain('AIC');
    const firstHistogramMark = histogram.querySelector('.histogram-chart-mark');
    firstHistogramMark?.dispatchEvent(new Event('pointerenter'));
    expect(histogram.querySelector('.histogram-chart-mark:last-child')).toBe(firstHistogramMark);
    expect(unitPie.querySelector('.pie-chart-mark')?.getAttribute('aria-label')).toBe('2026-08-29: 3 AIC');
    expect(unitPie.querySelector('.pie-chart-total-value')?.textContent).toBe('4');
    const fullPieSegments = fullPie.querySelectorAll('.pie-chart-segment');
    expect(fullPieSegments[0]?.getAttribute('d')?.match(/ A /g)).toHaveLength(2);
    expect(fullPieSegments[1]?.getAttribute('d')).toBe('M 21 5.0845');
  });

  it('renders temporal dot observations with per-series reference lines', () => {
    const points = [
      { x: '2026-09-04T10:00:00Z', y: 4_900, color: 'core', source: { limit: 5_000 } },
      { x: '2026-09-04T11:00:00Z', y: 4_875, color: 'core', source: { limit: 5_000 } },
      { x: '2026-09-04T11:00:00Z', y: 28, color: 'search', source: { limit: 30 } }
    ];
    const dot = renderChartWidget('dot', points, listChartSeries(points), null, 'Remaining', null, null, 'limit');

    expect(dot.getAttribute('data-chart-widget')).toBe('dot');
    expect(dot.querySelectorAll('.dot-chart-point')).toHaveLength(3);
    expect(dot.querySelectorAll('.dot-chart-reference')).toHaveLength(2);
    expect(dot.querySelector('[data-chart-reference="core"]')?.getAttribute('data-chart-reference-value')).toBe('5000');
    expect(dot.querySelector('.line-chart-series')).toBeNull();
    expect(dot.querySelector('svg')?.getAttribute('aria-label')).toBe('Dot chart with 3 points and 2 reference lines');
  });

  it('renders temporal scatter observations at proportional timestamps without connecting them', () => {
    const points = [
      { x: '2026-09-04T10:00:00Z', y: 98, color: 'max 5000' },
      { x: '2026-09-04T11:00:00Z', y: 50, color: 'max 5000' },
      { x: '2026-09-04T14:00:00Z', y: 10, color: 'max 30' }
    ];
    const scatter = renderChartWidget('scatter', points, listChartSeries(points), null, 'Remaining', {
      name: 'Percent',
      symbol: '%',
      significant: 0.1
    });
    const xCoordinates = [...scatter.querySelectorAll('.scatter-chart-point')]
      .map((point) => Number(point.getAttribute('cx')))
      .sort((left, right) => left - right);

    expect(scatter.getAttribute('data-chart-widget')).toBe('scatter');
    expect(xCoordinates).toEqual([0, 25, 100]);
    expect([...scatter.querySelectorAll('.timeline-chart-axis span')].map((tick) => tick.getAttribute('title'))).toEqual([
      '2026-09-04T10:00:00.000Z',
      '2026-09-04T12:00:00.000Z',
      '2026-09-04T14:00:00.000Z'
    ]);
    expect(scatter.querySelector('.line-chart-series')).toBeNull();
    expect(scatter.querySelector('svg')?.getAttribute('aria-label')).toBe('Scatter chart with 3 points');
  });

  it('exposes scatter cluster sizes in accessible point labels', () => {
    const scatter = renderChartWidget('scatter', [{
      x: '2026-09-04T10:00:00Z',
      y: 72,
      color: 'max 5000',
      source: { 'cluster-count': 250 }
    }], [{ name: 'max 5000', className: 'chart-series-1' }], null, 'Remaining', {
      name: 'Percent',
      symbol: '%',
      significant: 0.1
    });

    expect(scatter.querySelector('.chart-point')?.getAttribute('aria-label')).toContain('cluster of 250 observations');
  });

  it('dims historical line context and emphasizes the selected window', () => {
    const points = [
      { x: '2026-09-03T10:00:00Z', y: 2, color: 'worker', highlighted: false },
      { x: '2026-09-04T10:00:00Z', y: 3, color: 'worker', highlighted: true },
      { x: '2026-09-04T11:00:00Z', y: 4, color: 'worker', highlighted: true }
    ];
    const line = renderChartWidget('line', points, listChartSeries(points));

    expect(line.querySelector('.line-chart-context')).not.toBeNull();
    expect(Number(line.querySelector('.line-chart-window-band')?.getAttribute('width'))).toBeGreaterThan(0);
    expect(line.querySelector('.line-chart-current')?.getAttribute('points')).not.toBe('');
    expect(line.querySelectorAll('.chart-point-context')).toHaveLength(1);
    expect(line.querySelector('.chart-point-context .line-chart-point')?.getAttribute('style')).toContain('--chart-point-size: 4px');
    expect(line.querySelector('.chart-point-current .line-chart-point')?.getAttribute('style')).toContain('--chart-point-size: 4px');
    expect(line.querySelector('.chart-window-key')?.textContent).toContain('Selected window');
  });

  it('reduces non-scaling line-chart point sizes as the number of points increases', () => {
    /** @param {number} count */
    const renderPoints = (count) => {
      const points = Array.from({ length: count }, (_, index) => ({
        x: String(index),
        y: index,
        color: null
      }));
      return renderChartWidget('line', points, listChartSeries(points));
    };

    expect(renderPoints(2).querySelector('.line-chart-point')?.getAttribute('style')).toContain('--chart-point-size: 6px');
    expect(renderPoints(51).querySelector('.line-chart-point')?.getAttribute('style')).toContain('--chart-point-size: 4px');
    expect(renderPoints(100).querySelector('.line-chart-point')?.getAttribute('style')).toContain('--chart-point-size: 2px');
    expect(renderPoints(150).querySelector('.line-chart-point')?.getAttribute('style')).toContain('--chart-point-size: 2px');
  });

  it('renders 100,000 line-chart points in bounded time and SVG size', () => {
    const points = Array.from({ length: 100_000 }, (_, index) => ({
      x: new Date(index * 60_000).toISOString(),
      y: index % 1_000,
      color: null
    }));
    const startedAt = performance.now();
    const chart = renderChartWidget('line', points, listChartSeries(points));
    const elapsedMilliseconds = performance.now() - startedAt;
    const renderedPoints = chart.querySelector('.line-chart-series')?.getAttribute('points')?.split(' ') ?? [];

    expect(elapsedMilliseconds).toBeLessThan(1_000);
    expect(chart.getAttribute('data-line-rendering')).toBe('compact');
    expect(renderedPoints.length).toBeLessThanOrEqual(2_000);
    expect(chart.querySelectorAll('.chart-point')).toHaveLength(0);
    expect(chart.querySelectorAll('svg *').length).toBeLessThan(25);
  });

  it('renders a concise, evenly sampled timeline axis while preserving exact values', () => {
    const points = Array.from({ length: 9 }, (_, index) => ({
      x: `2026-09-0${index + 1}T0${index}:15:00Z`,
      y: index,
      color: null
    }));
    const chart = renderChartWidget('line', points, listChartSeries(points));
    const ticks = [...chart.querySelectorAll('.timeline-chart-axis span')];

    expect(ticks.map((tick) => tick.textContent)).toEqual([
      'Sep 1, 00:15 UTC',
      'Sep 3, 02:15 UTC',
      'Sep 5, 04:15 UTC',
      'Sep 7, 06:15 UTC',
      'Sep 9, 08:15 UTC'
    ]);
    expect(ticks.map((tick) => tick.getAttribute('title'))).toEqual([
      points[0].x,
      points[2].x,
      points[4].x,
      points[6].x,
      points[8].x
    ]);
  });

  it('renders concise, evenly sampled bar axes while preserving exact category values', () => {
    const points = Array.from({ length: 9 }, (_, index) => ({
      x: `category-with-a-long-name-${index + 1}`,
      y: index * 25,
      color: null
    }));
    const chart = renderChartWidget('bar', points, listChartSeries(points), null, 'Total', {
      name: 'AI Credits',
      symbol: 'AIC',
      significant: 1
    });
    const xTicks = [...chart.querySelectorAll('.bar-chart-x-axis text')];

    expect(xTicks).toHaveLength(5);
    expect(xTicks.map((tick) => tick.lastChild?.textContent)).toEqual([
      'category-wi…',
      'category-wi…',
      'category-wi…',
      'category-wi…',
      'category-wi…'
    ]);
    expect(xTicks.map((tick) => tick.getAttribute('title'))).toEqual([
      points[0].x,
      points[2].x,
      points[4].x,
      points[6].x,
      points[8].x
    ]);
    expect([...chart.querySelectorAll('.bar-chart-x-axis text > title')].map((title) => title.textContent)).toEqual([
      points[0].x,
      points[2].x,
      points[4].x,
      points[6].x,
      points[8].x
    ]);
    expect([...chart.querySelectorAll('.bar-chart-y-axis text')].map((tick) => tick.textContent)).toEqual([
      '200 AIC',
      '100 AIC',
      '0 AIC'
    ]);
  });
});
