/**
 * Reshapes wide observations into tidy temporal metric rows for charts,
 * statistics, and browser-side modeling in the data worker.
 */

const MAX_METRICS_PER_OBSERVATION = 64;
const MAX_OUTPUT_ROWS = 100_000;

/** @typedef {Record<string, unknown>} Row */

/**
 * @typedef {{
 *   time: string,
 *   series: string,
 *   shape?: 'tidy'|'groups',
 *   carry?: string[],
 *   measures?: Array<{ field: string, key?: string, kind: string }>,
 *   maps?: Array<{ field: string, definitions?: string, group?: string, kind: string }>
 * }} TemporalSeriesDefinition
 */

/**
 * @param {Row[]} rows
 * @param {TemporalSeriesDefinition} definition
 * @returns {Row[]}
 */
export function projectTemporalSeries(rows, definition) {
  /** @type {Row[]} */
  const projected = [];
  for (const row of rows) {
    const observedTime = row[definition.time];
    const time = typeof observedTime === 'string' ? observedTime : '';
    if (!time || !Number.isFinite(Date.parse(String(time)))) continue;
    const series = scalarText(row[definition.series]);
    const carried = Object.fromEntries((definition.carry ?? []).map((field) => [field, row[field]]));

    for (const measure of definition.measures ?? []) {
      const value = finiteNumber(row[measure.field]);
      if (value === null) continue;
      const metric = scalarText(measure.key ? row[measure.key] : measure.field) || measure.field;
      append(projected, {
        ...carried,
        time,
        series,
        metric,
        'metric-key': `${measure.kind}:${metric}`,
        'metric-name': metric,
        'metric-kind': measure.kind,
        'metric-group': metric,
        value
      });
    }

    for (const map of definition.maps ?? []) {
      const values = record(row[map.field]);
      const definitions = definitionMap(row[map.definitions ?? '']);
      const group = scalarText(map.group ? row[map.group] : '') || map.field;
      const entries = Object.entries(values).slice(0, MAX_METRICS_PER_OBSERVATION);
      for (const [metric, candidate] of entries) {
        const value = finiteNumber(candidate);
        if (value === null) continue;
        append(projected, {
          ...carried,
          time,
          series,
          metric,
          'metric-key': `${map.kind}:${group}:${metric}`,
          'metric-name': definitions.get(metric) ?? metric,
          'metric-kind': map.kind,
          'metric-group': group,
          value
        });
      }
    }
  }
  return definition.shape === 'groups'
    ? groupTemporalSeries(projected, definition.carry ?? [])
    : projected;
}

/**
 * @param {Row[]} rows
 * @param {string[]} carry
 * @returns {Row[]}
 */
function groupTemporalSeries(rows, carry) {
  /** @type {Map<string, Row>} */
  const groups = new Map();
  for (const [index, row] of rows.entries()) {
    const groupKey = JSON.stringify([...carry.map((field) => row[field] ?? null), row['metric-key']]);
    /** @type {Row} */
    const group = groups.get(groupKey) ?? {
      ...Object.fromEntries(carry.map((field) => [field, row[field]])),
      metric: row.metric,
      'metric-key': row['metric-key'],
      'metric-name': row['metric-name'],
      'metric-kind': row['metric-kind'],
      'metric-group': row['metric-group'],
      points: []
    };
    const points = Array.isArray(group.points) ? group.points : [];
    group.points = points;
    points.push({
      x: row.time,
      y: row.value,
      color: row.series,
      key: `${String(row['metric-key'])}:${index}`
    });
    groups.set(groupKey, group);
  }
  return [...groups.values()];
}

/** @param {Row[]} rows @param {Row} row */
function append(rows, row) {
  if (rows.length >= MAX_OUTPUT_ROWS) {
    throw new RangeError(`Temporal series exceeds the ${MAX_OUTPUT_ROWS}-row output limit.`);
  }
  rows.push(row);
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
