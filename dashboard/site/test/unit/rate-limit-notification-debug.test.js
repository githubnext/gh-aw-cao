// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';

afterEach(() => {
  document.body.replaceChildren();
  vi.doUnmock('../../src/debug.js');
  vi.resetModules();
});

/**
 * Mocks `createDebug` to record calls, then re-imports
 * `rate-limit-notification.js` fresh so its module-scoped state and effect
 * registration pick up the mocked logger.
 * @param {ReturnType<typeof vi.fn>} debugFn
 * @param {string} search
 */
async function loadRateLimitNotificationWithDebug(debugFn, search) {
  const output = /** @type {Pick<Console, 'debug'>} */ ({ debug: debugFn });
  vi.doMock('../../src/debug.js', async () => {
    const actual = /** @type {typeof import('../../src/debug.js')} */ (
      await vi.importActual('../../src/debug.js')
    );
    return {
      ...actual,
      createDebug: (/** @type {string} */ category) => actual.createDebug(category, { search: () => search, output })
    };
  });
  vi.resetModules();
  return import('../../src/rate-limit-notification.js');
}

describe('rate-limit-notification debug logging', () => {
  it('is disabled by default when the debug query is absent', async () => {
    const debugFn = vi.fn();
    const { updateRateLimitNotification } = await loadRateLimitNotificationWithDebug(debugFn, '');

    updateRateLimitNotification('/api/v1/query', 429);
    updateRateLimitNotification('/api/v1/query', 200);

    expect(debugFn).not.toHaveBeenCalled();
  });

  it('logs a policy-changed event only when a policy actually flips, under its predictable category', async () => {
    const debugFn = vi.fn();
    const { updateRateLimitNotification } = await loadRateLimitNotificationWithDebug(debugFn, '?debug=rate-limit-notification');

    updateRateLimitNotification('/api/v1/query', 429);
    updateRateLimitNotification('/api/v1/query', 429);

    expect(debugFn).toHaveBeenCalledWith('[cao:rate-limit-notification]', {
      event: 'policy-changed',
      policy: 'query',
      rateLimited: true,
      activePolicyCount: 1
    });
    expect(
      debugFn.mock.calls.filter((call) => call[1].event === 'policy-changed').length
    ).toBe(1);
  });

  it('logs notification-shown and notification-dismissed only on actual visibility transitions', async () => {
    const debugFn = vi.fn();
    const { updateRateLimitNotification } = await loadRateLimitNotificationWithDebug(debugFn, '?debug=rate-limit-notification');

    updateRateLimitNotification('/api/v1/query', 429);
    updateRateLimitNotification('/api/v1/refresh', 429);
    expect(debugFn).toHaveBeenCalledWith('[cao:rate-limit-notification]', {
      event: 'notification-shown',
      policyCount: 1
    });
    expect(
      debugFn.mock.calls.filter((call) => call[1].event === 'notification-shown').length
    ).toBe(1);

    updateRateLimitNotification('/api/v1/query', 200);
    expect(debugFn).not.toHaveBeenCalledWith('[cao:rate-limit-notification]', expect.objectContaining({ event: 'notification-dismissed' }));

    updateRateLimitNotification('/api/v1/refresh', 200);
    expect(debugFn).toHaveBeenCalledWith('[cao:rate-limit-notification]', { event: 'notification-dismissed' });
  });

  it('never logs request paths or other non-scalar values, only scalar metadata', async () => {
    const debugFn = vi.fn();
    const { updateRateLimitNotification } = await loadRateLimitNotificationWithDebug(debugFn, '?debug=rate-limit-notification');

    updateRateLimitNotification('/api/v1/query', 429);
    updateRateLimitNotification('/api/v1/refresh', 429);
    updateRateLimitNotification('/api/v1/query', 200);
    updateRateLimitNotification('/api/v1/refresh', 200);

    expect(debugFn.mock.calls.length).toBeGreaterThan(0);
    for (const call of debugFn.mock.calls) {
      const [, payload] = call;
      for (const value of Object.values(payload)) {
        expect(value === null || typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean').toBe(true);
      }
      expect(JSON.stringify(payload)).not.toContain('/api/v1');
    }
  });
});
