/**
 * Converts worker-produced rows into the presentation models consumed by
 * declarative table and chart UI elements.
 */

import { formatString, stringOrFallback, toNumber } from '../view-formatters.js';
import { findLink } from './link-content.js';

/** @typedef {{ field: string, aggregate?: string, as?: string, direction?: string } & Record<string, unknown>} TableField */
/** @typedef {{ key: string, x: string, y: number, weight?: number, category?: string, color: string | null, highlighted?: boolean | null, link: { href: string, label: string } | null, source?: Record<string, unknown> }} ChartPoint */

/** @param {unknown} value */
export function toViewText(value) {
  return stringOrFallback(value, 'unknown');
}

/**
 * @param {Array<Record<string, unknown>>} rows
 * @param {Array<{ field: string, aggregate?: string, as?: string, direction?: string }>} columns
 * @param {unknown} dataConfig
 */
export function prepareTableRows(rows, columns, dataConfig) {
  const aggregateColumns = columns.filter((column) => typeof column.aggregate === 'string');
  let prepared = aggregateColumns.length > 0 ? aggregateTableRows(rows, columns) : [...rows];
  const orderBy = /** @type {TableField[]} */ (isPlainObject(dataConfig) && Array.isArray(dataConfig['order-by'])
    ? dataConfig['order-by'].filter((item) => isPlainObject(item) && typeof item.field === 'string')
    : []);
  if (orderBy.length > 0) {
    prepared.sort((left, right) => compareOrderedRows(left, right, orderBy, columns));
  }
  const limit = isPlainObject(dataConfig) && Number.isInteger(dataConfig.limit) && dataConfig.limit > 0
    ? dataConfig.limit
    : null;
  return limit === null ? prepared : prepared.slice(0, limit);
}

/** @param {Array<Record<string, unknown>>} rows @param {TableField[]} columns */
function aggregateTableRows(rows, columns) {
  const dimensions = columns.filter((column) => typeof column.aggregate !== 'string');
  /** @type {Map<string, Array<Record<string, unknown>>>} */
  const groups = new Map();
  for (const row of rows) {
    const key = JSON.stringify(dimensions.map((column) => row[column.field]));
    const group = groups.get(key) ?? [];
    group.push(row);
    groups.set(key, group);
  }
  return [...groups.values()].map((group) => {
    const output = Object.fromEntries(dimensions.map((column) => [column.field, group[0]?.[column.field]]));
    for (const column of columns.filter((candidate) => typeof candidate.aggregate === 'string')) {
      const outputField = typeof column.as === 'string' ? column.as : column.field;
      output[outputField] = aggregateTableValue(group, column.field, column.aggregate);
    }
    return output;
  });
}

/** @param {Array<Record<string, unknown>>} rows @param {string} field @param {unknown} aggregate */
function aggregateTableValue(rows, field, aggregate) {
  const present = rows.map((row) => row[field]).filter((value) => value != null && value !== '');
  if (aggregate === 'count') return present.length;
  if (aggregate === 'distinct-count') return new Set(present.map(toViewText)).size;
  const values = present.map(toNumber);
  if (aggregate === 'sum') return values.reduce((total, value) => total + value, 0);
  if (aggregate === 'mean') return values.length > 0 ? values.reduce((total, value) => total + value, 0) / values.length : 'Unavailable';
  if (aggregate === 'min') return values.length > 0 ? Math.min(...values) : 'Unavailable';
  if (aggregate === 'max') return values.length > 0 ? Math.max(...values) : 'Unavailable';
  return present[0] == null ? 'Unavailable' : toViewText(present[0]);
}

/** @param {Record<string, unknown>} left @param {Record<string, unknown>} right @param {TableField[]} orderBy @param {TableField[]} columns */
function compareOrderedRows(left, right, orderBy, columns) {
  for (const ordering of orderBy) {
    const comparison = compareValues(left[ordering.field], right[ordering.field]);
    if (comparison !== 0) return ordering.direction === 'desc' ? -comparison : comparison;
  }
  for (const column of columns.filter((candidate) => typeof candidate.aggregate !== 'string')) {
    const comparison = compareValues(left[column.field], right[column.field]);
    if (comparison !== 0) return comparison;
  }
  return 0;
}

/** @param {unknown} left @param {unknown} right */
function compareValues(left, right) {
  if (typeof left === 'number' && typeof right === 'number') return left - right;
  return toViewText(left).localeCompare(toViewText(right));
}

/**
 * @param {string} pageId
 * @param {string} title
 * @param {Array<Record<string, unknown>>} rows
 * @param {Record<string, any> | null} x
 * @param {Record<string, any> | null} y
 * @param {Record<string, any> | null} color
 * @param {string | null} hrefField
 * @param {Record<string, any> | null} [weight]
 */
