// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';

afterEach(() => {
  document.body.replaceChildren();
  vi.doUnmock('../../src/debug.js');
  vi.resetModules();
});

describe('dom reconciler debug logging', () => {
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
    const { reconcileChildren } = await import('../../src/dom-reconciler.js');

    const current = document.createElement('main');
    current.append(document.createElement('span'));
    const desired = document.createDocumentFragment();
    desired.append(document.createElement('p'));

    reconcileChildren(current, desired);

    expect(output.debug).not.toHaveBeenCalled();
  });

  it('logs reused, inserted, and removed child counts under its predictable category when enabled', async () => {
    const output = { debug: vi.fn() };
    vi.doMock('../../src/debug.js', async () => {
      const actual = /** @type {typeof import('../../src/debug.js')} */ (
        await vi.importActual('../../src/debug.js')
      );
      return {
        ...actual,
        createDebug: (/** @type {string} */ category) =>
          actual.createDebug(category, { search: () => '?debug=dom-reconciler', output })
      };
    });
    vi.resetModules();
    const { reconcileChildren } = await import('../../src/dom-reconciler.js');

    const current = document.createElement('main');
    const kept = document.createElement('span');
    kept.id = 'kept';
    const dropped = document.createElement('span');
    dropped.id = 'dropped';
    current.append(kept, dropped);

    const desired = document.createDocumentFragment();
    const keptDesired = document.createElement('span');
    keptDesired.id = 'kept';
    const added = document.createElement('p');
    desired.append(keptDesired, added);

    reconcileChildren(current, desired);

    expect(output.debug).toHaveBeenCalledTimes(1);
    expect(output.debug).toHaveBeenCalledWith(
      '[cao:dom-reconciler]',
      expect.objectContaining({ reused: 1, inserted: 1, removed: 1, durationMs: expect.any(Number) })
    );
  });

  it('logs once per top-level call regardless of nested descendant reconciliation', async () => {
    const output = { debug: vi.fn() };
    vi.doMock('../../src/debug.js', async () => {
      const actual = /** @type {typeof import('../../src/debug.js')} */ (
        await vi.importActual('../../src/debug.js')
      );
      return {
        ...actual,
        createDebug: (/** @type {string} */ category) =>
          actual.createDebug(category, { search: () => '?debug=dom-reconciler', output })
      };
    });
    vi.resetModules();
    const { reconcileChildren } = await import('../../src/dom-reconciler.js');

    const current = document.createElement('main');
    const currentChild = document.createElement('div');
    currentChild.id = 'nested';
    currentChild.append(document.createElement('span'), document.createElement('span'));
    current.append(currentChild);

    const desired = document.createDocumentFragment();
    const desiredChild = document.createElement('div');
    desiredChild.id = 'nested';
    desiredChild.append(document.createElement('span'), document.createElement('span'), document.createElement('span'));
    desired.append(desiredChild);

    reconcileChildren(current, desired);

    expect(output.debug).toHaveBeenCalledTimes(1);
    for (const call of output.debug.mock.calls) {
      const [, payload] = call;
      for (const value of Object.values(payload)) {
        expect(typeof value === 'string' || typeof value === 'number').toBe(true);
      }
    }
  });
});
