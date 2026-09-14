// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderLazyInfiniteList } from '../../src/components/lazy-infinite-list.js';

describe('lazy infinite list', () => {
  afterEach(() => {
    document.body.replaceChildren();
    vi.unstubAllGlobals();
  });

  it('renders a bounded batch and loads the next batch at the boundary', () => {
    let intersect = () => {};
    class IntersectionObserverStub {
      /** @param {IntersectionObserverCallback} callback */
      constructor(callback) {
        intersect = () => callback(
          /** @type {IntersectionObserverEntry[]} */ (/** @type {unknown} */ ([{ isIntersecting: true }])),
          /** @type {IntersectionObserver} */ (/** @type {unknown} */ (this))
        );
      }
      disconnect() {}
      observe() {}
    }
    vi.stubGlobal('IntersectionObserver', IntersectionObserverStub);

    const rendered = renderLazyInfiniteList({
      items: () => Array.from({ length: 50 }, (_, index) => index),
      batchSize: 10,
      renderItems: (items) => items.map((item) => {
        const element = document.createElement('span');
        element.className = 'lazy-item';
        element.textContent = String(item);
        return element;
      }),
      renderEmpty: () => document.createElement('p')
    }).element;
    document.body.append(rendered);

    expect(rendered.querySelectorAll('.lazy-item')).toHaveLength(10);
    intersect();
    expect(rendered.querySelectorAll('.lazy-item')).toHaveLength(20);
    expect(rendered.textContent).toContain('Showing 20 of 50');
  });

  it('reflects newly available items when loadMore runs after items() grows', () => {
    let currentLength = 15;
    let clickLoadMore = () => {};

    const rendered = renderLazyInfiniteList({
      items: () => Array.from({ length: currentLength }, (_, index) => index),
      batchSize: 10,
      renderItems: (items) => items.map((item) => {
        const element = document.createElement('span');
        element.className = 'lazy-item';
        element.textContent = String(item);
        return element;
      }),
      renderEmpty: () => document.createElement('p')
    }).element;
    document.body.append(rendered);
    clickLoadMore = () => rendered.querySelector('button')?.dispatchEvent(new Event('click', { bubbles: true }));

    expect(rendered.querySelectorAll('.lazy-item')).toHaveLength(10);

    // Items grow between the initial render and the loadMore click, e.g. new
    // notifications arriving. renderedLimit must reflect the current item
    // count, not the count captured when the boundary was first rendered.
    currentLength = 50;
    clickLoadMore();

    expect(rendered.querySelectorAll('.lazy-item')).toHaveLength(20);
    expect(rendered.textContent).toContain('Showing 20 of 50');
  });

  it('renders the empty state without observing a boundary', () => {
    const renderEmpty = vi.fn(() => document.createElement('p'));
    const rendered = renderLazyInfiniteList({
      items: () => [],
      batchSize: 10,
      renderItems: () => [],
      renderEmpty
    }).element;

    expect(renderEmpty).toHaveBeenCalledOnce();
    expect(rendered.querySelector('p')).not.toBeNull();
  });
});
