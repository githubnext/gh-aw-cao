import { chartFacet, MAX_CHART_FACETS } from './chart-facet.js';
import { ADDITIVE_MEASURE_FIELDS, ERROR_CODES, FACET_FIELD_KEYS, FIELD_FORMAT_VALUES, LINK_FIELD_NAMES, NON_ADDITIVE_MEASURE_FIELDS, TEMPORAL_FIELD_NAMES } from './specification.js';
import { sourceFieldNames } from './validator-queries.js';
import { createError, getValueNodeByKey, isPlainObject, validateObjectKeys, validateOptionalStringField, validateStringField } from './validator-common.js';
import { state } from './validator-state.js';

/**
 * @param {Record<string, unknown>} view
 * @param {unknown} node
 * @param {string} path
 * @param {import('./validator.js').ValidationError[]} errors
 */
export function validateChartFacet(view, node, path, errors) {
  const encoding = isPlainObject(view.encoding) ? view.encoding : {};
  const channels = ['facet', 'row', 'column'].filter((key) => encoding[key] !== undefined);
  if (view.facet === undefined && view.columns === undefined && channels.length === 0) return;
  /** @param {string} message @param {string} location */
  const reject = (message, location) => errors.push(createError(ERROR_CODES.invalidScopeFilterTimeAggregationOrOrderReference, message, location));
  if (view.mark !== 'chart') reject('faceting is supported only by chart views.', path);
  if (view.facet !== undefined && channels.length > 0) reject('facet declarations must not mix view and encoding syntax.', `${path}.facet`);
  if (encoding.facet !== undefined && (encoding.row !== undefined || encoding.column !== undefined)) {
    reject('encoding.facet must not be combined with row or column.', `${path}.encoding.facet`);
  }
  const facet = chartFacet(view);
  if (view.columns !== undefined && (!Number.isSafeInteger(view.columns) || Number(view.columns) < 1 || Number(view.columns) > MAX_CHART_FACETS)) {
    reject(`columns must be an integer from 1 to ${MAX_CHART_FACETS}.`, `${path}.columns`);
  }
  if (view.columns !== undefined && !facet?.field) reject('columns requires a single-field facet.', `${path}.columns`);
  const source = isPlainObject(view.data) && typeof view.data.source === 'string' ? view.data.source : null;
  const sourceFields = source ? sourceFieldNames(source) : undefined;
  const encodingNode = getValueNodeByKey(node, 'encoding');
  /** @param {unknown} value @param {unknown} fieldNode @param {string} fieldPath */
  const validateField = (value, fieldNode, fieldPath) => {
    if (!isPlainObject(value)) {
      reject('facet field definitions must be mappings.', fieldPath);
      return;
    }
    validateObjectKeys(fieldNode, FACET_FIELD_KEYS, fieldPath, errors);
    validateStringField(value.field, `${fieldPath}.field`, true, errors);
    validateOptionalStringField(value.title, `${fieldPath}.title`, errors);
    if (value.type !== undefined && !['nominal', 'ordinal'].includes(String(value.type))) {
      reject('facet fields must be nominal or ordinal.', `${fieldPath}.type`);
    }
    const field = typeof value.field === 'string' ? value.field : '';
    const sourceType = source ? state.declaredQueryFieldTypes.get(source)?.get(field) : undefined;
    if (sourceType && !['text', 'scalar', 'boolean'].includes(sourceType)) reject('facet fields must have a categorical source type.', `${fieldPath}.field`);
    if (sourceFields && !sourceFields.includes(field)) reject('facet field must exist in the selected source.', `${fieldPath}.field`);
    if ([...LINK_FIELD_NAMES, ...TEMPORAL_FIELD_NAMES, ...ADDITIVE_MEASURE_FIELDS, ...NON_ADDITIVE_MEASURE_FIELDS].includes(field)) {
      reject('facet fields must be categorical; derive numeric or temporal categories in a query first.', `${fieldPath}.field`);
    }
    if (value.format !== undefined && !['workflow-relative-path', 'workflow-identity-label'].includes(String(value.format))) {
      reject(`facet format must be a categorical format (${FIELD_FORMAT_VALUES.filter((format) => format.startsWith('workflow-') && format !== 'workflow-run-url').join(', ')}).`, `${fieldPath}.format`);
    }
  };
  const rawFacet = view.facet ?? encoding.facet;
  if (rawFacet !== undefined) {
    const facetPath = view.facet !== undefined ? `${path}.facet` : `${path}.encoding.facet`;
    const facetNode = getValueNodeByKey(view.facet !== undefined ? node : encodingNode, 'facet');
    if (!isPlainObject(rawFacet)) reject('facet must be a field definition or a row/column mapping.', facetPath);
    else if (rawFacet.field !== undefined) validateField(rawFacet, facetNode, facetPath);
    else {
      validateObjectKeys(facetNode, ['row', 'column'], facetPath, errors);
      if (rawFacet.row === undefined && rawFacet.column === undefined) reject('facet must declare a field, row, or column.', facetPath);
      for (const channel of ['row', 'column']) {
        if (rawFacet[channel] !== undefined) validateField(rawFacet[channel], getValueNodeByKey(facetNode, channel), `${facetPath}.${channel}`);
      }
    }
  } else {
    for (const channel of ['row', 'column']) {
      if (encoding[channel] !== undefined) validateField(encoding[channel], getValueNodeByKey(encodingNode, channel), `${path}.encoding.${channel}`);
    }
  }
}
