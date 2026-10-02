import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { browserFirstLoad, showBrowserFirstLoad } from '../../src/browser-first-load.js';
import { mountFirstLoadOverlay } from '../../src/components/first-load-overlay.js';
import { renderFactoryHeader } from '../../src/components/factory-header.js';
import { scopedStorageKey } from '../../src/storage-scope.js';

let owner = new AbortController();

beforeEach(() => {
  owner = new AbortController();
  document.body.replaceChildren();
  browserFirstLoad.set({ status: 'loading', dismissed: false });
});

afterEach(() => {
  owner.abort();
  browserFirstLoad.set({ status: 'inactive', dismissed: false });
  localStorage.removeItem(scopedStorageKey('central-agentic-ops.dashboard.theme'));
});

describe('browser first-load presentation', () => {
  it('explains the import, reports actual file progress, and dismisses without cancelling', () => {
    mountFirstLoadOverlay({ document, signal: owner.signal, retry: vi.fn() });
    const dialog = document.querySelector('dialog');
    expect(dialog?.open).toBe(true);
    expect(dialog?.getAttribute('aria-label')).toBe('Preparing your dashboard');
    expect(dialog?.textContent).toContain('building a local database');
    expect(dialog?.querySelector('progress')?.hasAttribute('value')).toBe(false);
    browserFirstLoad.set({ status: 'loading', dismissed: false, completed: 2, total: 5 });
    expect(dialog?.querySelector('progress')?.getAttribute('value')).toBe('2');
    expect(dialog?.querySelector('[role="status"]')?.textContent).toContain('2 of 5');
    const browse = dialog?.querySelector('.first-load-browse');
    if (!(browse instanceof HTMLButtonElement)) throw new Error('Browse button is missing.');
    browse.click();
    expect(dialog?.open).toBe(false);
    expect(browserFirstLoad.get().status).toBe('loading');
    browserFirstLoad.set((current) => ({ ...current, completed: 3 }));
    expect(dialog?.open).toBe(false);
    showBrowserFirstLoad();
    expect(dialog?.open).toBe(true);
    expect(dialog?.querySelector('[role="status"]')?.textContent).toContain('3 of 5');
    browserFirstLoad.set({ status: 'inactive', dismissed: false });
    expect(dialog?.open).toBe(false);
    owner.abort();
    expect(document.querySelector('dialog')).toBeNull();
  });

  it('supports Escape dismissal, honest failure output and retry', () => {
    const retry = vi.fn();
    mountFirstLoadOverlay({ document, signal: owner.signal, retry });
    const dialog = document.querySelector('dialog');
    const cancel = new Event('cancel', { cancelable: true });
    dialog?.dispatchEvent(cancel);
    expect(cancel.defaultPrevented).toBe(true);
    expect(dialog?.open).toBe(false);
    browserFirstLoad.set({ status: 'failed', dismissed: false });
    expect(dialog?.open).toBe(true);
    expect(dialog?.textContent).toContain('first import could not finish');
    expect(dialog?.querySelector('progress')).toBeNull();
    const button = [...dialog?.querySelectorAll('button') ?? []].find((candidate) => candidate.textContent === 'Retry import');
    button?.click();
    expect(retry).toHaveBeenCalledOnce();
  });

  it('restores the selected theme when opening and reopening the body-owned overlay', () => {
    const key = scopedStorageKey('central-agentic-ops.dashboard.theme');
    localStorage.setItem(key, 'dark');
    mountFirstLoadOverlay({ document, signal: owner.signal, retry: vi.fn() });
    const dialog = document.querySelector('dialog');
    expect(dialog?.dataset.theme).toBe('dark');
    browserFirstLoad.set({ status: 'loading', dismissed: true });
    localStorage.setItem(key, 'light');
    showBrowserFirstLoad();
    expect(dialog?.dataset.theme).toBe('light');
  });

  it('suppresses idle and rhythm throughout the initial import, including after dismissal and failure', () => {
    const sources = {
      status: { rows: () => [{ heading: 'Your campaigns are idle.' }], pending: () => false, unavailable: () => false },
      rhythm: { rows: () => [], pending: () => false, unavailable: () => false }
    };
    const header = renderFactoryHeader(sources, owner, { presentation: 'status', rhythm: 'rhythm' }, true);
    expect(header.querySelector('h2')?.textContent).toBe('Your dashboard is taking shape.');
    expect(header.querySelector('h2')?.getAttribute('aria-busy')).toBe('true');
    expect(header.querySelector('.factory-rhythm')?.hasAttribute('hidden')).toBe(true);
    browserFirstLoad.set({ status: 'loading', dismissed: true });
    expect(header.textContent).not.toContain('idle');
    header.querySelector('button')?.click();
    expect(browserFirstLoad.get().dismissed).toBe(false);
    browserFirstLoad.set({ status: 'failed', dismissed: true });
    expect(header.querySelector('h2')?.textContent).toBe('Your dashboard import is incomplete.');
    expect(header.querySelector('h2')?.hasAttribute('aria-busy')).toBe(false);
    browserFirstLoad.set({ status: 'inactive', dismissed: false });
    expect(header.querySelector('h2')?.textContent).toBe('Your campaigns are idle.');
    expect(header.querySelector('.factory-rhythm')?.hasAttribute('hidden')).toBe(false);
    expect(header.querySelector('button')?.hidden).toBe(true);
    owner.abort();
    browserFirstLoad.set({ status: 'loading', dismissed: false });
    expect(header.querySelector('h2')?.textContent).toBe('Your campaigns are idle.');
  });

  it('does not apply the first-load presentation without declarative opt-in', () => {
    const source = { rows: () => [{ heading: 'Observed campaign status' }], pending: () => false, unavailable: () => false };
    const header = renderFactoryHeader({ status: source, rhythm: source }, owner, { presentation: 'status', rhythm: 'rhythm' });
    expect(header.querySelector('h2')?.textContent).toBe('Observed campaign status');
    expect(header.querySelector('button')?.hidden).toBe(true);
  });
});
