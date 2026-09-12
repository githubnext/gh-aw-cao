import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createNotificationService } from '../../src/notification-service.js';
import { publishWorkerNotification } from '../../src/data-worker.js';

describe('dashboard notification service', () => {
  beforeEach(() => {
    document.body.replaceChildren();
    vi.useFakeTimers();
  });

  it('publishes accessible notifications and removes them after their duration', () => {
    const service = createNotificationService(document);
    service.publish({ message: 'Dashboard refreshed.', tone: 'success', duration: 1000 });

    const notification = document.querySelector('.dashboard-notification');
    expect(notification?.getAttribute('role')).toBe('status');
    expect(notification?.textContent).toBe('Dashboard refreshed.');
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

    /** @type {HTMLButtonElement} */ (notification?.querySelector('button')).click();
    expect(action).toHaveBeenCalledTimes(1);

    handle.update({ message: 'Cancelling…', tone: 'warning', duration: 0 });
    expect(notification?.textContent).toBe('Cancelling…');
    expect(notification?.classList.contains('dashboard-notification-warning')).toBe(true);
    expect(notification?.querySelector('button')).toBeNull();
  });

  it('uses an assertive role for errors and rejects empty messages', () => {
    const service = createNotificationService(document);
    service.publish({ message: 'Refresh failed.', tone: 'error' });

    expect(document.querySelector('.dashboard-notification')?.getAttribute('role')).toBe('alert');
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
