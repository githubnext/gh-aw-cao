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

  it('keeps search, grouping, bulk actions, and deep links working with normalized stories', () => {
    const rendered = renderNotificationsInbox([
      attentionRow({
        'attention-signal-id': 'ci-failed',
        objective: 'CI failed',
        reason: 'The test job failed.',
        scope: 'githubnext/repository',
        'observed-at': '2026-09-08T01:00:00Z',
        'evidence-link': {
          href: 'https://github.com/githubnext/repository/pull/42',
          label: 'View pull request'
        }
      }),
      attentionRow({
        'attention-signal-id': 'ci-passed',
        'signal-type': 'status-update',
        objective: 'CI passed',
        reason: 'All required checks passed.',
        scope: 'githubnext/repository',
        'observed-at': '2026-09-08T02:00:00Z',
        'evidence-link': {
          href: 'https://github.com/githubnext/repository/pull/42',
          label: 'View pull request'
        }
      }),
      attentionRow({
        'attention-signal-id': 'other',
        objective: 'Review deployment',
        scope: 'githubnext/other',
        'observed-at': '2026-09-08T03:00:00Z'
      })
    ]);
    document.body.append(rendered);

    expect(rendered.querySelector('.notifications-result-count')?.textContent).toBe('2 notifications');
    expect(rendered.textContent).toContain('CI recovered');
    expect(rendered.querySelector('a[href="https://github.com/githubnext/repository/pull/42"]')).not.toBeNull();

    const search = /** @type {HTMLInputElement} */ (rendered.querySelector('[aria-label="Filter notifications"]'));
    search.value = 'recovered';
    search.dispatchEvent(new Event('input'));
    expect(rendered.querySelectorAll('.notification-item')).toHaveLength(1);

    search.value = '';
    search.dispatchEvent(new Event('input'));
    const group = /** @type {HTMLSelectElement} */ (rendered.querySelector('[aria-label="Group notifications"]'));
    group.value = 'repository';
    group.dispatchEvent(new Event('change'));
    expect([...rendered.querySelectorAll('.notifications-group-heading')].map((heading) => heading.textContent))
      .toEqual(['githubnext/other', 'githubnext/repository']);

    const selectAll = /** @type {HTMLInputElement} */ (rendered.querySelector('[aria-label="Select all notifications"]'));
    selectAll.click();
    /** @type {HTMLButtonElement} */ (rendered.querySelector('[aria-label="Mark selected as done"]')).click();
    const stored = JSON.parse(window.localStorage.getItem('central-agentic-ops.dashboard.notifications') ?? '{}');
    expect(stored.done).toHaveLength(2);
    expect(stored.done.every((/** @type {string} */ id) => id.startsWith('notification-story:'))).toBe(true);
  });

  it('preserves non-repository scope and uses the latest event for collapsed-story date grouping', () => {
    const now = Date.now();
    const rendered = renderNotificationsInbox([
      attentionRow({
        'attention-signal-id': 'a-old',
        'age-seconds': 700_000,
        objective: 'Deployment started',
        scope: 'production',
        'observed-at': new Date(now - 700_000_000).toISOString(),
        'evidence-link': {
          href: 'https://example.com/deployments/42',
          label: 'View deployment'
        },
        objectType: 'deployment',
        objectId: '42'
      }),
      attentionRow({
        'attention-signal-id': 'z-new',
        'age-seconds': 60,
        objective: 'Deployment succeeded',
        scope: 'production',
        'observed-at': new Date(now - 60_000).toISOString(),
        'evidence-link': {
          href: 'https://example.com/deployments/42',
          label: 'View deployment'
        },
        objectType: 'deployment',
        objectId: '42'
      })
    ]);
    document.body.append(rendered);

    expect(rendered.querySelector('.notification-repository')?.textContent).toBe('production');
    const group = /** @type {HTMLSelectElement} */ (rendered.querySelector('[aria-label="Group notifications"]'));
    group.value = 'date';
    group.dispatchEvent(new Event('change'));
    expect(rendered.querySelector('.notifications-group-heading')?.textContent).toBe('Today');
  });

  it('keeps the newest story when attention and operational events describe the same object', () => {
    const now = Date.now();
    const link = {
      href: 'https://github.com/githubnext/repository/issues/99',
      label: 'View issue'
    };
    const rendered = renderNotificationsInbox([attentionRow({
      'attention-signal-id': 'new-failure',
      objective: 'Deployment failed',
      reason: 'The latest deployment needs attention.',
      scope: 'githubnext/repository',
      'observed-at': new Date(now - 60_000).toISOString(),
      'evidence-link': link
    })], {
      outcomes: [{
        'safe-output': 'outcome-99',
        'outcome-state': 'pending',
        'outcome-title': 'Review generated change',
        organization: 'githubnext',
        repository: 'repository',
        'observed-at': new Date(now - 3_600_000).toISOString(),
        'external-link': link
      }]
    });
    document.body.append(rendered);

    expect(rendered.querySelectorAll('.notification-item')).toHaveLength(1);
    expect(rendered.querySelector('.notifications-main')?.textContent).toContain('Deployment failed');
    expect(rendered.querySelector('.notifications-main')?.textContent).not.toContain('Review generated change');
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

function catchUpRows() {
  return [
    attentionRow({
      'evidence-link': {
        href: 'https://github.com/githubnext/repository/actions/runs/42',
        label: 'View run'
      }
    }),
    attentionRow({
      'attention-signal-id': 'signal-2',
      'age-seconds': 120,
      'signal-type': 'agent-smell',
      objective: 'Review agent configuration',
      reason: 'Strict mode is disabled',
      scope: 'githubnext/repository-2',
      'evidence-link': {
        href: 'https://github.com/githubnext/repository-2/issues/43',
        label: 'View issue'
      }
    })
  ];
}

/** @param {Element} card @param {number} startX @param {number} endX */
function swipe(card, startX, endX) {
  card.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, button: 0, clientX: startX, clientY: 10 }));
  card.dispatchEvent(new MouseEvent('pointerup', { bubbles: true, button: 0, clientX: endX, clientY: 12 }));
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

  it('renders one mobile card with progress, classification, origin, and the existing deep link', () => {
    const rendered = renderNotificationsInbox(catchUpRows());
    document.body.append(rendered);

    expect(rendered.querySelectorAll('.home-catchup-mobile-card')).toHaveLength(1);
    expect(rendered.querySelectorAll('.home-story-rail .home-catchup-story')).toHaveLength(2);
    expect(rendered.querySelector('.home-catchup-mobile > header span')?.textContent).toBe('1 of 2');
    expect(rendered.querySelector('.home-catchup-classification')?.textContent).toBe('Needs you');
    expect(rendered.querySelector('.home-catchup-mobile .home-origin-work')).not.toBeNull();
    expect(rendered.querySelector('.home-catchup-mobile-link')?.getAttribute('href'))
      .toBe('https://github.com/githubnext/repository/actions/runs/42');
    expect(rendered.querySelector('.home-catchup-mobile-later')?.textContent).toContain('Later');
    expect(rendered.querySelector('.home-catchup-mobile-done')?.textContent).toContain('Done');
  });

  it('swipes right for Done and left for Later while advancing progress', () => {
    const rendered = renderNotificationsInbox(catchUpRows());
    document.body.append(rendered);

    swipe(/** @type {Element} */ (rendered.querySelector('.home-catchup-mobile-card')), 10, 90);

    expect(rendered.querySelector('.home-catchup-mobile > header span')?.textContent).toBe('2 of 2');
    expect(rendered.querySelector('.home-catchup-mobile-card')?.textContent).toContain('Review agent configuration');
    let stored = JSON.parse(window.localStorage.getItem('central-agentic-ops.dashboard.catch-up-queue') ?? '{}');
    expect(stored.done).toHaveLength(1);
    expect(stored.later).toHaveLength(0);

    swipe(/** @type {Element} */ (rendered.querySelector('.home-catchup-mobile-card')), 90, 10);

    expect(rendered.querySelectorAll('.home-catchup-mobile-card')).toHaveLength(0);
    expect(rendered.querySelector('.home-catchup-mobile')?.textContent).toContain('✓ You are caught up');
    stored = JSON.parse(window.localStorage.getItem('central-agentic-ops.dashboard.catch-up-queue') ?? '{}');
    expect(stored.done).toHaveLength(1);
    expect(stored.later).toHaveLength(1);
  });

  it('routes completion to Later in Notifications while excluding Done stories after refresh', () => {
    const rows = catchUpRows();
    const rendered = renderNotificationsInbox(rows);
    document.body.append(rendered);

    /** @type {HTMLButtonElement} */ (rendered.querySelector('.home-catchup-mobile-later')).click();
    /** @type {HTMLButtonElement} */ (rendered.querySelector('.home-catchup-mobile-done')).click();

    expect(rendered.querySelector('.home-catchup-mobile')?.textContent).toContain('✓ You are caught up');
    const notificationsLink = /** @type {HTMLAnchorElement} */ (rendered.querySelector('.home-catchup-mobile a[href="#page-overview"]'));
    expect(notificationsLink.textContent).toContain('View Later in Notifications');
    notificationsLink.click();

    expect(/** @type {HTMLInputElement} */ (rendered.querySelector('[aria-label="Filter notifications"]')).value).toBe('is:later');
    expect(rendered.querySelectorAll('.notification-item')).toHaveLength(1);
    expect(rendered.textContent).toContain('Investigate failure');
    expect(rendered.textContent).not.toContain('Review agent configuration');

    document.body.replaceChildren();
    const refreshed = renderNotificationsInbox(rows);
    document.body.append(refreshed);
    expect(refreshed.querySelector('.home-catchup-mobile')?.textContent).toContain('✓ You are caught up');
    /** @type {HTMLButtonElement} */ ([...refreshed.querySelectorAll('.notifications-state-tabs button')]
      .find((button) => button.textContent === 'Later')).click();
    expect(refreshed.querySelectorAll('.notification-item')).toHaveLength(1);
    expect(refreshed.querySelector('.notification-content')?.getAttribute('href'))
      .toBe('https://github.com/githubnext/repository/actions/runs/42');
  });

  it('keeps deferred operational stories accessible from Notifications', () => {
    const id = 'notification-story:githubnext%2Frepository:issue:99';
    window.localStorage.setItem('central-agentic-ops.dashboard.catch-up-queue', JSON.stringify({
      queue: [],
      size: 1,
      seen: [id],
      done: [],
      later: [id]
    }));
    const rendered = renderNotificationsInbox([], {
      outcomes: [{
        'safe-output': 'outcome-99',
        'outcome-state': 'pending',
        'outcome-title': 'Review generated change',
        'outcome-summary': 'A pull request is ready for review.',
        organization: 'githubnext',
        repository: 'repository',
        'observed-at': new Date().toISOString(),
        'external-link': {
          href: 'https://github.com/githubnext/repository/issues/99',
          label: 'View issue'
        }
      }]
    });
    document.body.append(rendered);

    /** @type {HTMLButtonElement} */ ([...rendered.querySelectorAll('.notifications-state-tabs button')]
      .find((button) => button.textContent === 'Later')).click();

    expect(rendered.querySelectorAll('.notification-item')).toHaveLength(1);
    expect(rendered.textContent).toContain('Review generated change');
    expect(rendered.querySelector('.notification-content')?.getAttribute('href'))
      .toBe('https://github.com/githubnext/repository/issues/99');
  });

  it('keeps every deferred operational-value story accessible when newer values arrive', () => {
    const ids = ['workflow-a', 'workflow-b'].map((workflow) => (
      `notification-story:githubnext%2Frepository:workflow:${workflow}`
    ));
    window.localStorage.setItem('central-agentic-ops.dashboard.catch-up-queue', JSON.stringify({
      queue: [],
      size: 2,
      seen: ids,
      done: [],
      later: ids
    }));
    const rendered = renderNotificationsInbox([], {
      operationalValues: [{
        'observation-id': 'value-a',
        organization: 'githubnext',
        repository: 'repository',
        workflow: 'workflow-a',
        'maturity-status': 'matured',
        'operational-value': 0.7,
        'observed-at': new Date(Date.now() - 60_000).toISOString()
      }, {
        'observation-id': 'value-b',
        organization: 'githubnext',
        repository: 'repository',
        workflow: 'workflow-b',
        'maturity-status': 'matured',
        'operational-value': 0.8,
        'observed-at': new Date().toISOString()
      }]
    });
    document.body.append(rendered);

    const group = /** @type {HTMLSelectElement} */ (rendered.querySelector('[aria-label="Group notifications"]'));
    group.value = 'none';
    group.dispatchEvent(new Event('change'));
    expect(new Set([...rendered.querySelectorAll('.notification-item input')].map((input) => (
      /** @type {HTMLInputElement} */ (input).dataset.notificationId
    )))).toEqual(new Set(ids));
    /** @type {HTMLButtonElement} */ ([...rendered.querySelectorAll('.notifications-state-tabs button')]
      .find((button) => button.textContent === 'Later')).click();

    expect(rendered.querySelectorAll('.notification-item')).toHaveLength(2);
    expect(rendered.textContent).toContain('workflow-a');
    expect(rendered.textContent).toContain('workflow-b');
  });

  it('provides mobile buttons equivalent to the swipe actions', () => {
    const rendered = renderNotificationsInbox(catchUpRows());
    document.body.append(rendered);

    const later = /** @type {HTMLButtonElement} */ (rendered.querySelector('.home-catchup-mobile-later'));
    later.focus();
    later.click();
    expect(rendered.querySelector('.home-catchup-mobile > header span')?.textContent).toBe('2 of 2');
    expect(document.activeElement).toBe(rendered.querySelector('.home-catchup-mobile-later'));

    const done = /** @type {HTMLButtonElement} */ (rendered.querySelector('.home-catchup-mobile-done'));
    done.focus();
    done.click();
    const stored = JSON.parse(window.localStorage.getItem('central-agentic-ops.dashboard.catch-up-queue') ?? '{}');
    expect(stored.later).toHaveLength(1);
    expect(stored.done).toHaveLength(1);
    expect(document.activeElement).toBe(rendered.querySelector('.home-catchup-mobile-progress'));
  });
});
