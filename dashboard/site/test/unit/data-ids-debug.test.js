import { afterEach, describe, expect, it, vi } from 'vitest';

afterEach(() => {
  vi.doUnmock('../../src/debug.js');
  vi.resetModules();
});

/** @param {{ search: string, output: { debug: import('vitest').Mock } }} options */
async function importIdsWithDebug({ search, output }) {
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
  return import('../../src/data/model/ids.js');
}

describe('canonical ID debug logging', () => {
  it('is disabled by default (no debug output) when the debug query is absent', async () => {
    const output = { debug: vi.fn() };
    const module = await importIdsWithDebug({ search: '', output });

    expect(() => module.issueCoordinates('not a url')).toThrow();
    expect(() => module.issueCoordinates('https://example.com/owner/repo/issues/1')).toThrow();
    expect(() => module.sourceId('audit', '', '42')).toThrow();

    expect(output.debug).not.toHaveBeenCalled();
  });

  it('is selected by the predictable "ids" category derived from the filename, not enabled by unrelated categories', async () => {
    const output = { debug: vi.fn() };
    const module = await importIdsWithDebug({ search: '?debug=some-other-category', output });

    expect(() => module.issueCoordinates('not a url')).toThrow();

    expect(output.debug).not.toHaveBeenCalled();
  });

  it('logs a rejection reason when a correlation URL cannot be parsed or matched', async () => {
    const output = { debug: vi.fn() };
    const module = await importIdsWithDebug({ search: '?debug=ids', output });

    expect(() => module.issueCoordinates('not a url')).toThrow();
    expect(output.debug).toHaveBeenCalledWith('[cao:ids]', {
      event: 'issue-coordinates-rejected',
      reason: 'unparseable-url'
    });

    output.debug.mockClear();
    expect(() => module.issueCoordinates('https://example.com/owner/repo/issues/1')).toThrow();
    expect(output.debug).toHaveBeenCalledWith('[cao:ids]', {
      event: 'issue-coordinates-rejected',
      reason: 'unmatched-path',
      host: 'example.com'
    });
  });

  it('logs the entity kind when a source coordinate is rejected', async () => {
    const output = { debug: vi.fn() };
    const module = await importIdsWithDebug({ search: '?debug=ids', output });

    expect(() => module.sourceId('audit', '', '42')).toThrow();
    expect(output.debug).toHaveBeenCalledWith('[cao:ids]', {
      event: 'source-id-rejected',
      kind: 'audit'
    });
  });

  it('never logs sensitive URL or coordinate content, only scalar metadata', async () => {
    const output = { debug: vi.fn() };
    const module = await importIdsWithDebug({ search: '?debug=ids', output });

    expect(() => module.issueCoordinates('https://example.com/owner/repo/issues/1?token=secret-value')).toThrow();
    expect(() => module.sourceId('audit', '', 'coordinate-with-secret-42')).toThrow();

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
