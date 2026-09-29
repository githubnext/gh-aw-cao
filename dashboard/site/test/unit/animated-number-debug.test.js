// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';

afterEach(() => {
  vi.doUnmock('../../src/debug.js');
  vi.resetModules();
});

/**
 * Loads animated-number.js with a stubbed debug output so assertions can
 * inspect emitted metadata without depending on module state left over from
 * other tests.
 * @param {string} search
 */
async function loadAnimatedNumberWithDebug(search) {
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
  const module = await import('../../src/components/animated-number.js');
  return { ...module, output };
}

describe('animated-number debug logging', () => {
  it('is disabled by default when the debug query is absent', async () => {
    const { createAnimatedNumber, output } = await loadAnimatedNumberWithDebug('');
    const controller = new AbortController();
    const counter = createAnimatedNumber({ animate: true, signal: controller.signal });

    counter.set({ text: '2', target: 2, href: '#page-runs' });

    expect(output.debug).not.toHaveBeenCalled();
    controller.abort();
  });

  it('logs a predictable created event with the animate flag under its category', async () => {
    const { createAnimatedNumber, output } = await loadAnimatedNumberWithDebug('?debug=animated-number');
    const controller = new AbortController();
    createAnimatedNumber({ animate: true, signal: controller.signal });

    expect(output.debug).toHaveBeenCalledWith('[cao:animated-number]', {
      event: 'created',
      animateEnabled: true
    });
    controller.abort();
  });

  it('logs a set event with whether the update animates and has a link', async () => {
    const { createAnimatedNumber, output } = await loadAnimatedNumberWithDebug('?debug=animated-number');
    const controller = new AbortController();
    const counter = createAnimatedNumber({ animate: true, signal: controller.signal });

    counter.set({ text: '2', target: 2, href: '#page-runs' });

    expect(output.debug).toHaveBeenCalledWith('[cao:animated-number]', {
      event: 'set',
      animated: true,
      hasHref: true
    });
    controller.abort();
  });

  it('logs an unanimated set event when animate is disabled or target is not a safe integer', async () => {
    const { createAnimatedNumber, output } = await loadAnimatedNumberWithDebug('?debug=animated-number');
    const controller = new AbortController();
    const counter = createAnimatedNumber({ signal: controller.signal });

    counter.set({ text: 'Unavailable' });

    expect(output.debug).toHaveBeenCalledWith('[cao:animated-number]', {
      event: 'set',
      animated: false,
      hasHref: false
    });
    controller.abort();
  });

  it('never logs record content, only scalar metadata', async () => {
    const { createAnimatedNumber, output } = await loadAnimatedNumberWithDebug('?debug=animated-number');
    const controller = new AbortController();
    const counter = createAnimatedNumber({ animate: true, signal: controller.signal });

    counter.set({ text: '2', target: 2, href: '#page-runs' });

    for (const call of output.debug.mock.calls) {
      const [, payload] = call;
      for (const value of Object.values(payload)) {
        expect(value === null || typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean').toBe(true);
      }
    }
    controller.abort();
  });
});
