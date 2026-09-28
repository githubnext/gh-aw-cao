// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';

afterEach(() => {
  document.body.replaceChildren();
  vi.doUnmock('../../src/debug.js');
  vi.resetModules();
  vi.unstubAllGlobals();
});

/** Stubs `IntersectionObserver` so `observeLoadMoreBoundary` can attach without a real browser. */
function stubIntersectionObserver() {
  class IntersectionObserverStub {
    disconnect() {}
    observe() {}
  }
  vi.stubGlobal('IntersectionObserver', IntersectionObserverStub);
}

function renderItemsAsSpans(/** @type {number[]} */ items) {
  return items.map((item) => {
    const element = document.createElement('span');
    element.className = 'lazy-item';
    element.textContent = String(item);
    return element;
  });
}

describe('lazy infinite list debug logging', () => {
  it('is disabled by default (no debug output) when the debug query is absent', async () => {
    stubIntersectionObserver();
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
    const { renderLazyInfiniteList } = await import('../../src/components/lazy-infinite-list.js');

    const rendered = renderLazyInfiniteList({
      items: () => Array.from({ length: 50 }, (_, index) => index),
      batchSize: 10,
      renderItems: renderItemsAsSpans,
      renderEmpty: () => document.createElement('p')
    }).element;
    document.body.append(rendered);
    rendered.querySelector('button')?.dispatchEvent(new Event('click', { bubbles: true }));

    expect(output.debug).not.toHaveBeenCalled();
  });

  it('logs a boundary-observed event with rendered and remaining counts under its predictable category', async () => {
    stubIntersectionObserver();
    const output = { debug: vi.fn() };
    vi.doMock('../../src/debug.js', async () => {
      const actual = /** @type {typeof import('../../src/debug.js')} */ (
        await vi.importActual('../../src/debug.js')
      );
      return {
        ...actual,
        createDebug: (/** @type {string} */ category) =>
          actual.createDebug(category, { search: () => '?debug=lazy-infinite-list', output })
      };
    });
    vi.resetModules();
    const { renderLazyInfiniteList } = await import('../../src/components/lazy-infinite-list.js');

    const rendered = renderLazyInfiniteList({
      items: () => Array.from({ length: 50 }, (_, index) => index),
      batchSize: 10,
      renderItems: renderItemsAsSpans,
      renderEmpty: () => document.createElement('p')
    }).element;
    document.body.append(rendered);

    expect(output.debug).toHaveBeenCalledWith(
      '[cao:lazy-infinite-list]',
      { event: 'boundary-observed', rendered: 10, remaining: 40 }
    );
  });

  it('logs a load-more event with the updated rendered limit and total when the boundary fires', async () => {
    stubIntersectionObserver();
    const output = { debug: vi.fn() };
    vi.doMock('../../src/debug.js', async () => {
      const actual = /** @type {typeof import('../../src/debug.js')} */ (
        await vi.importActual('../../src/debug.js')
      );
      return {
        ...actual,
        createDebug: (/** @type {string} */ category) =>
          actual.createDebug(category, { search: () => '?debug=lazy-infinite-list', output })
      };
    });
    vi.resetModules();
    const { renderLazyInfiniteList } = await import('../../src/components/lazy-infinite-list.js');

    const rendered = renderLazyInfiniteList({
      items: () => Array.from({ length: 50 }, (_, index) => index),
      batchSize: 10,
      renderItems: renderItemsAsSpans,
      renderEmpty: () => document.createElement('p')
    }).element;
    document.body.append(rendered);
    output.debug.mockClear();

    rendered.querySelector('button')?.dispatchEvent(new Event('click', { bubbles: true }));

    expect(output.debug).toHaveBeenCalledWith(
      '[cao:lazy-infinite-list]',
      { event: 'load-more', renderedLimit: 20, total: 50 }
    );
  });

  it('logs an empty event with no other metadata when there are no items', async () => {
    stubIntersectionObserver();
    const output = { debug: vi.fn() };
    vi.doMock('../../src/debug.js', async () => {
      const actual = /** @type {typeof import('../../src/debug.js')} */ (
        await vi.importActual('../../src/debug.js')
      );
      return {
        ...actual,
        createDebug: (/** @type {string} */ category) =>
          actual.createDebug(category, { search: () => '?debug=lazy-infinite-list', output })
      };
    });
    vi.resetModules();
    const { renderLazyInfiniteList } = await import('../../src/components/lazy-infinite-list.js');

    renderLazyInfiniteList({
      items: () => [],
      batchSize: 10,
      renderItems: () => [],
      renderEmpty: () => document.createElement('p')
    });

    expect(output.debug).toHaveBeenCalledWith('[cao:lazy-infinite-list]', { event: 'empty' });
    for (const call of output.debug.mock.calls) {
      const [, payload] = call;
      for (const value of Object.values(payload)) {
        expect(typeof value === 'string' || typeof value === 'number').toBe(true);
      }
    }
  });
});
