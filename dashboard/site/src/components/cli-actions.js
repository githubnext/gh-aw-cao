import { h } from '../dom.js';
import { octicon } from '../octicons.js';
import { renderCliActionCommand } from '../cli-action-template.js';
import { createCopyControl, createModalDialog, renderCloseButton } from './ui-primitives.js';

const endpoint = './__cli_action';
/** @type {Array<{ id: string, label: string, description?: string, icon: string, command: string, placement?: 'toolbar'|'settings'|'row', arguments?: Array<{ id: string, label: string, description?: string, type: 'boolean', flag: string, default?: boolean }> }>} */
let declaredCliActions = [];
let declaredCliActionsCanExecute = true;
/** @type {Record<string, string>} */
let declaredCliActionTemplateValues = {};

/** @param {typeof declaredCliActions} actions @param {{ canExecute?: boolean, templateValues?: Record<string, string> }} [options] */
export function setDeclaredCliActions(actions, options = {}) {
  declaredCliActions = Array.isArray(actions) ? actions : [];
  declaredCliActionsCanExecute = options.canExecute !== false;
  declaredCliActionTemplateValues = options.templateValues ?? {};
}

/**
 * @param {string} id
 * @param {Record<string, boolean>} argumentsValue
 * @param {Record<string, string>} templateValues
 * @param {(event: { stream: 'stdout'|'stderr', data: string }) => void} onOutput
 */
async function executeAction(id, argumentsValue, templateValues, onOutput) {
  /** @type {Record<string, unknown>} */
  const payload = { id, arguments: argumentsValue };
  if (Object.keys(templateValues).length > 0) payload.values = templateValues;
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  });
  if (!response.ok) {
    const result = await response.json().catch(() => null);
    throw new Error(result?.error || `Action failed with HTTP ${response.status}.`);
  }
  if (!response.body) throw new Error('Action output stream is unavailable.');

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  /** @type {{ ok: boolean, error?: string, stdout?: string, stderr?: string } | undefined} */
  let result;
  /** @param {string} line */
  const consume = (line) => {
    if (!line) return;
    const event = JSON.parse(line);
    if (event.type === 'output') {
      onOutput(event);
    } else if (event.type === 'complete') {
      result = event.result;
    } else if (event.type === 'error') {
      throw new Error(event.error || 'Action failed.');
    }
  };
  while (true) {
    const { value, done } = await reader.read();
    buffer += decoder.decode(value, { stream: !done });
    const lines = buffer.split('\n');
    buffer = lines.pop() ?? '';
    for (const line of lines) consume(line);
    if (done) break;
  }
  consume(buffer);
  if (!result) throw new Error('Action ended without a completion result.');
  return result;
}

/** @param {{ stdout?: string, stderr?: string }} result */
function resultText(result) {
  const sections = [];
  if (result.stdout) sections.push(result.stdout.trimEnd());
  if (result.stderr) sections.push(result.stderr.trimEnd());
  return sections.filter(Boolean).join('\n') || 'Command completed without output.';
}

/**
 * @param {{ command: string, arguments?: Array<{ id: string, flag: string }> }} action
 * @param {Record<string, boolean>} values
 * @param {Record<string, string>} templateValues
 */
function commandPreview(action, values, templateValues) {
  return [
    renderCliActionCommand(action.command, templateValues),
    ...(action.arguments ?? []).filter((argument) => values[argument.id]).map((argument) => argument.flag)
  ].join(' ');
}

/**
 * @param {{ id: string, label: string, description?: string, icon: string, command: string, arguments?: Array<{ id: string, label: string, description?: string, type: 'boolean', flag: string, default?: boolean }> }} action
 * @param {{ presentation?: 'menu'|'settings'|'row', templateValues?: Record<string, string>, canExecute?: boolean }} [options]
 */
