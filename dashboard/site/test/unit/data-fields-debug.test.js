import { afterEach, describe, expect, it, vi } from 'vitest';

afterEach(() => {
  vi.doUnmock('../../src/debug.js');
  vi.resetModules();
});

/** @param {{ search: string, output: { debug: import('vitest').Mock } }} options */
async function importFieldsWithDebug({ search, output }) {
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
  return import('../../src/data/model/fields.js');
}

describe('canonical field pruning debug logging', () => {
  it('is disabled by default (no debug output) when the debug query is absent', async () => {
    const output = { debug: vi.fn() };
    const module = await importFieldsWithDebug({ search: '', output });

    expect(() => module.pruneCanonicalRecord('audits', { targetRepo: 'not-a-coordinate' })).toThrow();
    expect(() => module.pruneCanonicalRecord('workflows', { campaign: '  ' })).toThrow();

    expect(output.debug).not.toHaveBeenCalled();
  });

  it('is selected by the predictable "fields" category derived from the filename, not enabled by unrelated categories', async () => {
    const output = { debug: vi.fn() };
    const module = await importFieldsWithDebug({ search: '?debug=some-other-category', output });

    expect(() => module.pruneCanonicalRecord('audits', { targetRepo: 'not-a-coordinate' })).toThrow();

    expect(output.debug).not.toHaveBeenCalled();
  });

  it('logs when an owner/repository coordinate cannot be matched', async () => {
    const output = { debug: vi.fn() };
    const module = await importFieldsWithDebug({ search: '?debug=fields', output });

    expect(() => module.pruneCanonicalRecord('audits', { targetRepo: 'not-a-coordinate' })).toThrow();
    expect(output.debug).toHaveBeenCalledWith('[cao:fields]', {
      event: 'retain-coordinates-rejected',
      copy: 'targetRepo',
      reason: 'unmatched-coordinate'
    });
  });

  it('logs when a recomputable fact conflicts with its duplicate', async () => {
    const output = { debug: vi.fn() };
    const module = await importFieldsWithDebug({ search: '?debug=fields', output });

    expect(() => module.pruneCanonicalRecord('evalObservations', {
      sourceEvalId: 'e1',
      evalResult: 'pass',
      answer: 'fail'
    })).toThrow();
    expect(output.debug).toHaveBeenCalledWith('[cao:fields]', {
      event: 'retain-fact-rejected',
      field: 'evalResult',
      copy: 'answer'
    });
  });

  it('logs when a workflow campaign slug is missing or blank', async () => {
    const output = { debug: vi.fn() };
    const module = await importFieldsWithDebug({ search: '?debug=fields', output });

    expect(() => module.pruneCanonicalRecord('workflows', { campaign: '   ' })).toThrow();
    expect(output.debug).toHaveBeenCalledWith('[cao:fields]', { event: 'campaign-slug-rejected' });
  });

  it('never logs sensitive record content, only scalar metadata', async () => {
    const output = { debug: vi.fn() };
    const module = await importFieldsWithDebug({ search: '?debug=fields', output });

    expect(() => module.pruneCanonicalRecord('audits', { targetRepo: 'secret-token-value' })).toThrow();
    expect(() => module.pruneCanonicalRecord('workflows', { campaign: '   ' })).toThrow();

    expect(output.debug.mock.calls.length).toBeGreaterThan(0);
    for (const call of output.debug.mock.calls) {
      const [, payload] = call;
      for (const value of Object.values(payload)) {
        expect(typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean').toBe(true);
      }
      expect(JSON.stringify(payload)).not.toContain('secret');
    }
  });
});
