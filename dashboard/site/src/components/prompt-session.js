import { h } from '../dom.js';
import { effect, state } from '../reactive.js';
import { createFactoryScope } from './factory-elements.js';
import { renderLiveRegion } from './ui-primitives.js';
import { publishNotification } from '../notification-service.js';
import { createDebug, diagnosticErrorName } from '../debug.js';

const debug = createDebug('prompt-session');

/** @param {() => string} getPrompt */
export function createPromptSessionControl(getPrompt) {
  const endpoint = document.querySelector('meta[name="dashboard-copilot-session"]')?.getAttribute('content');
  if (!endpoint) return null;
  const url = new URL(endpoint, window.location.href);
  if (url.origin !== window.location.origin) throw new Error('Copilot session endpoint must be same-origin.');
  const scope = createFactoryScope();
  const busy = state(false);
  const started = state(false);
  const message = state('');
  const status = renderLiveRegion('output', 'table-intent-copy-status');
  const button = /** @type {HTMLButtonElement} */ (h('button', {
    type: 'button', className: 'table-intent-copy-button',
    onClick: async () => {
      if (scope.signal.aborted || busy.get() || started.get()) return;
      debug({ event: 'start', status: 'requested' });
      busy.set(true);
      message.set('Starting session...');
      try {
        const response = await fetch(url, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ prompt: getPrompt() }), signal: scope.signal,
        });
        const result = await response.json();
        if (!response.ok || result.ok !== true) throw new Error(result.error || 'Could not start the Copilot session.');
        if (scope.signal.aborted) return;
        debug({ event: 'start', status: 'started', httpStatus: response.status });
        started.set(true);
        message.set('Session started in the Copilot app.');
      } catch (cause) {
        if (scope.signal.aborted) return;
        debug({ event: 'start', status: 'failed', errorName: diagnosticErrorName(cause) });
        const error = cause instanceof Error ? cause.message : 'Could not start the Copilot session.';
        message.set(error);
        publishNotification({ message: error, tone: 'error' });
      } finally {
        if (!scope.signal.aborted) busy.set(false);
      }
    },
  }, 'Start session'));
  effect(() => {
    button.disabled = busy.get() || started.get();
    status.textContent = message.get();
  }, { signal: scope.signal });
  scope.bind(button);
  return {
    button, status,
    reset() {
      if (busy.get()) return;
      started.set(false);
      message.set('');
    },
  };
}
