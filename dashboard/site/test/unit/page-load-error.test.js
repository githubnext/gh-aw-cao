import { describe, expect, it, vi } from 'vitest';
import { renderPageLoadError } from '../../src/components/page-load-error.js';
import { DashboardServerError } from '../../src/remote-data-backend.js';

describe('page load error', () => {
  it('explains a query budget failure, identifies the query, and retries', () => {
    const retry = vi.fn();
    const element = renderPageLoadError(
      new DashboardServerError('limit exceeded', 'query_plan_too_large', 'campaign-repository-coverage', 'retained_bytes'),
      retry
    );
    expect(element.getAttribute('role')).toBe('alert');
    expect(element.querySelector('h2')?.textContent).toContain('more data');
    expect(element.querySelector('.page-load-error-detail')?.textContent).toBe('Query: campaign-repository-coverage');
    expect(element.textContent).toContain('Limit type: Retained data');
    expect(element.textContent).not.toMatch(/512|536870912/);
    /** @type {HTMLButtonElement} */ (element.querySelector('button')).click();
    expect(retry).toHaveBeenCalledOnce();
  });

  it('hides the query detail for unrelated or unidentified failures', () => {
    for (const error of [
      new Error('internal details'),
      new DashboardServerError('limit exceeded', 'query_plan_too_large', ''),
      new DashboardServerError('unknown internal detail', 'unexpected_future_code', 'hidden-query', 'retained_bytes')
    ]) {
      const element = renderPageLoadError(error, () => {});
      expect(element.getAttribute('role')).toBe('alert');
      expect(element.querySelector('.page-load-error-detail')).toBeNull();
      expect(element.textContent).not.toContain('internal details');
      expect(element.textContent).not.toContain('hidden-query');
      expect(element.querySelector('button')?.textContent).toBe('Try again');
    }
  });

  it('does not display unknown boundary identifiers or numeric server messages', () => {
    const element = renderPageLoadError(
      new DashboardServerError('limit 536870912', 'query_plan_too_large', 'campaign-inventory', '__proto__'),
      () => {}
    );
    expect(element.textContent).toContain('Query: campaign-inventory');
    expect(element.textContent).not.toContain('__proto__');
    expect(element.textContent).not.toContain('536870912');
  });
});
