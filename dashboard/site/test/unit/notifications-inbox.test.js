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
    window.localStorage.clear();
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

  it('preserves the current selection when loading another batch', () => {
    Object.defineProperty(window, 'innerHeight', { configurable: true, value: 640 });
    const rendered = renderNotificationsInbox(notifications(5_000));
    document.body.append(rendered);

    const firstCheckbox = rendered.querySelector('.notification-item input[type="checkbox"]');
    if (firstCheckbox instanceof HTMLInputElement) {
      firstCheckbox.checked = true;
      firstCheckbox.dispatchEvent(new Event('change', { bubbles: true }));
    }
    const bulkDone = rendered.querySelector('[aria-label="Mark selected as done"]');
    expect(bulkDone?.hasAttribute('disabled')).toBe(false);

    const loadMoreButton = rendered.querySelector('[data-notifications-load-boundary] button');
    if (loadMoreButton instanceof HTMLButtonElement) loadMoreButton.click();

    const refreshedBulkDone = rendered.querySelector('[aria-label="Mark selected as done"]');
    expect(refreshedBulkDone?.hasAttribute('disabled')).toBe(false);
  });
});

/** @param {Record<string, unknown>} overrides */
function attentionRow(overrides = {}) {
  return {
    'attention-signal-id': 'signal-1',
    'age-seconds': 60,
    'consequence-tier': 'high',
    'expected-actor': 'operator',
    'signal-type': 'runtime-failure',
    objective: 'Investigate failure',
    reason: 'Run failed',
    scope: 'githubnext/repository',
    ...overrides
  };
}

describe('catch up queue', () => {
  afterEach(() => {
    document.body.replaceChildren();
    window.localStorage.clear();
  });

  it('renders a queue of unprocessed stories with Done and Later actions', () => {
    const rendered = renderNotificationsInbox([attentionRow()]);
    document.body.append(rendered);

    const stories = rendered.querySelectorAll('.home-catchup-story');
    expect(stories).toHaveLength(1);
    expect(rendered.querySelector('[aria-label^="Mark as done"]')).not.toBeNull();
    expect(rendered.querySelector('[aria-label^="Save for later"]')).not.toBeNull();
  });

  it('removes a story from the queue once marked done and it does not return after a refresh', () => {
    const rows = [attentionRow()];
    const rendered = renderNotificationsInbox(rows);
    document.body.append(rendered);

    const doneButton = rendered.querySelector('[aria-label^="Mark as done"]');
    expect(doneButton instanceof HTMLButtonElement).toBe(true);
    /** @type {HTMLButtonElement} */ (doneButton).click();

    expect(rendered.querySelectorAll('.home-catchup-story')).toHaveLength(0);

    // Simulate a refresh: re-render from the same source rows and confirm the
    // done story stays out of the queue because its state was persisted.
    document.body.replaceChildren();
    const refreshed = renderNotificationsInbox(rows);
    document.body.append(refreshed);
    expect(refreshed.querySelectorAll('.home-catchup-story')).toHaveLength(0);
  });

  it('moves a story out of the active queue when saved for later without deleting it permanently', () => {
    const rows = [attentionRow()];
    const rendered = renderNotificationsInbox(rows);
    document.body.append(rendered);

    const laterButton = rendered.querySelector('[aria-label^="Save for later"]');
    expect(laterButton instanceof HTMLButtonElement).toBe(true);
    /** @type {HTMLButtonElement} */ (laterButton).click();

    expect(rendered.querySelectorAll('.home-catchup-story')).toHaveLength(0);

    const stored = JSON.parse(window.localStorage.getItem('central-agentic-ops.dashboard.catch-up-queue') ?? '{}');
    expect(stored.later).toHaveLength(1);
    expect(stored.done).toEqual([]);
  });

  it('does not mark a story done or later just by rendering it (opening does not silently process it)', () => {
    const rendered = renderNotificationsInbox([attentionRow()]);
    document.body.append(rendered);

    const stored = JSON.parse(window.localStorage.getItem('central-agentic-ops.dashboard.catch-up-queue') ?? '{}');
    expect(stored.done ?? []).toEqual([]);
    expect(stored.later ?? []).toEqual([]);
    expect(rendered.querySelectorAll('.home-catchup-story')).toHaveLength(1);
  });
});