export function buildChartPoints(pageId, title, rows, x, y, color, hrefField, weight = null) {
  const aggregate = typeof y?.aggregate === 'string' ? y.aggregate : null;
  if (!aggregate || aggregate === 'none') {
    return rows.map((row, rowIndex) => ({
      key: `${pageId}-${title}-${rowIndex}`,
      x: x ? formatString(row[x.field], x.format) : 'unknown',
      y: y ? toNumber(row[y.field]) : 0,
      weight: weight ? toNumber(row[weight.field]) : 1,
      category: y ? formatString(row[y.field], y.format) : 'unknown',
      color: color ? formatString(row[color.field], color.format) : null,
      highlighted: typeof row['in-window'] === 'boolean' ? row['in-window'] : null,
      link: hrefField ? findLink(row, hrefField) : null,
      source: row
    }));
  }

  /** @type {Map<string, { x: string, color: string | null, values: unknown[], links: Array<{ href: string, label: string }>, source: Record<string, unknown> }>} */
  const groups = new Map();
  for (const row of rows) {
    const rawXValue = x ? toViewText(row[x.field]) : 'unknown';
    const rawColorValue = color ? toViewText(row[color.field]) : null;
    const key = JSON.stringify([rawXValue, rawColorValue]);
    const group = groups.get(key) ?? {
      x: x ? formatString(row[x.field], x.format) : 'unknown',
      color: color ? formatString(row[color.field], color.format) : null,
      values: [],
      links: [],
      source: row
    };
    group.values.push(y ? row[y.field] : null);
    const link = hrefField ? findLink(row, hrefField) : null;
    if (link) group.links.push(link);
    groups.set(key, group);
  }
  return [...groups.values()].map((group, index) => {
    const numericValues = group.values.map(toNumber);
    let value = 0;
    if (aggregate === 'count') value = group.values.filter((candidate) => candidate != null && candidate !== '').length;
    else if (aggregate === 'distinct-count') value = new Set(group.values.map(toViewText)).size;
    else if (aggregate === 'sum') value = numericValues.reduce((total, candidate) => total + candidate, 0);
    else if (aggregate === 'mean') value = numericValues.length > 0
      ? numericValues.reduce((total, candidate) => total + candidate, 0) / numericValues.length
      : 0;
    else if (aggregate === 'min') value = numericValues.length > 0 ? Math.min(...numericValues) : 0;
    else if (aggregate === 'max') value = numericValues.length > 0 ? Math.max(...numericValues) : 0;
    const distinctLinks = new Map(group.links.map((link) => [link.href, link]));
    return {
      key: `${pageId}-${title}-${index}`,
      x: group.x,
      y: value,
      weight: weight ? toNumber(group.source[weight.field]) : 1,
      category: toViewText(group.values[0]),
      color: group.color,
      highlighted: null,
      link: distinctLinks.size === 1 ? distinctLinks.values().next().value ?? null : null,
      source: group.source
    };
  });
}

/**
 * @param {Array<{ key: string, x: string, y: number, category?: string, color: string | null, highlighted?: boolean | null, link: { href: string, label: string } | null, source?: Record<string, unknown> }>} points
 * @param {Record<string, any> | null} x
 * @param {Record<string, any> | null} y
 * @param {Record<string, any> | null} color
 * @param {unknown} dataConfig
 */
export function prepareChartPoints(points, x, y, color, dataConfig) {
  const prepared = [...points];
  const orderBy = /** @type {TableField[]} */ (isPlainObject(dataConfig) && Array.isArray(dataConfig['order-by'])
    ? dataConfig['order-by'].filter((item) => isPlainObject(item) && typeof item.field === 'string')
    : []);
  prepared.sort((left, right) => {
    for (const item of orderBy) {
      const comparison = compareValues(
        chartPointOutputValue(left, item.field, x, y, color),
        chartPointOutputValue(right, item.field, x, y, color)
      );
      if (comparison !== 0) return item.direction === 'desc' ? -comparison : comparison;
    }
    const xComparison = compareValues(
      chartPointOutputValue(left, x?.field, x, y, color),
      chartPointOutputValue(right, x?.field, x, y, color)
    );
    return xComparison !== 0
      ? xComparison
      : compareValues(
          chartPointOutputValue(left, color?.field, x, y, color),
          chartPointOutputValue(right, color?.field, x, y, color)
        );
  });
  const limit = isPlainObject(dataConfig) && Number.isInteger(dataConfig.limit) && dataConfig.limit > 0
    ? dataConfig.limit
    : null;
  return limit === null ? prepared : prepared.slice(0, limit);
}

/** @param {ChartPoint} point @param {string | undefined} field @param {Record<string, any> | null} x @param {Record<string, any> | null} y @param {Record<string, any> | null} color */
function chartPointOutputValue(point, field, x, y, color) {
  if (typeof field !== 'string') return null;
  if (field === x?.field || field === x?.as) return point.source?.[x.field] ?? point.x;
  const yOutput = typeof y?.as === 'string'
    ? y.as
    : typeof y?.aggregate === 'string' ? `${y.aggregate}-${y.field}` : y?.field;
  if (field === y?.field || field === yOutput) return point.y;
  if (field === color?.field || field === color?.as) return point.source?.[color.field] ?? point.color;
  return null;
}

/** @param {unknown} value @returns {value is Record<string, any>} */
function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
