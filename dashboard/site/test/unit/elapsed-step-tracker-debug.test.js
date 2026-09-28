import { afterEach, describe, expect, it, vi } from 'vitest';

afterEach(() => {
  vi.doUnmock('../../src/debug.js');
  vi.resetModules();
});

describe('elapsed step tracker debug logging', () => {
  it('is disabled by default (no debug output) when the debug query is absent', async () => {
    const output = { debug: vi.fn() };
    vi.doMock('../../src/debug.js', async () => {
      const actual = /** @type {typeof import('../../src/debug.js')} */ (
        await vi.importActual('../../src/debug.js')
      );
      return {
        ...actual,
        createDebug: (/** @type {string} */ category) => actual.createDebug(category, { search: () => '', output })
      };
    });
    vi.resetModules();
    const { createElapsedStepTracker } = await import('../../src/elapsed-step-tracker.js');

    const tracker = createElapsedStepTracker('Preparing...', { now: () => 0 });
    tracker.advance('Parsing...');
    tracker.update('Storing...', 'storing');

    expect(output.debug).not.toHaveBeenCalled();
  });

  it('logs creation and phase transitions under its predictable category when enabled', async () => {
    const output = { debug: vi.fn() };
    vi.doMock('../../src/debug.js', async () => {
      const actual = /** @type {typeof import('../../src/debug.js')} */ (
        await vi.importActual('../../src/debug.js')
      );
      return {
        ...actual,
        createDebug: (/** @type {string} */ category) =>
          actual.createDebug(category, { search: () => '?debug=elapsed-step-tracker', output })
      };
    });
    vi.resetModules();
    const { createElapsedStepTracker } = await import('../../src/elapsed-step-tracker.js');

    const tracker = createElapsedStepTracker('Preparing...', { historyLimit: 2, now: () => 0 });

    expect(output.debug).toHaveBeenCalledWith(
      '[cao:elapsed-step-tracker]',
      { event: 'created', phase: 'initial', historyLimit: 2 }
    );

    tracker.advance('Parsing...');
    expect(output.debug).toHaveBeenCalledWith(
      '[cao:elapsed-step-tracker]',
      { event: 'phase-transition', previousPhase: 'initial', phase: 'step-1', historyLength: 1, truncated: false }
    );

    tracker.update('Storing...', 'storing');
    expect(output.debug).toHaveBeenCalledWith(
      '[cao:elapsed-step-tracker]',
      { event: 'phase-transition', previousPhase: 'step-1', phase: 'storing', historyLength: 2, truncated: false }
    );

    tracker.advance('Finalizing...');
    expect(output.debug).toHaveBeenCalledWith(
      '[cao:elapsed-step-tracker]',
      { event: 'phase-transition', previousPhase: 'storing', phase: 'step-2', historyLength: 2, truncated: true }
    );
  });

  it('never logs step or history message text, only scalar phase and count metadata', async () => {
    const output = { debug: vi.fn() };
    vi.doMock('../../src/debug.js', async () => {
      const actual = /** @type {typeof import('../../src/debug.js')} */ (
        await vi.importActual('../../src/debug.js')
      );
      return {
        ...actual,
        createDebug: (/** @type {string} */ category) =>
          actual.createDebug(category, { search: () => '?debug=elapsed-step-tracker', output })
      };
    });
    vi.resetModules();
    const { createElapsedStepTracker } = await import('../../src/elapsed-step-tracker.js');

    const tracker = createElapsedStepTracker('Preparing sensitive-token-value...', { now: () => 0 });
    tracker.advance('Parsing user-content-goes-here...');
    tracker.update('Storing more-secret-data...', 'storing');

    for (const call of output.debug.mock.calls) {
      const [, payload] = call;
      for (const value of Object.values(payload)) {
        expect(typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean').toBe(true);
      }
      expect(JSON.stringify(payload)).not.toMatch(/preparing|parsing|storing sensitive|user-content|secret/i);
    }
  });
});
