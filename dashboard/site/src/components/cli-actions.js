import { h } from '../dom.js';
import { octicon } from '../octicons.js';
import { renderCliActionCommand } from '../cli-action-template.js';
import { createCopyControl, createModalDialog, renderCloseButton, renderLiveRegion } from './ui-primitives.js';
import { createDebug } from '../debug.js';
import { createFactoryScope } from './factory-elements.js';
import { effect, state } from '../reactive.js';
import { assertActionLevel, normalizeAction, actionPresentation } from '../action-model.js';
import { createDialogSelector } from './dialog-selector.js';
import { createCliTerminal } from './cli-terminal.js';
import { enqueueCliCommand, attachCliCommand, cancelCliCommand, cliQueueAvailable, subscribeCanonicalDashboardView } from '../data-processor.js';
import { publishNotification } from '../notification-service.js';

const debugCliActions = createDebug('cli-actions');

/** @type {Array<{ id: string, level?: import('../action-model.js').ActionLevel, verb?: string, label: string, description?: string, icon: string, command: string, placement?: 'toolbar'|'settings'|'view'|'row', 'copy-only'?: boolean, selector?: import('../dialog-selector.js').DialogSelector, arguments?: Array<{ id: string, label: string, description?: string, type: 'boolean', flag: string, default?: boolean }> }>} */
let declaredCliActions = [];
let declaredCliActionsCanExecute = true;
/** @type {Record<string, string>} */
let declaredCliActionTemplateValues = {};

/** @param {typeof declaredCliActions} actions @param {{ canExecute?: boolean, templateValues?: Record<string, string> }} [options] */
export function setDeclaredCliActions(actions, options = {}) {
  declaredCliActions = Array.isArray(actions)
    ? actions.map((action) => ({ ...normalizeAction(action, { id: action.id, type: 'cli' }), ...action })) : [];
  declaredCliActionsCanExecute = options.canExecute !== false;
  declaredCliActionTemplateValues = options.templateValues ?? {};
}

/** @returns {string | undefined} */
export function declaredAgentTaskActionId() {
  return declaredCliActions.find((action) => action.command === 'gh agent-task create --from-file -'
    && action.placement === 'row')?.id;
}

/**
 * @param {string} id
 * @param {Record<string, boolean>} argumentsValue
 * @param {Record<string, string>} templateValues
 * @param {(event: { stream: 'stdout'|'stderr', data: string }) => void} onOutput
 * @param {string | undefined} [input]
 * @param {AbortSignal} [signal]
 * @param {(command: { id: string }) => void | Promise<void>} [onEnqueued]
 */
async function executeAction(id, argumentsValue, templateValues, onOutput, input, signal, onEnqueued) {
  /** @type {Record<string, unknown>} */
  const payload = { id, arguments: argumentsValue, idempotencyKey: crypto.randomUUID() };
  if (Object.keys(templateValues).length > 0) payload.values = templateValues;
  if (input !== undefined) payload.input = input;
  const command = await enqueueCliCommand(payload, signal);
  await onEnqueued?.(command);
  const complete = await attachCliCommand(command.id, (event) => onOutput(
    /** @type {{ stream: 'stdout'|'stderr', data: string }} */ (event)
  ), signal);
  if (complete.command?.status === 'canceled') {
    return { ...complete.result, error: 'Cancelled. Completed changes are not undone.' };
  }
  return complete.result;
}

/**
 * @param {Parameters<typeof executeAction>[0]} id
 * @param {Parameters<typeof executeAction>[1]} argumentsValue
 * @param {Array<Record<string, string>>} targets
 * @param {Parameters<typeof executeAction>[3]} onOutput
 * @param {AbortSignal} signal
 * @param {NonNullable<Parameters<typeof executeAction>[6]>} onEnqueued
 */
