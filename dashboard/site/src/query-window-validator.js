import { ERROR_CODES, ORDER_BY_KEYS, ORDER_DIRECTION_VALUES, QUERY_WINDOW_KEYS } from './specification.js';
import { createDebug } from './debug.js';

const debugQueryWindow = createDebug('query-window-validator');

/**
 * @param {unknown} definitions
 * @param {unknown} windowNode
 * @param {string} path
 * @param {import('./validator.js').ValidationError[]} errors
 * @param {{
 *   isPlainObject: (value: unknown) => value is Record<string, unknown>,
 *   getValueNodeByKey: (node: unknown, key: string) => unknown,
 *   getSequenceItemNode: (node: unknown, index: number) => unknown,
 *   validateObjectKeys: (node: unknown, keys: string[], path: string, errors: import('./validator.js').ValidationError[]) => void,
 *   validateStringField: (value: unknown, path: string, required: boolean, errors: import('./validator.js').ValidationError[]) => void,
 *   createError: (code: string, message: string, path: string) => import('./validator.js').ValidationError,
 *   requireField: (field: unknown, path: string) => void,
 *   requireSchemaType: (field: unknown, path: string, use: 'read'|'scalar'|'numeric') => void,
 *   declareField: (field: unknown, path: string) => void
 * }} helpers
 */
