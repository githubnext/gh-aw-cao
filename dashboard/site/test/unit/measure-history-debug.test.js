// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';

afterEach(() => {
  document.body.replaceChildren();
  vi.doUnmock('../../src/debug.js');
  vi.resetModules();
});

const metadata = {
  'source-id': 'operational-grader-fixture',
  'source-kind': 'fixture',
  'as-of': '2026-09-24T20:56:21Z',
  'retrieved-at': '2026-09-24T20:57:00Z',
  completeness: /** @type {'complete'} */ ('complete'),
  freshness: /** @type {'fresh'} */ ('fresh'),
  availability: /** @type {'available'} */ ('available')
};

/** @param {Record<string, unknown>[]} rows */
function graderContext(rows) {
  return {
    title: 'Measure history',
    sourceNames: ['measure-series'],
    sources: {
      'measure-series': { source: 'measure-series', metadata, rows }
    },
    elementConfig: {},
    pageId: 'test-page',
    contextDetails: [],
    headingTag: /** @type {'h3'} */ ('h3')
  };
}

async function mockedDebug(search = '') {
  const output = { debug: vi.fn() };
  vi.doMock('../../src/debug.js', async () => {
    const actual = /** @type {typeof import('../../src/debug.js')} */ (
      await vi.importActual('../../src/debug.js')
    );
    return {
      ...actual,
      createDebug: (/** @type {string} */ category) => actual.createDebug(category, { search: () => search, output })
    };
  });
  vi.resetModules();
  return output;
}

describe('measure history debug logging', () => {
  it('is disabled by default (no debug output) when the debug query is absent', async () => {
    const output = await mockedDebug('');
    const { renderMeasureHistory } = await import('../../src/components/measure-history.js');

    renderMeasureHistory(graderContext([]));

    expect(output.debug).not.toHaveBeenCalled();
  });

  it('logs an empty status with the measure source and a zero count when no metrics are observed', async () => {
    const output = await mockedDebug('?debug=measure-history');
    const { renderMeasureHistory } = await import('../../src/components/measure-history.js');

    renderMeasureHistory(graderContext([]));

    expect(output.debug).toHaveBeenCalledWith(
      '[cao:measure-history]',
      { measureSource: 'operational-grader', metricCount: 0, status: 'empty' }
    );
  });

  it('logs a rendered status with the metric count under its predictable category when enabled', async () => {
    const output = await mockedDebug('?debug=measure-history');
    const { renderMeasureHistory } = await import('../../src/components/measure-history.js');

    renderMeasureHistory(graderContext([{
      metric: 'sample-metric',
      'metric-name': 'Sample metric',
      'metric-kind': 'primary',
      points: [{ x: '2026-09-15T23:30:36Z', y: 1, color: 'gh-aw', key: 'primary:0' }]
    }]));

    expect(output.debug).toHaveBeenCalledWith(
      '[cao:measure-history]',
      { measureSource: 'operational-grader', metricCount: 1, status: 'rendered' }
    );
  });

  it('logs point selection and deselection as booleans, excluding raw point values', async () => {
    const output = await mockedDebug('?debug=measure-history');
    const { renderMeasureHistory } = await import('../../src/components/measure-history.js');

    const rendered = renderMeasureHistory(graderContext([{
      metric: 'sample-metric',
      'metric-name': 'Sample metric',
      'metric-kind': 'primary',
      points: [
        { x: '2026-09-15T23:30:36Z', y: 1, color: 'gh-aw', key: 'primary:0' },
        { x: '2026-09-20T23:30:36Z', y: 2, color: 'gh-aw', key: 'primary:1' }
      ]
    }]));
    document.body.append(rendered);

    const mark = rendered.querySelector('[data-chart-point-key]');
    expect(mark).not.toBeNull();
    output.debug.mockClear();

    mark?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(output.debug).toHaveBeenCalledWith('[cao:measure-history]', { event: 'point-selection', selected: true });

    output.debug.mockClear();
    mark?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(output.debug).toHaveBeenCalledWith('[cao:measure-history]', { event: 'point-selection', selected: false });

    for (const call of output.debug.mock.calls) {
      const [, payload] = call;
      for (const value of Object.values(payload)) {
        expect(typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean').toBe(true);
      }
    }
  });
});