async function executeActionTargets(id, argumentsValue, targets, onOutput, signal, onEnqueued) {
  const results = await Promise.allSettled(targets.map((values, index) => executeAction(
    id, argumentsValue, values,
    (event) => onOutput({ ...event, data: targets.length > 1 ? `[${index + 1}] ${event.data}` : event.data }),
    undefined, signal, onEnqueued
  )));
  signal.throwIfAborted();
  const rejected = results.find((result) => result.status === 'rejected');
  if (rejected?.status === 'rejected') throw rejected.reason;
  const outcomes = results.flatMap((result) => result.status === 'fulfilled' ? [result.value] : []);
  return outcomes.find((result) => !result.ok) ?? outcomes[0];
}

/** @param {{ stdout?: string, stderr?: string }} result */
function resultText(result) {
  const sections = [];
  if (result.stdout) sections.push(result.stdout.trimEnd());
  if (result.stderr) sections.push(result.stderr.trimEnd());
  return sections.filter(Boolean).join('\n') || 'Command completed without output.';
}

/**
 * Create the canvas-only control that starts an agent task from a generated prompt.
 * @param {string} actionId
 * @param {() => string} getPrompt
 * @param {{ level?: import('../action-model.js').ActionLevel, label?: string }} [options]
 */
export function createPromptCliActionControl(actionId, getPrompt, options = {}) {
  assertActionLevel(options.level ?? 'propose', 'prompt');
  const action = declaredCliActions.find((candidate) => candidate.id === actionId);
  if (!declaredCliActionsCanExecute || !cliQueueAvailable() || !action || action['copy-only'] === true) return null;
  const scope = createFactoryScope();
  const status = /** @type {HTMLOutputElement} */ (renderLiveRegion('output', 'table-intent-copy-status'));
  const output = h('pre', { className: 'cli-action-output', hidden: true });

  // `busy`, `statusText`, `outputVisible`, and `outputText` are this control's
  // entire visible state; the effect below is the only place that writes
  // them onto the owned `button`/`status`/`output` nodes.
  const busy = state(false);
  const statusText = state('');
  const outputVisible = state(false);
  const outputText = state('');

  const button = /** @type {HTMLButtonElement} */ (h('button', {
    type: 'button',
    className: 'table-intent-copy-button',
    onClick: async () => {
      busy.set(true);
      statusText.set('Starting agent task…');
      outputText.set('');
      outputVisible.set(true);
      try {
        const result = await executeAction(action.id, {}, {}, ({ data }) => {
          outputText.set((current) => current + data);
          output.scrollTop = output.scrollHeight;
        }, getPrompt(), scope.signal);
        statusText.set(result.ok ? 'Agent task started.' : (result.error || 'Could not start agent task.'));
        if (!outputText.get()) outputText.set(resultText(result));
      } catch (error) {
        statusText.set(error instanceof Error ? error.message : 'Could not start agent task.');
      } finally {
        busy.set(false);
      }
    }
  }, options.level === 'operate' ? options.label ?? action.label : 'Start agent task'));
  effect(() => {
    button.disabled = busy.get();
    status.textContent = statusText.get();
    output.hidden = !outputVisible.get();
    output.textContent = outputText.get();
  }, { signal: scope.signal });
  scope.bind(button);
  return {
    button,
    status,
    output,
    reset() {
      statusText.set('');
      outputText.set('');
      outputVisible.set(false);
      busy.set(false);
    }
  };
}

/**
 * @param {{ command: string, arguments?: Array<{ id: string, flag: string }> }} action
 * @param {Record<string, boolean>} values
 * @param {Record<string, string>} templateValues
 */
