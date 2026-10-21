/**
 * Reshapes wide observations into tidy temporal metric rows for charts,
 * statistics, and browser-side modeling in the data worker.
 */

import { createDebug } from '../../debug.js';

const debugTemporalSeries = createDebug('temporal-series');

const MAX_METRICS_PER_OBSERVATION = 64;
const MAX_OUTPUT_ROWS = 100_000;

/** @typedef {Record<string, unknown>} Row */
/** @typedef {{ point: Row, time: number }} TimedPoint */
/** @typedef {{ row: Row, points: TimedPoint[], series: Map<string, TimedPoint[]> }} TemporalGroup */

/**
 * @typedef {{
 *   time: string,
 *   series: string,
 *   shape?: 'tidy'|'groups'|'panels',
 *   link?: string,
 *   carry?: string[],
 *   ['point-carry']?: string[],
 *   measures?: Array<{ field: string, key?: string, kind: string }>,
 *   maps?: Array<{ field: string, definitions?: string, group?: string, kind: string }>,
 *   trend?: { direction: string }
 * }} TemporalSeriesDefinition
 */

/**
 * @param {Row[]} rows
 * @param {TemporalSeriesDefinition} definition
 * @returns {Row[]}
 */
export function projectTemporalSeries(rows, definition) {
  const pointFields = definition['point-carry'];
  if (pointFields !== undefined && (definition.shape !== 'panels' || !Array.isArray(pointFields)
    || pointFields.length === 0 || pointFields.length > 16 || pointFields.some(field => typeof field !== 'string' || !field))) {
    throw new TypeError('temporal-series point-carry requires panels and 1 to 16 named fields.');
  }
  debugTemporalSeries({ event: 'projection-started', inputRows: rows.length, shape: definition.shape ?? 'tidy' });
  const carry = definition.carry ?? [];
  const panels = definition.shape === 'panels';
  const grouped = panels || definition.shape === 'groups';
  /** @type {Row[]} */
  const projected = [];
  /** @type {Map<string, TemporalGroup>} */
  const groups = new Map();
  let count = 0;
  /**
   * Group during expansion so grouped queries never retain a second tidy table.
   * @param {Row} row
   * @param {number} time
   * @param {Row | undefined} metadata
   */
  function append(row, time, metadata) {
    if (count >= MAX_OUTPUT_ROWS) {
      debugTemporalSeries({ event: 'projection-rejected', reason: 'output-row-limit', limit: MAX_OUTPUT_ROWS });
      throw new RangeError(`Temporal series exceeds the ${MAX_OUTPUT_ROWS}-row output limit.`);
    }
    const index = count++;
    if (!grouped) {
      projected.push(row);
      return;
    }
    const key = JSON.stringify([...carry.map((field) => row[field] ?? null), row['metric-key']]);
    let group = groups.get(key);
    if (!group) {
      group = {
        row: Object.fromEntries([...carry, 'metric', 'metric-key', 'metric-name', 'metric-kind', 'metric-group']
          .map((field) => [field, row[field]])),
        points: [],
        series: new Map()
      };
      groups.set(key, group);
    }
    const point = {
      x: row.time,
      y: row.value,
      key: `${String(row['metric-key'])}:${index}`,
      ...(!panels ? { color: row.series } : {}),
      ...(panels && metadata ? { metadata } : {}),
      ...(panels && row.link !== undefined ? { link: row.link } : {})
    };
    let points = group.points;
    if (panels) {
      const id = String(row.series);
      points = group.series.get(id) ?? [];
      group.series.set(id, points);
    }
    points.push({ point, time });
  }
  for (const row of rows) {
    const observedTime = row[definition.time];
    const time = typeof observedTime === 'string' ? observedTime : '';
    if (!time) continue;
    const timestamp = Date.parse(time);
    if (!Number.isFinite(timestamp)) continue;
    const series = scalarText(row[definition.series]);
    const carried = Object.fromEntries(carry.map((field) => [field, row[field]]));
    const linked = definition.link ? { link: row[definition.link] } : {};
    const pointMetadata = pointFields ? Object.fromEntries(pointFields
        .filter((field) => row[field] !== undefined)
        .map((field) => {
          const value = row[field];
          if (value !== null && !['string', 'number', 'boolean'].includes(typeof value)) {
            throw new TypeError('temporal-series point-carry requires scalar fields.');
          }
          return [field, value];
        })) : undefined;

    for (const measure of definition.measures ?? []) {
      const value = finiteNumber(row[measure.field]);
      if (value === null) continue;
      const metric = scalarText(measure.key ? row[measure.key] : measure.field) || measure.field;
      append({
        ...carried,
        ...linked,
        time,
        series,
        metric,
        'metric-key': `${measure.kind}:${metric}`,
        'metric-name': metric,
        'metric-kind': measure.kind,
        'metric-group': metric,
        value
      }, timestamp, pointMetadata);
    }

    for (const map of definition.maps ?? []) {
      const values = record(row[map.field]);
      const definitions = definitionMap(row[map.definitions ?? '']);
      const group = scalarText(map.group ? row[map.group] : '') || map.field;
      const entries = Object.entries(values).slice(0, MAX_METRICS_PER_OBSERVATION);
      for (const [metric, candidate] of entries) {
        const value = finiteNumber(candidate);
        if (value === null) continue;
        append({
          ...carried,
          ...linked,
          time,
          series,
          metric,
          'metric-key': `${map.kind}:${group}:${metric}`,
          'metric-name': definitions.get(metric) ?? metric,
          'metric-kind': map.kind,
          'metric-group': group,
          value
        }, timestamp, pointMetadata);
      }
    }
  }
  const result = grouped ? [...groups.values()].map((group) => {
    if (panels) {
      return {
        ...group.row,
        series: [...group.series]
          .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
          .map(([id, points]) => ({ id, label: id, points: orderedPoints(points) }))
      };
    }
    const points = orderedPoints(group.points);
    /** @type {Row} */
    const row = { ...group.row, points };
    return definition.trend
      ? appendTrend(row, scalarText(row[definition.trend.direction]), points)
      : row;
  }) : projected;
  debugTemporalSeries({ event: 'projection-completed', outputRows: result.length });
  return result;
}

