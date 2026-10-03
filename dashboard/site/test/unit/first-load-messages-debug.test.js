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

describe('first-load message picker debug logging', () => {
  it('is disabled by default (no debug output) when the debug query is absent', async () => {
    const debugFn = vi.fn();
    mockDebugModule(debugFn, '');
    const { createFirstLoadMessagePicker } = await import('../../src/components/first-load-messages.js');

    const next = createFirstLoadMessagePicker();
    next();

    expect(debugFn).not.toHaveBeenCalled();
  });

  it('logs picker-created once and cycle-reshuffled for each exhausted deck under its predictable category', async () => {
    const debugFn = vi.fn();
    mockDebugModule(debugFn, '?debug=first-load-messages');
    const {
      createFirstLoadMessagePicker,
      FIRST_LOAD_MESSAGES
    } = await import('../../src/components/first-load-messages.js');

    const next = createFirstLoadMessagePicker();
    expect(debugFn).toHaveBeenCalledWith(
      '[cao:first-load-messages]',
      { event: 'picker-created', messageCount: FIRST_LOAD_MESSAGES.length }
    );
    debugFn.mockClear();

    for (let index = 0; index < FIRST_LOAD_MESSAGES.length; index += 1) next();
    expect(debugFn).toHaveBeenCalledTimes(1);
    expect(debugFn).toHaveBeenCalledWith('[cao:first-load-messages]', { event: 'cycle-reshuffled', cycleCount: 1 });

    debugFn.mockClear();
    next();
    expect(debugFn).toHaveBeenCalledWith('[cao:first-load-messages]', { event: 'cycle-reshuffled', cycleCount: 2 });
  });

  it('is enabled by the wildcard debug query', async () => {
    const debugFn = vi.fn();
    mockDebugModule(debugFn, '?debug=*');
    const { createFirstLoadMessagePicker } = await import('../../src/components/first-load-messages.js');

    createFirstLoadMessagePicker();

    expect(debugFn).toHaveBeenCalled();
  });

  it('never logs message text, only scalar metadata', async () => {
    const debugFn = vi.fn();
    mockDebugModule(debugFn, '?debug=first-load-messages');
    const { createFirstLoadMessagePicker, FIRST_LOAD_MESSAGES } = await import('../../src/components/first-load-messages.js');

    const next = createFirstLoadMessagePicker();
    for (let index = 0; index < FIRST_LOAD_MESSAGES.length + 1; index += 1) next();

    for (const call of debugFn.mock.calls) {
      const [, payload] = call;
      for (const value of Object.values(payload)) {
        expect(value === null || typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean').toBe(true);
        expect(FIRST_LOAD_MESSAGES.includes(/** @type {string} */ (value))).toBe(false);
      }
    }
  });

  it('still returns every message exactly once per cycle regardless of debug status', async () => {
    const debugFn = vi.fn();
    mockDebugModule(debugFn, '');
    const { createFirstLoadMessagePicker, FIRST_LOAD_MESSAGES } = await import('../../src/components/first-load-messages.js');

    const next = createFirstLoadMessagePicker();
    const seen = new Set();
    for (let index = 0; index < FIRST_LOAD_MESSAGES.length; index += 1) seen.add(next());

    expect(seen.size).toBe(FIRST_LOAD_MESSAGES.length);
  });
});
