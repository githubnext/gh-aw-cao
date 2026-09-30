import { afterEach, describe, expect, it, vi } from 'vitest';

afterEach(() => {
  vi.doUnmock('../../src/debug.js');
  vi.resetModules();
});

/**
 * Loads run-classification.js with a stubbed debug output so assertions can
 * inspect emitted metadata without depending on module state left over from
 * other tests.
 * @param {string} search
 */
async function loadRunClassificationWithDebug(search) {
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
  const module = await import('../../src/components/run-classification.js');
  return { ...module, output };
}

describe('run-classification debug logging', () => {
  it('is disabled by default (no debug output) when the debug query is absent', async () => {
    const { isFailureConclusion, isApprovalConclusion, classifyUtilizationRatio, output } =
      await loadRunClassificationWithDebug('');

    isFailureConclusion('failure');
    isApprovalConclusion('action-required');
    classifyUtilizationRatio(0.9);

    expect(output.debug).not.toHaveBeenCalled();
  });

  it('logs conclusion and utilization classification under the predictable category name derived from the filename', async () => {
    const { isFailureConclusion, isApprovalConclusion, classifyUtilizationRatio, output } =
      await loadRunClassificationWithDebug('?debug=run-classification');

    expect(isFailureConclusion('failure')).toBe(true);
    expect(output.debug).toHaveBeenCalledWith('[cao:run-classification]', { event: 'conclusion-classified', kind: 'failure' });

    expect(isApprovalConclusion('action-required')).toBe(true);
    expect(output.debug).toHaveBeenCalledWith('[cao:run-classification]', { event: 'conclusion-classified', kind: 'approval' });

    expect(classifyUtilizationRatio(0.9)).toBe('high');
    expect(output.debug).toHaveBeenCalledWith('[cao:run-classification]', { event: 'utilization-classified', status: 'high' });

    expect(classifyUtilizationRatio(0.2)).toBe('low');
    expect(output.debug).toHaveBeenCalledWith('[cao:run-classification]', { event: 'utilization-classified', status: 'low' });
  });

  it('does not log when a conclusion does not match a failure or approval classification', async () => {
    const { isFailureConclusion, isApprovalConclusion, output } = await loadRunClassificationWithDebug('?debug=run-classification');

    expect(isFailureConclusion('success')).toBe(false);
    expect(isApprovalConclusion('success')).toBe(false);

    expect(output.debug).not.toHaveBeenCalled();
  });

  it('never logs raw conclusion strings or ratios, only scalar metadata with stable keys', async () => {
    const { isFailureConclusion, classifyUtilizationRatio, output } = await loadRunClassificationWithDebug('?debug=run-classification');

    isFailureConclusion('timed-out');
    classifyUtilizationRatio(0.42);

    for (const call of output.debug.mock.calls) {
      const [, payload] = call;
      for (const value of Object.values(payload)) {
        expect(value === null || typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean').toBe(true);
      }
    }
  });
});
