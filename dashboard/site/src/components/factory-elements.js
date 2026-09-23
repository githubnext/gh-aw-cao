/**
 * Shared data adapters for the declaratively composed factory elements.
 */

import { batch, effect, state } from '../reactive.js';
import { publishSource, requestSource, sourceState } from '../source-store.js';
import { dashboardViewAliasName } from '../data/queries/view-payload-compiler.js';

/** @typedef {Record<string, unknown>} Row */
/** @typedef {{ rows: () => Row[], pending: () => boolean, unavailable: () => boolean }} SourceBinding */
/** @typedef {Record<string, SourceBinding>} SourceBindings */
/** @typedef {{ total: number, registered: number, averageCoverage: number, unavailable: boolean, registeredUnavailable: boolean, coverageUnavailable: boolean }} Coverage */
/** @typedef {{ operations: number, live: number, review: number }} Motion */
/** @typedef {{ singular: string, plural: string }} PluralText */

/**
 * @typedef {{
 *   campaigns: () => number,
 *   campaignTotal: () => number,
 *   campaignHealth: () => number,
 *   issues: () => number,
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

/**
 * Canonical metric roles consumed by {@link createFactoryMetrics}. A JSON
 * view may bind an element to differently named sources by overriding any of
 * these roles through `config.sources`, so the same factory element can be
 * reused on another page without changing its JavaScript.
 * @type {string[]}
 */
export const FACTORY_METRIC_ROLES = [
  'campaigns',
  'healthy-campaigns',
  'issues',
  'run-summary',
  'value-summary',
  'repository-coverage',
  'delivery-summary',
  'registered-repository-summary',
  'worker-summary',
  'dispatch-summary',
  'outcome-summary'
];

/**
 * Resolves the actual source name bound to each canonical metric role,
 * applying any `config.sources` overrides declared on the view.
 * @param {Record<string, string>} defaults
 * @param {Record<string, unknown> | undefined} config
 * @returns {Record<string, string>}
 */
export function resolveFactorySourceNames(defaults, config) {
  const overrides = config && typeof config === 'object' && config.sources && typeof config.sources === 'object'
    ? /** @type {Record<string, unknown>} */ (config.sources)
    : {};
  return Object.fromEntries(Object.entries(defaults).map(([role, defaultName]) => {
    const override = overrides[role];
    return [role, typeof override === 'string' && override ? override : defaultName];
  }));
}

/** @type {Record<string, PluralText>} */
const DEFAULT_STATION_LABELS = {
  campaigns: { singular: 'Campaign', plural: 'Campaigns' },
  repositories: { singular: 'Repository', plural: 'Repositories' },
  issues: { singular: 'Issue & PR', plural: 'Issues & PRs' },
  'successful-runs': { singular: 'Successful run', plural: 'Successful runs' },
  dispatches: { singular: 'Dispatch', plural: 'Dispatches' },
  'value-gains': { singular: 'Value gain', plural: 'Value gains' }
};

/**
 * Binds each declared query independently so the element can render before all
 * worker results settle and update only the widgets that consume each result.
 * @param {Record<string, import('../presenter.js').LogicalSourceInput>} sources
 * @param {string[]} names
 * @param {{ pageId?: string, viewId?: string, viewIndex?: number, sourceNames?: string[], queryContext?: import('./ui-elements.js').ElementRenderContext['queryContext'] }} [request]
 * @returns {SourceBindings}
 */
export function bindFactorySources(sources, names, request) {
  batch(() => {
    for (const [sourceIndex, name] of names.entries()) {
      const source = sources[name];
      const declaredSourceIndex = request?.sourceNames?.indexOf(name) ?? -1;
      const effectiveSourceIndex = declaredSourceIndex >= 0 ? declaredSourceIndex : sourceIndex;
      const bindingKey = request?.pageId && request.viewId
        ? dashboardViewAliasName(request.pageId, { id: request.viewId }, request.viewIndex ?? 0, name, effectiveSourceIndex)
        : name;
      if (source && Array.isArray(source.rows)) publishSource(name, source, bindingKey);
      else requestSource(name, { ...request, sourceIndex: effectiveSourceIndex, bindingKey });
    }
  });
  return Object.fromEntries(names.map((name) => {
    const declaredSourceIndex = request?.sourceNames?.indexOf(name) ?? -1;
    const effectiveSourceIndex = declaredSourceIndex >= 0 ? declaredSourceIndex : names.indexOf(name);
    const bindingKey = request?.pageId && request.viewId
      ? dashboardViewAliasName(request.pageId, { id: request.viewId }, request.viewIndex ?? 0, name, effectiveSourceIndex)
      : name;
    const entryState = sourceState(bindingKey);
    return [name, {
      rows: () => entryState.get().source?.rows ?? [],
      pending: () => entryState.get().status === 'loading',
      unavailable: () => {
        const entry = entryState.get();
        return entry.status === 'failed' || entry.source?.metadata?.availability === 'unavailable';
      }
    }];
  }));
}