function commandPreview(action, values, templateValues) {
  const command = [
    renderCliActionCommand(action.command, templateValues),
    ...(action.arguments ?? []).filter((argument) => values[argument.id]).map((argument) => argument.flag)
  ].join(' ');
  const userAgentData = typeof navigator === 'undefined'
    ? undefined
    : /** @type {{ platform?: unknown }} */ (Reflect.get(navigator, 'userAgentData'));
  const platform = typeof userAgentData?.platform === 'string'
    ? userAgentData.platform
    : typeof navigator === 'undefined' ? '' : navigator.platform || navigator.userAgent;
  const userAgent = typeof navigator === 'undefined' ? '' : navigator.userAgent;
  // Windows terminals need an explicit Bash interpreter; leave other commands untouched.
  return (/^win/i.test(platform) || /windows/i.test(userAgent))
    && /^(?:"[^"]+\.sh"|'[^']+\.sh'|\S+\.sh)(?:\s|$)/.test(command)
    ? `bash ${command}`
    : command;
}

/**
 * @param {{ id: string, label: string, description?: string, icon: string, command: string, 'copy-only'?: boolean, selector?: import('../dialog-selector.js').DialogSelector, arguments?: Array<{ id: string, label: string, description?: string, type: 'boolean', flag: string, default?: boolean }> }} action
 * @param {{ presentation?: 'menu'|'settings'|'row', templateValues?: Record<string, string>, canExecute?: boolean, showRowLabel?: boolean, batch?: { targets: Array<Record<string, string>>, error?: string } }} [options]
 */
