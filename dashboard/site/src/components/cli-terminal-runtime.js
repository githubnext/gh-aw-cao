import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { WebLinksAddon } from '@xterm/addon-web-links';
import terminalStyles from '@xterm/xterm/css/xterm.css';
import { h } from '../dom.js';
import { createDebug } from '../debug.js';

const debugRuntime = createDebug('cli-terminal-runtime');

/**
 * Terminal emulation is interaction-only: Dashboard Language still owns action
 * declarations. Isolate the vendor's required CSS from dashboard styles.
 * @param {HTMLElement} root
 * @param {AbortSignal} signal
 */
export function mountTerminal(root, signal) {
  const shadow = root.attachShadow({ mode: 'open' });
  const container = h('div', { className: 'terminal-container' });
  shadow.append(h('style', null, terminalStyles + `
    :host { display: block; }
    .terminal-container { height: 100%; padding: 8px; box-sizing: border-box; }
    .xterm { height: 100%; }
  `), container);
  const terminal = new Terminal({
    disableStdin: true,
    cursorBlink: false,
    cursorInactiveStyle: 'none',
    convertEol: true,
    scrollback: 5000,
    fontSize: 13,
    screenReaderMode: true,
    // A terminal palette is deliberately independent of dashboard light mode.
    theme: {
      background: '#0d1117', foreground: '#e6edf3',
      black: '#484f58', red: '#ff7b72', green: '#3fb950', yellow: '#d29922',
      blue: '#58a6ff', magenta: '#bc8cff', cyan: '#39c5cf', white: '#b1bac4',
      brightBlack: '#6e7681', brightRed: '#ffa198', brightGreen: '#7ee787', brightYellow: '#e3b341',
      brightBlue: '#79c0ff', brightMagenta: '#d2a8ff', brightCyan: '#56d4dd', brightWhite: '#f0f6fc'
    }
  });
  const fit = new FitAddon();
  terminal.loadAddon(fit);
  terminal.loadAddon(new WebLinksAddon((_event, uri) => {
    window.open(uri, '_blank', 'noopener,noreferrer');
  }));
  terminal.open(container);
  terminal.textarea?.setAttribute('readonly', '');
  const resize = () => {
    if (root.clientWidth && root.clientHeight) fit.fit();
  };
  const observer = new ResizeObserver(resize);
  observer.observe(root);
  resize();
  debugRuntime({ event: 'mounted', scrollback: 5000 });
  const dispose = () => {
    observer.disconnect();
    terminal.dispose();
    debugRuntime({ event: 'disposed', aborted: signal.aborted });
  };
  signal.addEventListener('abort', dispose, { once: true });
  if (signal.aborted) dispose();
  return {
    /** @param {string} data @param {'stdout'|'stderr'} [_stream] */
    write(data, _stream = 'stdout') {
      // Preserve ANSI state across chunks; stderr also carries colored progress.
      if (!signal.aborted) terminal.write(data);
    },
    reset() { if (!signal.aborted) terminal.reset(); }
  };
}
