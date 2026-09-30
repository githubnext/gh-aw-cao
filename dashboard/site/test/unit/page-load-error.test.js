import { describe, expect, it, vi } from 'vitest';
import { renderPageLoadError } from '../../src/components/page-load-error.js';
import { DashboardServerError } from '../../src/remote-data-backend.js';

describe('page load error', () => {
  it('explains a query budget failure, identifies the query, and retries', () => {
    const retry = vi.fn();
    const element = renderPageLoadError(
      new DashboardServerError('limit exceeded', 'query_plan_too_large', 'campaign-repository-coverage'),
      retry
    );
    expect(element.getAttribute('role')).toBe('alert');
    expect(element.querySelector('h2')?.textContent).toContain('more data');
    expect(element.querySelector('.page-load-error-detail')?.textContent).toBe('Query: campaign-repository-coverage');
    /** @type {HTMLButtonElement} */ (element.querySelector('button')).click();
    expect(retry).toHaveBeenCalledOnce();
  });

  it('hides the query detail for unrelated or unidentified failures', () => {
    for (const error of [
      new Error('internal details'),
      new DashboardServerError('limit exceeded', 'query_plan_too_large', '')
    ]) {
      const element = renderPageLoadError(error, () => {});
      expect(element.getAttribute('role')).toBe('alert');
      expect(element.querySelector('.page-load-error-detail')).toBeNull();
      expect(element.textContent).not.toContain('internal details');
      expect(element.querySelector('button')?.textContent).toBe('Try again');
    }
  });
});
