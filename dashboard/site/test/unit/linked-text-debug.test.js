// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';

afterEach(() => {
  vi.doUnmock('../../src/debug.js');
  vi.resetModules();
});

/**
 * Loads linked-text.js with a stubbed debug output so assertions can inspect
 * emitted metadata without depending on module state left over from other
 * tests.
 * @param {string} search
 */
async function loadLinkedTextWithDebug(search) {
  const output = { debug: vi.fn() };
  vi.doMock('../../src/debug.js', async () => {
    const actual = /** @type {typeof import('../../src/debug.js')} */ (
      await vi.importActual('../../src/debug.js')
    );
    return {
      ...actual,
      createDebug: (/** @type {string} */ category) => actual.createDebug(category, { search: () => search, output })
    };
  });
  vi.resetModules();
  const module = await import('../../src/components/linked-text.js');
  return { ...module, output };
}

/** @param {unknown} value */
const toText = (value) => value == null ? 'unknown' : String(value);
/** @param {unknown} display @param {unknown} value */
const renderTableCellValue = (display, value) => `${String(display ?? 'text')}:${String(value)}`;

describe('linked-text debug logging', () => {
  it('is disabled by default (no debug output) when the debug query is absent', async () => {
    const { createEntityAwareCellRenderer, output } = await loadLinkedTextWithDebug('');
    const renderEntityAwareCellValue = createEntityAwareCellRenderer(
      { repository: 'repository-link' },
      () => null,
      renderTableCellValue,
      toText
    );

    renderEntityAwareCellValue('repository', 'gh-aw-cao', {});
    renderEntityAwareCellValue({ field: 'homepage' }, 'https://example.com', {});

    expect(output.debug).not.toHaveBeenCalled();
  });

  it('logs an entity-link-missing event under the predictable category name derived from the filename', async () => {
    const { createEntityAwareCellRenderer, output } = await loadLinkedTextWithDebug('?debug=linked-text');
    const renderEntityAwareCellValue = createEntityAwareCellRenderer(
      { repository: 'repository-link' },
      () => null,
      renderTableCellValue,
      toText
    );

    const rendered = renderEntityAwareCellValue('repository', 'gh-aw-cao', {});

    expect(rendered).toBe('text:gh-aw-cao');
    expect(output.debug).toHaveBeenCalledWith('[cao:linked-text]', {
      event: 'entity-link-missing',
      field: 'repository',
      linkField: 'repository-link'
    });
  });

  it('does not log when an entity link field resolves a safe link', async () => {
    const { createEntityAwareCellRenderer, output } = await loadLinkedTextWithDebug('?debug=linked-text');
    const renderEntityAwareCellValue = createEntityAwareCellRenderer(
      { repository: 'repository-link' },
      () => ({ href: 'https://github.com/githubnext/gh-aw-cao', label: 'View on GitHub' }),
      renderTableCellValue,
      toText
    );

    renderEntityAwareCellValue('repository', 'gh-aw-cao', {});

    expect(output.debug).not.toHaveBeenCalled();
  });

  it('logs an external-link-unresolved event when a URL-like field value fails to resolve', async () => {
    const { createEntityAwareCellRenderer, output } = await loadLinkedTextWithDebug('?debug=linked-text');
    const renderEntityAwareCellValue = createEntityAwareCellRenderer(
      {},
      () => null,
      renderTableCellValue,
      toText
    );

    const rendered = renderEntityAwareCellValue({ field: 'homepage-url' }, 'not-a-url', {});

    expect(rendered).toBe('text:not-a-url');
    expect(output.debug).toHaveBeenCalledWith('[cao:linked-text]', {
      event: 'external-link-unresolved',
      field: 'homepage-url'
    });
  });

  it('does not log when an external URL field resolves successfully', async () => {
    const { createEntityAwareCellRenderer, output } = await loadLinkedTextWithDebug('?debug=linked-text');
    const renderEntityAwareCellValue = createEntityAwareCellRenderer(
      {},
      () => null,
      renderTableCellValue,
      toText
    );

    renderEntityAwareCellValue({ field: 'homepage-url' }, 'https://example.com', {});

    expect(output.debug).not.toHaveBeenCalled();
  });

  it('never logs the raw field value, only scalar metadata', async () => {
    const { createEntityAwareCellRenderer, output } = await loadLinkedTextWithDebug('?debug=linked-text');
    const renderEntityAwareCellValue = createEntityAwareCellRenderer(
      { repository: 'repository-link' },
      () => null,
      renderTableCellValue,
      toText
    );

    renderEntityAwareCellValue('repository', 'Do_Not_Log_This_Secret_Value', {});
    renderEntityAwareCellValue({ field: 'homepage-url' }, 'Do_Not_Log_This_Secret_Value_Either', {});

    for (const call of output.debug.mock.calls) {
      const [, payload] = call;
      for (const value of Object.values(payload)) {
        expect(value === null || typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean').toBe(true);
      }
    }
  });
});
