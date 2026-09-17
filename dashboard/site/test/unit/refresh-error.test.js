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

    const retryButton = /** @type {HTMLButtonElement | null} */ (error.querySelector('.source-refresh-retry'));
    expect(retryButton?.textContent).toBe('Retry');
    expect(retryButton?.type).toBe('button');
    retryButton?.click();
    expect(retry).toHaveBeenCalledOnce();
  });

  it('can dismiss the partial data warning', () => {
    const error = renderRefreshError(vi.fn());
    document.body.append(error);

    const dismissButton = /** @type {HTMLButtonElement | null} */ (error.querySelector('.source-refresh-dismiss'));
    expect(dismissButton?.getAttribute('aria-label')).toBe('Dismiss partial data warning');
    expect(dismissButton?.getAttribute('title')).toBe('Dismiss partial data warning');
    dismissButton?.click();

    expect(document.body.contains(error)).toBe(false);
  });
});
