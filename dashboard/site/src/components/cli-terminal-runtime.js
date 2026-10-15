import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { WebLinksAddon } from '@xterm/addon-web-links';
import terminalStyles from '@xterm/xterm/css/xterm.css';
import { h } from '../dom.js';

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
    theme: { background: '#0d1117', foreground: '#e6edf3' }
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
  const dispose = () => {
    observer.disconnect();
    terminal.dispose();
  };
  signal.addEventListener('abort', dispose, { once: true });
  if (signal.aborted) dispose();
  return {
    /** @param {string} data */
    write(data) { if (!signal.aborted) terminal.write(data); },
    reset() { if (!signal.aborted) terminal.reset(); }
  };
}
