import { afterEach, describe, expect, it, vi } from 'vitest';

afterEach(() => {
  vi.doUnmock('../../src/debug.js');
  vi.resetModules();
});

/** @param {string} search */
async function load(search) {
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
  const module = await import('../../src/data/github-query-sources.js');
  return { output, githubSnapshotSource: module.githubSnapshotSource };
}

const snapshot = {
  data: { full_name: 'secret-owner/secret-repo', description: 'private text' },
  status: /** @type {const} */ ('available'),
  source: /** @type {const} */ ('network'),
  error: null,
  retryAt: null
};

describe('github query source debug logging', () => {
  it('is silent by default', async () => {
    const { output, githubSnapshotSource } = await load('');
    githubSnapshotSource('github-repository', snapshot);
    expect(output.debug).not.toHaveBeenCalled();
  });

  it('is silent when another category is selected', async () => {
    const { output, githubSnapshotSource } = await load('?debug=data:query');
    githubSnapshotSource('github-repository', snapshot);
    expect(output.debug).not.toHaveBeenCalled();
  });

  it('logs scalar metadata without snapshot data under its category', async () => {
    const { output, githubSnapshotSource } = await load('?debug=github-query-sources');
    const result = githubSnapshotSource('github-repository', snapshot);
    expect(result.rows).toEqual([snapshot.data]);
    expect(output.debug).toHaveBeenCalledExactlyOnceWith('[cao:github-query-sources]', {
      event: 'snapshot',
      source: 'github-repository',
      status: 'available',
      origin: 'network',
      hasData: true,
      hasError: false
    });
    expect(JSON.stringify(output.debug.mock.calls)).not.toMatch(/secret|private text/);
  });
});
