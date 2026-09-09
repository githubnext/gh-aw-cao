/**
 * A small, serializable subset of tidy-style row operations.
 *
 * Operators are plain data so the same pipeline can run in a Web Worker.
 */

import { formatCount, titleCase } from './components/count-formatters.js';
import { formatPercent } from './view-formatters.js';

/**
 * @typedef {Record<string, unknown>} Row
 * @typedef {{ field: string, equals?: unknown, in?: unknown[], includes?: string }} Predicate
 * @typedef {{ op: 'filter', predicates?: Predicate[], search?: { fields: string[], query: string } }} FilterOperator
 * @typedef {{ op: 'summarize', by?: string[], values: Array<{ field: string, as: string, reducer: 'count'|'distinct-count'|'distinct-list'|'sum'|'mean'|'min'|'max' }> }} SummarizeOperator
 * @typedef {{ op: 'arrange', by: Array<{ field: string, direction?: 'asc'|'desc' }> }} ArrangeOperator
 * @typedef {{ op: 'slice', offset?: number, limit: number }} SliceOperator
 * @typedef {{ field: string } | { value: string|number|boolean|null }} ComputeArgument
 * @typedef {{ as: string, function: keyof typeof COMPUTE_FUNCTION_ARITY, args: ComputeArgument[] }} ComputedField
 * @typedef {{ op: 'compute', values: ComputedField[] }} ComputeOperator
 * @typedef {{ op: 'select', fields: Array<{ field: string, as?: string }> }} SelectOperator
 * @typedef {FilterOperator|SummarizeOperator|ArrangeOperator|SliceOperator|ComputeOperator|SelectOperator} DataOperator
 */

/**
 * The closed, typed vocabulary of deterministic computed-field functions and
 * the inclusive minimum and maximum argument counts each one accepts.
 */
export const COMPUTE_FUNCTION_ARITY = {
  coalesce: [2, 8],
  concat: [2, 8],
  lower: [1, 1],
  upper: [1, 1],
  'title-case': [1, 1],
  trim: [1, 1],
  'url-encode': [1, 1],
  'equals-any': [2, 8],
  'greater-than': [2, 2],
  if: [3, 3],
  'format-count': [1, 1],
  'format-percent': [1, 1],
  number: [1, 1],
  sum: [2, 8],
  difference: [2, 2],
  product: [2, 8],
  quotient: [2, 2]
};

/** Computed-field functions whose result is always text or null. */
export const TEXT_COMPUTE_FUNCTIONS = [
  'concat', 'lower', 'upper', 'title-case', 'trim', 'url-encode', 'format-count', 'format-percent'
];

/** Computed-field functions whose result is always a finite number or null. */
export const NUMERIC_COMPUTE_FUNCTIONS = ['number', 'sum', 'difference', 'product', 'quotient'];

/**
 * Applies a sequence of declarative operators without mutating the input rows.
 * @param {Row[]} rows
 * @param {DataOperator[]} operators
 * @returns {Row[]}
 */
export function tidy(rows, operators) {
  return operators.reduce((current, operator) => applyOperator(current, operator), [...rows]);
}

/** @param {Row[]} rows @param {DataOperator} operator */
function applyOperator(rows, operator) {
  if (operator.op === 'filter') return filter(rows, operator);
  if (operator.op === 'summarize') return summarize(rows, operator);
  if (operator.op === 'arrange') return arrange(rows, operator);
  if (operator.op === 'compute') return compute(rows, operator);
  if (operator.op === 'select') return select(rows, operator);
  if (operator.op === 'slice') {
    const offset = Number.isInteger(operator.offset) ? Math.max(0, Number(operator.offset)) : 0;
    return rows.slice(offset, offset + Math.max(0, operator.limit));
  }
  throw new TypeError(`Unsupported data operator: ${String(/** @type {{ op?: unknown }} */ (operator).op)}`);
}

/**
 * Adds deterministic computed fields. Computed fields are evaluated in
 * declaration order so a later field may read an earlier one.
 * @param {Row[]} rows @param {ComputeOperator} operator
 */
function compute(rows, operator) {
  return rows.map((row) => {
    const computed = { ...row };
    for (const value of operator.values) {
      computed[value.as] = computeValue(computed, value);
    }
    return computed;
  });
}

/**
 * Projects and renames fields, dropping every field that is not selected.
 * @param {Row[]} rows @param {SelectOperator} operator
 */
function select(rows, operator) {
  return rows.map((row) => Object.fromEntries(
    operator.fields
      .filter((field) => row[field.field] !== undefined)
      .map((field) => [field.as ?? field.field, row[field.field]])
  ));
}

/**
 * Evaluates one computed field. Missing values, unusable types, and
 * division by zero yield `null` rather than throwing or propagating `NaN`.
 * @param {Row} row
 * @param {ComputedField} definition
 * @returns {string|number|boolean|null}
 */
