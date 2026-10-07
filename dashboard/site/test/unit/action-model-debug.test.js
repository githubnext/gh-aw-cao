// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';

/**
 * Loads action-model.js with a stubbed debug output so assertions can
 * inspect emitted metadata without depending on module state left over from
 * other tests.
 * @param {string} search
 */
async function loadActionModelWithDebug(search) {
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
  const module = await import('../../src/action-model.js');
  return { ...module, output };
}

afterEach(() => {
  vi.doUnmock('../../src/debug.js');
  vi.resetModules();
});

describe('action-model debug logging', () => {
  it('is disabled by default when the debug query is absent', async () => {
    const { normalizeAction, constrainPrompt, assertActionLevel, output } = await loadActionModelWithDebug('');

    normalizeAction({ level: 'propose' }, { id: 'test', type: 'prompt' });
    constrainPrompt('Investigate', 'explore');
    expect(() => assertActionLevel(/** @type {any} */ ('invalid'), 'cli')).toThrow();

    expect(output.debug).not.toHaveBeenCalled();
  });

  it('logs normalize-action outcomes under its predictable category when enabled', async () => {
    const { normalizeAction, output } = await loadActionModelWithDebug('?debug=action-model');

    normalizeAction({ level: 'propose' }, { id: 'test', type: 'prompt' });
    expect(output.debug).toHaveBeenCalledWith(
      '[cao:action-model]',
      { operation: 'normalize-action', type: 'prompt', level: 'propose', source: 'explicit', explicit: true }
    );

    output.debug.mockClear();
    normalizeAction({}, { id: 'old', type: 'cli' });
    expect(output.debug).toHaveBeenCalledWith(
      '[cao:action-model]',
      { operation: 'normalize-action', type: 'cli', level: 'operate', source: 'explicit', explicit: false }
    );
  });

  it('logs constrain-prompt level selection', async () => {
    const { constrainPrompt, output } = await loadActionModelWithDebug('?debug=action-model');

    constrainPrompt('Investigate', 'explore');
    expect(output.debug).toHaveBeenCalledWith('[cao:action-model]', { operation: 'constrain-prompt', level: 'explore' });
  });

  it('logs assert-action-level rejection reasons without logging on success', async () => {
    const { assertActionLevel, output } = await loadActionModelWithDebug('?debug=action-model');

    assertActionLevel('propose', 'prompt');
    expect(output.debug).not.toHaveBeenCalled();

    expect(() => assertActionLevel(/** @type {any} */ ('not-a-level'), 'cli')).toThrow('Unknown action level');
    expect(output.debug).toHaveBeenCalledWith(
      '[cao:action-model]',
      { operation: 'assert-action-level', status: 'rejected', reason: 'unknown-level', type: 'cli' }
    );

    output.debug.mockClear();
    expect(() => assertActionLevel('ui', 'cli')).toThrow('reserved for native dashboard');
    expect(output.debug).toHaveBeenCalledWith(
      '[cao:action-model]',
      { operation: 'assert-action-level', status: 'rejected', reason: 'ui-reserved', type: 'cli' }
    );
  });

  it('never logs sensitive payload content, only scalar metadata', async () => {
    const { normalizeAction, constrainPrompt, output } = await loadActionModelWithDebug('?debug=action-model');

    normalizeAction({ level: 'operate', command: 'gh aw run', label: 'Secret label' }, { id: 'test', type: 'cli' });
    constrainPrompt('Prompt with user content that must not be logged', 'propose');

    for (const call of output.debug.mock.calls) {
      const [, payload] = call;
      for (const value of Object.values(payload)) {
        expect(typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean').toBe(true);
      }
    }
  });
});