function renderCliActionControl(action, options = {}) {
  const presentation = actionPresentation(normalizeAction(action, { id: action.id, type: 'cli' }));
  const settingsPresentation = options.presentation === 'settings';
  const rowPresentation = options.presentation === 'row';
  const canExecute = options.canExecute !== false && cliQueueAvailable() && action['copy-only'] !== true;
  const confirmationLabel = presentation.label;
  const templateValues = { ...options.templateValues };
  const templateTargets = options.batch?.targets ?? [templateValues];
  const preview = () => options.batch?.error ?? (action.selector && !templateValues[action.selector.mapping.target]
    ? 'Select a repository to review the command.'
    : templateTargets.map((values) => commandPreview(action, argumentValues, values)).join('\n'));
  const argumentValues = Object.fromEntries(
    (action.arguments ?? []).map((argument) => [argument.id, argument.default === true])
  );
  /** @type {HTMLButtonElement} */
  let trigger;
  /** @type {HTMLElement} */
  let command;
  // `commandPreviewText` is the command node's entire visible state; the
  // effect below is the only place that writes it onto the owned `command`
  // node, replacing the three scattered `command.textContent` writes
  // previously made from the checkbox listener, `resetArguments`, and the
  // dialog-open handler.
  const commandPreviewText = state(preview());
  const inputs = (action.arguments ?? []).map((argument) => {
    const input = /** @type {HTMLInputElement} */ (h('input', {
      type: 'checkbox',
      checked: argument.default === true,
      onChange: (/** @type {Event} */ event) => {
        argumentValues[argument.id] = /** @type {HTMLInputElement} */ (event.currentTarget).checked;
        commandPreviewText.set(preview());
      }
    }));
    return {
      argument,
      input,
      element: h(
        'label',
        { className: 'cli-action-argument' },
        input,
        h(
          'span',
          null,
          h('strong', null, argument.label),
          argument.description ? h('small', null, argument.description) : null
        )
      )
    };
  });
  const resetArguments = () => {
    for (const { argument, input } of inputs) {
      const checked = argument.default === true;
      argumentValues[argument.id] = checked;
      input.checked = checked;
    }
    commandPreviewText.set(preview());
  };
  const { dialog, open, close: closeModal } = createModalDialog({
    className: 'cli-action-dialog',
    ariaLabel: `Approve ${action.label}`,
    onFallbackClose: () => trigger.focus()
  });
  const close = () => {
    runController?.abort();
    selector?.cancel();
    showTerminalWindow.set(false);
    closeModal();
  };
  const copyControl = canExecute ? null : createCopyControl({
    getContent: () => commandPreviewText.get(),
    label: 'Copy command',
    buttonClassName: 'cli-action-confirm',
    statusClassName: 'cli-action-status',
    successText: 'Command copied.',
    failureText: 'Could not copy command.',
    trackState: true
  });
  const status = copyControl?.status ?? /** @type {HTMLOutputElement} */ (renderLiveRegion('output', 'cli-action-status'));
  const output = h('pre', { className: 'cli-action-output', hidden: true });
  const inlineOutput = h('div', { className: 'cli-action-terminal-output', hidden: true }, output);
  /** @type {Awaited<ReturnType<typeof createCliTerminal>> | undefined} */
  let terminal;

  const scope = createFactoryScope();
  const busy = state(false);
  const statusText = state('');
  const outputVisible = state(false);
  const showTerminalWindow = state(false);
  const terminalReady = state(false);
  const cancelling = state(false);
  /** @type {AbortController | undefined} */
  let runController;
  /** @type {string | undefined} */
  let commandId;
  const commandIds = new Set(/** @type {string[]} */ ([]));
  let cancellationRequested = false;
  const cancelRun = async () => {
    if (!commandId || cancelling.get()) return;
    cancellationRequested = true;
    cancelling.set(true);
    statusText.set('Cancelling command…');
    try {
      await Promise.all([...commandIds].map((id) => cancelCliCommand(id, scope.signal)));
    } catch (error) {
      statusText.set(error instanceof Error ? error.message : 'Could not cancel command.');
    } finally {
      cancelling.set(false);
    }
  };
  const terminalCheckbox = /** @type {HTMLInputElement} */ (h('input', {
    type: 'checkbox',
    checked: false,
    onChange: (/** @type {Event} */ event) => {
      showTerminalWindow.set(/** @type {HTMLInputElement} */ (event.currentTarget).checked);
    }
  }));
  const { dialog: terminalDialog, open: openTerminal, close: closeTerminal } = createModalDialog({
    className: 'cli-action-dialog cli-action-terminal-dialog',
    ariaLabel: `Terminal: ${action.label}`,
    onFallbackClose: () => (busy.get() ? cancel : terminalCheckbox).focus()
  });
  const terminalStatus = renderLiveRegion('output', 'cli-action-terminal-status');
  const terminalBody = h('div', { className: 'cli-action-dialog-body' });
  const terminalCancel = /** @type {HTMLButtonElement} */ (h('button', {
    type: 'button',
    className: 'cli-action-cancel',
    onClick: cancelRun
  }, 'Cancel command'));
  const inlineCancel = /** @type {HTMLButtonElement} */ (h('button', {
    type: 'button', className: 'cli-action-cancel', hidden: true, onClick: cancelRun
  }, 'Cancel command'));
  const terminalClose = h('button', {
    type: 'button',
    className: 'cli-action-cancel',
    onClick: () => showTerminalWindow.set(false)
  }, 'Close terminal');
  terminalDialog.append(
    h('header', { className: 'cli-action-dialog-header' },
      h('h2', null, `Terminal: ${action.label}`),
      renderCloseButton({
        className: 'cli-action-dialog-close',
        label: 'Close terminal window',
        onClick: () => showTerminalWindow.set(false)
      })
    ),
    terminalBody,
    h('footer', { className: 'cli-action-dialog-footer' }, terminalStatus, terminalCancel, terminalClose)
  );
  terminalDialog.addEventListener('cancel', (event) => {
    event.preventDefault();
    event.stopPropagation();
    showTerminalWindow.set(false);
  });
  terminalDialog.addEventListener('close', (event) => {
    event.stopPropagation();
    if (!terminalDialog.open && dialog.open) (busy.get() ? cancel : terminalCheckbox).focus();
  });
  const selectionReady = state(!action.selector && !options.batch?.error);
  const selector = action.selector ? createDialogSelector(action.id, action.selector, {
    signal: scope.signal,
    select: (value) => {
      const target = action.selector?.mapping.target;
      if (!target) return;
      statusText.set('');
      outputVisible.set(false);
      if (value === null) delete templateValues[target];
      else templateValues[target] = value;
      try {
        commandPreviewText.set(preview());
        selectionReady.set(value !== null);
      } catch (error) {
        delete templateValues[target];
        selectionReady.set(false);
        statusText.set(error instanceof Error ? error.message : 'Invalid selection.');
        commandPreviewText.set(preview());
      }
    }
  }) : null;

  const cancel = /** @type {HTMLButtonElement} */ (h('button', {
    type: 'button',
    className: 'cli-action-cancel cli-action-detach',
    onClick: close
  }, 'Cancel'));
  const confirm = copyControl?.button ?? /** @type {HTMLButtonElement} */ (h('button', {
      type: 'button',
      className: 'cli-action-confirm',
      onClick: async () => {
        if (busy.get() || outputVisible.get() || !selectionReady.get()) return;
        const controller = new AbortController();
        runController = controller;
        const abort = () => controller.abort();
        scope.signal.addEventListener('abort', abort, { once: true });
        cancellationRequested = false;
        commandIds.clear();
        cancelling.set(false);
        busy.set(true);
        statusText.set('Running…');
        outputVisible.set(true);
        cancel.focus();
        debugCliActions({ event: 'execute-started', actionId: action.id });
        try {
          if (!terminal) {
            terminal = await createCliTerminal(scope.signal);
            output.replaceWith(terminal.root);
            terminalReady.set(true);
          }
          terminal.root.hidden = false;
          controller.signal.throwIfAborted();
          terminal.write(`$ ${commandPreviewText.get()}\r\n`);
          let hasOutput = false;
          const result = await executeActionTargets(action.id, argumentValues, templateTargets, ({ data }) => {
            hasOutput = true;
            terminal?.write(data);
          }, controller.signal, async (queued) => {
            commandId = queued.id;
            commandIds.add(queued.id);
            statusText.set(`Queued: ${queued.id}. Closing detaches; the command continues.`);
            if (cancellationRequested) await cancelCliCommand(queued.id, scope.signal);
          });
          statusText.set(result.ok ? 'Completed' : (result.error || 'Action failed'));
          if (!hasOutput) terminal.write(resultText(result));
          const exitStatus = Number.isInteger(result.exitCode) ? ` (exit ${result.exitCode})` : '';
          terminal.write(`\r\n${result.ok ? 'Completed' : result.error || 'Action failed'}${exitStatus}\r\n`);
          debugCliActions({ event: 'execute-completed', actionId: action.id, ok: result.ok });
          publishNotification({
            message: `${action.label}: ${result.ok ? 'Completed' : result.error || 'Action failed'}`,
            tone: result.ok ? 'success' : 'error'
          });
          close();
        } catch (error) {
          const message = controller.signal.aborted
            ? 'Detached. The command continues in Maintenance → Commands.'
            : error instanceof Error ? error.message : 'Action failed.';
          statusText.set(message);
          terminal?.write(`\r\n${message}\r\n`);
          debugCliActions({
            event: 'execute-failed',
            actionId: action.id,
            errorName: error instanceof Error ? error.name : 'UnknownError'
          });
        } finally {
          scope.signal.removeEventListener('abort', abort);
          runController = undefined;
          cancelling.set(false);
          busy.set(false);
        }
      }
    }, 'Run action'));
  if (options.batch?.error) confirm.disabled = true;
  if (canExecute) {
    effect(() => {
      dialog.classList.toggle('cli-action-running', busy.get());
      terminalDialog.classList.toggle('cli-action-running', busy.get());
      confirm.hidden = outputVisible.get();
      confirm.disabled = busy.get() || outputVisible.get() || !selectionReady.get();
      cancel.disabled = false;
      cancel.textContent = busy.get() ? 'Detach' : outputVisible.get() ? 'Close' : 'Cancel';
      for (const { input } of inputs) input.disabled = busy.get() || outputVisible.get();
      selector?.setDisabled(busy.get() || outputVisible.get());
      status.textContent = statusText.get();
      output.hidden = !outputVisible.get();
      if (terminal) terminal.root.hidden = !outputVisible.get();
      confirm.textContent = confirmationLabel;
      terminalCheckbox.checked = showTerminalWindow.get();
      terminalStatus.textContent = statusText.get();
      terminalCancel.hidden = !busy.get();
      inlineCancel.hidden = !busy.get();
      inlineCancel.disabled = cancelling.get();
      terminalClose.hidden = false;
      terminalCancel.disabled = cancelling.get();
      const terminalOpen = outputVisible.get() && terminalReady.get() && showTerminalWindow.get();
      inlineOutput.hidden = !outputVisible.get() || terminalOpen;
      const terminalParent = terminalOpen ? terminalBody : inlineOutput;
      if (terminal && terminal.root.parentNode !== terminalParent) terminalParent.append(terminal.root);
      if (terminalOpen && !terminalDialog.open) openTerminal();
      else if (!terminalOpen && terminalDialog.open) closeTerminal();
    }, { signal: scope.signal });
  }
  trigger = /** @type {HTMLButtonElement} */ (h(
    'button',
    {
      type: 'button',
      className: rowPresentation
        ? 'cli-action-trigger table-cli-action-button'
        : settingsPresentation
        ? 'cli-action-trigger configuration-cli-action'
        : 'cli-action-trigger',
      title: action.label,
      'aria-label': action.label,
      onClick: () => {
        copyControl?.reset();
        if (canExecute) {
          commandId = undefined;
          statusText.set('');
          outputVisible.set(false);
          showTerminalWindow.set(false);
          if (terminal) terminal.root.hidden = true;
        }
        resetArguments();
        selector?.reset();
        open();
        selector?.focus();
      }
    },
    octicon(presentation.icon),
    h(
      'span',
      { className: 'cli-action-trigger-copy' },
      h('strong', null, presentation.label),
      !rowPresentation && action.description ? h('small', null, action.description) : null
    )
  ));
  command = h('code', { className: 'cli-action-command' }, commandPreviewText.get());
  effect(() => {
    command.textContent = commandPreviewText.get();
  }, { signal: scope.signal });
  dialog.append(
    h(
      'header',
      { className: 'cli-action-dialog-header' },
      h('h2', null, presentation.label),
      renderCloseButton({
        className: 'cli-action-dialog-close',
        label: 'Close action approval',
        onClick: close
      })
    ),
    h(
      'div',
      { className: 'cli-action-dialog-body' },
      action.description ? h('p', null, action.description) : null,
      selector?.root,
      inputs.length > 0
        ? h('fieldset', { className: 'cli-action-arguments' },
          h('legend', null, 'Options'),
          ...inputs.map(({ element }) => element))
        : null,
      action.selector ? null : h('p', null, canExecute
        ? presentation.confirmation
          ? `Confirm the exact effect of ${presentation.label} on the selected targets. Each listed command will execute once after approval. Actions that use gh aw may install the pinned extension first.`
          : 'This command is declared as read-only investigation. Review its exact target and command before running.'
        : 'Copy this command and run it in your terminal.'),
      command,
      canExecute ? h('label', { className: 'cli-action-argument' },
        terminalCheckbox,
        h('span', null,
          h('strong', null, 'Open terminal window'),
          h('small', null, 'Output appears here by default. Closing the terminal window does not cancel the command.')
        )
      ) : null,
      canExecute ? inlineOutput : null
    ),
    h('footer', { className: 'cli-action-dialog-footer' }, status, inlineCancel, cancel, confirm)
  );
  dialog.addEventListener('close', () => {
    runController?.abort();
    selector?.cancel();
    trigger.focus();
  });
  dialog.addEventListener('cancel', (event) => {
    event.preventDefault();
    close();
  });
  scope.bind(trigger);
  return { trigger, dialog, terminalDialog: canExecute ? terminalDialog : null };
}

