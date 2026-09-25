import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
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
    expect(bar?.getAttribute('role')).toBe('progressbar');
    expect(bar?.getAttribute('aria-label')).toBe('Loading dashboard data');
    expect(bar?.hasAttribute('aria-valuenow')).toBe(false);
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
    const bar = /** @type {HTMLElement | null} */ (document.querySelector('.loading-progress'));
    expect(bar?.getAttribute('aria-valuenow')).toBe('50');
    setLoadingProgressState(document, { id: 'ingestion-1', phase: 'update', completed: 0, total: 4 });
    vi.advanceTimersByTime(60_000);

    expect(bar?.style.transform).toBe('scaleX(0.08)');
    expect(bar?.getAttribute('aria-valuenow')).toBe('0');
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
    expect(bar?.getAttribute('aria-valuenow')).toBe('100');
    vi.advanceTimersByTime(240);
    expect(document.querySelectorAll('.loading-progress')).toHaveLength(0);
    expect(document.querySelectorAll('style[data-loading-progress-styles]')).toHaveLength(1);
  });

  describe('debug logging', () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });

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
      const { setLoadingProgressState: setLoadingProgressStateWithDebug } = await import('../../src/loading-progress.js');

      setLoadingProgressStateWithDebug(document, { id: 'ingestion-1', phase: 'start' });
      setLoadingProgressStateWithDebug(document, { id: 'ingestion-2', phase: 'start' });
      setLoadingProgressStateWithDebug(document, { id: 'ingestion-1', phase: 'complete' });
      setLoadingProgressStateWithDebug(document, { id: 'ingestion-2', phase: 'complete' });

      expect(output.debug).not.toHaveBeenCalled();

      vi.doUnmock('../../src/debug.js');
      vi.resetModules();
    });

    it('logs only scalar metadata under its predictable category when enabled', async () => {
      const output = { debug: vi.fn() };
      vi.doMock('../../src/debug.js', async () => {
        const actual = /** @type {typeof import('../../src/debug.js')} */ (
          await vi.importActual('../../src/debug.js')
        );
        return {
          ...actual,
          createDebug: (/** @type {string} */ category) => actual.createDebug(category, { search: () => '?debug=loading-progress', output })
        };
      });
      vi.resetModules();
      const { setLoadingProgressState: setLoadingProgressStateWithDebug } = await import('../../src/loading-progress.js');

      setLoadingProgressStateWithDebug(document, { id: 'ingestion-1', phase: 'start' });
      expect(output.debug).toHaveBeenCalledWith('[cao:loading-progress]', { event: 'bar-created', id: 'ingestion-1' });

      setLoadingProgressStateWithDebug(document, { id: 'ingestion-2', phase: 'start' });
      expect(output.debug).toHaveBeenCalledWith('[cao:loading-progress]', {
        event: 'concurrent-operation-started',
        id: 'ingestion-2',
        activeCount: 2
      });

      setLoadingProgressStateWithDebug(document, { id: 'ingestion-1', phase: 'complete' });
      setLoadingProgressStateWithDebug(document, { id: 'ingestion-2', phase: 'complete' });
      expect(output.debug).toHaveBeenCalledWith('[cao:loading-progress]', {
        event: 'all-operations-complete',
        id: 'ingestion-2'
      });

      for (const call of output.debug.mock.calls) {
        const metadata = call[1];
        expect(Object.values(metadata).every((value) => typeof value !== 'object')).toBe(true);
      }

      vi.doUnmock('../../src/debug.js');
      vi.resetModules();
    });
  });
});