export function computeValue(row, definition) {
  const values = definition.args.map((argument) => (
    'field' in argument ? row[argument.field] ?? null : argument.value ?? null
  ));
  if (definition.function === 'coalesce') {
    return /** @type {string|number|boolean|null} */ (
      values.find((value) => value !== null && value !== '' && typeof value !== 'object') ?? null
    );
  }
  if (definition.function === 'concat') return values.map(textValue).join('');
  if (definition.function === 'lower') return textValue(values[0]).toLocaleLowerCase('en');
  if (definition.function === 'upper') return textValue(values[0]).toLocaleUpperCase('en');
  if (definition.function === 'title-case') return titleCase(textValue(values[0]));
  if (definition.function === 'trim') return textValue(values[0]).trim();
  if (definition.function === 'url-encode') return encodeURIComponent(textValue(values[0]));
  if (definition.function === 'equals-any') {
    return values.slice(1).some((value) => sameValue(values[0], value));
  }
  if (definition.function === 'if') return scalarValue(values[0] === true ? values[1] : values[2]);
  if (definition.function === 'format-count') {
    const value = numericValue(values[0]);
    return value === null ? null : formatCount(value);
  }
  if (definition.function === 'format-percent') {
    const value = numericValue(values[0]);
    return value === null ? null : formatPercent(value);
  }
  const numbers = values.map(numericValue);
  if (numbers.some((value) => value === null)) return null;
  const finite = /** @type {number[]} */ (numbers);
  if (definition.function === 'number') return finite[0];
  if (definition.function === 'greater-than') return finite[0] > finite[1];
  if (definition.function === 'sum') return finite.reduce((total, value) => total + value, 0);
  if (definition.function === 'difference') return finite[0] - finite[1];
  if (definition.function === 'product') return finite.reduce((total, value) => total * value, 1);
  if (definition.function === 'quotient') return finite[1] === 0 ? null : finite[0] / finite[1];
  throw new TypeError(`Unsupported computed-field function: ${String(definition.function)}`);
}

/** @param {unknown} value */
function textValue(value) {
  return value == null || typeof value === 'object' ? '' : String(value);
}

/** @param {unknown} value @returns {string | number | boolean | null} */
function scalarValue(value) {
  return value == null || typeof value === 'object'
    ? null
    : /** @type {string | number | boolean} */ (value);
}

/** @param {unknown} value @returns {number | null} */
function numericValue(value) {
  if (value === null || value === undefined || value === '' || typeof value === 'object' || typeof value === 'boolean') {
    return null;
  }
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
}

/** @param {Row[]} rows @param {FilterOperator} operator */
function filter(rows, operator) {
  const query = operator.search?.query.trim().toLocaleLowerCase('en') ?? '';
  const fields = operator.search?.fields ?? [];
  return rows.filter((row) => {
    const matchesSearch = query === '' || fields.some((field) => String(row[field] ?? '')
      .toLocaleLowerCase('en')
      .includes(query));
    return matchesSearch && (operator.predicates ?? []).every((predicate) => matches(row[predicate.field], predicate));
  });
}

/** @param {unknown} value @param {Predicate} predicate */
function matches(value, predicate) {
  if (Array.isArray(predicate.in)) return predicate.in.some((candidate) => sameValue(value, candidate));
  if (typeof predicate.includes === 'string') {
    return String(value ?? '').toLocaleLowerCase('en').includes(predicate.includes.toLocaleLowerCase('en'));
  }
  return sameValue(value, predicate.equals);
}

/** @param {unknown} left @param {unknown} right */
function sameValue(left, right) {
  return left == null ? right === 'unknown' || right == null : String(left) === String(right);
}

/** @param {Row[]} rows @param {SummarizeOperator} operator */
function summarize(rows, operator) {
  const groupFields = operator.by ?? [];
  /** @type {Map<string, Row[]>} */
  const groups = new Map();
  for (const row of rows) {
    const key = JSON.stringify(groupFields.map((field) => row[field]));
    const group = groups.get(key) ?? [];
    group.push(row);
    groups.set(key, group);
  }
  if (groups.size === 0 && groupFields.length === 0) groups.set('[]', []);
  return [...groups.values()].map((group) => {
    return Object.fromEntries([
      ...groupFields.map((field) => [field, group[0]?.[field]]),
      ...operator.values.map((summary) => [
        summary.as,
        reduceValues(group.map((row) => row[summary.field]), summary.reducer)
      ])
    ]);
  });
}

/** @param {unknown[]} input @param {SummarizeOperator['values'][number]['reducer']} reducer */
function reduceValues(input, reducer) {
  const present = input.filter((value) => value != null && value !== '');
  if (reducer === 'count') return present.length;
  if (reducer === 'distinct-count') return new Set(present.map(String)).size;
  if (reducer === 'distinct-list') return [...new Set(present.map(String))].sort().join(', ');
  const values = present.map(Number).filter(Number.isFinite);
  if (reducer === 'sum') return values.reduce((total, value) => total + value, 0);
  if (values.length === 0) return null;
  if (reducer === 'mean') return values.reduce((total, value) => total + value, 0) / values.length;
  if (reducer === 'min') return Math.min(...values);
  return Math.max(...values);
}

/** @param {Row[]} rows @param {ArrangeOperator} operator */
function arrange(rows, operator) {
  return [...rows].sort((left, right) => {
    for (const ordering of operator.by) {
      const comparison = compareValues(left[ordering.field], right[ordering.field]);
      if (comparison !== 0) return ordering.direction === 'desc' ? -comparison : comparison;
    }
    return 0;
  });
}

/** @param {unknown} left @param {unknown} right */
function compareValues(left, right) {
  if (left === right) return 0;
  if (left == null || left === '') return 1;
  if (right == null || right === '') return -1;
  const leftNumber = Number(String(left).replace(/,/g, ''));
  const rightNumber = Number(String(right).replace(/,/g, ''));
  if (Number.isFinite(leftNumber) && Number.isFinite(rightNumber)) return leftNumber - rightNumber;
  const leftDate = Date.parse(String(left));
  const rightDate = Date.parse(String(right));
  if (Number.isFinite(leftDate) && Number.isFinite(rightDate)) return leftDate - rightDate;
  return String(left).localeCompare(String(right));
}