/**
 * Render one row-scoped CLI action with template values sourced from the row.
 * @param {string} actionId
 * @param {Record<string, string>} templateValues
 * @param {{ showLabel?: boolean, level?: import('../action-model.js').ActionLevel, verb?: string, label?: string, icon?: string }} [options]
 */
export function renderRowCliAction(actionId, templateValues, options = {}) {
  const action = declaredCliActions.find((candidate) => candidate.id === actionId);
  if (!action) return null;
  const { trigger, dialog, terminalDialog } = renderCliActionControl({
    ...action,
    ...(options.level && { level: options.level }),
    ...(options.verb && { verb: options.verb }),
    ...(options.label && { label: options.label }),
    ...(options.icon && { icon: options.icon })
  }, {
    presentation: 'row',
    templateValues,
    canExecute: declaredCliActionsCanExecute,
    showRowLabel: options.showLabel === true
  });
  return h('span', { className: 'table-cli-action-control' }, trigger, dialog, terminalDialog);
}

/**
 * Render one declared CLI action with its authored label and description.
 * @param {string} actionId
 * @param {Record<string, string>} [templateValues]
 * @param {{ rows: Array<Record<string, unknown>>, fields: string[], available: boolean }} [binding]
 */
export function renderDeclaredCliAction(actionId, templateValues = {}, binding) {
  const action = declaredCliActions.find((candidate) => candidate.id === actionId);
  if (!action || action.selector && !declaredCliActionsCanExecute) return null;
  /** @type {{ targets: Array<Record<string, string>>, error?: string } | undefined} */
  let batch;
  if (binding) {
    batch = { targets: [] };
    try {
      if (!binding.available || binding.rows.length === 0) {
        throw new Error('The complete target list is unavailable. No commands can be approved.');
      }
      for (const row of binding.rows) {
        const values = Object.fromEntries(binding.fields.map((field) => {
          const value = row[field];
          if (typeof value !== 'string') throw new Error(`CLI action context "${field}" is missing or invalid.`);
          return [field, value];
        }));
        renderCliActionCommand(action.command, values);
        batch.targets.push(values);
      }
    } catch (error) {
      batch.error = error instanceof Error ? error.message : 'The command target list is invalid.';
      batch.targets = [];
    }
  }
  const rendered = renderCliActionControl(action, {
    templateValues: { ...declaredCliActionTemplateValues, ...templateValues },
    canExecute: declaredCliActionsCanExecute,
    batch
  });
  return h('span', { className: 'declared-cli-action' }, rendered.trigger, rendered.dialog, rendered.terminalDialog);
}

