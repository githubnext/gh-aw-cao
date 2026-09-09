/**
 * A small, serializable subset of tidy-style row operations.
 *
 * Operators are plain data so the same pipeline can run in a Web Worker.
 */

/**
 * @typedef {Record<string, unknown>} Row
 * @typedef {{ field: string, equals?: unknown, in?: unknown[], includes?: string }} Predicate
 * @typedef {{ op: 'filter', predicates?: Predicate[], search?: { fields: string[], query: string } }} FilterOperator
 * @typedef {{ op: 'summarize', by?: string[], values: Array<{ field: string, as: string, reducer: 'count'|'distinct-count'|'sum'|'mean'|'min'|'max' }> }} SummarizeOperator
 * @typedef {{ op: 'arrange', by: Array<{ field: string, direction?: 'asc'|'desc' }> }} ArrangeOperator
 * @typedef {{ op: 'slice', offset?: number, limit: number }} SliceOperator
 * @typedef {FilterOperator|SummarizeOperator|ArrangeOperator|SliceOperator} DataOperator
 */

/**
 * Applies a sequence of declarative operators without mutating the input rows.
 * @param {Row[]} rows
 * @param {DataOperator[]} operators
 * @returns {Row[]}
 */
export function tidy(rows, operators) {
  return operators.reduce(
    (current, operator) => applyOperator(current, operator),
    [...rows],
  )
}

/** @param {Row[]} rows @param {DataOperator} operator */
function applyOperator(rows, operator) {
  if (operator.op === 'filter') return filter(rows, operator)
  if (operator.op === 'summarize') return summarize(rows, operator)
  if (operator.op === 'arrange') return arrange(rows, operator)
  if (operator.op === 'slice') {
    const offset = Number.isInteger(operator.offset)
      ? Math.max(0, Number(operator.offset))
      : 0
    return rows.slice(offset, offset + Math.max(0, operator.limit))
  }
  throw new TypeError(
    `Unsupported data operator: ${String(/** @type {{ op?: unknown }} */ (operator).op)}`,
  )
}

/** @param {Row[]} rows @param {FilterOperator} operator */
function filter(rows, operator) {
  const query = operator.search?.query.trim().toLocaleLowerCase('en') ?? ''
  const fields = operator.search?.fields ?? []
  return rows.filter((row) => {
    const matchesSearch =
      query === '' ||
      fields.some((field) =>
        String(row[field] ?? '')
          .toLocaleLowerCase('en')
          .includes(query),
      )
    return (
      matchesSearch &&
      (operator.predicates ?? []).every((predicate) =>
        matches(row[predicate.field], predicate),
      )
    )
  })
}

/** @param {unknown} value @param {Predicate} predicate */
function matches(value, predicate) {
  if (Array.isArray(predicate.in))
    return predicate.in.some((candidate) => sameValue(value, candidate))
  if (typeof predicate.includes === 'string') {
    return String(value ?? '')
      .toLocaleLowerCase('en')
      .includes(predicate.includes.toLocaleLowerCase('en'))
  }
  return sameValue(value, predicate.equals)
}

/** @param {unknown} left @param {unknown} right */
function sameValue(left, right) {
  return left == null
    ? right === 'unknown' || right == null
    : String(left) === String(right)
}

/** @param {Row[]} rows @param {SummarizeOperator} operator */
function summarize(rows, operator) {
  const groupFields = operator.by ?? []
  /** @type {Map<string, Row[]>} */
  const groups = new Map()
  for (const row of rows) {
    const key = JSON.stringify(groupFields.map((field) => row[field]))
    const group = groups.get(key) ?? []
    group.push(row)
    groups.set(key, group)
  }
  if (groups.size === 0 && groupFields.length === 0) groups.set('[]', [])
  return [...groups.values()].map((group) => {
    return Object.fromEntries([
      ...groupFields.map((field) => [field, group[0]?.[field]]),
      ...operator.values.map((summary) => [
        summary.as,
        reduceValues(
          group.map((row) => row[summary.field]),
          summary.reducer,
        ),
      ]),
    ])
  })
}

/** @param {unknown[]} input @param {SummarizeOperator['values'][number]['reducer']} reducer */
function reduceValues(input, reducer) {
  const present = input.filter((value) => value != null && value !== '')
  if (reducer === 'count') return present.length
  if (reducer === 'distinct-count') return new Set(present.map(String)).size
  const values = present.map(Number).filter(Number.isFinite)
  if (reducer === 'sum')
    return values.reduce((total, value) => total + value, 0)
  if (values.length === 0) return null
  if (reducer === 'mean')
    return values.reduce((total, value) => total + value, 0) / values.length
  if (reducer === 'min') return Math.min(...values)
  return Math.max(...values)
}

/** @param {Row[]} rows @param {ArrangeOperator} operator */
function arrange(rows, operator) {
  return [...rows].sort((left, right) => {
    for (const ordering of operator.by) {
      const comparison = compareValues(
        left[ordering.field],
        right[ordering.field],
      )
      if (comparison !== 0)
        return ordering.direction === 'desc' ? -comparison : comparison
    }
    return 0
  })
}

/** @param {unknown} left @param {unknown} right */
function compareValues(left, right) {
  if (left === right) return 0
  if (left == null || left === '') return 1
  if (right == null || right === '') return -1
  const leftNumber = Number(String(left).replace(/,/g, ''))
  const rightNumber = Number(String(right).replace(/,/g, ''))
  if (Number.isFinite(leftNumber) && Number.isFinite(rightNumber))
    return leftNumber - rightNumber
  const leftDate = Date.parse(String(left))
  const rightDate = Date.parse(String(right))
  if (Number.isFinite(leftDate) && Number.isFinite(rightDate))
    return leftDate - rightDate
  return String(left).localeCompare(String(right))
}
