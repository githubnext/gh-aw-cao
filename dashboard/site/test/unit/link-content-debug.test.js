// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';

afterEach(() => {
  vi.doUnmock('../../src/debug.js');
  vi.resetModules();
});

/**
 * @param {ReturnType<typeof vi.fn>} debugFn
 * @param {string} search
 */
function mockDebugModule(debugFn, search) {
  const output = /** @type {Pick<Console, 'debug'>} */ ({ debug: debugFn });
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
}

describe('link-content debug logging', () => {
  it('is disabled by default (no debug output) when the debug query is absent', async () => {
    const debugFn = vi.fn();
    mockDebugModule(debugFn, '');
    const { findLink, renderWorkflowRunUrl, renderShortenedUrl } = await import('../../src/components/link-content.js');

    findLink({}, 'run-link');
    renderWorkflowRunUrl('https://example.com/not-a-run');
    renderShortenedUrl('http://example.com/insecure');

    expect(debugFn).not.toHaveBeenCalled();
  });

  it('logs a link-unresolved event with the field name when no safe link can be resolved', async () => {
    const debugFn = vi.fn();
    mockDebugModule(debugFn, '?debug=link-content');
    const { findLink } = await import('../../src/components/link-content.js');

    findLink({ 'run-link': { href: 'not-a-url', label: 'Run' } }, 'run-link');

    expect(debugFn).toHaveBeenCalledWith('[cao:link-content]', {
      event: 'link-unresolved',
      field: 'run-link',
      hasDashboardHref: false,
      hasExternalHref: false
    });
  });

  it('does not log when a link resolves successfully', async () => {
    const debugFn = vi.fn();
    mockDebugModule(debugFn, '?debug=link-content');
    const { findLink } = await import('../../src/components/link-content.js');

    findLink({ 'run-link': { href: 'https://github.com/octo-org/platform/issues/42', label: 'Issue 42' } }, 'run-link');

    expect(debugFn).not.toHaveBeenCalled();
  });

  it('logs a workflow-run-url-rejected event with protocol and hostname when the URL does not match the pattern', async () => {
    const debugFn = vi.fn();
    mockDebugModule(debugFn, '?debug=link-content');
    const { renderWorkflowRunUrl } = await import('../../src/components/link-content.js');

    renderWorkflowRunUrl('https://example.com/octo-org/platform/actions/runs/42');

    expect(debugFn).toHaveBeenCalledWith('[cao:link-content]', {
      event: 'workflow-run-url-rejected',
      protocol: 'https:',
      hostname: 'example.com'
    });
  });

  it('logs a shortened-url-rejected event with the protocol when the URL is not HTTPS', async () => {
    const debugFn = vi.fn();
    mockDebugModule(debugFn, '?debug=link-content');
    const { renderShortenedUrl } = await import('../../src/components/link-content.js');

    renderShortenedUrl('http://example.com/path/to/page');

    expect(debugFn).toHaveBeenCalledWith('[cao:link-content]', {
      event: 'shortened-url-rejected',
      protocol: 'http:'
    });
  });

  it('never logs record content, only scalar metadata', async () => {
    const debugFn = vi.fn();
    mockDebugModule(debugFn, '?debug=link-content');
    const { findLink, renderWorkflowRunUrl, renderShortenedUrl } = await import('../../src/components/link-content.js');

    findLink({ 'run-link': { href: 'not-a-url', label: 'secret-label' } }, 'run-link');
    renderWorkflowRunUrl('https://example.com/octo-org/platform/actions/runs/42');
    renderShortenedUrl('http://example.com/secret/path');

    for (const call of debugFn.mock.calls) {
      const [, payload] = call;
      for (const value of Object.values(payload)) {
        expect(value === null || typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean').toBe(true);
      }
    }
  });
});
