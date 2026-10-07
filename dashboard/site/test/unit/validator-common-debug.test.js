// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';

/**
 * Loads validator-common.js with a stubbed debug output so assertions can
 * inspect emitted metadata without depending on module state left over from
 * other tests.
 * @param {string} search
 */
async function loadValidatorCommonWithDebug(search) {
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
  const module = await import('../../src/validator-common.js');
  return { ...module, output };
}

afterEach(() => {
  vi.doUnmock('../../src/debug.js');
  vi.resetModules();
});

describe('validator-common debug logging', () => {
  it('is disabled by default when the debug query is absent', async () => {
    const { validateLinkObject, isSafeRepositorySlug, rejectSensitiveStringsInObject, output } =
      await loadValidatorCommonWithDebug('');

    validateLinkObject({ relation: 'external', href: 'https://example.com', label: 'Example' }, 'link', 'Link', []);
    isSafeRepositorySlug('owner/name');
    rejectSensitiveStringsInObject({ token: 'sk-abc123' }, 'metadata', []);

    expect(output.debug).not.toHaveBeenCalled();
  });

  it('logs the link-object validation outcome under its predictable category when enabled', async () => {
    const { validateLinkObject, output } = await loadValidatorCommonWithDebug('?debug=validator-common');

    validateLinkObject({ relation: 'external', href: 'https://example.com', label: 'Example' }, 'link', 'Link', []);
    expect(output.debug).toHaveBeenCalledWith(
      '[cao:validator-common]',
      { operation: 'validate-link-object', status: 'ok' }
    );

    output.debug.mockClear();
    validateLinkObject('not-an-object', 'link', 'Link', []);
    expect(output.debug).toHaveBeenCalledWith(
      '[cao:validator-common]',
      { operation: 'validate-link-object', status: 'invalid' }
    );
  });

  it('logs the repository-slug safety check outcome', async () => {
    const { isSafeRepositorySlug, output } = await loadValidatorCommonWithDebug('?debug=validator-common');

    isSafeRepositorySlug('owner/name');
    expect(output.debug).toHaveBeenCalledWith(
      '[cao:validator-common]',
      { operation: 'validate-repository-slug', status: 'accepted' }
    );

    output.debug.mockClear();
    isSafeRepositorySlug('owner/../name');
    expect(output.debug).toHaveBeenCalledWith(
      '[cao:validator-common]',
      { operation: 'validate-repository-slug', status: 'rejected' }
    );
  });

  it('logs the sensitive-string rejection count without logging the rejected values', async () => {
    const { rejectSensitiveStringsInObject, output } = await loadValidatorCommonWithDebug('?debug=validator-common');

    rejectSensitiveStringsInObject({ label: 'ok' }, 'metadata', []);
    expect(output.debug).toHaveBeenCalledWith(
      '[cao:validator-common]',
      { operation: 'reject-sensitive-strings', status: 'ok', rejectedCount: 0 }
    );

    output.debug.mockClear();
    rejectSensitiveStringsInObject({ token: 'sk-abc123def456', other: 'github_pat_abc123' }, 'metadata', []);
    expect(output.debug).toHaveBeenCalledWith(
      '[cao:validator-common]',
      { operation: 'reject-sensitive-strings', status: 'rejected', rejectedCount: 2 }
    );
  });

  it('never logs sensitive payload content, only scalar metadata', async () => {
    const { validateLinkObject, isSafeRepositorySlug, rejectSensitiveStringsInObject, output } =
      await loadValidatorCommonWithDebug('?debug=validator-common');

    validateLinkObject({ relation: 'external', href: 'https://example.com', label: 'Example' }, 'link', 'Link', []);
    isSafeRepositorySlug('owner/name');
    rejectSensitiveStringsInObject({ token: 'sk-abc123def456' }, 'metadata', []);

    for (const call of output.debug.mock.calls) {
      const [, payload] = call;
      for (const value of Object.values(payload)) {
        expect(typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean').toBe(true);
      }
    }
  });
});