/**
 * Render dashboard-declared CLI actions. Every invocation requires a fresh,
 * explicit confirmation; approval is never persisted or inferred.
 * @param {Array<{ id: string, label: string, description?: string, icon: string, command: string, 'copy-only'?: boolean, selector?: import('../dialog-selector.js').DialogSelector, arguments?: Array<{ id: string, label: string, description?: string, type: 'boolean', flag: string, default?: boolean }> }> | undefined} actions
 * @param {{ presentation?: 'menu'|'settings', templateValues?: Record<string, string>, canExecute?: boolean }} [options]
 * @returns {HTMLElement | null}
 */
export function renderCliActions(actions, options = {}) {
  if (!Array.isArray(actions) || actions.length === 0) return null;
  const visibleActions = actions.filter((action) => !action.selector || options.canExecute !== false);
  if (!visibleActions.length) return null;

  const settingsPresentation = options.presentation === 'settings';
  const settingsList = settingsPresentation
    ? h('div', { className: 'configuration-cli-action-list' })
    : null;
  const root = settingsPresentation
    ? h(
      'section',
      {
        className: 'configuration-browser-settings cli-actions-settings',
        'aria-labelledby': 'configuration-cli-actions-heading'
      },
      h(
        'div',
        { className: 'configuration-browser-settings-heading' },
        h(
          'div',
          null,
          h('h3', { id: 'configuration-cli-actions-heading' }, 'Agentic Workflows'),
          h('p', null, 'Update installed campaigns or upgrade this repository’s Agentic Workflows.')
        )
      ),
      settingsList
    )
    : h(
      'details',
      { className: 'cli-actions-menu' },
      h(
        'summary',
        { className: 'cli-actions-toggle', title: 'Dashboard actions' },
        octicon('play'),
        h('span', { className: 'action-label' }, 'Actions')
      )
    );
  const list = settingsPresentation
    ? settingsList
    : h('div', { className: 'cli-actions-list' });
  if (!list) return null;
  if (!settingsPresentation) root.append(list);

  for (const declared of visibleActions) {
    const action = { ...normalizeAction(declared, { id: declared.id, type: 'cli' }), ...declared };
    const { trigger, dialog, terminalDialog } = renderCliActionControl(action, options);
    list.append(trigger);
    root.append(dialog);
    if (terminalDialog) root.append(terminalDialog);
  }
  return root;
}

