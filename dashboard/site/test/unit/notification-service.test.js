import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createNotificationService } from '../../src/notification-service.js';
import { publishWorkerNotification } from '../../src/ingestion-progress.js';

describe('dashboard notification service', () => {
  beforeEach(() => {
    document.body.replaceChildren();
    vi.useFakeTimers();
  });

  it('publishes accessible notifications and removes them after their duration', () => {
    const service = createNotificationService(document);
    service.publish({ message: 'Dashboard refreshed.', tone: 'success', duration: 1000 });

    const notification = document.querySelector('.dashboard-notification');
    expect(notification?.querySelector('.dashboard-notification-message')?.getAttribute('role')).toBe('status');
    expect(notification?.querySelector('.dashboard-notification-message')?.textContent).toBe('Dashboard refreshed.');
    expect(notification?.classList.contains('dashboard-notification-success')).toBe(true);

    vi.advanceTimersByTime(1180);
    expect(document.querySelector('.dashboard-notification')).toBeNull();
  });

  it('supports persistent actionable notifications and updates them in place', () => {
    const service = createNotificationService(document);
    const action = vi.fn();
    const handle = service.publish({
      message: 'Data processing is slow.',
      duration: 0,
      action: { label: 'Cancel', run: action }
    });
    const notification = document.querySelector('.dashboard-notification');
    expect(notification).not.toBeNull();
    if (!notification) throw new Error('Notification was not rendered.');

    /** @type {HTMLButtonElement} */ (notification.querySelector('button')).click();
    expect(action).toHaveBeenCalledTimes(1);

    handle.update({ message: 'Cancelling…', tone: 'warning', duration: 0 });
    expect(notification?.querySelector('.dashboard-notification-message')?.textContent).toBe('Cancelling…');
    expect(notification?.classList.contains('dashboard-notification-warning')).toBe(true);
    expect(notification?.querySelector('button')).toBeNull();
  });

  it('expands, updates, and collapses a bounded progress history', () => {
    const service = createNotificationService(document);
    const handle = service.publish({
      message: 'Storing data...',
      detailsSubtitle: 'A local copy is being downloaded in this browser.',
      duration: 0,
      details: Array.from({ length: 105 }, (_, index) => `Step ${index + 1}`)
    });
    const toggle = /** @type {HTMLButtonElement} */ (
      document.querySelector('.dashboard-notification-toggle')
    );
    const details = /** @type {HTMLUListElement} */ (
      document.querySelector('.dashboard-notification-details')
    );

    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    expect(details.hidden).toBe(true);
    expect(details.children).toHaveLength(100);
    expect(details.firstElementChild?.textContent).toBe('Step 6');
    const subtitle = /** @type {HTMLParagraphElement} */ (
      document.querySelector('.dashboard-notification-details-subtitle')
    );
    expect(subtitle.hidden).toBe(true);

    toggle.click();
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    expect(toggle.getAttribute('aria-label')).toBe('Storing data... Hide ingestion progress history');
    expect(details.hidden).toBe(false);
    expect(subtitle.hidden).toBe(false);
    expect(subtitle.textContent).toContain('local copy');

    handle.update({
      message: 'Refreshing queries...',
      detailsSubtitle: 'Cached shards are reused.',
      duration: 0,
      details: ['Parsing complete.', 'Refreshing queries.']
    });
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    expect(details.hidden).toBe(false);
    expect(details.textContent).toContain('Refreshing queries.');
    expect(subtitle.textContent).toBe('Cached shards are reused.');
    expect(details.tagName).toBe('UL');

    toggle.click();
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    expect(details.hidden).toBe(true);
  });

  it('updates progress entries in place while following or preserving scroll', () => {
    const service = createNotificationService(document);
    const handle = service.publish({
      message: 'Storing data...',
      duration: 0,
      details: ['Loading metadata.', 'Storing data...']
    });
    const details = /** @type {HTMLUListElement} */ (
      document.querySelector('.dashboard-notification-details')
    );
    Object.defineProperties(details, {
      clientHeight: { configurable: true, value: 100 },
      scrollHeight: { configurable: true, get: () => 100 + details.children.length * 50 }
    });
    details.scrollTop = 100;
    const firstEntry = details.firstElementChild;

    handle.update({
      message: 'Refreshing queries...',
      duration: 0,
      details: ['Loading metadata.', 'Storing data...', 'Refreshing queries.']
    });
    expect(details.firstElementChild).toBe(firstEntry);
    expect(details.firstElementChild).toBe(firstEntry);
    details.scrollTop = 20;
    details.scrollTop = 20;

    handle.update({
      message: 'Still refreshing...',
      duration: 0,
      details: ['Loading metadata.', 'Storing data...', 'Refreshing queries.', 'Still refreshing.']
    });

    expect(details.scrollTop).toBe(20);
  });

  it('captures wheel scrolling in expanded progress history', () => {
    const service = createNotificationService(document);
    service.publish({
      message: 'Storing data...',
      duration: 0,
      details: ['Loading metadata.', 'Storing data...', 'Refreshing queries.']
    });
    const details = /** @type {HTMLUListElement} */ (
      document.querySelector('.dashboard-notification-details')
    );
    Object.defineProperties(details, {
      clientHeight: { configurable: true, value: 100 },
      scrollHeight: { configurable: true, value: 300 }
    });
    details.scrollTop = 0;

    const scrollDown = new WheelEvent('wheel', { bubbles: true, cancelable: true, deltaY: 60 });
    details.dispatchEvent(scrollDown);

    expect(details.scrollTop).toBe(60);
    expect(scrollDown.defaultPrevented).toBe(true);

    details.scrollTop = 200;
    const scrollPastEnd = new WheelEvent('wheel', { bubbles: true, cancelable: true, deltaY: 60 });
    details.dispatchEvent(scrollPastEnd);

    expect(details.scrollTop).toBe(200);
    expect(scrollPastEnd.defaultPrevented).toBe(true);
  });

  it('uses an assertive role for errors and rejects empty messages', () => {
    const service = createNotificationService(document);
    service.publish({ message: 'Refresh failed.', tone: 'error' });

    expect(document.querySelector('.dashboard-notification-message')?.getAttribute('role')).toBe('alert');
    expect(() => service.publish('   ')).toThrow('Notification message must be a non-empty string.');
  });

  it('cleans up notifications and timers when disposed', () => {
    const service = createNotificationService(document);
    service.publish({ message: 'Pending', duration: 1000 });

    service.dispose();
    vi.runAllTimers();

    expect(document.querySelector('.dashboard-notifications')).toBeNull();
    expect(() => service.publish('Later')).toThrow('Notification service has been disposed.');
  });

  it('gives the data worker a serializable notification channel', () => {
    const postMessage = vi.fn();
    publishWorkerNotification(
      { message: 'Rows processed.', tone: 'success', duration: 1200 },
      { postMessage }
    );

    expect(postMessage).toHaveBeenCalledWith({
      type: 'notification',
      notification: { message: 'Rows processed.', tone: 'success', duration: 1200 }
    });
  });
});
