// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { h } from '../../src/dom.js';
import { renderViewportCollection } from '../../src/components/viewport-collection.js';
import { renderNotificationsInbox } from '../../src/components/notifications-inbox.js';

/** @type {TestIntersectionObserver[]} */
const observers = [];
/** @type {TestResizeObserver[]} */
const resizeObservers = [];
/** @type {FrameRequestCallback[]} */
const frames = [];

class TestIntersectionObserver {
  /** @param {IntersectionObserverCallback} callback */
  constructor(callback) {
    this.callback = callback;
    observers.push(this);
  }

  observe() {}
  disconnect() {}
}

class TestResizeObserver {
  /** @param {ResizeObserverCallback} callback */
  constructor(callback) {
    this.callback = callback;
    resizeObservers.push(this);
  }

  observe() {}
  disconnect() {}
}

function enableObservers() {
  vi.stubGlobal('IntersectionObserver', TestIntersectionObserver);
  vi.stubGlobal('ResizeObserver', TestResizeObserver);
  vi.stubGlobal('requestAnimationFrame', (/** @type {FrameRequestCallback} */ callback) => {
    frames.push(callback);
    return frames.length;
  });
  vi.stubGlobal('cancelAnimationFrame', () => {});
}

function flushFrame() {
  const callback = frames.shift();
  callback?.(0);
}

afterEach(() => {
  document.body.replaceChildren();
  observers.length = 0;
  resizeObservers.length = 0;
  frames.length = 0;
  vi.unstubAllGlobals();
});

describe('renderViewportCollection', () => {
  it('keeps a batched, measured window in the DOM while scrolling', async () => {
    enableObservers();
    const list = renderViewportCollection({
      items: Array.from({ length: 1_000 }, (_, index) => index),
      key: (item) => String(item),
      renderItem: (item) => h('li', null, `Row ${item}`),
      estimatedItemSize: 50
    });
    document.body.append(list);
    await Promise.resolve();

    expect(list.querySelectorAll('[data-viewport-index]')).toHaveLength(40);
    expect(list.children.length).toBe(42);
    expect(observers).toHaveLength(1);

    vi.spyOn(list, 'getBoundingClientRect').mockReturnValue(/** @type {DOMRect} */ ({
      top: -5_000, bottom: 45_000, left: 0, right: 100, width: 100, height: 50_000,
      x: 0, y: -5_000, toJSON: () => ({})
    }));
    window.dispatchEvent(new Event('scroll'));
    flushFrame();

    expect(list.querySelector('[data-viewport-index]')?.getAttribute('data-viewport-index')).toBe('80');
    expect(list.querySelectorAll('[data-viewport-index]').length).toBeLessThanOrEqual(60);
    expect(list.children.length).toBeLessThanOrEqual(62);
  });

  it('preserves semantic table rows and exposes full row positions', async () => {
    enableObservers();
    const body = renderViewportCollection({
      items: Array.from({ length: 100 }, (_, index) => index),
      key: (item) => String(item),
      renderItem: (item) => h('tr', null, h('td', null, String(item))),
      tagName: 'tbody',
      colSpan: 1
    });

    const table = h('table', null, h('thead', null, h('tr', null, h('th', null, 'Value'))), body);
    document.body.append(table);
    await Promise.resolve();

    expect(table.getAttribute('aria-rowcount')).toBe('101');
    expect(body.querySelectorAll(':scope > tr')).toHaveLength(42);
    expect(body.querySelector('[data-viewport-index="0"]')?.getAttribute('aria-rowindex')).toBe('2');
    expect(body.querySelectorAll('.viewport-spacer[aria-hidden="true"]')).toHaveLength(2);
  });

  it('does not steal focus after a focused row is unloaded', async () => {
    enableObservers();
    const list = renderViewportCollection({
      items: Array.from({ length: 1_000 }, (_, index) => index),
      key: (item) => String(item),
      renderItem: (item) => h('li', null, h('button', null, `Row ${item}`)),
      estimatedItemSize: 50
    });
    const outside = h('button', null, 'Outside');
    document.body.append(list, outside);
    await Promise.resolve();

    /** @type {HTMLButtonElement} */ (list.querySelector('button')).focus();
    vi.spyOn(list, 'getBoundingClientRect').mockReturnValue(/** @type {DOMRect} */ ({
      top: -5_000, bottom: 45_000, left: 0, right: 100, width: 100, height: 50_000,
      x: 0, y: -5_000, toJSON: () => ({})
    }));
    window.dispatchEvent(new Event('scroll'));
    flushFrame();
    expect(document.activeElement).toBe(list);

    outside.focus();
    window.dispatchEvent(new Event('scroll'));
    flushFrame();
    expect(document.activeElement).toBe(outside);
  });

  it('bounds the overview notification DOM for large inboxes', async () => {
    enableObservers();
    const rows = Array.from({ length: 250 }, (_, index) => ({
      'attention-signal-id': `signal-${index}`,
      'signal-type': 'authority-gate',
      objective: `Notification ${index}`,
      scope: `github/repository-${index}`,
      reason: `Reason ${index}`,
      'consequence-tier': 'high',
      priority: 1,
      'age-seconds': index
    }));
    const inbox = renderNotificationsInbox(rows);
    document.body.append(inbox);
    await Promise.resolve();

    expect(inbox.querySelector('.notifications-result-count')?.textContent).toBe('250 notifications');
    expect(inbox.querySelectorAll('.notification-item')).toHaveLength(40);
    expect(inbox.querySelectorAll('.viewport-spacer')).toHaveLength(2);
  });
});