/**
 * Exposes the compact query fields consumed by the factory components. The
 * optional `roleNames` map resolves each canonical metric role (see
 * {@link FACTORY_METRIC_DEFAULT_SOURCES}) to the source name it was actually
 * bound under, so callers may reuse the same metric roles against
 * differently named sources. When omitted, roles are looked up by their own
 * name, preserving compatibility with callers that only need `motion()`.
 * @param {SourceBindings} sources
 * @param {Record<string, string>} [roleNames]
 * @returns {FactoryMetrics}
 */
export function createFactoryMetrics(sources, roleNames) {
  /** @param {string} role */
  const sourceFor = (role) => sources[roleNames?.[role] ?? role];
  /** @param {string} role */
  const row = (role) => sourceFor(role)?.rows()[0] ?? {};
  return {
    campaigns: () => numberField(row('healthy-campaigns'), 'healthy-campaigns'),
    campaignTotal: () => numberField(row('campaigns'), 'campaigns'),
     campaignHealth: () => {
       const total = numberField(row('campaigns'), 'campaigns');
       const healthy = numberField(row('healthy-campaigns'), 'healthy-campaigns');
       return total > 0 ? healthy / total : 0;
     },
    issues: () => numberField(row('issues'), 'issues'),
    successfulRuns: () => numberField(row('run-summary'), 'successful-runs'),
    failedRuns: () => numberField(row('run-summary'), 'failed-runs'),
    activeRuns: () => numberField(row('run-summary'), 'active-runs'),
    valueGains: () => numberField(row('value-summary'), 'value-gains'),
    coverage: () => ({
      total: numberField(row('repository-coverage'), 'reached-repositories'),
      registered: numberField(row('repository-coverage'), 'registered-repositories-total'),
      averageCoverage: Math.min(1, Math.max(0, numberField(row('repository-coverage'), 'repository-coverage'))),
      unavailable: sourceFor('delivery-summary')?.unavailable() ?? true,
      registeredUnavailable: sourceFor('registered-repository-summary')?.unavailable() ?? true,
      coverageUnavailable: sourceFor('repository-coverage')?.unavailable() ?? true
    }),
    workers: () => numberField(row('worker-summary'), 'workers'),
    dispatches: () => numberField(row('dispatch-summary'), 'dispatches'),
    failedDispatches: () => numberField(row('dispatch-summary'), 'failed-dispatches'),
    usefulOutputs: () => numberField(row('outcome-summary'), 'useful-outputs'),
    deliveredRepositories: () => numberField(row('outcome-summary'), 'delivered-repositories'),
    motion: () => ({
      operations: numberField(row('run-summary'), 'active-runs'),
      live: numberField(row('run-summary'), 'active-live'),
      review: numberField(row('run-summary'), 'active-review')
    })
  };
}

/**
 * Creates the reactive state shared by one factory element's widgets.
 * @param {FactoryMetrics} metrics
 */
export function createFactoryScope(metrics) {
  const lifetime = new AbortController();
  const motion = state(metrics.motion());
  effect(() => {
    const next = metrics.motion();
    motion.set((current) => (
      current.operations === next.operations && current.live === next.live && current.review === next.review
        ? current
        : next
    ));
  }, { signal: lifetime.signal });
  return {
    signal: lifetime.signal,
    motion,
    /** @param {HTMLElement} element */
    bind(element) {
      if (typeof MutationObserver !== 'function') return;
      let wasConnected = element.isConnected;
      const observer = new MutationObserver((records) => {
        if (element.isConnected) {
          wasConnected = true;
        } else if (wasConnected || records.some((record) => (
          [...record.addedNodes].some((node) => node === element || (node instanceof Element && node.contains(element)))
        ))) {
          lifetime.abort();
        }
      });
      observer.observe(element.ownerDocument, { childList: true, subtree: true });
      lifetime.signal.addEventListener('abort', () => observer.disconnect(), { once: true });
    }
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