export function renderSettingsCliActions() {
  return renderCliActions(
    declaredCliActions.filter((action) => action.placement === 'settings'),
    {
      presentation: 'settings',
      templateValues: declaredCliActionTemplateValues,
      canExecute: declaredCliActionsCanExecute
    }
  );
}

/**
 * Attach dashboard-declared CLI actions to their toolbar and settings placements.
 * View and row actions are rendered by their declaring views.
 * @param {HTMLElement} dashboard
 * @param {typeof declaredCliActions} actions
 * @param {{ repository?: string, canExecute?: boolean }} [options]
 */
export function attachCliActions(dashboard, actions, options = {}) {
  const canExecute = options.canExecute !== false;
  /** @type {Record<string, string>} */
  const templateValues = {};
  if (typeof options.repository === 'string') templateValues.repository = options.repository;
  setDeclaredCliActions(actions, { canExecute, templateValues });
  const toolbarActions = renderCliActions(
    actions.filter((action) => (action.placement ?? 'toolbar') === 'toolbar'),
    { templateValues, canExecute }
  );
  if (toolbarActions) dashboard.querySelector('.report-actions')?.prepend(toolbarActions);
  if (canExecute && cliQueueAvailable() && !dashboard.querySelector('.cli-commands-navigation')) {
    const scope = createFactoryScope();
    const navigation = h('a', {
      href: '#page-commands', className: 'cli-actions-toggle cli-commands-navigation',
      'aria-label': 'Commands'
    }, 'Commands');
    dashboard.querySelector('.report-actions')?.prepend(navigation);
    scope.bind(navigation);
    subscribeCanonicalDashboardView('cli-commands-navigation', ['cli-command-summary'], {
      pages: []
    }, (sources) => {
      const running = sources['cli-command-summary']?.rows[0]?.running;
      navigation.textContent = typeof running === 'number' ? `Commands (${running} running)` : 'Commands';
    }, undefined, { signal: scope.signal });
  }

  const settingsActions = renderSettingsCliActions();
  const existingSettingsActions = dashboard.querySelector('.configuration-view > .cli-actions-settings');
  if (!settingsActions) {
    existingSettingsActions?.remove();
    return;
  }
  const dialogs = [...settingsActions.querySelectorAll('dialog')];
  if (existingSettingsActions) {
    existingSettingsActions.replaceWith(settingsActions);
  } else {
    dashboard.querySelector('.configuration-view > .configuration-browser-settings')?.before(settingsActions);
  }
  for (const dialog of dialogs) dashboard.append(dialog);
}