export function validateQueryWindow(definitions, windowNode, path, errors, helpers) {
  const {
    isPlainObject, getValueNodeByKey, getSequenceItemNode, validateObjectKeys,
    validateStringField, createError, requireField, requireSchemaType, declareField
  } = helpers;
  if (!Array.isArray(definitions) || definitions.length === 0 || definitions.length > 8) {
    debugQueryWindow({ event: 'window-rejected', reason: 'invalid-definition-count' });
    errors.push(createError(ERROR_CODES.missingOrInvalidRequiredField, 'window must contain 1 to 8 definitions.', `${path}.window`));
    return;
  }
  const errorCountBeforeWindow = errors.length;
  for (const [index, entry] of definitions.entries()) {
    const entryPath = `${path}.window[${index}]`;
    if (!isPlainObject(entry)) {
      errors.push(createError(ERROR_CODES.missingOrInvalidRequiredField, 'window definition must be a mapping.', entryPath));
      continue;
    }
    const entryNode = getSequenceItemNode(windowNode, index);
    validateObjectKeys(entryNode, QUERY_WINDOW_KEYS, entryPath, errors);
    validateStringField(entry.field, `${entryPath}.field`, true, errors);
    validateStringField(entry.as, `${entryPath}.as`, true, errors);
    requireField(entry.field, `${entryPath}.field`);
    requireSchemaType(entry.field, `${entryPath}.field`, 'numeric');
    if (entry.operation !== 'rolling' && entry.operation !== 'change') {
      debugQueryWindow({ event: 'operation-rejected', operation: typeof entry.operation === 'string' ? entry.operation : typeof entry.operation });
      errors.push(createError(ERROR_CODES.nonCanonicalVocabularyOrIdentifier, 'window operation must be rolling or change.', `${entryPath}.operation`));
    }
    if (!Array.isArray(entry['order-by']) || entry['order-by'].length === 0 || entry['order-by'].length > 8) {
      errors.push(createError(ERROR_CODES.missingOrInvalidRequiredField, 'window order-by must contain 1 to 8 fields.', `${entryPath}.order-by`));
    } else {
      entry['order-by'].forEach((clause, clauseIndex) => {
        const clausePath = `${entryPath}.order-by[${clauseIndex}]`;
        if (!isPlainObject(clause)) {
          errors.push(createError(ERROR_CODES.missingOrInvalidRequiredField, 'window order-by entry must be a mapping.', clausePath));
          return;
        }
        validateObjectKeys(getSequenceItemNode(getValueNodeByKey(entryNode, 'order-by'), clauseIndex), ORDER_BY_KEYS, clausePath, errors);
        validateStringField(clause.field, `${clausePath}.field`, true, errors);
        requireField(clause.field, `${clausePath}.field`);
        requireSchemaType(clause.field, `${clausePath}.field`, 'scalar');
        if (clause.direction !== undefined && !ORDER_DIRECTION_VALUES.includes(String(clause.direction))) {
          errors.push(createError(ERROR_CODES.nonCanonicalVocabularyOrIdentifier, 'window order direction must be asc or desc.', `${clausePath}.direction`));
        }
      });
    }
    if (entry.groupby !== undefined) {
      if (!Array.isArray(entry.groupby) || entry.groupby.length === 0 || entry.groupby.length > 8 || new Set(entry.groupby).size !== entry.groupby.length) {
        errors.push(createError(ERROR_CODES.missingOrInvalidRequiredField, 'window groupby must contain 1 to 8 distinct fields.', `${entryPath}.groupby`));
      } else {
        entry.groupby.forEach((field, groupIndex) => {
          const fieldPath = `${entryPath}.groupby[${groupIndex}]`;
          validateStringField(field, fieldPath, true, errors);
          requireField(field, fieldPath);
          requireSchemaType(field, fieldPath, 'scalar');
        });
      }
    }
    if (entry.operation === 'rolling') {
      if (!Number.isSafeInteger(entry.frame) || Number(entry.frame) < 1 || Number(entry.frame) > 1000) {
        errors.push(createError(ERROR_CODES.missingOrInvalidRequiredField, 'rolling frame must be an integer from 1 to 1000.', `${entryPath}.frame`));
      }
      if (entry.reducer !== undefined && !['sum', 'mean', 'min', 'max'].includes(String(entry.reducer))) {
        errors.push(createError(ERROR_CODES.nonCanonicalVocabularyOrIdentifier, 'rolling reducer must be sum, mean, min, or max.', `${entryPath}.reducer`));
      }
      if (entry.alignment !== undefined && !['trailing', 'centered'].includes(String(entry.alignment))) {
        errors.push(createError(ERROR_CODES.nonCanonicalVocabularyOrIdentifier, 'rolling alignment must be trailing or centered.', `${entryPath}.alignment`));
      }
      if (entry.alignment === 'centered' && Number(entry.frame) % 2 !== 1) {
        errors.push(createError(ERROR_CODES.missingOrInvalidRequiredField, 'centered rolling frame must be odd.', `${entryPath}.frame`));
      }
      if (entry.mode !== undefined || entry['time-field'] !== undefined || entry.unit !== undefined) {
        errors.push(createError(ERROR_CODES.missingOrInvalidRequiredField, 'rolling does not accept mode, time-field, or unit.', entryPath));
      }
    } else if (entry.operation === 'change') {
      if (entry.frame !== undefined || entry.reducer !== undefined || entry.alignment !== undefined) {
        errors.push(createError(ERROR_CODES.missingOrInvalidRequiredField, 'change does not accept frame, reducer, or alignment.', entryPath));
      }
      if (entry.mode !== undefined && !['absolute', 'percentage', 'rate'].includes(String(entry.mode))) {
        errors.push(createError(ERROR_CODES.nonCanonicalVocabularyOrIdentifier, 'change mode must be absolute, percentage, or rate.', `${entryPath}.mode`));
      }
      if (entry.mode === 'rate') {
        validateStringField(entry['time-field'], `${entryPath}.time-field`, true, errors);
        requireField(entry['time-field'], `${entryPath}.time-field`);
        if (!['second', 'minute', 'hour', 'day'].includes(String(entry.unit))) {
          errors.push(createError(ERROR_CODES.nonCanonicalVocabularyOrIdentifier, 'rate unit must be second, minute, hour, or day.', `${entryPath}.unit`));
        }
      } else if (entry['time-field'] !== undefined || entry.unit !== undefined) {
        errors.push(createError(ERROR_CODES.missingOrInvalidRequiredField, 'time-field and unit require rate mode.', entry['time-field'] !== undefined ? `${entryPath}.time-field` : `${entryPath}.unit`));
      }
    }
    declareField(entry.as, `${entryPath}.as`);
  }
  debugQueryWindow({
    event: 'window-validated',
    definitionCount: definitions.length,
    status: errors.length === errorCountBeforeWindow ? 'ok' : 'invalid'
  });
}
