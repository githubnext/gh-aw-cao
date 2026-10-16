import { h } from '../dom.js';
import { createDebug, diagnosticErrorName } from '../debug.js';

const debugCliTerminal = createDebug('cli-terminal');

/** @param {AbortSignal} signal */
export async function createCliTerminal(signal) {
  const root = h('div', {
    className: 'cli-action-terminal',
    role: 'region',
    'aria-label': 'Read-only command terminal'
  });
  const startedAt = Date.now();
  let runtime;
  try {
    runtime = await import('./cli-terminal-runtime.js');
  } catch (error) {
    debugCliTerminal({ event: 'runtime-load-failed', status: 'error', error: diagnosticErrorName(error) });
    throw error;
  }
  if (signal.aborted) {
    debugCliTerminal({ event: 'runtime-load-aborted', status: 'aborted', durationMs: Date.now() - startedAt });
    throw new DOMException('Terminal closed.', 'AbortError');
  }
  debugCliTerminal({ event: 'runtime-loaded', status: 'ok', durationMs: Date.now() - startedAt });
  return { root, ...runtime.mountTerminal(root, signal) };
}