function renderCliActionControl(action, options = {}) {
  const settingsPresentation = options.presentation === 'settings';
  const rowPresentation = options.presentation === 'row';
  const canExecute = options.canExecute !== false;
  const templateValues = options.templateValues ?? {};
  const argumentValues = Object.fromEntries(
    (action.arguments ?? []).map((argument) => [argument.id, argument.default === true])
  );
  /** @type {HTMLButtonElement} */
  let trigger;
  /** @type {HTMLElement} */
  let command;
  const inputs = (action.arguments ?? []).map((argument) => {
    const input = /** @type {HTMLInputElement} */ (h('input', {
      type: 'checkbox',
      checked: argument.default === true,
      onChange: (/** @type {Event} */ event) => {
        argumentValues[argument.id] = /** @type {HTMLInputElement} */ (event.currentTarget).checked;
        command.textContent = commandPreview(action, argumentValues, templateValues);
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
    command.textContent = commandPreview(action, argumentValues, templateValues);
  };
  const { dialog, open, close } = createModalDialog({
    className: 'cli-action-dialog',
    ariaLabel: `Approve ${action.label}`,
    onFallbackClose: () => trigger.focus()
  });
  const copyControl = canExecute ? null : createCopyControl({
    getContent: () => command.textContent ?? '',
    label: 'Copy command',
    buttonClassName: 'cli-action-confirm',
    statusClassName: 'cli-action-status',
    successText: 'Command copied.',
    failureText: 'Could not copy command.',
    trackState: true
  });
  const status = copyControl?.status ?? /** @type {HTMLOutputElement} */ (h('output', {
    className: 'cli-action-status',
    'aria-live': 'polite'
  }));
  const output = h('pre', { className: 'cli-action-output', hidden: true });
  const cancel = /** @type {HTMLButtonElement} */ (h('button', {
    type: 'button',
    className: 'cli-action-cancel',
    onClick: close
  }, 'Cancel'));
  const confirm = copyControl?.button ?? /** @type {HTMLButtonElement} */ (h('button', {
      type: 'button',
      className: 'cli-action-confirm',
      onClick: async () => {
        confirm.disabled = true;
        cancel.disabled = true;
        status.textContent = 'Running…';
        output.textContent = '';
        output.hidden = false;
        try {
          const result = await executeAction(action.id, argumentValues, templateValues, ({ data }) => {
            output.textContent += data;
            output.scrollTop = output.scrollHeight;
          });
          status.textContent = result.ok ? 'Completed' : (result.error || 'Action failed');
          if (!output.textContent) output.textContent = resultText(result);
          confirm.textContent = 'Run again';
        } catch (error) {
          status.textContent = error instanceof Error ? error.message : 'Action failed.';
        } finally {
          confirm.disabled = false;
          cancel.disabled = false;
        }
      }
    }, 'Run action'));
  trigger = /** @type {HTMLButtonElement} */ (h(
    'button',
    {
      type: 'button',
      className: rowPresentation
        ? 'cli-action-trigger table-cli-action-button'
        : settingsPresentation
        ? 'cli-action-trigger configuration-cli-action'
        : 'cli-action-trigger',
      title: rowPresentation ? action.label : undefined,
      'aria-label': rowPresentation ? action.label : undefined,
      onClick: () => {
        status.textContent = '';
        copyControl?.reset();
        output.hidden = true;
        if (canExecute) confirm.textContent = 'Run action';
        resetArguments();
        open();
      }
    },
    octicon(action.icon),
    rowPresentation ? null : h(
      'span',
      { className: 'cli-action-trigger-copy' },
      h('strong', null, action.label),
      action.description ? h('small', null, action.description) : null
    )
  ));
  command = h('code', { className: 'cli-action-command' }, commandPreview(action, argumentValues, templateValues));
  dialog.append(
    h(
      'header',
      { className: 'cli-action-dialog-header' },
      h('h2', null, action.label),
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
      inputs.length > 0
        ? h('fieldset', { className: 'cli-action-arguments' },
          h('legend', null, 'Options'),
          ...inputs.map(({ element }) => element))
        : null,
      h('p', null, canExecute
        ? 'Review and approve this command. Approval applies to this run only. If gh aw is unavailable, this run may install the pinned CLI extension first.'
        : 'Copy this command and run it in your terminal.'),
      command,
      canExecute ? output : null
    ),
    h('footer', { className: 'cli-action-dialog-footer' }, status, cancel, confirm)
  );
  dialog.addEventListener('close', () => {
    trigger.focus();
  });
  return { trigger, dialog };
}

/**
 * Render one row-scoped CLI action with template values sourced from the row.
 * @param {string} actionId
 * @param {Record<string, string>} templateValues
 */
export function renderRowCliAction(actionId, templateValues) {
  const action = declaredCliActions.find((candidate) => candidate.id === actionId);
  if (!action) return null;
  const { trigger, dialog } = renderCliActionControl(action, {
    presentation: 'row',
    templateValues,
    canExecute: declaredCliActionsCanExecute
  });
  return h('span', { className: 'table-cli-action-control' }, trigger, dialog);
}

/**
 * Render dashboard-declared CLI actions. Every invocation requires a fresh,
 * explicit confirmation; approval is never persisted or inferred.
 * @param {Array<{ id: string, label: string, description?: string, icon: string, command: string, arguments?: Array<{ id: string, label: string, description?: string, type: 'boolean', flag: string, default?: boolean }> }> | undefined} actions
 * @param {{ presentation?: 'menu'|'settings', templateValues?: Record<string, string>, canExecute?: boolean }} [options]
 * @returns {HTMLElement | null}
 */
export function renderCliActions(actions, options = {}) {
  if (!Array.isArray(actions) || actions.length === 0) return null;

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
          h('p', null, 'Update installed packages or upgrade this repository’s Agentic Workflows.')
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

  for (const action of actions) {
    const { trigger, dialog } = renderCliActionControl(action, options);
    list.append(trigger);
    root.append(dialog);
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
 * Attach dashboard-declared CLI actions to their toolbar, settings, and row placements.
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
    actions.filter((action) => !['settings', 'row'].includes(action.placement ?? 'toolbar')),
    { templateValues, canExecute }
  );
  if (toolbarActions) dashboard.querySelector('.report-actions')?.prepend(toolbarActions);

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
