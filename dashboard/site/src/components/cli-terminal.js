import { h } from '../dom.js';

/** @param {AbortSignal} signal */
export async function createCliTerminal(signal) {
  const root = h('div', {
    className: 'cli-action-terminal',
    role: 'region',
    'aria-label': 'Read-only command terminal'
  });
  const { mountTerminal } = await import('./cli-terminal-runtime.js');
  if (signal.aborted) throw new DOMException('Terminal closed.', 'AbortError');
  return { root, ...mountTerminal(root, signal) };
}
