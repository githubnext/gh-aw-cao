// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';

/** @type {import('../../src/presenter.js').SourceMetadata} */
const metadata = {
  'source-id': 'records',
  'source-kind': 'query',
  availability: 'available',
  completeness: 'complete',
  freshness: 'fresh',
  provenance: [],
  'as-of': '2026-09-25T00:00:00Z',
  'retrieved-at': '2026-09-25T00:00:00Z'
};

/**
 * @param {Array<Record<string, unknown>>} rows
 * @param {Record<string, string>} [config]
 * @returns {import('../../src/components/ui-elements.js').ElementRenderContext}
 */
function context(rows, config = {}) {
  return {
    pageId: 'detail',
    title: 'README',
    sourceNames: ['records'],
    sources: { records: { source: 'records', metadata, rows } },
    contextDetails: [],
    elementConfig: { 'content-field': 'readme', ...config },
    headingTag: 'h3'
  };
}

afterEach(() => {
  vi.doUnmock('../../src/debug.js');
  vi.resetModules();
});

describe('markdown element debug logging', () => {
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
    const { renderMarkdownElement } = await import('../../src/components/markdown.js');

    renderMarkdownElement(context([{ readme: '# Example' }]));

    expect(output.debug).not.toHaveBeenCalled();
  });

  it('logs rendered and empty status under its predictable category when enabled', async () => {
    const output = { debug: vi.fn() };
    vi.doMock('../../src/debug.js', async () => {
      const actual = /** @type {typeof import('../../src/debug.js')} */ (
        await vi.importActual('../../src/debug.js')
      );
      return {
        ...actual,
        createDebug: (/** @type {string} */ category) =>
          actual.createDebug(category, { search: () => '?debug=markdown', output })
      };
    });
    vi.resetModules();
    const { renderMarkdownElement } = await import('../../src/components/markdown.js');

    renderMarkdownElement(context([{ readme: '# Example\n\n- One\n- Two' }]));
    expect(output.debug).toHaveBeenCalledWith(
      '[cao:markdown]',
      { event: 'render', pageId: 'detail', status: 'rendered', blockCount: expect.any(Number) }
    );

    output.debug.mockClear();
    renderMarkdownElement(context([]));
    expect(output.debug).toHaveBeenCalledWith(
      '[cao:markdown]',
      { event: 'render', pageId: 'detail', status: 'empty' }
    );
  });

  it('never logs raw markdown content, only scalar render metadata', async () => {
    const output = { debug: vi.fn() };
    vi.doMock('../../src/debug.js', async () => {
      const actual = /** @type {typeof import('../../src/debug.js')} */ (
        await vi.importActual('../../src/debug.js')
      );
      return {
        ...actual,
        createDebug: (/** @type {string} */ category) =>
          actual.createDebug(category, { search: () => '?debug=markdown', output })
      };
    });
    vi.resetModules();
    const { renderMarkdownElement } = await import('../../src/components/markdown.js');

    renderMarkdownElement(context([{
      readme: '# Secret\n\nSee the [guide](docs/guide.md) for **sensitive-token-value**.'
    }]));

    for (const call of output.debug.mock.calls) {
      const [, payload] = call;
      for (const value of Object.values(payload)) {
        expect(typeof value === 'string' || typeof value === 'number').toBe(true);
      }
      expect(JSON.stringify(payload)).not.toContain('sensitive-token-value');
      expect(JSON.stringify(payload)).not.toContain('guide.md');
    }
  });
});
