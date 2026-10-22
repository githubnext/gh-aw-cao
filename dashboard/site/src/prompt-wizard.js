import { isSafeRepositorySlug } from './validator-common.js';
import octiconNames from './octicon-names.json' with { type: 'json' };

/**
 * @typedef {{ value: string, label: string, description?: string, summary?: string, instructions?: string, icon?: string, context?: unknown, defaults?: WizardValues }} WizardOption
 * @typedef {{ id: string, label: string, control: 'text'|'textarea'|'select'|'cards'|'checkboxes', required?: boolean,
 *   'advance-on-select'?: boolean, 'empty-message'?: string,
 *   format?: 'identifier'|'repositories', 'max-length'?: number, placeholder?: string, default?: string|string[],
 *   when?: { field: string, equals: string }, options?: WizardOption[] }} WizardField
 * @typedef {{ id: string, title: string, description?: string, fields: WizardField[] }} WizardStep
 * @typedef {{ repository: string, revision: string, url: string, 'generated-at': string,
 *   'source-repositories': number, 'total-workflows': number, notice: string, license: string }} WizardProvenance
 * @typedef {{ intro: string, steps: WizardStep[], prompt: { label: string, instructions: string },
 *   provenance?: WizardProvenance }} PromptWizard
 * @typedef {Record<string, string|string[]>} WizardValues
 */

