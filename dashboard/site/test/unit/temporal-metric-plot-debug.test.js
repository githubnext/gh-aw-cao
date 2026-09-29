// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';

afterEach(() => {
  vi.doUnmock('../../src/debug.js');
  vi.resetModules();
});

/**
 * @param {ReturnType<typeof vi.fn>} debugFn
 * @param {string} search
 */
function mockDebugModule(debugFn, search) {
  const output = /** @type {Pick<Console, 'debug'>} */ ({ debug: debugFn });
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
}

const SINGLE_METRIC_OPTIONS = {
  title: 'Example Workflow',
  mode: /** @type {'baseline-comparable'} */ ('baseline-comparable'),
  adoptionAt: '2025-11-15T13:36:21Z',
  metrics: [{
    id: 'primary-measure',
    label: 'Primary measure',
    unit: 'count',
    direction: /** @type {'decrease'} */ ('decrease'),
    points: [
      { x: '2025-10-25T13:36:21Z', y: 1640 },
      { x: '2025-11-15T13:36:21Z', y: 1480 }
    ]
  }],
  outcomes: [
    { date: '2025-10-25', successfulRuns: 4, failedRuns: 1, successRate: 0.8, concludedRuns: 5 },
    { date: '2099-01-01', successfulRuns: 1, failedRuns: 0, successRate: 1, concludedRuns: 1 }
  ]
};

describe('temporal metric plot debug logging', () => {
  it('is disabled by default (no debug output) when the debug query is absent', async () => {
    const debugFn = vi.fn();
    mockDebugModule(debugFn, '');
    const { renderTemporalMetricPlot } = await import('../../src/components/temporal-metric-plot.js');

    renderTemporalMetricPlot(SINGLE_METRIC_OPTIONS);

    expect(debugFn).not.toHaveBeenCalled();
  });

  it('logs render-skipped with a reason when no observations are available', async () => {
    const debugFn = vi.fn();
    mockDebugModule(debugFn, '?debug=temporal-metric-plot');
    const { renderTemporalMetricPlot } = await import('../../src/components/temporal-metric-plot.js');

    renderTemporalMetricPlot({
      title: 'Empty Workflow',
      mode: 'baseline-comparable',
      adoptionAt: '2025-11-15T13:36:21Z',
      metrics: []
    });

    expect(debugFn).toHaveBeenCalledWith('[cao:temporal-metric-plot]', {
      event: 'render-skipped',
      reason: 'no-observations',
      metricCount: 0
    });
  });

  it('logs outcomes-filtered with provided and kept counts', async () => {
    const debugFn = vi.fn();
    mockDebugModule(debugFn, '?debug=temporal-metric-plot');
    const { renderTemporalMetricPlot } = await import('../../src/components/temporal-metric-plot.js');

    renderTemporalMetricPlot(SINGLE_METRIC_OPTIONS);

    expect(debugFn).toHaveBeenCalledWith('[cao:temporal-metric-plot]', {
      event: 'outcomes-filtered',
      providedCount: 2,
      keptCount: 1
    });
  });

  it('logs render-completed with mode, metric count, observation count, and provisional flag', async () => {
    const debugFn = vi.fn();
    mockDebugModule(debugFn, '?debug=temporal-metric-plot');
    const { renderTemporalMetricPlot } = await import('../../src/components/temporal-metric-plot.js');

    renderTemporalMetricPlot({ ...SINGLE_METRIC_OPTIONS, provisional: true });

    expect(debugFn).toHaveBeenCalledWith('[cao:temporal-metric-plot]', {
      event: 'render-completed',
      mode: 'baseline-comparable',
      metricCount: 1,
      observationCount: 2,
      provisional: true
    });
  });

  it('never logs record content, only scalar metadata', async () => {
    const debugFn = vi.fn();
    mockDebugModule(debugFn, '?debug=temporal-metric-plot');
    const { renderTemporalMetricPlot } = await import('../../src/components/temporal-metric-plot.js');

    renderTemporalMetricPlot(SINGLE_METRIC_OPTIONS);

    for (const call of debugFn.mock.calls) {
      const [, payload] = call;
      for (const value of Object.values(payload)) {
        expect(value === null || typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean').toBe(true);
      }
    }
  });
});
