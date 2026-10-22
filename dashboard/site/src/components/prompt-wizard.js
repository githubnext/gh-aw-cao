import { h } from '../dom.js';
import { effect, state } from '../reactive.js';
import { normalizeAction } from '../action-model.js';
import { parsePromptWizard, initialWizardValues, wizardFieldVisible, wizardFieldError, wizardDesign, buildWizardPrompt } from '../prompt-wizard.js';
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
  const reviewJson = state('');
  const prefix = `prompt-wizard-${++nextWizardId}`;
  /** @type {Map<string, { root: HTMLElement, control: HTMLInputElement|HTMLTextAreaElement|HTMLSelectElement, description: HTMLElement }>} */
  const controls = new Map();
  /** @param {string} id @param {string|string[]} value */
  const update = (id, value) => {
    if (scope.signal.aborted) return;
    values.set((current) => ({ ...current, [id]: value }));
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
    /** @type {HTMLInputElement|HTMLTextAreaElement|HTMLSelectElement} */
    let control;
    let root;
    if (field.control === 'checkboxes') {
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
  const progress = h('ol', { className: 'prompt-wizard-progress', 'aria-label': 'Wizard progress' },
    ...[...wizard.steps.map((step) => step.title), 'Review'].map((title) => h('li', null, title)));
  const summary = h('pre', { className: 'prompt-wizard-summary' });
  const preview = renderPromptPreviewAction(normalizeAction({
    level: 'propose', label: wizard.prompt.label, presentation: 'copy-prompt'
  }, { id: `${context.viewId ?? 'wizard'}-generate`, type: 'prompt' }), reviewedPrompt.get);
  const review = h('section', { className: 'prompt-wizard-review', 'aria-label': 'Review your design' },
    h('h3', { tabindex: -1 }, 'Review your design'),
    h('p', null, 'Use the prompt button to review and copy the generation prompt for your coding agent. No commands are queued, and no automation is installed or activated here.'),
    h('details', { open: true }, h('summary', null, 'Selected requirements and historical pattern guidance'), summary),
    preview);
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
    const heading = active.get() === wizard.steps.length ? review.querySelector('h3') : null;
    if (heading instanceof HTMLElement) heading.focus();
    else wizard.steps[active.get()]?.fields.some((field) => {
      if (!wizardFieldVisible(field, values.get())) return false;
      controls.get(field.id)?.control.focus();
      return true;
    });
  };
  const back = /** @type {HTMLButtonElement} */ (h('button', {
    type: 'button', className: 'cli-action-trigger',
    onClick: () => { if (!scope.signal.aborted) { active.set(Math.max(0, active.get() - 1)); error.set(''); focusPanel(); } }
  }, 'Back'));
  const next = /** @type {HTMLButtonElement} */ (h('button', {
    type: 'button', className: 'cli-action-confirm',
    onClick: () => {
      if (scope.signal.aborted || !validateStep()) return;
      try {
        if (active.get() === wizard.steps.length - 1) {
          reviewedPrompt.set(buildWizardPrompt(wizard, values.get()));
          reviewJson.set(JSON.stringify(wizardDesign(wizard, values.get()), null, 2));
        }
        active.set(active.get() + 1);
        error.set('');
        focusPanel();
      } catch (cause) {
        const message = cause instanceof Error ? cause.message : 'Could not prepare generation prompt.';
        error.set(message);
        publishNotification({ message, tone: 'error' });
        debugWizard({ event: 'prompt-rejected', errorName: diagnosticErrorName(cause) });
      }
    }
  }, 'Next'));
  const source = wizard.provenance;
  const root = h('section', { className: 'prompt-wizard', 'aria-label': context.title },
    h('p', null, wizard.intro),
    progress,
    ...panels, review, status,
    h('div', { className: 'prompt-wizard-actions' }, back, next),
    source ? h('aside', { className: 'prompt-wizard-provenance' },
      h('p', null, h('a', { href: source.url, target: '_blank', rel: 'noopener noreferrer' }, 'Patterns from gh-aw-wizard'),
        ` · ${source['source-repositories']} repositories · ${source['total-workflows']} workflows · mined ${source['generated-at'].slice(0, 10)} · revision ${source.revision.slice(0, 12)}`),
      h('p', null, source.notice),
      h('details', null, h('summary', null, 'Upstream dataset license'), h('pre', null, source.license))) : null);
  effect(() => {
    const current = active.get();
    panels.forEach((panel, index) => { panel.hidden = index !== current; panel.disabled = index !== current; });
    [...progress.children].forEach((item, index) => {
      if (index === current) item.setAttribute('aria-current', 'step');
      else item.removeAttribute('aria-current');
    });
    back.disabled = current === 0;
    next.hidden = current === wizard.steps.length;
    next.textContent = current === wizard.steps.length - 1 ? 'Review design' : 'Next';
    review.hidden = current !== wizard.steps.length;
    summary.textContent = reviewJson.get();
    status.textContent = error.get() || `Step ${current + 1} of ${wizard.steps.length + 1}: ${wizard.steps[current]?.title ?? 'Review'}`;
    for (const step of wizard.steps) {
      for (const field of step.fields) {
        const item = controls.get(field.id);
        if (!item) continue;
        item.root.hidden = !wizardFieldVisible(field, values.get());
        if (field.control === 'select') {
          item.description.textContent = field.options?.find((option) => option.value === values.get()[field.id])?.description ?? '';
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
