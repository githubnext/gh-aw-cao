// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';

afterEach(() => {
  vi.doUnmock('../../src/debug.js');
  vi.resetModules();
});

describe('rate-limit notification debug logging', () => {
  it('is disabled by default (no debug output) when the debug query is absent', async () => {
    const output = { debug: vi.fn() };
    vi.doMock('../../src/debug.js', async () => {
      const actual = /** @type {typeof import('../../src/debug.js')} */ (
        await vi.importActual('../../src/debug.js')
      );
      return {
        ...actual,
        createDebug: (/** @type {string} */ category) => actual.createDebug(category, { search: () => '', output })
      };
    });
    vi.resetModules();
    const { updateRateLimitNotification } = await import('../../src/rate-limit-notification.js');

    updateRateLimitNotification('/api/v1/query', 429);
    updateRateLimitNotification('/api/v1/query', 200);

    expect(output.debug).not.toHaveBeenCalled();
  });

  it('logs predictable policy-change and notification-lifecycle metadata when enabled', async () => {
    const output = { debug: vi.fn() };
    vi.doMock('../../src/debug.js', async () => {
      const actual = /** @type {typeof import('../../src/debug.js')} */ (
        await vi.importActual('../../src/debug.js')
      );
      return {
        ...actual,
        createDebug: (/** @type {string} */ category) =>
          actual.createDebug(category, { search: () => '?debug=rate-limit-notification', output })
      };
    });
    vi.resetModules();
    const { updateRateLimitNotification } = await import('../../src/rate-limit-notification.js');

    updateRateLimitNotification('/api/v1/query', 429);
    expect(output.debug).toHaveBeenCalledWith(
      '[cao:rate-limit-notification]',
      { event: 'policy-changed', policy: 'query', rateLimited: true, activePolicyCount: 1 }
    );
    expect(output.debug).toHaveBeenCalledWith(
      '[cao:rate-limit-notification]',
      { event: 'notification-shown', policyCount: 1 }
    );

    output.debug.mockClear();
    updateRateLimitNotification('/api/v1/refresh', 429);
    expect(output.debug).toHaveBeenCalledWith(
      '[cao:rate-limit-notification]',
      { event: 'policy-changed', policy: 'general', rateLimited: true, activePolicyCount: 2 }
    );
    // Already shown; must not fire a duplicate notification-shown event.
    expect(output.debug).not.toHaveBeenCalledWith(
      '[cao:rate-limit-notification]',
      { event: 'notification-shown', policyCount: 2 }
    );

    output.debug.mockClear();
    updateRateLimitNotification('/api/v1/query', 200);
    expect(output.debug).toHaveBeenCalledWith(
      '[cao:rate-limit-notification]',
      { event: 'policy-changed', policy: 'query', rateLimited: false, activePolicyCount: 1 }
    );

    output.debug.mockClear();
    updateRateLimitNotification('/api/v1/refresh', 200);
    expect(output.debug).toHaveBeenCalledWith(
      '[cao:rate-limit-notification]',
      { event: 'policy-changed', policy: 'general', rateLimited: false, activePolicyCount: 0 }
    );
    expect(output.debug).toHaveBeenCalledWith(
      '[cao:rate-limit-notification]',
      { event: 'notification-dismissed' }
    );

    // Never log secrets, request paths, or other sensitive values.
    for (const call of output.debug.mock.calls) {
      const [, payload] = call;
      expect(JSON.stringify(payload)).not.toMatch(/\/api\/v1/);
    }
  });
});