/** @param {unknown} value @param {string[]} keys @param {string} path @returns {Record<string, unknown>} */
function mapping(value, keys, path) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${path} must be a mapping.`);
  const object = /** @type {Record<string, unknown>} */ (value);
  if (Object.keys(object).some((key) => !keys.includes(key))) throw new Error(`${path} contains an unknown key.`);
  return object;
}

/** @param {unknown} value @param {string} path @param {number} [max] @returns {asserts value is string} */
function text(value, path, max = 20_000) {
  if (typeof value !== 'string' || !value.trim() || value.length > max) throw new Error(`${path} must be non-empty text of at most ${max} characters.`);
}

/** @param {unknown} value @returns {PromptWizard} */
export function parsePromptWizard(value) {
  const wizard = mapping(value, ['intro', 'steps', 'prompt', 'provenance'], 'wizard');
  text(wizard.intro, 'wizard.intro');
  const prompt = mapping(wizard.prompt, ['label', 'instructions'], 'wizard.prompt');
  for (const key of ['label', 'instructions']) text(prompt[key], `wizard.prompt.${key}`);
  if (!Array.isArray(wizard.steps) || !wizard.steps.length || wizard.steps.length > 8) throw new Error('wizard.steps must contain 1 to 8 steps.');
  const stepIds = new Set();
  /** @type {Map<string, WizardField>} */
  const fields = new Map();
  for (const entry of wizard.steps) {
    const step = mapping(entry, ['id', 'title', 'description', 'fields'], 'wizard step');
    text(step.id, 'step.id', 80);
    text(step.title, 'step.title', 200);
    if (!/^[a-z][a-z0-9-]*$/.test(step.id) || stepIds.has(step.id)) throw new Error('Wizard step identifiers must be unique kebab-case.');
    stepIds.add(step.id);
    if (step.description !== undefined) text(step.description, 'step.description');
    if (!Array.isArray(step.fields) || !step.fields.length || step.fields.length > 20) throw new Error('Each wizard step must contain 1 to 20 fields.');
    for (const entry of step.fields) {
      const field = mapping(entry, ['id', 'label', 'control', 'required', 'advance-on-select', 'empty-message', 'format', 'max-length', 'placeholder', 'default', 'when', 'options'], 'wizard field');
      text(field.id, 'field.id', 80);
      text(field.label, 'field.label', 200);
      if (!/^[a-z][a-z0-9-]*$/.test(field.id) || fields.has(field.id)) throw new Error('Wizard field identifiers must be unique kebab-case.');
      if (!['text', 'textarea', 'select', 'cards', 'checkboxes'].includes(String(field.control))) throw new Error('Unknown wizard field control.');
      if (field.required !== undefined && typeof field.required !== 'boolean') throw new Error('field.required must be a boolean.');
      if (field['advance-on-select'] !== undefined && (field.control !== 'cards' || typeof field['advance-on-select'] !== 'boolean')) {
        throw new Error('field.advance-on-select must be a boolean on a cards control.');
      }
      if (field.placeholder !== undefined) text(field.placeholder, 'field.placeholder');
      if (field['empty-message'] !== undefined) text(field['empty-message'], 'field.empty-message', 1000);
      if (field['max-length'] !== undefined && (!Number.isInteger(field['max-length']) || Number(field['max-length']) < 1 || Number(field['max-length']) > 8000)) {
        throw new Error('field.max-length must be an integer from 1 to 8000.');
      }
      const choices = field.control === 'select' || field.control === 'cards' || field.control === 'checkboxes';
      if (field.format !== undefined && (!['identifier', 'repositories'].includes(String(field.format)) || choices)) throw new Error('field.format supports identifier or repositories on text controls only.');
      if (choices) {
        if (!Array.isArray(field.options) || !field.options.length || field.options.length > 100) throw new Error('Choice fields require 1 to 100 options.');
        const values = new Set();
        for (const entry of field.options) {
          const option = mapping(entry, ['value', 'label', 'description', 'summary', 'instructions', 'icon', 'context', 'defaults'], 'wizard option');
          text(option.value, 'option.value', 100);
          text(option.label, 'option.label', 200);
          if (!/^[a-z][a-z0-9_-]*$/.test(option.value) || values.has(option.value)) throw new Error('Wizard option values must be unique identifiers.');
          values.add(option.value);
          if (option.description !== undefined) text(option.description, 'option.description');
          if (option.summary !== undefined) text(option.summary, 'option.summary', 1000);
          if (option.instructions !== undefined) text(option.instructions, 'option.instructions');
          if (option.icon !== undefined && !octiconNames.includes(String(option.icon))) throw new Error('option.icon must be a canonical Octicon.');
          if (option.context !== undefined && JSON.stringify(option.context).length > 30_000) throw new Error('Wizard option context is too large.');
        }
      } else if (field.options !== undefined) throw new Error('Text fields cannot declare options.');
      if (field.when !== undefined) {
        const when = mapping(field.when, ['field', 'equals'], 'field.when');
        const dependency = fields.get(String(when.field));
        if (!dependency || !['select', 'cards'].includes(dependency.control) || !dependency.options?.some((option) => option.value === when.equals)) {
          throw new Error('field.when must match an option of an earlier single-choice field.');
        }
      }
      const parsed = /** @type {WizardField} */ (field);
      if (field.default !== undefined) {
        const error = wizardFieldError({ ...parsed, required: false }, /** @type {string|string[]} */ (field.default));
        if (error) throw new Error(`Invalid default: ${error}`);
      }
      fields.set(field.id, parsed);
    }
  }
  for (const field of fields.values()) {
    for (const option of field.options ?? []) {
      if (option.defaults === undefined) continue;
      if (!['select', 'cards'].includes(field.control)) throw new Error('option.defaults requires a single-choice control.');
      const defaults = mapping(option.defaults, [...fields.keys()], 'option.defaults');
      if (!Object.keys(defaults).length) throw new Error('option.defaults must name a field to prefill.');
      for (const [id, value] of Object.entries(defaults)) {
        const target = fields.get(id);
        if (!target || id === field.id) throw new Error('option.defaults must reference another declared field.');
        const error = wizardFieldError({ ...target, required: false }, value);
        if (error) throw new Error(`Invalid option default: ${error}`);
      }
    }
  }
  if (wizard.provenance !== undefined) {
    const source = mapping(wizard.provenance, ['repository', 'revision', 'url', 'generated-at', 'source-repositories', 'total-workflows', 'notice', 'license'], 'wizard.provenance');
    for (const key of ['repository', 'revision', 'url', 'generated-at', 'notice', 'license']) text(source[key], `provenance.${key}`);
    if (source.repository !== 'githubnext/gh-aw-wizard' || !/^[a-f0-9]{40}$/.test(String(source.revision))
      || source.url !== `https://github.com/${source.repository}/tree/${source.revision}/patterns`
      || !Number.isFinite(Date.parse(String(source['generated-at'])))) throw new Error('Wizard pattern provenance must identify an immutable upstream revision.');
    for (const key of ['source-repositories', 'total-workflows']) {
      if (!Number.isSafeInteger(source[key]) || Number(source[key]) < 0) throw new Error(`provenance.${key} must be a nonnegative integer.`);
    }
  }
  return /** @type {PromptWizard} */ (wizard);
}

/** @param {WizardField} field @param {WizardValues} values */
export function wizardFieldVisible(field, values) {
  return !field.when || values[field.when.field] === field.when.equals;
}

