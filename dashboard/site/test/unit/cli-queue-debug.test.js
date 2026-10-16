import { afterEach, describe, expect, it, vi } from 'vitest';

/** @param {string} search */
async function loadCliQueue(search) {
  const output = { debug: vi.fn() };
  vi.doMock('../../src/debug.js', async () => {
    const actual = /** @type {typeof import('../../src/debug.js')} */ (await vi.importActual('../../src/debug.js'));
    return {
      ...actual,
      createDebug: (/** @type {string} */ category) => actual.createDebug(category, { search: () => search, output })
    };
  });
  vi.resetModules();
  const module = await import('../../src/data/cli-queue.js');
  module.configureCliQueue(true);
  return { ...module, output };
}

/** @param {string} body */
function streamResponse(body) {
  return new Response(body, { status: 200 });
}

afterEach(() => {
  vi.doUnmock('../../src/debug.js');
  vi.resetModules();
  vi.unstubAllGlobals();
});

describe('cli-queue debug logging', () => {
  it('is disabled by default', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 500 })));
    const { cliQueueOperation, output } = await loadCliQueue('');
    await expect(cliQueueOperation({ action: 'list' })).rejects.toThrow();
    expect(output.debug).not.toHaveBeenCalled();
  });

  it('logs failed requests with status only, not server messages or URLs', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ error: 'secret-message' }), { status: 503 })));
    const { cliQueueOperation, output } = await loadCliQueue('?debug=cli-queue');
    await expect(cliQueueOperation({ action: 'list', status: 'private-filter' })).rejects.toThrow();
    expect(output.debug).toHaveBeenCalledWith('[cao:cli-queue]', { event: 'request-failed', method: 'GET', status: 503 });
    expect(JSON.stringify(output.debug.mock.calls)).not.toMatch(/secret-message|private-filter/);
  });

  it('logs attach completion metadata without output content', async () => {
    const lines = [
      { type: 'output', sequence: 3, text: 'private-output' },
      { type: 'complete', status: 'completed' }
    ].map((event) => JSON.stringify(event)).join('\n');
    vi.stubGlobal('fetch', vi.fn(async () => streamResponse(lines)));
    const { cliQueueOperation, output } = await loadCliQueue('?debug=cli-*');
    await cliQueueOperation({ action: 'attach', commandId: 7, after: 1 });
    expect(output.debug).toHaveBeenCalledWith('[cao:cli-queue]', { event: 'attach', after: 1, lastSequence: 3, completed: true });
    expect(JSON.stringify(output.debug.mock.calls)).not.toContain('private-output');
  });

  it('is excluded by a negative pattern', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 500 })));
    const { cliQueueOperation, output } = await loadCliQueue('?debug=1,-cli-queue');
    await expect(cliQueueOperation({ action: 'list' })).rejects.toThrow();
    expect(output.debug).not.toHaveBeenCalled();
  });
});