/**
 * @param {TimedPoint[]} points
 * @returns {Row[]}
 */
function orderedPoints(points) {
  for (let index = 1; index < points.length; index++) {
    if (points[index].time < points[index - 1].time) {
      points.sort((left, right) => left.time - right.time);
      break;
    }
  }
  return points.map(({ point }) => point);
}

/**
 * @param {Row} group
 * @param {string} preferredDirection
 * @param {Row[]} points Already timestamp-ordered by the temporal projection.
 * @returns {Row}
 */
function appendTrend(group, preferredDirection, points) {
  if (points.length < 2) {
    return {
      ...group,
      'trend-observation-count': points.length,
      'trend-assessment': 'insufficient'
    };
  }
  const startValue = finiteNumber(points[0]?.y);
  const endValue = finiteNumber(points.at(-1)?.y);
  if (startValue === null || endValue === null) {
    return {
      ...group,
      'trend-observation-count': points.length,
      'trend-assessment': 'insufficient'
    };
  }
  const delta = endValue - startValue;
  const observedDirection = delta > 0 ? 'up' : delta < 0 ? 'down' : 'flat';
  const assessment = observedDirection === 'flat'
    ? 'stable'
    : (preferredDirection === 'increase' && observedDirection === 'up')
        || (preferredDirection === 'decrease' && observedDirection === 'down')
      ? 'improving'
      : (preferredDirection === 'increase' && observedDirection === 'down')
          || (preferredDirection === 'decrease' && observedDirection === 'up')
        ? 'worsening'
        : 'neutral';
  return {
    ...group,
    'trend-start-value': startValue,
    'trend-end-value': endValue,
    'trend-delta': delta,
    'trend-relative-percent': startValue === 0 ? null : (delta / Math.abs(startValue)) * 100,
    'trend-observed-direction': observedDirection,
    'trend-assessment': assessment,
    'trend-observation-count': points.length
  };
}

/** @param {unknown} value @returns {number|null} */
function finiteNumber(value) {
  if (value === null || value === undefined || value === '') return null;
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
}

/** @param {unknown} value @returns {string} */
function scalarText(value) {
  return typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean'
    ? String(value)
    : '';
}

/** @param {unknown} value @returns {Row} */
function record(value) {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? /** @type {Row} */ (value)
    : {};
}

/** @param {unknown} value @returns {Map<string, string>} */
function definitionMap(value) {
  return new Map((Array.isArray(value) ? value : []).flatMap((definition) => {
    const candidate = record(definition);
    const id = scalarText(candidate.id);
    return id ? [[id, scalarText(candidate.name) || id]] : [];
  }));
}
