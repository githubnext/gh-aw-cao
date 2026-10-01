import { afterEach, expect, it } from 'vitest';
import { updateRateLimitNotification } from '../../src/rate-limit-notification.js';

const activeNotices = () => document.querySelectorAll(
  '.dashboard-notification:not(.dashboard-notification-exit)'
);

afterEach(() => {
  updateRateLimitNotification('/api/v1/query', 200);
  updateRateLimitNotification('/api/v1/refresh', 200);
});

it('reacts to overlapping policies without duplicating or prematurely dismissing the alert', () => {
  updateRateLimitNotification('/api/v1/query', 429);
  updateRateLimitNotification('/api/v1/query', 429);
  updateRateLimitNotification('/api/v1/refresh', 429);
  expect(activeNotices()).toHaveLength(1);
  expect(activeNotices()[0].querySelector('[role="alert"]')?.textContent)
    .toContain('Dashboard is rate limited');

  updateRateLimitNotification('/api/v1/query', 200);
  expect(activeNotices()).toHaveLength(1);
  updateRateLimitNotification('/api/v1/refresh', 503);
  expect(activeNotices()).toHaveLength(1);

  updateRateLimitNotification('/api/v1/refresh', 200);
  expect(activeNotices()).toHaveLength(0);

  updateRateLimitNotification('/api/v1/query', 429);
  expect(activeNotices()).toHaveLength(1);
});
