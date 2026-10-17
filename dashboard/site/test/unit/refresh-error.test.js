// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderDashboardCurrentStatus, notifyRefreshError } from '../../src/components/refresh-error.js';
import { updateRateLimitNotification } from '../../src/rate-limit-notification.js';

afterEach(() => document.body.replaceChildren());

describe('refresh error', () => {
  it('explains the stale state and retries the refresh', () => {
    const retry = vi.fn();
    notifyRefreshError(retry, { snapshot: { createdAt: '2026-09-28T12:00:00.000Z' } });
    const error = /** @type {HTMLElement} */ (document.querySelector('.dashboard-notification'));

    expect(error.querySelector('[role="alert"]')).not.toBeNull();
    expect(error.textContent).toContain('Dashboard data could not be refreshed.');
    expect(error.textContent).toContain('Some views may be unavailable.');
    expect(error.textContent).toContain('most recent cached data');

    const retryButton = /** @type {HTMLButtonElement | null} */ (error.querySelector('.dashboard-notification-action'));
    expect(retryButton?.textContent).toBe('Retry');
    expect(retryButton?.type).toBe('button');
    retryButton?.click();
    expect(retry).toHaveBeenCalledOnce();
  });

  it('can dismiss the partial data warning', () => {
    notifyRefreshError(vi.fn());
    const error = /** @type {HTMLElement} */ (document.querySelector('.dashboard-notification'));

    const dismissButton = /** @type {HTMLButtonElement | null} */ (error.querySelector('.dashboard-notification-dismiss'));
    expect(dismissButton?.getAttribute('aria-label')).toBe('Dismiss Dashboard data could not be refreshed.');
    dismissButton?.click();

    expect(error.classList.contains('dashboard-notification-exit')).toBe(true);
  });

  it('announces a failed refresh with the last complete snapshot time', () => {
    notifyRefreshError(vi.fn(), { snapshot: { createdAt: '2026-09-28T12:00:00.000Z' } });
    const status = /** @type {HTMLElement} */ (document.querySelector('.dashboard-notification'));

    expect(status.querySelector('[role="alert"]')).not.toBeNull();
    expect(status.textContent).toContain('Dashboard data could not be refreshed.');
    expect(status.textContent).toContain('last complete snapshot from');
  });

  it('shows refresh progress in the existing status tooltip', () => {
    const status = renderDashboardCurrentStatus({ createdAt: '2026-09-28T12:00:00.000Z' }, { refreshing: true });
    const button = status.querySelector('button');
    const tooltip = status.querySelector('[role="tooltip"]');

    expect(button?.getAttribute('aria-label')).toBe('Refreshing dashboard data');
    expect(button?.getAttribute('aria-describedby')).toBe(tooltip?.id);
    expect(status.querySelector('.octicon-sync')).not.toBeNull();
    expect(status.querySelector('.octicon-check-circle-fill')).toBeNull();
    expect(tooltip?.textContent).toContain('Showing the last complete snapshot from');
  });

  it('shows the current snapshot time in an accessible icon tooltip', () => {
    const status = renderDashboardCurrentStatus({ createdAt: '2026-09-28T12:00:00.000Z' });
    const button = status.querySelector('button');
    const tooltip = status.querySelector('[role="tooltip"]');

    expect(button?.getAttribute('aria-label')).toBe('Dashboard data is current');
    expect(button?.getAttribute('aria-describedby')).toBe(tooltip?.id);
    expect(status.querySelector('.octicon-check-circle-fill')).not.toBeNull();
    expect(tooltip?.textContent).toContain('Dashboard data is current as of');
  });

  it('reactively shows the sync status icon when hosted requests are rate limited', async () => {
    const status = renderDashboardCurrentStatus(null);
    document.body.append(status);
    expect(status.hidden).toBe(true);
    updateRateLimitNotification('/api/v1/query', 429);
    expect(status.hidden).toBe(false);
    expect(status.querySelector('.octicon-stop')).not.toBeNull();
    expect(status.querySelector('button')?.getAttribute('aria-label')).toBe('Dashboard is rate limited');
    expect(status.querySelector('[role="tooltip"]')?.textContent).toContain('Please try again shortly');
    expect(document.querySelectorAll('.dashboard-notification:not(.dashboard-notification-exit)')).toHaveLength(1);

    const trigger = status.querySelector('button');
    updateRateLimitNotification('/api/v1/query', 200);
    expect(status.querySelector('button')).toBe(trigger);
    expect(status.hidden).toBe(true);
    expect(document.querySelectorAll('.dashboard-notification:not(.dashboard-notification-exit)')).toHaveLength(0);
    status.remove();
    await vi.waitFor(() => expect(status.isConnected).toBe(false));
  });

  it('does not claim cached data exists when the first refresh fails', () => {
    notifyRefreshError(vi.fn());
    const error = /** @type {HTMLElement} */ (document.querySelector('.dashboard-notification'));

    expect(error.textContent).toContain('A complete dashboard snapshot is not available yet.');
    expect(error.textContent).not.toContain('most recent cached data');
  });
});
