import { h } from '../dom.js';
import { state, effect } from '../reactive.js';
import { attachCliCommand, cancelCliCommand, retryCliCommand, requestCliQueue, cliQueueAvailable } from '../data-processor.js';
import { createFactoryScope } from './factory-elements.js';
import { createCliTerminal } from './cli-terminal.js';
import { publishNotification } from '../notification-service.js';

/** @param {import('./ui-elements.js').ElementRenderContext} context */
export function renderCommandTerminal(context) {
  const scope = createFactoryScope();
  const id = context.routeParameters?.command;
  const message = state('Loading command…');
  const status = state('');
  const busy = state(false);
  const output = h('div', { className: 'cli-action-terminal-output' });
  const statusNode = h('output', { role: 'status', 'aria-live': 'polite' });
  /** @type {AbortController | undefined} */
  let attachment;
  /** @type {Awaited<ReturnType<typeof createCliTerminal>> | undefined} */
  let terminal;
  let currentId = id;
  const attach = async () => {
    if (!currentId) return;
    attachment?.abort();
    const controller = new AbortController();
    attachment = controller;
    const abort = () => controller.abort();
    scope.signal.addEventListener('abort', abort, { once: true });
    try {
      const command = await requestCliQueue({ action: 'get', commandId: currentId }, { signal: controller.signal });
      if (controller.signal.aborted) return;
      status.set(command.status);
      message.set(`${command.id} · ${command.status}. Closing this page only detaches.`);
      terminal ??= await createCliTerminal(scope.signal);
      if (controller.signal.aborted) return;
      output.append(terminal.root);
      terminal.reset();
      const complete = await attachCliCommand(currentId, (event) => terminal?.write(event.data), controller.signal);
      if (controller.signal.aborted) return;
      status.set(complete.command.status);
      message.set(`${complete.command.id} · ${complete.command.status}`);
      if (complete.result.error) terminal.write(`\r\n${complete.result.error}\r\n`);
    } catch (error) {
      if (!controller.signal.aborted) message.set(error instanceof Error ? error.message : 'Command output unavailable.');
    } finally {
      scope.signal.removeEventListener('abort', abort);
    }
  };
  const cancel = h('button', {
    type: 'button', className: 'cli-action-cancel',
    onClick: async () => {
      if (!currentId) return;
      busy.set(true);
      try {
        const command = await cancelCliCommand(currentId, scope.signal);
        status.set(command.status);
        message.set(`${command.id} · ${command.status}`);
      } catch (error) {
        publishNotification({ message: error instanceof Error ? error.message : 'Cancellation failed.', tone: 'error' });
      } finally { busy.set(false); }
    }
  }, 'Cancel command');
  const retry = h('button', {
    type: 'button', className: 'cli-action-confirm',
    onClick: async () => {
      if (!currentId) return;
      busy.set(true);
      try {
        const command = await retryCliCommand(currentId, scope.signal);
        if (scope.signal.aborted) return;
        const previousId = currentId;
        currentId = command.id;
        window.location.hash = `page-command?command=${encodeURIComponent(command.id)}`;
        if (previousId === currentId) void attach();
      } catch (error) {
        publishNotification({ message: error instanceof Error ? error.message : 'Retry failed.', tone: 'error' });
      } finally { busy.set(false); }
    }
  }, 'Retry command');
  const reconnect = h('button', {
    type: 'button', className: 'cli-action-cancel', onClick: () => { void attach(); }
  }, 'Reconnect output');
  const root = h('section', { className: 'command-terminal', 'aria-label': 'Persistent command terminal' },
    statusNode, output,
    h('footer', { className: 'cli-action-dialog-footer' }, cancel, retry, reconnect,
      h('a', { href: '#page-commands' }, 'Back to Commands'))
  );
  effect(() => {
    statusNode.textContent = message.get();
    cancel.hidden = !['queued', 'running', 'paused'].includes(status.get());
    retry.hidden = !['failed', 'cancelled'].includes(status.get());
    /** @type {HTMLButtonElement} */ (cancel).disabled = busy.get();
    /** @type {HTMLButtonElement} */ (retry).disabled = busy.get();
  }, { signal: scope.signal });
  scope.bind(root);
  if (!cliQueueAvailable()) {
    message.set('Command queue is available only in an authorized local admin or canvas dashboard.');
    reconnect.hidden = true;
  } else if (!id) {
    message.set('Select a command from Maintenance → Commands.');
    reconnect.hidden = true;
  } else void attach();
  return root;
}
