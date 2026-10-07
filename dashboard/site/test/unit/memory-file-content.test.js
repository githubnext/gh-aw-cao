// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderMemoryFileContent } from '../../src/components/memory-file-content.js';
import { DataRequestWorker } from '../data-request-worker.js';

class MemoryWorker extends DataRequestWorker {
  /** @param {Record<string, unknown>} request */
  postMessage(request) {
    if (request.operation !== 'cancel-data-processing') super.postMessage(request);
  }
}

beforeEach(() => vi.stubGlobal('Worker', MemoryWorker));
afterEach(() => document.body.replaceChildren());

/** @param {HTMLElement} root @param {string} label */
function tab(root, label) {
  return /** @type {HTMLButtonElement} */ ([...root.querySelectorAll('[role="tab"]')]
    .find((button) => button.textContent === label));
}

describe('JSONL memory file viewer', () => {
  it('reuses table sorting, filtering, and paging without losing state across tabs', async () => {
    const content = Array.from({ length: 30 }, (_, index) =>
      JSON.stringify({ id: 30 - index, label: `record-${String(index).padStart(2, '0')}` })).join('\n');
    const root = await renderMemoryFileContent('records.JSONL', content, new AbortController().signal);
    document.body.append(root);
    expect(tab(root, 'Raw').getAttribute('aria-selected')).toBe('true');
    expect(root.querySelector('pre')?.textContent).toContain('"id": 30');
    expect(root.querySelector('table')).toBeNull();
    tab(root, 'Table').click();
    await vi.waitFor(() => expect(root.querySelector('.table-filter-result')?.textContent)
      .toBe('Showing 25 of 30 records'));
    expect([...root.querySelectorAll('thead th')].map((cell) => cell.textContent))
      .toEqual(['Line', 'id', 'label']);
    await vi.waitFor(() => expect(root.querySelectorAll('tbody > tr:not([hidden])')).toHaveLength(25));
    /** @type {HTMLButtonElement} */ (root.querySelector('[data-table-more]')).click();
    await vi.waitFor(() => expect(root.querySelector('.table-filter-result')?.textContent)
      .toBe('Showing 30 of 30 records'));
    /** @type {HTMLButtonElement} */ (root.querySelector('[data-table-sort="1"]')).click();
    await vi.waitFor(() => expect(root.querySelector('tbody > tr > td:nth-child(2)')?.textContent).toBe('1'));
    const input = /** @type {HTMLInputElement} */ (root.querySelector('[data-table-filter]'));
    input.value = 'record-07';
    input.dispatchEvent(new Event('input'));
    await vi.waitFor(() => expect(root.querySelector('.table-filter-result')?.textContent).toBe('Showing 1 of 1 record'));
    expect(root.querySelector('tbody > tr:not([hidden])')?.textContent).toContain('record-07');
    tab(root, 'Raw').click();
    expect(root.querySelector('[aria-label="Raw"]')?.hasAttribute('hidden')).toBe(false);
    expect(root.querySelector('[aria-label="Table"]')?.hasAttribute('hidden')).toBe(true);
    tab(root, 'Table').click();
    expect(root.querySelector('[data-table-filter]')).toBe(input);
    expect(input.value).toBe('record-07');
  });

  it('supports keyboard tabs and links each tab to its own panel', async () => {
    const root = await renderMemoryFileContent('records.jsonl', '{"id":1}\n', new AbortController().signal);
    document.body.append(root);
    const raw = tab(root, 'Raw');
    const table = tab(root, 'Table');
    expect(raw.getAttribute('aria-controls')).not.toBe(table.getAttribute('aria-controls'));
    raw.focus();
    raw.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
    expect(document.activeElement).toBe(table);
    expect(table.getAttribute('aria-selected')).toBe('true');
    expect(raw.tabIndex).toBe(-1);
    await vi.waitFor(() => expect(root.querySelector('table')).not.toBeNull());
    table.dispatchEvent(new KeyboardEvent('keydown', { key: 'Home', bubbles: true }));
    expect(document.activeElement).toBe(raw);
    expect(raw.getAttribute('aria-selected')).toBe('true');
  });

  it('keeps malformed content readable and reports the invalid line instead of dropping it', async () => {
    const root = await renderMemoryFileContent('records.jsonl', '{"id":1}\n\nnot-json', new AbortController().signal);
    document.body.append(root);
    tab(root, 'Table').click();
    await vi.waitFor(() => expect(root.querySelector('[role="alert"]')?.textContent)
      .toContain('Invalid JSON on line 3'));
    expect(root.querySelector('table')).toBeNull();
    tab(root, 'Raw').click();
    expect(root.querySelector('pre')?.textContent).toContain('not-json');
  });

  it('shows an honest empty table for blank files and leaves other file types unchanged', async () => {
    const root = await renderMemoryFileContent('records.jsonl', '\r\n \n', new AbortController().signal);
    document.body.append(root);
    tab(root, 'Table').click();
    await vi.waitFor(() => expect(root.querySelector('tbody')?.textContent)
      .toBe('This JSONL file contains no records.'));
    expect(root.querySelector('[data-table-filter]')).toBeNull();
    const text = await renderMemoryFileContent('notes.md', '# Notes', new AbortController().signal);
    expect(text.tagName).toBe('PRE');
    expect(text.textContent).toBe('# Notes');
  });

  it('aborts pending worker preparation and stops tab effects when its lifetime ends', async () => {
    const controller = new AbortController();
    const pending = renderMemoryFileContent('records.jsonl', '{"id":1}', controller.signal);
    controller.abort();
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    const root = await renderMemoryFileContent('records.jsonl', '{"id":1}', new AbortController().signal);
    document.body.append(root);
    tab(root, 'Table').click();
    root.remove();
    await Promise.resolve();
    await Promise.resolve();
    tab(root, 'Raw').click();
    expect(tab(root, 'Table').getAttribute('aria-selected')).toBe('true');
  });
});
