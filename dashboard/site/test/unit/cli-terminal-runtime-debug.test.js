// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';

const writes = vi.hoisted(() => vi.fn());
vi.mock('@xterm/xterm', () => ({
  Terminal: class {
    textarea = null;
    loadAddon() {}
    open() {}
    dispose() {}
    write = writes;
    reset() {}
  }
}));
vi.mock('@xterm/addon-fit', () => ({ FitAddon: class { fit() {} } }));
vi.mock('@xterm/addon-web-links', () => ({ WebLinksAddon: class {} }));
vi.mock('@xterm/xterm/css/xterm.css', () => ({ default: '' }));

/** @param {string} search */
async function loadRuntime(search) {
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
  writes.mockClear();
  const module = await import('../../src/components/cli-terminal-runtime.js');
  return { ...module, output };
}

/** @returns {typeof ResizeObserver} */
function stubResizeObserver() {
  vi.stubGlobal('ResizeObserver', class {
    observe() {}
    disconnect() {}
  });
  return ResizeObserver;
}

afterEach(() => {
  vi.doUnmock('../../src/debug.js');
  vi.unstubAllGlobals();
  vi.resetModules();
});

describe('cli-terminal-runtime debug logging', () => {
  it('provides plain clipboard text without altering colored terminal output', async () => {
    stubResizeObserver();
    const { mountTerminal } = await loadRuntime('');
    const controller = new AbortController();
    const terminal = mountTerminal(document.createElement('div'), controller.signal);
    const colored = '\x1b[1;38;2;10;20;30mCommand output\x1b[0m\r\n';
    terminal.write(colored);
    expect(terminal.plainText(colored)).toBe('Command output\r\n');
    expect(writes).toHaveBeenCalledExactlyOnceWith(colored);
    controller.abort();
  });

  it('preserves ANSI sequences and color state across stdout and stderr chunks', async () => {
    stubResizeObserver();
    const { mountTerminal } = await loadRuntime('');
    const controller = new AbortController();
    const terminal = mountTerminal(document.createElement('div'), controller.signal);
    terminal.write('\x1b[3', 'stderr');
    terminal.write('2mProgress', 'stderr');
    terminal.write(' complete\x1b[0m\r\n', 'stderr');
    terminal.write('\x1b[38;5;208mIndexed\x1b[0m\r\n');
    terminal.write('\x1b[38;2;10;20;30mTrue color\x1b[0m\r\n');
    terminal.write('Normal output.\r\n');
    expect(writes.mock.calls).toEqual([
      ['\x1b[3'],
      ['2mProgress'],
      [' complete\x1b[0m\r\n'],
      ['\x1b[38;5;208mIndexed\x1b[0m\r\n'],
      ['\x1b[38;2;10;20;30mTrue color\x1b[0m\r\n'],
      ['Normal output.\r\n']
    ]);
    controller.abort();
    terminal.write('Late error', 'stderr');
    expect(writes).toHaveBeenCalledTimes(6);
  });

  it('is disabled by default', async () => {
    stubResizeObserver();
    const { mountTerminal, output } = await loadRuntime('');
    const controller = new AbortController();
    mountTerminal(document.createElement('div'), controller.signal);
    controller.abort();
    expect(output.debug).not.toHaveBeenCalled();
  });

  it('logs mount and disposal under its predictable category without sensitive data', async () => {
    stubResizeObserver();
    const { mountTerminal, output } = await loadRuntime('?debug=cli-terminal-runtime');
    const controller = new AbortController();
    const terminal = mountTerminal(document.createElement('div'), controller.signal);
    terminal.write('secret-token');
    controller.abort();

    expect(output.debug).toHaveBeenNthCalledWith(1, '[cao:cli-terminal-runtime]', { event: 'mounted', scrollback: 5000 });
    expect(output.debug).toHaveBeenNthCalledWith(2, '[cao:cli-terminal-runtime]', { event: 'disposed', aborted: true });
    expect(JSON.stringify(output.debug.mock.calls)).not.toContain('secret-token');
  });

  it('honours category exclusion', async () => {
    stubResizeObserver();
    const { mountTerminal, output } = await loadRuntime('?debug=*,-cli-terminal-runtime');
    mountTerminal(document.createElement('div'), new AbortController().signal);
    expect(output.debug).not.toHaveBeenCalled();
  });
});
