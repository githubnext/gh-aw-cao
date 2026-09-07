// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderNotificationsInbox } from '../../src/components/notifications-inbox.js';

/** @param {number} count */
function notifications(count) {
  return Array.from({ length: count }, (_, index) => ({
    'attention-signal-id': `signal-${index}`,
    'age-seconds': index,
    'consequence-tier': 'high',
    'expected-actor': 'operator',
    'signal-type': 'runtime-failure',
    objective: `Investigate failure ${index}`,
    reason: `Run ${index} failed`,
    scope: `githubnext/repository-${index}`
  }));
}

describe('notifications inbox large data', () => {
  afterEach(() => {
    document.body.replaceChildren();
    vi.unstubAllGlobals();
  });

  it('keeps initial notification DOM proportional to the viewport', () => {
    Object.defineProperty(window, 'innerHeight', { configurable: true, value: 640 });

    const rendered = renderNotificationsInbox(notifications(5_000));
    document.body.append(rendered);

    expect(rendered.querySelector('.notifications-result-count')?.textContent).toBe('5000 notifications');
    expect(rendered.querySelectorAll('.notification-item').length).toBeGreaterThan(0);
    expect(rendered.querySelectorAll('.notification-item').length).toBeLessThanOrEqual(24);
    expect(rendered.querySelector('[data-notifications-load-boundary]')).not.toBeNull();
  });

  it('loads another bounded batch when the list boundary approaches the viewport', () => {
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
      /** @param {Element} _target */
      observe(_target) {}
    }
    vi.stubGlobal('IntersectionObserver', IntersectionObserverStub);
    Object.defineProperty(window, 'innerHeight', { configurable: true, value: 640 });

    const rendered = renderNotificationsInbox(notifications(5_000));
    document.body.append(rendered);
    const initialCount = rendered.querySelectorAll('.notification-item').length;
    intersect();

    expect(rendered.querySelectorAll('.notification-item').length).toBeGreaterThan(initialCount);
    expect(rendered.querySelectorAll('.notification-item').length).toBeLessThanOrEqual(initialCount * 2);
    expect(rendered.querySelector('[data-notifications-load-boundary]')?.textContent).toContain(`Showing ${initialCount * 2} of 5000`);
  });

  it('resets the render window when filtering a large result set', () => {
    Object.defineProperty(window, 'innerHeight', { configurable: true, value: 640 });
    const rendered = renderNotificationsInbox(notifications(5_000));
    document.body.append(rendered);
    const search = rendered.querySelector('[aria-label="Filter notifications"]');

    if (search instanceof HTMLInputElement) {
      search.value = 'failure 4999';
      search.dispatchEvent(new Event('input'));
    }

    expect(rendered.querySelectorAll('.notification-item')).toHaveLength(1);
    expect(rendered.querySelector('.notifications-result-count')?.textContent).toBe('1 notification');
    expect(rendered.querySelector('[data-notifications-load-boundary]')).toBeNull();
  });
});