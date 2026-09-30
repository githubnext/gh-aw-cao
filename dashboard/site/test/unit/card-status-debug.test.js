import { afterEach, describe, expect, it, vi } from 'vitest';

afterEach(() => {
  vi.doUnmock('../../src/debug.js');
  vi.resetModules();
});

/**
 * Loads card-status.js with a stubbed debug output so assertions can inspect
 * emitted metadata without depending on module state left over from other
 * tests.
 * @param {string} search
 */
async function loadCardStatusWithDebug(search) {
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
  const module = await import('../../src/components/card-status.js');
  return { ...module, output };
}

describe('card status debug logging', () => {
  it('is disabled by default (no debug output) when the debug query is absent', async () => {
    const { resolveCardStatus, output } = await loadCardStatusWithDebug('');

    resolveCardStatus('success');

    expect(output.debug).not.toHaveBeenCalled();
  });

  it('logs a resolved event under the predictable category name derived from the filename', async () => {
    const { resolveCardStatus, output } = await loadCardStatusWithDebug('?debug=card-status');

    const result = resolveCardStatus('success');

    expect(result).toEqual({ icon: 'check-circle-fill', tone: 'success', text: 'success' });
    expect(output.debug).toHaveBeenCalledWith('[cao:card-status]', {
      event: 'resolved',
      normalized: 'success',
      matched: true,
      tone: 'success'
    });
  });

  it('logs matched: false and the fallback tone when a status value has no configured mapping', async () => {
    const { resolveCardStatus, output } = await loadCardStatusWithDebug('?debug=card-status');

    resolveCardStatus('totally-unrecognized-status');

    expect(output.debug).toHaveBeenCalledWith('[cao:card-status]', {
      event: 'resolved',
      normalized: 'totally-unrecognized-status',
      matched: false,
      tone: 'muted'
    });
  });

  it('does not log when there is no observed status value', async () => {
    const { resolveCardStatus, output } = await loadCardStatusWithDebug('?debug=card-status');

    expect(resolveCardStatus('')).toBeNull();
    expect(resolveCardStatus(null)).toBeNull();
    expect(resolveCardStatus(undefined)).toBeNull();

    expect(output.debug).not.toHaveBeenCalled();
  });

  it('never logs the raw source value, only scalar metadata', async () => {
    const { resolveCardStatus, output } = await loadCardStatusWithDebug('?debug=card-status');

    resolveCardStatus('Do_Not_Log_This_Secret_Value');

    for (const call of output.debug.mock.calls) {
      const [, payload] = call;
      expect(JSON.stringify(payload)).not.toContain('Do_Not_Log_This_Secret_Value');
      for (const value of Object.values(payload)) {
        expect(value === null || typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean').toBe(true);
      }
    }
  });
});
