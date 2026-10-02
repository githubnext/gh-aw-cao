import { h } from '../dom.js';
import { debounce, throttle } from '../debounce.js';
import { createDebug } from '../debug.js';
import { state, effect } from '../reactive.js';
import { createFactoryScope } from './factory-elements.js';

const DEFAULT_DELAY_MS = 250;

const debugDashboardForm = createDebug('dashboard-form');

/**
 * @param {Record<string, unknown>} definition
 * @param {Record<string, string|number|boolean> | undefined} currentValues
 * @param {(values: Record<string, string|number|boolean>) => void} onChange
 * @param {string} [idPrefix]
 */
export function renderDashboardForm(definition, currentValues, onChange, idPrefix = 'scenario') {
  const fields = Array.isArray(definition.fields) ? definition.fields.filter(isRecord) : [];
  /** @type {Record<string, string|number|boolean>} */
  const values = Object.fromEntries(fields.flatMap((field) => {
    const value = scalar(currentValues?.[String(field.id)]) ?? scalar(field.default);
    return value === undefined ? [] : [[String(field.id), value]];
  }));
  const update = isRecord(definition.update) ? definition.update : {};
  const delay = Number(update['delay-ms']) || DEFAULT_DELAY_MS;
  const schedule = update.strategy === 'throttle'
    ? throttle(emit, delay)
    : debounce(emit, delay);
  let lastEmitted = '';
  const root = h(
    'form',
    {
      className: 'dashboard-parameter-form',
      'aria-label': typeof definition.title === 'string' ? definition.title : 'Scenario controls'
    },
    ...(typeof definition.title === 'string' || typeof definition.description === 'string'
      ? [h(
          'div',
          { className: 'dashboard-parameter-form-header' },
          typeof definition.title === 'string' ? h('h2', null, definition.title) : null,
          typeof definition.description === 'string' ? h('p', null, definition.description) : null
        )]
      : []),
    h('div', { className: 'dashboard-parameter-fields' }, ...fields.map(renderField))
  );
  root.addEventListener('submit', (event) => event.preventDefault());
  debugDashboardForm({ event: 'built', idPrefix, fieldCount: fields.length, strategy: update.strategy === 'throttle' ? 'throttle' : 'debounce', delayMs: delay });
  return root;

  function emit() {
    if (!root.isConnected) {
      debugDashboardForm({ event: 'emit-skipped', idPrefix, reason: 'disconnected' });
      return;
    }
    const serialized = JSON.stringify(values);
    if (serialized === lastEmitted) {
      debugDashboardForm({ event: 'emit-skipped', idPrefix, reason: 'unchanged' });
      return;
    }
    lastEmitted = serialized;
    debugDashboardForm({ event: 'emitted', idPrefix, fieldCount: fields.length });
    onChange({ ...values });
  }

  /** @param {Record<string, unknown>} field */
  function renderField(field) {
    const id = String(field.id);
    const controlId = `dashboard-form-${idPrefix}-${id}`;
    const descriptionId = typeof field.description === 'string' ? `${controlId}-description` : undefined;
    const label = String(field.label);
    const description = descriptionId ? h('span', { id: descriptionId, className: 'dashboard-parameter-description' }, field.description) : null;
    if (field.control === 'checkbox') {
      const input = /** @type {HTMLInputElement} */ (h('input', {
        id: controlId,
        type: 'checkbox',
        checked: values[id] === true,
        'aria-describedby': descriptionId
      }));
      input.addEventListener('change', () => {
        values[id] = input.checked;
        schedule();
      });
      return h('div', { className: 'dashboard-parameter-field dashboard-parameter-checkbox' },
        h('label', { htmlFor: controlId }, input, h('span', null, label)),
        description
      );
    }
    if (field.control === 'radio') {
      const options = Array.isArray(field.options) ? field.options.filter(isRecord) : [];
      return h(
        'fieldset',
        { className: 'dashboard-parameter-field dashboard-parameter-radio', 'aria-describedby': descriptionId },
        h('legend', null, label),
        description,
        h('div', { className: 'dashboard-parameter-radio-options' }, ...options.map((option, index) => {
          const optionId = `${controlId}-${index + 1}`;
          const value = scalar(option.value);
          const input = /** @type {HTMLInputElement} */ (h('input', {
            id: optionId,
            type: 'radio',
            name: controlId,
            checked: values[id] === value
          }));
          input.addEventListener('change', () => {
            if (!input.checked || value === undefined) return;
            values[id] = value;
            schedule();
          });
          return h('label', { htmlFor: optionId }, input, h('span', null, String(option.label)));
        }))
      );
    }
    // `sliderText` is this readout's entire visible run state; the effect
    // below is the only place that writes it onto the owned `output` node,
    // matching the `createCopyControl` (`ui-primitives.js`) state/effect/
    // `createFactoryScope` shape for owned interactive DOM.
    const sliderScope = createFactoryScope();
    const sliderText = state(String(values[id]));
    const output = h('output', { htmlFor: controlId }, String(values[id]));
    effect(() => {
      output.textContent = sliderText.get();
    }, { signal: sliderScope.signal });
    sliderScope.bind(output);
    const input = /** @type {HTMLInputElement} */ (h('input', {
      id: controlId,
      type: 'range',
      min: String(field.min),
      max: String(field.max),
      step: String(field.step),
      value: String(values[id]),
      'aria-describedby': descriptionId
    }));
    input.addEventListener('input', () => {
      values[id] = Number(input.value);
      sliderText.set(input.value);
      schedule();
    });
    return h('div', { className: 'dashboard-parameter-field dashboard-parameter-slider' },
      h('div', { className: 'dashboard-parameter-label' }, h('label', { htmlFor: controlId }, label), output),
      input,
      description
    );
  }
}

/** @param {unknown} value */
/** @param {unknown} value @returns {string|number|boolean|undefined} */
function scalar(value) {
  if (typeof value === 'string' || typeof value === 'boolean') return value;
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

/** @param {unknown} value @returns {value is Record<string, unknown>} */
function isRecord(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}
