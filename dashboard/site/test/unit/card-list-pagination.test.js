import { afterEach, describe, expect, it, vi } from 'vitest';
import { h } from '../../src/dom.js';
import { enableCardListPagination, restoreCardListPagination } from '../../src/components/card-list-pagination.js';

const rows = Array.from({ length: 60 }, (_, index) => ({ name: `Package ${index + 1}` }));
const renderItems = (/** @type {Record<string, unknown>[]} */ items) =>
  items.map((row) => h('li', { className: 'entity-card-list-card' }, h('a', { href: '#package' }, String(row.name))));

function fixture() {
  const list = h('ul', { className: 'entity-card-list' }, ...renderItems(rows.slice(0, 25)));
  const section = h('section', { 'data-view-id': 'packages' }, list);
  document.body.append(section);
  return { section, list };
}

afterEach(() => {
  document.body.replaceChildren();
  vi.unstubAllGlobals();
});

describe('lazy entity-card pagination', () => {
  it('reveals bounded batches without replacing existing cards or requiring an observer', async () => {
    vi.stubGlobal('IntersectionObserver', undefined);
    const { section, list } = fixture();
    enableCardListPagination(section, { rows, renderItems });
    const first = list.firstElementChild;
    const link = /** @type {HTMLAnchorElement} */ (first?.querySelector('a'));
    link.focus();
    const button = /** @type {HTMLButtonElement} */ (section.querySelector('button'));
    button.click();
    expect(list.querySelectorAll('.entity-card-list-card')).toHaveLength(50);
    expect(list.firstElementChild).toBe(first);
    expect(document.activeElement).toBe(link);
    await Promise.resolve();
    button.click();
    expect(list.querySelectorAll('.entity-card-list-card')).toHaveLength(60);
    expect(button.hidden).toBe(true);
    expect(section.querySelector('[role="status"]')?.textContent).toBe('Showing 60 of 60 items');
  });

  it('loads worker continuation pages once and reports errors with a manual retry', async () => {
    const load = vi.fn()
      .mockRejectedValueOnce(new Error('upstream unavailable'))
      .mockResolvedValueOnce({ rows: rows.slice(25, 50), continuationToken: 'second' })
      .mockResolvedValueOnce({ rows: rows.slice(50) });
    const { section, list } = fixture();
    enableCardListPagination(section, {
      rows: rows.slice(0, 25), renderItems,
      continuation: { token: 'first', totalRows: 60, load }
    });
    const button = /** @type {HTMLButtonElement} */ (section.querySelector('button'));
    button.click();
    button.click();
    expect(load).toHaveBeenCalledTimes(1);
    await vi.waitFor(() => expect(button.textContent).toBe('Try again'));
    expect(section.querySelector('[role="status"]')?.textContent).toContain('Could not load more items');
    button.click();
    await vi.waitFor(() => expect(list.querySelectorAll('.entity-card-list-card')).toHaveLength(50));
    button.click();
    await vi.waitFor(() => expect(list.querySelectorAll('.entity-card-list-card')).toHaveLength(60));
    expect(load.mock.calls.map(([token]) => token)).toEqual(['first', 'first', 'second']);
    expect(button.hidden).toBe(true);
  });

  it('restores expanded depth from new query results rather than retaining stale rows', async () => {
    const previous = fixture();
    enableCardListPagination(previous.section, { rows, renderItems });
    const button = /** @type {HTMLButtonElement} */ (previous.section.querySelector('button'));
    button.click();
    await Promise.resolve();
    await Promise.resolve();
    button.click();
    await vi.waitFor(() => expect(previous.list.querySelectorAll('.entity-card-list-card')).toHaveLength(60));
    const next = fixture();
    const refreshed = rows.map(row => ({ name: `${row.name} updated` }));
    next.list.replaceChildren(...renderItems(refreshed.slice(0, 25)));
    enableCardListPagination(next.section, { rows: refreshed, renderItems });
    restoreCardListPagination(previous.section, next.section);
    await vi.waitFor(() => expect(next.list.querySelectorAll('.entity-card-list-card')).toHaveLength(60));
    expect(next.list.textContent).toContain('Package 60 updated');
  });

  it('disconnects its observer and ignores a pending page after detachment', async () => {
    const disconnect = vi.fn();
    /** @type {IntersectionObserverCallback | undefined} */
    let onIntersect;
    vi.stubGlobal('IntersectionObserver', class {
      constructor(/** @type {IntersectionObserverCallback} */ callback) { onIntersect = callback; }
      observe() {}
      disconnect = disconnect;
    });
    /** @type {(page: { rows: Record<string, unknown>[] }) => void} */
    let finish = () => {};
    const load = vi.fn(() => new Promise((resolve) => { finish = resolve; }));
    const { section, list } = fixture();
    enableCardListPagination(section, {
      rows: rows.slice(0, 25), renderItems,
      continuation: { token: 'first', totalRows: 60, load }
    });
    onIntersect?.(
      [/** @type {IntersectionObserverEntry} */ ({ isIntersecting: true })],
      /** @type {IntersectionObserver} */ ({})
    );
    expect(load).toHaveBeenCalledOnce();
    section.remove();
    await Promise.resolve();
    expect(disconnect).toHaveBeenCalledOnce();
    finish({ rows: rows.slice(25) });
    await Promise.resolve();
    expect(list.querySelectorAll('.entity-card-list-card')).toHaveLength(25);
  });
});
