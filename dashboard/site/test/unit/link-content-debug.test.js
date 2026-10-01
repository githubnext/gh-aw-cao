// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';

afterEach(() => {
  vi.doUnmock('../../src/debug.js');
  vi.resetModules();
});

/**
 * Loads link-content.js with a stubbed debug output so assertions can
 * inspect emitted metadata without depending on module state left over from
 * other tests.
 * @param {string} search
 */
async function loadLinkContentWithDebug(search) {
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
  const module = await import('../../src/components/link-content.js');
  return { ...module, output };
}

describe('link-content debug logging', () => {
  it('is disabled by default (no debug output) when the debug query is absent', async () => {
    const { resolveTitleLink, output } = await loadLinkContentWithDebug('');

    resolveTitleLink({}, null);
    resolveTitleLink({}, { 'href-field': 'link', 'identifier-field': 'number' });
    resolveTitleLink(
      { link: { href: 'https://github.com/octo/repo/issues/1', label: 'Issue' }, number: 1 },
      { 'href-field': 'link', 'identifier-field': 'number' }
    );

    expect(output.debug).not.toHaveBeenCalled();
  });

  it('logs a title-link-rejected event with reason config-not-object under the predictable category name', async () => {
    const { resolveTitleLink, output } = await loadLinkContentWithDebug('?debug=link-content');

    const result = resolveTitleLink({}, null);

    expect(result).toBeNull();
    expect(output.debug).toHaveBeenCalledWith('[cao:link-content]', {
      event: 'title-link-rejected',
      reason: 'config-not-object'
    });
  });

  it('logs a title-link-rejected event with reason config-fields-missing', async () => {
    const { resolveTitleLink, output } = await loadLinkContentWithDebug('?debug=link-content');

    const result = resolveTitleLink({}, { 'href-field': 'link' });

    expect(result).toBeNull();
    expect(output.debug).toHaveBeenCalledWith('[cao:link-content]', {
      event: 'title-link-rejected',
      reason: 'config-fields-missing'
    });
  });

  it('logs a title-link-rejected event with reason no-link when no safe link is present', async () => {
    const { resolveTitleLink, output } = await loadLinkContentWithDebug('?debug=link-content');

    const result = resolveTitleLink(
      { number: 42 },
      { 'href-field': 'link', 'identifier-field': 'number' }
    );

    expect(result).toBeNull();
    expect(output.debug).toHaveBeenCalledWith('[cao:link-content]', {
      event: 'title-link-rejected',
      reason: 'no-link',
      identifierLength: 2
    });
  });

  it('logs a title-link-rejected event with reason identifier-invalid when the identifier is empty', async () => {
    const { resolveTitleLink, output } = await loadLinkContentWithDebug('?debug=link-content');

    const result = resolveTitleLink(
      { link: { href: 'https://github.com/octo/repo/issues/1', label: 'Issue' }, number: '' },
      { 'href-field': 'link', 'identifier-field': 'number' }
    );

    expect(result).toBeNull();
    expect(output.debug).toHaveBeenCalledWith('[cao:link-content]', {
      event: 'title-link-rejected',
      reason: 'identifier-invalid',
      identifierLength: 0
    });
  });

  it('does not log when a title link resolves successfully', async () => {
    const { resolveTitleLink, output } = await loadLinkContentWithDebug('?debug=link-content');

    const result = resolveTitleLink(
      { link: { href: 'https://github.com/octo/repo/issues/1', label: 'Issue' }, number: 1 },
      { 'href-field': 'link', 'identifier-field': 'number' }
    );

    expect(result).toEqual({ href: 'https://github.com/octo/repo/issues/1', label: 'Open #1 on GitHub' });
    expect(output.debug).not.toHaveBeenCalled();
  });

  it('never logs the raw source value, only scalar metadata', async () => {
    const { resolveTitleLink, output } = await loadLinkContentWithDebug('?debug=link-content');

    resolveTitleLink({}, null);
    resolveTitleLink({}, { 'href-field': 'link' });
    resolveTitleLink({ number: 'Do_Not_Log_This_Secret_Value' }, { 'href-field': 'link', 'identifier-field': 'number' });

    for (const call of output.debug.mock.calls) {
      const [, payload] = call;
      for (const value of Object.values(payload)) {
        expect(value === null || typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean').toBe(true);
      }
    }
  });
});
