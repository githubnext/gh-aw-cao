/**
 * Shared data adapters for the declaratively composed factory elements.
 */

/** @typedef {Record<string, unknown>} Row */
/** @typedef {{ rows: () => Row[], pending: () => boolean, unavailable: () => boolean }} SourceBinding */
/** @typedef {Record<string, SourceBinding>} SourceBindings */
/** @typedef {{ total: number, registered: number, unavailable: boolean, registeredUnavailable: boolean }} Coverage */
/** @typedef {{ operations: number, live: number, review: number }} Motion */
/** @typedef {{ singular: string, plural: string }} PluralText */

/**
 * @typedef {{
 *   successfulRuns: () => number,
 *   failedRuns: () => number,
 *   activeRuns: () => number,
 *   valueGains: () => number,
 *   coverage: () => Coverage,
 *   workers: () => number,
 *   dispatches: () => number,
 *   failedDispatches: () => number,
 *   usefulOutputs: () => number,
 *   deliveredRepositories: () => number,
 *   motion: () => Motion
 * }} FactoryMetrics
 */

/** @type {Record<string, PluralText>} */
const DEFAULT_STATION_LABELS = {
  repositories: { singular: 'Repository registered', plural: 'Repositories registered' },
  'successful-runs': { singular: 'Successful run', plural: 'Successful runs' },
  dispatches: { singular: 'Dispatch', plural: 'Dispatches' },
  'value-gains': { singular: 'Value gain', plural: 'Value gains' }
};

/**
 * Adapts page-scoped query payloads to the reactive component boundary.
 * Page subscriptions replace the element when a fresh worker result arrives.
 * @param {Record<string, import('../presenter.js').LogicalSourceInput>} sources
 * @param {string[]} names
 * @returns {SourceBindings}
 */
export function bindFactorySources(sources, names) {
  return Object.fromEntries(names.map((name) => {
    const source = sources[name];
    return [name, {
      rows: () => Array.isArray(source?.rows) ? source.rows : [],
      pending: () => false,
      unavailable: () => !source || source.metadata?.availability === 'unavailable'
    }];
  }));
}

/**
 * Exposes the compact query fields consumed by the factory components.
 * @param {SourceBindings} sources
 * @returns {FactoryMetrics}
 */
export function createFactoryMetrics(sources) {
  /** @param {string} name */
  const row = (name) => sources[name]?.rows()[0] ?? {};
  return {
    successfulRuns: () => numberField(row('overview-run-summary'), 'successful-runs'),
    failedRuns: () => numberField(row('overview-run-summary'), 'failed-runs'),
    activeRuns: () => numberField(row('overview-run-summary'), 'active-runs'),
    valueGains: () => numberField(row('overview-value-summary'), 'value-gains'),
    coverage: () => ({
      total: numberField(row('overview-delivery-summary'), 'delivered-repositories'),
      registered: numberField(row('overview-registered-repository-summary'), 'registered-repositories'),
      unavailable: sources['overview-delivery-summary']?.unavailable() ?? true,
      registeredUnavailable: sources['overview-registered-repository-summary']?.unavailable() ?? true
    }),
    workers: () => numberField(row('overview-worker-summary'), 'workers'),
    dispatches: () => numberField(row('overview-dispatch-summary'), 'dispatches'),
    failedDispatches: () => numberField(row('overview-dispatch-summary'), 'failed-dispatches'),
    usefulOutputs: () => numberField(row('overview-outcome-summary'), 'useful-outputs'),
    deliveredRepositories: () => numberField(row('overview-outcome-summary'), 'delivered-repositories'),
    motion: () => ({
      operations: numberField(row('overview-run-summary'), 'active-runs'),
      live: numberField(row('overview-run-summary'), 'active-live'),
      review: numberField(row('overview-run-summary'), 'active-review')
    })
  };
}

/**
 * @param {Record<string, unknown> | undefined} config
 * @returns {(labelId: string, count: number) => string}
 */
export function factoryStationLabel(config) {
  const declared = config && typeof config === 'object' && config.labels && typeof config.labels === 'object'
    ? /** @type {Record<string, unknown>} */ (config.labels)
    : {};
  return (labelId, count) => {
    const candidate = declared[labelId];
    const text = candidate && typeof candidate === 'object'
      && typeof (/** @type {PluralText} */ (candidate).singular) === 'string'
      && typeof (/** @type {PluralText} */ (candidate).plural) === 'string'
      ? /** @type {PluralText} */ (candidate)
      : DEFAULT_STATION_LABELS[labelId];
    if (!text) return labelId;
    return Math.abs(count) === 1 ? text.singular : text.plural;
  };
}

/** @param {Row} row @param {string} field */
function numberField(row, field) {
  const value = Number(row[field]);
  return Number.isFinite(value) ? value : 0;
}
