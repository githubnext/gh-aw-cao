import {
  ERROR_CODES, VIEW_FILTER_BAR_KEYS, VIEW_FILTER_CONTROL_KEYS, VIEW_FILTER_GROUP_KEYS
} from './specification.js';
import { viewDataSourceNames } from './view-filter-contract.js';
import { createDebug } from './debug.js';

const debugViewFilterValidator = createDebug('view-filter-validator');

/**
 * @param {Record<string, unknown>} view
 * @param {unknown} viewNode
 * @param {string} path
 * @param {string | null} sourceName
 * @param {import('./validator.js').ValidationError[]} errors
 * @param {{
 *   isPlainObject: (value: unknown) => value is Record<string, unknown>,
 *   getValueNodeByKey: (node: unknown, key: string) => unknown,
 *   getSequenceItemNode: (node: unknown, index: number) => unknown,
 *   getMappingItems: (node: unknown) => unknown[] | null,
 *   validateObjectKeys: (node: unknown, keys: string[], path: string, errors: import('./validator.js').ValidationError[]) => void,
 *   validateRequiredIdentifier: (value: unknown, path: string, label: string, errors: import('./validator.js').ValidationError[]) => void,
 *   validateStringField: (value: unknown, path: string, required: boolean, errors: import('./validator.js').ValidationError[]) => void,
 *   validateSource: (value: unknown, path: string, errors: import('./validator.js').ValidationError[]) => void,
 *   sourceFieldNames: (source: string) => string[] | undefined,
 *   createError: (code: string, message: string, path: string) => import('./validator.js').ValidationError
 * }} helpers
 */
export function validateViewFilterBar(view, viewNode, path, sourceName, errors, helpers) {
  const {
    isPlainObject, getValueNodeByKey, getSequenceItemNode, getMappingItems,
    validateObjectKeys, validateRequiredIdentifier, validateStringField,
    validateSource, sourceFieldNames, createError
  } = helpers;
  const bar = view['filter-bar'];
  if (bar === undefined) return;
  validateRequiredIdentifier(view.id, `${path}.id`, 'view id', errors);
  const barPath = `${path}.filter-bar`;
  const fail = (/** @type {string} */ message, /** @type {string} */ errorPath = barPath) => {
    errors.push(createError(ERROR_CODES.invalidScopeFilterTimeAggregationOrOrderReference, message, errorPath));
  };
  /** @param {Record<string, unknown>} value @param {unknown} node @param {string[]} keys @param {string} keyPath */
  const validateKeys = (value, node, keys, keyPath) => {
    validateObjectKeys(node, keys, keyPath, errors);
    if (getMappingItems(node)) return;
    for (const key of Object.keys(value)) {
      if (!keys.includes(key)) {
        errors.push(createError(ERROR_CODES.unknownOrDuplicateKey, `Unknown key "${key}" is not allowed at ${keyPath}.`, `${keyPath}.${key}`));
      }
    }
  };
  if (view.mark !== 'list' && (view.mark !== 'table' || view.controls === 'static')) {
    fail('View filter-bar is supported only on list and interactive table views.');
  }
  if (!isPlainObject(bar)) {
    debugViewFilterValidator({ event: 'filter-bar-rejected', reason: 'not-a-mapping' });
    fail('View filter-bar must be a mapping.');
    return;
  }
  const barNode = getValueNodeByKey(viewNode, 'filter-bar');
  validateKeys(bar, barNode, VIEW_FILTER_BAR_KEYS, barPath);
  if (!Array.isArray(bar.filters) || bar.filters.length === 0) {
    debugViewFilterValidator({ event: 'filter-bar-rejected', reason: 'empty-filters' });
    fail('filter-bar.filters must be a non-empty sequence.', `${barPath}.filters`);
    return;
  }
  const errorCountBeforeFilterBar = errors.length;
  const ids = new Set();
  const fields = new Set();
  bar.filters.forEach((control, index) => {
    const controlPath = `${barPath}.filters[${index}]`;
    const controlNode = getSequenceItemNode(getValueNodeByKey(barNode, 'filters'), index);
    if (!isPlainObject(control)) {
      fail('Filter control must be a mapping.', controlPath);
      return;
    }
    validateKeys(control, controlNode, VIEW_FILTER_CONTROL_KEYS, controlPath);
    validateRequiredIdentifier(control.id, `${controlPath}.id`, 'filter control id', errors);
    validateStringField(control.label, `${controlPath}.label`, true, errors);
    if (ids.has(control.id)) fail('Filter control ids must be unique.', `${controlPath}.id`);
    ids.add(control.id);
    if (!Array.isArray(control.groups) || control.groups.length === 0) {
      fail('Filter groups must be a non-empty sequence.', `${controlPath}.groups`);
      return;
    }
    control.groups.forEach((group, groupIndex) => {
      const groupPath = `${controlPath}.groups[${groupIndex}]`;
      const groupNode = getSequenceItemNode(getValueNodeByKey(controlNode, 'groups'), groupIndex);
      if (!isPlainObject(group)) {
        fail('Filter group must be a mapping.', groupPath);
        return;
      }
      validateKeys(group, groupNode, VIEW_FILTER_GROUP_KEYS, groupPath);
      for (const key of ['label', 'field', 'source', 'value-field']) {
        validateStringField(group[key], `${groupPath}.${key}`, true, errors);
      }
      if (group['label-field'] !== undefined) validateStringField(group['label-field'], `${groupPath}.label-field`, true, errors);
      validateSource(group.source, `${groupPath}.source`, errors);
      if (!sourceName || typeof group.field !== 'string' || !sourceFieldNames(sourceName)?.includes(group.field)) {
        fail('Filter field must be declared by the view data source.', `${groupPath}.field`);
      }
      if (fields.has(group.field)) fail('Filter fields must be unique within a view.', `${groupPath}.field`);
      fields.add(group.field);
      if (typeof group.source === 'string' && viewDataSourceNames(view).includes(group.source)) {
        fail('Filter options must use a separate declarative source.', `${groupPath}.source`);
      }
      for (const key of ['value-field', 'label-field']) {
        const field = group[key];
        if (field !== undefined && (typeof field !== 'string' || typeof group.source !== 'string'
            || !sourceFieldNames(group.source)?.includes(field))) {
          fail('Filter option field must be declared by its option source.', `${groupPath}.${key}`);
        }
      }
    });
  });
  debugViewFilterValidator({
    event: 'filter-bar-validated',
    controlCount: bar.filters.length,
    status: errors.length === errorCountBeforeFilterBar ? 'ok' : 'invalid'
  });
}
