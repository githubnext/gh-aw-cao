import { h } from '../dom.js';
import { state, effect } from '../reactive.js';
import { attachCliCommand, cancelCliCommand, retryCliCommand, requestCliQueue, cliQueueAvailable } from '../data-processor.js';
import { createFactoryScope } from './factory-elements.js';
import { createCliTerminal } from './cli-terminal.js';
import { publishNotification } from '../notification-service.js';
import { createModalDialog, renderCloseButton } from './ui-primitives.js';

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
  /** @type {Promise<Awaited<ReturnType<typeof createCliTerminal>>> | undefined} */
  let terminalPromise;
  let currentId = id;
  const { dialog, open, close: closeModal } = createModalDialog({
    className: 'cli-action-dialog cli-action-running',
    ariaLabel: 'Command console log'
  });
  const close = () => {
    attachment?.abort();
    closeModal();
    window.location.hash = 'page-commands';
  };
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
      message.set(`${command.id} · ${command.status}. Closing this console only detaches.`);
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
      if (!currentId || busy.get() || scope.signal.aborted) return;
      busy.set(true);
      try {
        const command = await cancelCliCommand(currentId, scope.signal);
        if (scope.signal.aborted) return;
        status.set(command.status);
        message.set(`${command.id} · ${command.status}`);
      } catch (error) {
        if (!scope.signal.aborted) publishNotification({ message: error instanceof Error ? error.message : 'Cancellation failed.', tone: 'error' });
      } finally { busy.set(false); }
    }
  }, 'Cancel command');
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
  const reconnect = h('button', {
    type: 'button', className: 'cli-action-cancel', onClick: () => { void attach(); }
  }, 'Reconnect output');
  dialog.append(
    h('header', { className: 'cli-action-dialog-header' },
      h('div', { className: 'command-console-heading' },
        h('h2', null, 'Command console log'), statusNode),
      renderCloseButton({ className: 'cli-action-dialog-close', label: 'Close command console', onClick: close })),
    h('div', { className: 'cli-action-dialog-body' }, output),
    h('footer', { className: 'cli-action-dialog-footer' }, cancel, retry, reconnect,
      h('button', { type: 'button', className: 'cli-action-cancel', onClick: close }, 'Back to Commands'))
  );
  const root = h('section', { className: 'command-terminal', 'aria-label': 'Persistent command terminal' }, dialog);
  dialog.addEventListener('cancel', (event) => { event.preventDefault(); close(); }, { signal: scope.signal });
  dialog.addEventListener('close', () => {
    if (!scope.signal.aborted) {
      attachment?.abort();
      window.location.hash = 'page-commands';
    }
  }, { signal: scope.signal });
  scope.signal.addEventListener('abort', closeModal, { once: true });
  const mountObserver = new MutationObserver(() => {
    if (root.isConnected && !scope.signal.aborted) {
      mountObserver.disconnect();
      open();
    }
  });
  mountObserver.observe(document, { childList: true, subtree: true });
  scope.signal.addEventListener('abort', () => mountObserver.disconnect(), { once: true });
  effect(() => {
    statusNode.textContent = message.get();
    cancel.hidden = !['queued', 'running'].includes(status.get());
    retry.hidden = !['failed', 'timed-out'].includes(status.get());
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