/** @param {WizardField} field @param {unknown} value @returns {string | null} */
export function wizardFieldError(field, value) {
  const multiple = field.control === 'checkboxes';
  if (multiple ? !Array.isArray(value) || value.some((item) => typeof item !== 'string') : typeof value !== 'string') return `${field.label} has an invalid value.`;
  if (field.required && (multiple ? !/** @type {string[]} */ (value).length : !String(value).trim())) return `${field.label} is required.`;
  const values = Array.isArray(value) ? value : value ? [value] : [];
  if (field.options && (new Set(values).size !== values.length || values.some((value) => !field.options?.some((option) => option.value === value)))) return `Choose a declared option for ${field.label}.`;
  if (typeof value === 'string' && value.length > (field['max-length'] ?? 8000)) return `${field.label} is too long.`;
  if (field.format === 'identifier' && value && !/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/.test(String(value))) return `${field.label} must use kebab-case.`;
  if (field.format === 'repositories' && value && String(value).trim().split(/[\s,]+/).some((repository) => !isSafeRepositorySlug(repository))) {
    return `${field.label} must list exact owner/repository names separated by commas or whitespace.`;
  }
  return null;
}

/** @param {PromptWizard} wizard @returns {WizardValues} */
export function initialWizardValues(wizard) {
  return Object.fromEntries(wizard.steps.flatMap((step) => step.fields.map((field) => [
    field.id, field.default === undefined ? field.control === 'checkboxes' ? [] : '' : structuredClone(field.default)
  ])));
}

/** @param {WizardField} field @param {WizardValues} values @param {string|string[]} value @returns {WizardValues} */
export function updateWizardValues(field, values, value) {
  const defaults = typeof value === 'string' && values[field.id] !== value
    ? field.options?.find((option) => option.value === value)?.defaults : undefined;
  return { ...values, ...structuredClone(defaults ?? {}), [field.id]: value };
}

/** @param {PromptWizard} wizard @param {WizardValues} values */
export function wizardDesign(wizard, values) {
  return Object.fromEntries(wizard.steps.flatMap((step) => step.fields.flatMap((field) => {
    if (!wizardFieldVisible(field, values)) return [];
    const value = values[field.id];
    const error = wizardFieldError(field, value);
    if (error) throw new Error(error);
    const selected = Array.isArray(value) ? value : [value];
    const references = field.options?.filter((option) => selected.includes(option.value));
    return [[field.id, {
      label: field.label, value,
      ...(references?.length ? { choices: references } : {})
    }]];
  })));
}

/** @param {PromptWizard} wizard @param {WizardValues} values @returns {Array<{ label: string, value: string, description: string }>} */
export function wizardReview(wizard, values) {
  const design = wizardDesign(wizard, values);
  return wizard.steps.flatMap((step) => step.fields.flatMap((field) => {
    const answer = design[field.id];
    if (!answer) return [];
    const labels = answer.choices?.map((/** @type {WizardOption} */ option) => option.label).join(', ');
    const raw = Array.isArray(answer.value) ? answer.value.join(', ') : answer.value.trim();
    const value = labels || raw || field['empty-message'] || 'Not specified';
    const description = (answer.choices ?? []).map((/** @type {WizardOption} */ option) => option.summary ?? option.description ?? '')
      .filter((/** @type {string} */ detail) => detail && detail !== value).join('\n');
    return [{ label: field.label, value, description }];
  }));
}

/** @param {PromptWizard} wizard @param {WizardValues} values */
export function buildWizardPrompt(wizard, values) {
  const design = wizardDesign(wizard, values);
  const sections = wizard.steps.flatMap((step) => step.fields.flatMap((field) => {
    const answer = design[field.id];
    if (!answer || typeof answer.value === 'string' && !answer.value.trim() && !field.required) return [];
    const title = field.label.replace(/ \(optional\)$/, '');
    const choices = /** @type {WizardOption[]} */ (answer.choices ?? []);
    const content = choices.length
      ? choices.map((option) => [option.label, option.instructions ?? option.summary ?? option.description].filter(Boolean).join('\n')).join('\n\n')
      : typeof answer.value === 'string' ? answer.value.trim()
        : answer.value.length ? answer.value.join(', ') : field['empty-message'] ?? 'None selected.';
    return [`### ${title}\n${content}`];
  }));
  const prompt = [
    'Create a Pull Request for the following task:',
    wizard.prompt.instructions,
    '## Task requirements',
    ...sections
  ].join('\n\n');
  if (prompt.length > 100_000) throw new Error('Generation prompt exceeds the 100,000-character limit. Shorten the design.');
  return prompt;
}
