// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { renderRefreshError } from '../../src/components/refresh-error.js';

describe('refresh error', () => {
  it('explains the stale state and retries the refresh', () => {
    const retry = vi.fn();
    const error = renderRefreshError(retry);

    expect(error.getAttribute('role')).toBe('alert');
    expect(error.textContent).toContain('Dashboard data could not be refreshed.');
    expect(error.textContent).toContain('Some views may be unavailable.');
    expect(error.textContent).toContain('most recent cached data');

    const button = error.querySelector('button');
    expect(button?.textContent).toBe('Retry');
    expect(button?.type).toBe('button');
    button?.click();
    expect(retry).toHaveBeenCalledOnce();
  });
});
