import { h } from '../dom.js';
import { octicon } from '../octicons.js';
import { state, effect } from '../reactive.js';
import { attachCliCommand, cancelCliCommand, retryCliCommand, requestCliQueue, cliQueueAvailable } from '../data-processor.js';
import { createFactoryScope } from './factory-elements.js';
import { createCliTerminal } from './cli-terminal.js';
import { publishNotification } from '../notification-service.js';
import { createDebug, diagnosticErrorName } from '../debug.js';

const debugCommandTerminal = createDebug('command-terminal');

/** @param {import('./ui-elements.js').ElementRenderContext} context */
export function renderCommandTerminal(context) {
  const scope = createFactoryScope();
  const id = context.routeParameters?.command;
  const message = state('Loading command…');
  const title = state(context.title);
  const status = state('');
  const busy = state(false);
  const output = h('div', { className: 'cli-action-terminal-output' });
  const statusNode = h('output', { className: 'sr-only', role: 'status', 'aria-live': 'polite' });
  /** @type {AbortController | undefined} */
  let attachment;
  /** @type {Awaited<ReturnType<typeof createCliTerminal>> | undefined} */
  let terminal;
  /** @type {Promise<Awaited<ReturnType<typeof createCliTerminal>>> | undefined} */
  let terminalPromise;
  let currentId = id;
  const attach = async () => {
    if (!currentId || scope.signal.aborted) return;
    attachment?.abort();
    const controller = new AbortController();
    attachment = controller;
    const abort = () => controller.abort();
    scope.signal.addEventListener('abort', abort, { once: true });
    try {
      const command = await requestCliQueue({ action: 'get', commandId: currentId }, { signal: controller.signal });
      if (controller.signal.aborted) return;
      status.set(command.status);
      title.set(command.command || context.title);
      message.set(`${command.id} · ${command.status}`);
      terminalPromise ??= createCliTerminal(scope.signal).catch((error) => {
        terminalPromise = undefined;
        throw error;
      });
      const mountedTerminal = await terminalPromise;
      if (controller.signal.aborted) return;
      terminal = mountedTerminal;
      output.append(terminal.root);
      terminal.reset();
      const complete = await attachCliCommand(currentId, (event) => {
        if (!controller.signal.aborted) terminal?.write(event.data);
      }, controller.signal);
      if (controller.signal.aborted) return;
      status.set(complete.command.status);
      message.set(`${complete.command.id} · ${complete.command.status}`);
      debugCommandTerminal({ event: 'attach', outcome: 'complete', status: complete.command.status, failed: Boolean(complete.result.error) });
      if (complete.result.error) terminal.write(`\r\n${complete.result.error}\r\n`);
    } catch (error) {
      if (!controller.signal.aborted) {
        debugCommandTerminal({ event: 'attach', outcome: 'error', error: diagnosticErrorName(error) });
        message.set(error instanceof Error ? error.message : 'Command output unavailable.');
      }
    } finally {
      scope.signal.removeEventListener('abort', abort);
    }
  };
  const cancel = h('button', {
    type: 'button', className: 'cli-action-cancel',
    'aria-label': 'Cancel command',
    onClick: async () => {
      if (!currentId || busy.get() || scope.signal.aborted) return;
      busy.set(true);
      try {
        const command = await cancelCliCommand(currentId, scope.signal);
        if (scope.signal.aborted) return;
        debugCommandTerminal({ event: 'cancel', status: command.status });
        status.set(command.status);
        message.set(`${command.id} · ${command.status}`);
      } catch (error) {
        if (!scope.signal.aborted) publishNotification({ message: error instanceof Error ? error.message : 'Cancellation failed.', tone: 'error' });
      } finally { busy.set(false); }
    }
  }, octicon('x'), 'Cancel');
  const retry = h('button', {
    type: 'button', className: 'cli-action-confirm',
    onClick: async () => {
      if (!currentId || busy.get() || scope.signal.aborted) return;
      busy.set(true);
      try {
        const command = await retryCliCommand(currentId, scope.signal);
        if (scope.signal.aborted) return;
        const previousId = currentId;
        currentId = command.id;
        window.location.hash = `page-command?command=${encodeURIComponent(command.id)}`;
        if (previousId === currentId) void attach();
      } catch (error) {
        if (!scope.signal.aborted) publishNotification({ message: error instanceof Error ? error.message : 'Retry failed.', tone: 'error' });
      } finally { busy.set(false); }
    }
  }, 'Retry command');
  const actions = h('div', { className: 'command-terminal-actions' }, cancel, retry);
  const root = h('section', { className: 'command-terminal', 'aria-label': 'Command console log' },
    statusNode,
    h('div', { className: 'cli-action-dialog-body' }, output),
    actions
  );
  effect(() => {
    statusNode.textContent = message.get();
    root.dispatchEvent(new CustomEvent('dashboard-route-allocation', {
      bubbles: true,
      detail: { title: title.get(), description: message.get() }
    }));
    cancel.hidden = !['queued', 'running'].includes(status.get());
    retry.hidden = !['failed', 'timed-out'].includes(status.get());
    actions.hidden = cancel.hidden && retry.hidden;
    /** @type {HTMLButtonElement} */ (cancel).disabled = busy.get();
    /** @type {HTMLButtonElement} */ (retry).disabled = busy.get();
  }, { signal: scope.signal });
  scope.bind(root);
  if (!cliQueueAvailable()) {
    message.set('Command queue is available only in an authorized local admin or canvas dashboard.');
  } else if (!id) {
    message.set('Select a command from Maintenance → Commands.');
  } else void attach();
  return root;
}
