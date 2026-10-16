// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';

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
  vi.doMock('../../src/components/cli-terminal-runtime.js', () => ({
    mountTerminal: () => ({ secret: 'terminal-secret' })
  }));
  vi.resetModules();
  const module = await import('../../src/components/cli-terminal.js');
  return { ...module, output };
}

afterEach(() => {
  vi.doUnmock('../../src/debug.js');
  vi.doUnmock('../../src/components/cli-terminal-runtime.js');
  vi.resetModules();
});

describe('cli-terminal debug logging', () => {
  it('is disabled by default', async () => {
    const { createCliTerminal, output } = await load('');
    await createCliTerminal(new AbortController().signal);
    expect(output.debug).not.toHaveBeenCalled();
  });

  it('logs load completion under cli-terminal with scalar metadata only', async () => {
    const { createCliTerminal, output } = await load('?debug=cli-terminal');
    await createCliTerminal(new AbortController().signal);
    expect(output.debug).toHaveBeenCalledWith(
      '[cao:cli-terminal]',
      expect.objectContaining({ event: 'runtime-loaded', status: 'ok', durationMs: expect.any(Number) })
    );
    expect(JSON.stringify(output.debug.mock.calls)).not.toContain('terminal-secret');
  });

  it('logs aborted loads and honors exclusion', async () => {
    const controller = new AbortController();
    controller.abort();
    const { createCliTerminal, output } = await load('?debug=cli-*');
    await expect(createCliTerminal(controller.signal)).rejects.toThrow('Terminal closed.');
    expect(output.debug).toHaveBeenCalledWith(
      '[cao:cli-terminal]',
      expect.objectContaining({ event: 'runtime-load-aborted', status: 'aborted' })
    );
    const excluded = await load('?debug=*,-cli-terminal');
    await excluded.createCliTerminal(new AbortController().signal);
    expect(excluded.output.debug).not.toHaveBeenCalled();
  });
});
