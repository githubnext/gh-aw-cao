import { h } from '../dom.js';
import { effect, state } from '../reactive.js';
import { normalizeAction } from '../action-model.js';
import { octicon } from '../octicons.js';
import { parsePromptWizard, initialWizardValues, updateWizardValues, wizardFieldVisible, wizardFieldError, buildWizardPrompt } from '../prompt-wizard.js';
import { createFactoryScope } from './factory-elements.js';
import { renderPromptPreviewAction } from './data-view.js';
import { renderLiveRegion } from './ui-primitives.js';
import { publishNotification } from '../notification-service.js';
import { createDebug, diagnosticErrorName } from '../debug.js';

const debugWizard = createDebug('components:prompt-wizard');
let nextWizardId = 0;

/** @param {import('./ui-elements.js').ElementRenderContext} context */
export function renderPromptWizard(context) {
  const wizard = parsePromptWizard(context.elementConfig?.wizard);
  const scope = createFactoryScope();
  const values = state(initialWizardValues(wizard));
  const active = state(0);
  const error = state('');
  const reviewedPrompt = state('');
  const fieldsById = new Map(wizard.steps.flatMap((step) => step.fields.map((field) => [field.id, field])));
  const prefix = `prompt-wizard-${++nextWizardId}`;
  /** @type {Map<string, { root: HTMLElement, control: HTMLInputElement|HTMLTextAreaElement|HTMLSelectElement|HTMLButtonElement, description: HTMLElement }>} */
  const controls = new Map();
  /** @param {string} id @param {string|string[]} value */
  const update = (id, value) => {
    if (scope.signal.aborted) return;
    const field = fieldsById.get(id);
    if (!field) throw new Error('Wizard field is not declared.');
    values.set((current) => updateWizardValues(field, current, value));
    controls.get(id)?.control.removeAttribute('aria-invalid');
    reviewedPrompt.set('');
    error.set('');
  };
  const panels = wizard.steps.map((step, index) => /** @type {HTMLFieldSetElement} */ (h('fieldset', {
    className: 'prompt-wizard-step', 'aria-describedby': `${prefix}-${step.id}-description`
  }, h('legend', null, step.title),
  h('p', { id: `${prefix}-${step.id}-description` }, step.description ?? ''),
  ...step.fields.map((field) => {
    const id = `${prefix}-${field.id}`;
    const description = h('p', { id: `${id}-help`, className: 'prompt-wizard-help' });
    const label = `${field.label}${field.required ? ' (required)' : ''}`;
    /** @type {HTMLInputElement|HTMLTextAreaElement|HTMLSelectElement|HTMLButtonElement} */
    let control;
    let root;
    if (field.control === 'cards') {
      const cards = (field.options ?? []).map((option) => {
        const titleId = `${id}-${option.value}-title`;
        const summaryId = `${id}-${option.value}-summary`;
        return /** @type {HTMLButtonElement} */ (h('button', {
          type: 'button', value: option.value,
          className: 'issue-list-card entity-card-list-card prompt-wizard-card',
          'aria-labelledby': titleId, 'aria-describedby': summaryId,
          'aria-pressed': String(values.get()[field.id] === option.value),
          onClick: () => {
            update(field.id, option.value);
            if (field['advance-on-select']) advance();
          }
        },
            h('span', { className: 'issue-list-card-icon', 'aria-hidden': 'true' }, octicon(option.icon ?? 'workflow')),
            h('span', { className: 'issue-list-card-content' },
              h('strong', { id: titleId, className: 'issue-list-card-title' }, option.label),
              h('span', { id: summaryId, className: 'issue-list-card-subtitle' }, option.summary ?? option.description ?? ''))));
      });
      control = cards[0];
      root = h('fieldset', { className: 'prompt-wizard-field prompt-wizard-cards' },
        h('legend', null, label),
        h('div', { className: 'entity-card-list entity-card-list-marketplace' }, ...cards));
    } else if (field.control === 'checkboxes') {
      const inputs = (field.options ?? []).map((option) => {
        const input = /** @type {HTMLInputElement} */ (h('input', {
          type: 'checkbox', value: option.value,
          checked: Array.isArray(values.get()[field.id]) && values.get()[field.id].includes(option.value),
          onChange: () => update(field.id, inputs.filter(({ input }) => input.checked).map(({ input }) => input.value))
        }));
        return { input, root: h('label', { className: 'prompt-wizard-choice' }, input,
          h('span', null, h('strong', null, option.label), option.description ? h('small', null, option.description) : null)) };
      });
      control = inputs[0].input;
      root = h('fieldset', { className: 'prompt-wizard-field prompt-wizard-options' },
        h('legend', null, label), ...inputs.map(({ root }) => root), description);
    } else {
      control = /** @type {HTMLInputElement|HTMLTextAreaElement|HTMLSelectElement} */ (h(
        field.control === 'select' ? 'select' : field.control === 'textarea' ? 'textarea' : 'input',
        {
          id, ...(field.control === 'text' ? { type: 'text' } : {}),
          ...(field.control === 'textarea' ? { rows: 4 } : {}),
          ...(field.control !== 'select' ? { maxlength: field['max-length'] ?? 8000, placeholder: field.placeholder ?? '' } : {}),
          'aria-describedby': `${id}-help`, required: field.required === true,
          [field.control === 'select' ? 'onChange' : 'onInput']: (/** @type {Event} */ event) => update(field.id, /** @type {HTMLInputElement} */ (event.currentTarget).value)
        },
        ...(field.control === 'select' ? [
          h('option', { value: '' }, 'Choose an option'),
          ...(field.options ?? []).map((option) => h('option', { value: option.value }, option.label))
        ] : [])
      ));
      control.value = String(values.get()[field.id]);
      root = h('div', { className: 'prompt-wizard-field' }, h('label', { for: id }, label), control, description);
    }
    controls.set(field.id, { root, control, description });
    root.dataset.wizardStep = String(index);
    return root;
  }))));
  const status = renderLiveRegion('output', 'prompt-wizard-status');
  const stepButtons = wizard.steps.map((step, index) =>
    /** @type {HTMLButtonElement} */ (h('button', {
      type: 'button', 'aria-label': `Return to ${step.title}`,
      onClick: () => goBack(index)
    }, `${index + 1}. ${step.title}`)));
  const progress = h('ol', { className: 'prompt-wizard-progress', 'aria-label': 'Wizard progress' },
    ...stepButtons.map((button) => h('li', null, button)));
  const validateStep = () => {
    const step = wizard.steps[active.get()];
    for (const field of step?.fields ?? []) {
      if (!wizardFieldVisible(field, values.get())) continue;
      const message = wizardFieldError(field, values.get()[field.id]);
      const control = controls.get(field.id)?.control;
      control?.setAttribute('aria-invalid', String(Boolean(message)));
      if (message) {
        error.set(message);
        control?.focus();
        return false;
      }
    }
    return true;
  };
  const focusPanel = () => {
    wizard.steps[active.get()]?.fields.some((field) => {
      if (!wizardFieldVisible(field, values.get())) return false;
      const item = controls.get(field.id);
      const selected = item?.root.querySelector('input:checked, button[aria-pressed="true"]');
      if (selected instanceof HTMLElement) selected.focus();
      else item?.control.focus();
      return true;
    });
  };
  /** @param {number} index */
  const goBack = (index) => {
    if (scope.signal.aborted || index < 0 || index >= active.get()) return;
    active.set(index);
    error.set('');
    focusPanel();
  };
  const back = /** @type {HTMLButtonElement} */ (h('button', {
    type: 'button', className: 'cli-action-trigger',
    onClick: () => goBack(active.get() - 1)
  }, 'Back'));
  const advance = () => {
    if (scope.signal.aborted || active.get() >= wizard.steps.length - 1 || !validateStep()) return;
    active.set(active.get() + 1);
    error.set('');
    focusPanel();
  };
  const preparePrompt = () => {
    if (scope.signal.aborted || active.get() !== wizard.steps.length - 1 || !validateStep()) return false;
    try {
      reviewedPrompt.set(buildWizardPrompt(wizard, values.get()));
      error.set('');
      return true;
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : 'Could not prepare generation prompt.';
      error.set(message);
      publishNotification({ message, tone: 'error' });
      debugWizard({ event: 'prompt-rejected', errorName: diagnosticErrorName(cause) });
      return false;
    }
  };
  const next = /** @type {HTMLButtonElement} */ (h('button', {
    type: 'button', className: 'cli-action-confirm', onClick: advance
  }, 'Next'));
  const preview = renderPromptPreviewAction(normalizeAction({
    level: 'propose', label: wizard.prompt.label, presentation: 'copy-prompt'
  }, { id: `${context.viewId ?? 'wizard'}-generate`, type: 'prompt' }), reviewedPrompt.get,
  undefined, undefined, undefined, preparePrompt);
  const navigation = h('div', { className: 'prompt-wizard-actions' }, back, next, preview);
  const root = h('section', { className: 'prompt-wizard', 'aria-label': context.title },
    h('p', null, wizard.intro),
    progress,
    ...panels, status,
    navigation);
  effect(() => {
    const current = active.get();
    const fields = wizard.steps[current]?.fields;
    navigation.hidden = current === 0 && fields?.length === 1 && fields[0]['advance-on-select'] === true;
    panels.forEach((panel, index) => { panel.hidden = index !== current; panel.disabled = index !== current; });
    stepButtons.forEach((item, index) => {
      item.disabled = index >= current;
      if (index === current) item.setAttribute('aria-current', 'step');
      else item.removeAttribute('aria-current');
    });
    back.disabled = current === 0;
    next.hidden = current === wizard.steps.length - 1;
    preview.hidden = current !== wizard.steps.length - 1;
    status.textContent = error.get() || `Step ${current + 1} of ${wizard.steps.length}: ${wizard.steps[current].title}`;
    for (const step of wizard.steps) {
      for (const field of step.fields) {
        const item = controls.get(field.id);
        if (!item) continue;
        item.root.hidden = !wizardFieldVisible(field, values.get());
        if (field.control === 'select') {
          if (item.control.value !== values.get()[field.id]) item.control.value = String(values.get()[field.id]);
          item.description.textContent = field.options?.find((option) => option.value === values.get()[field.id])?.description ?? '';
        } else if (field.control === 'checkboxes') {
          const selected = values.get()[field.id];
          for (const input of item.root.querySelectorAll('input')) input.checked = Array.isArray(selected) && selected.includes(input.value);
        } else if (field.control === 'cards') {
          for (const choice of item.root.querySelectorAll('button')) {
            choice.setAttribute('aria-pressed', String(choice.value === values.get()[field.id]));
          }
        } else if (item.control.value !== values.get()[field.id]) {
          item.control.value = String(values.get()[field.id]);
        }
      }
    }
  }, { signal: scope.signal });
  scope.signal.addEventListener('abort', () => {
    for (const dialog of root.querySelectorAll('dialog')) dialog.removeAttribute('open');
  }, { once: true });
  scope.bind(root);
  return root;
}
