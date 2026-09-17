import { afterEach, describe, expect, it, vi } from 'vitest';
import { setLoadingProgressState } from '../../src/loading-progress.js';

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  document.head.replaceChildren();
  document.body.replaceChildren();
});

describe('loading progress', () => {
  it('is created only when the worker starts an operation', () => {
    vi.useFakeTimers();

    expect(document.querySelector('.loading-progress')).toBeNull();
    setLoadingProgressState(document, { id: 'ingestion-1', phase: 'start' });
    const bar = /** @type {HTMLElement | null} */ (document.querySelector('.loading-progress'));

    expect(bar?.style.transform).toBe('scaleX(0.08)');
  });

  it('keeps a shimmer animation running while progress waits to complete', () => {
    vi.useFakeTimers();

    setLoadingProgressState(document, { id: 'ingestion-1', phase: 'start' });
    vi.advanceTimersByTime(60_000);

    const styles = document.querySelector('style[data-loading-progress-styles]')?.textContent;
    expect(styles).toContain('animation: loading-progress-shimmer 1.2s ease-in-out infinite');
    expect(styles).toContain('@keyframes loading-progress-shimmer');
    expect(styles).toContain('from {\n    transform: translateX(-100%);');
  });

  it('uses the worker shard state after its total becomes known', () => {
    vi.useFakeTimers();

    setLoadingProgressState(document, { id: 'ingestion-1', phase: 'start' });
    setLoadingProgressState(document, { id: 'ingestion-1', phase: 'update', completed: 2, total: 4 });
    setLoadingProgressState(document, { id: 'ingestion-1', phase: 'update', completed: 0, total: 4 });
    vi.advanceTimersByTime(60_000);

    const bar = /** @type {HTMLElement | null} */ (document.querySelector('.loading-progress'));
    expect(bar?.style.transform).toBe('scaleX(0.08)');
  });

  it('waits for every worker operation before completing', () => {
    vi.useFakeTimers();
    setLoadingProgressState(document, { id: 'ingestion-1', phase: 'start' });
    setLoadingProgressState(document, { id: 'ingestion-2', phase: 'start' });
    const bar = /** @type {HTMLElement | null} */ (document.querySelector('.loading-progress'));

    setLoadingProgressState(document, { id: 'ingestion-1', phase: 'complete' });

    expect(bar?.classList.contains('loading-progress-complete')).toBe(false);
    expect(document.querySelectorAll('.loading-progress')).toHaveLength(1);

    setLoadingProgressState(document, { id: 'ingestion-2', phase: 'complete' });

    expect(bar?.classList.contains('loading-progress-complete')).toBe(true);
    expect(bar?.style.transform).toBe('scaleX(1)');
    vi.advanceTimersByTime(240);
    expect(document.querySelectorAll('.loading-progress')).toHaveLength(0);
    expect(document.querySelectorAll('style[data-loading-progress-styles]')).toHaveLength(1);
  });
});
