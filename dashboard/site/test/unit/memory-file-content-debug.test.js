// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DataRequestWorker } from '../data-request-worker.js';

class MemoryWorker extends DataRequestWorker {
  /** @param {Record<string, unknown>} request */
  postMessage(request) {
    if (request.operation !== 'cancel-data-processing') super.postMessage(request);
  }
}

beforeEach(() => vi.stubGlobal('Worker', MemoryWorker));
afterEach(() => {
  document.body.replaceChildren();
  vi.doUnmock('../../src/debug.js');
  vi.resetModules();
});

/** @param {HTMLElement} root @param {string} label */
function tab(root, label) {
  return /** @type {HTMLButtonElement} */ ([...root.querySelectorAll('[role="tab"]')]
    .find((button) => button.textContent === label));
}

describe('memory file content debug logging', () => {
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
    const { renderMemoryFileContent } = await import('../../src/components/memory-file-content.js');

    const root = await renderMemoryFileContent('records.jsonl', '{"id":1}\n', new AbortController().signal);
    document.body.append(root);
    tab(root, 'Table').click();
    await vi.waitFor(() => expect(root.querySelector('table')).not.toBeNull());

    expect(output.debug).not.toHaveBeenCalled();
  });

  it('logs prepare and render-table boundaries under its predictable category when enabled', async () => {
    const output = { debug: vi.fn() };
    vi.doMock('../../src/debug.js', async () => {
      const actual = /** @type {typeof import('../../src/debug.js')} */ (
        await vi.importActual('../../src/debug.js')
      );
      return {
        ...actual,
        createDebug: (/** @type {string} */ category) =>
          actual.createDebug(category, { search: () => '?debug=memory-file-content', output })
      };
    });
    vi.resetModules();
    const { renderMemoryFileContent } = await import('../../src/components/memory-file-content.js');

    const root = await renderMemoryFileContent('records.jsonl', '{"id":1}\n{"id":2}\n', new AbortController().signal);
    expect(output.debug).toHaveBeenCalledWith(
      '[cao:memory-file-content]',
      { operation: 'prepare', status: 'ok', rowCount: 2 }
    );

    document.body.append(root);
    output.debug.mockClear();
    tab(root, 'Table').click();
    await vi.waitFor(() => expect(root.querySelector('table')).not.toBeNull());
    expect(output.debug).toHaveBeenCalledWith(
      '[cao:memory-file-content]',
      { operation: 'render-table', status: 'ok' }
    );

    // Selecting the Table tab again does not re-render or re-log.
    output.debug.mockClear();
    tab(root, 'Raw').click();
    tab(root, 'Table').click();
    expect(output.debug).not.toHaveBeenCalled();
  });

  it('logs a raw-only outcome for non-tabular files and parse errors without leaking file content', async () => {
    const output = { debug: vi.fn() };
    vi.doMock('../../src/debug.js', async () => {
      const actual = /** @type {typeof import('../../src/debug.js')} */ (
        await vi.importActual('../../src/debug.js')
      );
      return {
        ...actual,
        createDebug: (/** @type {string} */ category) =>
          actual.createDebug(category, { search: () => '?debug=memory-file-content', output })
      };
    });
    vi.resetModules();
    const { renderMemoryFileContent } = await import('../../src/components/memory-file-content.js');

    await renderMemoryFileContent('notes.md', '# Secret project notes', new AbortController().signal);
    expect(output.debug).not.toHaveBeenCalled();

    output.debug.mockClear();
    const root = await renderMemoryFileContent('records.jsonl', 'not-json', new AbortController().signal);
    expect(output.debug).toHaveBeenCalledWith(
      '[cao:memory-file-content]',
      { operation: 'prepare', status: 'parse-error', rowCount: undefined }
    );

    document.body.append(root);
    output.debug.mockClear();
    tab(root, 'Table').click();
    await vi.waitFor(() => expect(root.querySelector('[role="alert"]')).not.toBeNull());
    expect(output.debug).toHaveBeenCalledWith(
      '[cao:memory-file-content]',
      { operation: 'render-table', status: 'error' }
    );

    for (const call of output.debug.mock.calls) {
      const [, payload] = call;
      expect(JSON.stringify(payload)).not.toContain('not-json');
      for (const value of Object.values(payload)) {
        expect(value === undefined
          || typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean').toBe(true);
      }
    }
  });
});
