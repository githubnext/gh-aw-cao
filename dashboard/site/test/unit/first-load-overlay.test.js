import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { browserFirstLoad, showBrowserFirstLoad } from '../../src/browser-first-load.js';
import { mountFirstLoadOverlay } from '../../src/components/first-load-overlay.js';
import { renderFactoryHeader } from '../../src/components/factory-header.js';
import { scopedStorageKey } from '../../src/storage-scope.js';
import { createFirstLoadMessagePicker, FIRST_LOAD_MESSAGES, FIRST_LOAD_MESSAGE_INTERVAL_MS } from '../../src/components/first-load-messages.js';

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
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('browser first-load presentation', () => {
  it('contains exactly 100 distinct messages and visits every message once per randomized cycle', () => {
    expect(FIRST_LOAD_MESSAGES).toHaveLength(100);
    expect(new Set(FIRST_LOAD_MESSAGES).size).toBe(100);
    for (const message of FIRST_LOAD_MESSAGES) {
      expect(message).toBe(message.trim());
      expect(message.length).toBeLessThanOrEqual(72);
      expect(message).toMatch(/^[\x20-\x7e]+$/);
    }
    vi.spyOn(Math, 'random').mockReturnValue(0);
    const next = createFirstLoadMessagePicker();
    const firstCycle = Array.from({ length: 100 }, next);
    const secondCycle = Array.from({ length: 100 }, next);
    expect(new Set(firstCycle).size).toBe(100);
    expect(new Set(secondCycle).size).toBe(100);
    expect(firstCycle.toSorted()).toEqual(FIRST_LOAD_MESSAGES.toSorted());
    expect(secondCycle[0]).not.toBe(firstCycle.at(-1));
    expect(firstCycle).not.toEqual(FIRST_LOAD_MESSAGES);
  });

  it('rotates at six-second intervals without progress updates restarting the timer', () => {
    vi.useFakeTimers();
    mountFirstLoadOverlay({ document, signal: owner.signal, retry: vi.fn() });
    const message = document.querySelector('.first-load-message');
    const original = message?.textContent;
    expect(FIRST_LOAD_MESSAGES).toContain(original);
    expect(message?.getAttribute('aria-live')).toBe('off');
    vi.advanceTimersByTime(FIRST_LOAD_MESSAGE_INTERVAL_MS / 2);
    browserFirstLoad.set({ status: 'loading', dismissed: false, completed: 1, total: 5 });
    vi.advanceTimersByTime(FIRST_LOAD_MESSAGE_INTERVAL_MS / 2);
    expect(message?.textContent).not.toBe(original);
    expect(document.querySelector('[role="status"]')?.textContent).toContain('Importing activity files');
  });

  it('pauses rotation when dismissed or failed and tears down permanently when complete', () => {
    vi.useFakeTimers();
    mountFirstLoadOverlay({ document, signal: owner.signal, retry: vi.fn() });
    const message = document.querySelector('.first-load-message');
    browserFirstLoad.set({ status: 'loading', dismissed: true });
    const original = message?.textContent;
    vi.advanceTimersByTime(FIRST_LOAD_MESSAGE_INTERVAL_MS * 2);
    expect(message?.textContent).toBe(original);
    expect(vi.getTimerCount()).toBe(0);
    showBrowserFirstLoad();
    vi.advanceTimersByTime(FIRST_LOAD_MESSAGE_INTERVAL_MS);
    expect(message?.textContent).not.toBe(original);
    browserFirstLoad.set({ status: 'failed', dismissed: false });
    expect(message?.hasAttribute('hidden')).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
    browserFirstLoad.set({ status: 'inactive', dismissed: false });
    expect(vi.getTimerCount()).toBe(0);
    expect(document.querySelector('dialog')).toBeNull();
    browserFirstLoad.set({ status: 'loading', dismissed: false });
    expect(document.querySelector('dialog')).toBeNull();
    expect(vi.getTimerCount()).toBe(0);
    owner.abort();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('does not mount after data is already loaded or its owner is aborted', () => {
    vi.useFakeTimers();
    browserFirstLoad.set({ status: 'inactive', dismissed: false });
    mountFirstLoadOverlay({ document, signal: owner.signal, retry: vi.fn() });
    expect(document.querySelector('dialog')).toBeNull();
    browserFirstLoad.set({ status: 'loading', dismissed: false });
    owner.abort();
    mountFirstLoadOverlay({ document, signal: owner.signal, retry: vi.fn() });
    expect(document.querySelector('dialog')).toBeNull();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('explains the import, reports all preparation stages, and dismisses without cancelling', () => {
    mountFirstLoadOverlay({ document, signal: owner.signal, retry: vi.fn() });
    const dialog = document.querySelector('dialog');
    expect(dialog?.open).toBe(true);
    expect(dialog?.getAttribute('aria-label')).toBe('Preparing your dashboard');
    expect(dialog?.textContent).toContain('building a local database');
    expect(dialog?.querySelector('.first-load-description .first-load-compact-copy')?.textContent)
      .toBe('Preparing a local copy of activity data. First visits can take a few minutes.');
    const serverOption = dialog?.querySelector('.first-load-server-option');
    expect(serverOption?.textContent).toContain('deploy a CAO backend server');
    expect(serverOption?.textContent).toContain('avoid this browser import');
    expect([...serverOption?.querySelectorAll('a') ?? []].map((link) => [link.textContent, link.href])).toEqual([
      ['deployment options', 'https://githubnext.github.io/gh-aw-cao/deployment/']
    ]);
    for (const link of serverOption?.querySelectorAll('a') ?? []) {
      expect(link.target).toBe('_blank');
      expect(link.rel).toBe('noopener noreferrer');
      expect(link.getAttribute('aria-label')).toBe(`${link.textContent} (opens in a new tab)`);
    }
    expect(dialog?.querySelector('.first-load-background')?.getAttribute('aria-hidden')).toBe('true');
    expect(dialog?.querySelector('.first-load-background')?.childElementCount).toBe(0);
    expect(dialog?.querySelector('progress')?.hasAttribute('value')).toBe(false);
    browserFirstLoad.set({ status: 'loading', dismissed: false, completed: 2, total: 5 });
    expect(dialog?.querySelector('progress')?.getAttribute('value')).toBe('2');
    expect(dialog?.querySelector('progress')?.getAttribute('aria-label')).toBe('Dashboard import progress');
    expect(dialog?.querySelector('[role="status"]')?.textContent).toContain('Importing activity files');
    browserFirstLoad.set({ status: 'loading', dismissed: false, completed: 2.5, total: 5, stage: 'maintenance' });
    expect(dialog?.querySelector('progress')?.value).toBe(2.5);
    expect(dialog?.querySelector('[role="status"]')?.textContent).toContain('Applying retention limits');
    browserFirstLoad.set({ status: 'loading', dismissed: false, completed: 3, total: 5, stage: 'inventory' });
    expect(dialog?.querySelector('[role="status"]')?.textContent).toContain('Preparing inventory');
    browserFirstLoad.set({ status: 'loading', dismissed: false, completed: 4, total: 5, stage: 'queries' });
    expect(dialog?.querySelector('[role="status"]')?.textContent).toContain('Refreshing dashboard queries');
    const browse = dialog?.querySelector('.first-load-browse');
    if (!(browse instanceof HTMLButtonElement)) throw new Error('Browse button is missing.');
    browse.click();
    expect(dialog?.open).toBe(false);
    expect(browserFirstLoad.get().status).toBe('loading');
    browserFirstLoad.set((current) => ({ ...current, completed: 3 }));
    expect(dialog?.open).toBe(false);
    showBrowserFirstLoad();
    expect(dialog?.open).toBe(true);
    expect(dialog?.querySelector('[role="status"]')?.textContent).toContain('Refreshing dashboard queries');
    browserFirstLoad.set({ status: 'inactive', dismissed: false });
    expect(dialog?.open).toBe(false);
    expect(document.querySelector('dialog')).toBeNull();
    owner.abort();
    expect(document.querySelector('dialog')).toBeNull();
  });

  it('explains a database upgrade without claiming this is a first visit', () => {
    browserFirstLoad.set({ status: 'loading', dismissed: false, reason: 'upgrade' });
    mountFirstLoadOverlay({ document, signal: owner.signal, retry: vi.fn() });
    const dialog = document.querySelector('dialog');
    expect(dialog?.open).toBe(true);
    expect(dialog?.querySelector('.first-load-eyebrow')?.textContent).toBe('Dashboard update');
    expect(dialog?.querySelector('h2')?.textContent).toContain('Updating your dashboard');
    expect(dialog?.querySelector('.first-load-description')?.textContent).toContain('rebuild the local database');
    expect(dialog?.textContent).not.toContain('The first import can take');
    expect(dialog?.querySelector('[role="status"]')?.textContent).toContain('Updating the local database');
    browserFirstLoad.set({ status: 'loading', dismissed: false, reason: 'upgrade', stage: 'files', completed: 1, total: 5 });
    expect(dialog?.querySelector('[role="status"]')?.textContent).toContain('Importing activity files');
    browserFirstLoad.set({ status: 'failed', dismissed: false, reason: 'upgrade' });
    expect(dialog?.querySelector('h2')?.textContent).toContain('dashboard update could not finish');
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
    expect(dialog?.querySelector('.first-load-server-option')?.textContent).toContain('deploy a CAO backend server');
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
