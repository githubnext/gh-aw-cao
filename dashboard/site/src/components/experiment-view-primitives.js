import { h } from '../dom.js';

const UNKNOWN = '—';

/**
 * Renders the shared heading used by experiment decision and detail sections.
 * @param {string} id
 * @param {string} title
 * @param {string} description
 * @returns {HTMLElement}
 */
export function renderExperimentSectionHeading(id, title, description) {
  return h('header', { className: 'experiment-section-heading' }, h('div', null, h('h2', { id }, title), h('p', null, description)));
}

/**
 * @param {number} value
 * @returns {HTMLElement}
 */
export function renderExperimentEffect(value) {
  if (!Number.isFinite(value)) return h('span', { className: 'effect effect-unknown' }, UNKNOWN, h('span', { className: 'sr-only' }, ' insufficient evidence'));
  const positive = value > 0;
  const negative = value < 0;
  return h(
    'span',
    { className: `effect ${positive ? 'effect-positive' : negative ? 'effect-negative' : 'effect-neutral'}` },
    `${positive ? '+' : ''}${value.toFixed(3)}`,
    positive ? ' ▲' : negative ? ' ▼' : ' ·',
    h('span', { className: 'sr-only' }, positive ? ' improvement' : negative ? ' regression' : ' no change')
  );
}

/**
 * @param {string} decision
 * @returns {string}
 */
export function decisionTone(decision) {
  if (decision === 'PROMOTE') return 'success';
  if (decision === 'REJECT') return 'danger';
  if (decision === 'READY' || decision === 'EXTEND') return 'attention';
  return 'neutral';
}

/**
 * @param {string} source
 * @param {string} identifier
 * @returns {string}
 */
export function sourceMetricLabel(source, identifier) {
  return source === UNKNOWN ? identifier : `${source}:${identifier}`;
}

/**
 * @param {string} value
 * @returns {string}
 */
export function formatExperimentDate(value) {
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? new Date(timestamp).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' }) : UNKNOWN;
}

/**
 * @param {any[]} observations
 * @param {string} control
 * @param {string} candidate
 * @returns {any[]}
 */
export function metricSummaries(observations, control, candidate) {
  /** @type {Map<string, any[]>} */
  const groups = new Map();
  for (const observation of observations) {
    const key = `${observation.sourceType}:${observation.identifier}`;
    const group = groups.get(key) ?? [];
    group.push(observation);
    groups.set(key, group);
  }
  return [...groups.values()].map((group) => {
    const first = group[0];
    const controlRows = group.filter((row) => row.variant === control && row.included);
    const candidateRows = group.filter((row) => row.variant === candidate && row.included);
    const controlValue = aggregateObservations(controlRows, first.sourceType);
    const candidateValue = aggregateObservations(candidateRows, first.sourceType);
    const rawEffect = difference(candidateValue, controlValue);
    const normalizedEffect = normalizeEffect(rawEffect, first.direction);
    const thresholdRegression = first.role === 'GUARDRAIL' && first.threshold !== null
      ? (first.direction === 'lower_is_better' ? candidateValue > first.threshold : candidateValue < first.threshold)
      : false;
    return {
      identifier: first.identifier,
      sourceType: first.sourceType,
      role: first.role,
      direction: first.direction,
      unit: first.unit,
      question: first.question,
      threshold: first.threshold,
      controlValue,
      candidateValue,
      rawEffect,
      normalizedEffect,
      controlN: controlRows.length,
      candidateN: candidateRows.length,
      excluded: group.length - controlRows.length - candidateRows.length,
      regression: thresholdRegression || (Number.isFinite(normalizedEffect) && normalizedEffect < 0)
    };
  }).sort((left, right) => roleOrder(left.role) - roleOrder(right.role) || left.identifier.localeCompare(right.identifier));
}

/**
 * @param {any[]} rows
 * @param {string} sourceType
 * @returns {number}
 */
function aggregateObservations(rows, sourceType) {
  if (sourceType === 'eval') {
    const known = rows.filter((row) => row.result === 'YES' || row.result === 'NO');
    return known.length ? known.filter((row) => row.result === 'YES').length / known.length : NaN;
  }
  return mean(rows.map(numericObservation).filter(Number.isFinite));
}

/**
 * @param {any} observation
 * @returns {number}
 */
function numericObservation(observation) {
  if (observation.sourceType === 'eval') return observation.result === 'YES' ? 1 : observation.result === 'NO' ? 0 : NaN;
  return finite(observation.result) ?? NaN;
}

/**
 * @param {number} value
 * @param {string} direction
 * @returns {number}
 */
function normalizeEffect(value, direction) {
  if (!Number.isFinite(value)) return NaN;
  return direction === 'lower_is_better' ? -value : value;
}

/**
 * @param {number} left
 * @param {number} right
 * @returns {number}
 */
function difference(left, right) {
  return Number.isFinite(left) && Number.isFinite(right) ? left - right : NaN;
}

/**
 * @param {number[]} values
 * @returns {number}
 */
function mean(values) {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : NaN;
}

/**
 * @param {unknown} value
 * @returns {number | null}
 */
function finite(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

/**
 * @param {string} role
 * @returns {number}
 */
function roleOrder(role) {
  return role === 'PRIMARY' ? 0 : role === 'GUARDRAIL' ? 1 : 2;
}
