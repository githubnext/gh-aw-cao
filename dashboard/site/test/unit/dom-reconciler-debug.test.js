// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';

afterEach(() => {
  vi.doUnmock('../../src/debug.js');
  vi.resetModules();
});

/**
 * Loads dom-reconciler.js with a stubbed debug output so assertions can
 * inspect emitted metadata without depending on module state left over from
 * other tests.
 * @param {string} search
 */
async function loadReconcilerWithDebug(search) {
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
  const module = await import('../../src/dom-reconciler.js');
  return { ...module, output };
}

describe('dom-reconciler debug logging', () => {
  it('is disabled by default (no debug output) when the debug query is absent', async () => {
    const { reconcileChildren, output } = await loadReconcilerWithDebug('');

    const current = document.createElement('div');
    current.append(document.createElement('span'));
    const desired = document.createDocumentFragment();
    desired.append(document.createElement('strong'));

    reconcileChildren(current, desired);

    expect(output.debug).not.toHaveBeenCalled();
  });

  it('logs reused/inserted/removed counts and a coarse duration under the predictable category', async () => {
    const { reconcileChildren, output } = await loadReconcilerWithDebug('?debug=dom-reconciler');

    const current = document.createElement('div');
    const kept = document.createElement('span');
    kept.setAttribute('data-key', 'kept');
    const stale = document.createElement('span');
    stale.setAttribute('data-key', 'stale');
    current.append(kept, stale);

    const desired = document.createDocumentFragment();
    const keptAgain = document.createElement('span');
    keptAgain.setAttribute('data-key', 'kept');
    const fresh = document.createElement('span');
    fresh.setAttribute('data-key', 'fresh');
    desired.append(keptAgain, fresh);

    reconcileChildren(current, desired);

    expect(output.debug).toHaveBeenCalledTimes(1);
    const [prefix, payload] = output.debug.mock.calls[0];
    expect(prefix).toBe('[cao:dom-reconciler]');
    expect(payload).toMatchObject({ reused: 1, inserted: 1, removed: 1 });
    expect(typeof payload.durationMs).toBe('number');
    expect(payload.durationMs).toBeGreaterThanOrEqual(0);
  });

  it('logs exactly once per top-level call even when reconciliation recurses into nested children', async () => {
    const { reconcileChildren, output } = await loadReconcilerWithDebug('?debug=dom-reconciler');

    const current = document.createElement('div');
    const currentChild = document.createElement('section');
    currentChild.setAttribute('data-key', 'child');
    currentChild.append(document.createElement('em'));
    current.append(currentChild);

    const desired = document.createDocumentFragment();
    const desiredChild = document.createElement('section');
    desiredChild.setAttribute('data-key', 'child');
    desiredChild.append(document.createElement('em'), document.createElement('b'));
    desired.append(desiredChild);

    reconcileChildren(current, desired);

    expect(output.debug).toHaveBeenCalledTimes(1);
  });

  it('never logs sensitive values such as node content or attribute values', async () => {
    const { reconcileChildren, output } = await loadReconcilerWithDebug('?debug=dom-reconciler');

    const current = document.createElement('div');
    const currentChild = document.createElement('span');
    currentChild.setAttribute('data-secret', 'top-secret-value');
    currentChild.textContent = 'sensitive user content';
    current.append(currentChild);

    const desired = document.createDocumentFragment();
    const desiredChild = document.createElement('span');
    desiredChild.setAttribute('data-secret', 'top-secret-value');
    desiredChild.textContent = 'sensitive user content';
    desired.append(desiredChild);

    reconcileChildren(current, desired);

    expect(output.debug).toHaveBeenCalledTimes(1);
    const [, payload] = output.debug.mock.calls[0];
    expect(Object.keys(payload).sort()).toEqual(['durationMs', 'inserted', 'removed', 'reused']);
    const serialized = JSON.stringify(payload);
    expect(serialized).not.toContain('top-secret-value');
    expect(serialized).not.toContain('sensitive user content');
  });
});
