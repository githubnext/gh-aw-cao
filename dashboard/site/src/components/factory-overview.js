import { batch, derived, effect, state } from '../reactive.js';
import { clearSources, publishSource, requestSource, sourceState } from '../source-store.js';
import { renderFactoryFloor } from './factory-floor.js';
import { renderFactoryHeader } from './factory-header.js';
import { factoryOverviewSections } from './factory-overview-sections.js';
import { renderPanel } from './panel.js';

/**
 * Compact worker-query results consumed by the overview.
 */
const OVERVIEW_SOURCE_NAMES = [
  'overview-outcome-summary',
  'overview-run-summary',
  'overview-dispatch-summary',
  'overview-delivery-summary',
  'overview-value-summary',
  'overview-factory-status',
  'overview-registered-repository-summary',
  'overview-worker-summary',
  'overview-rhythm'
];

/** @typedef {Record<string, unknown>} Row */
/** @typedef {{ operations: number, live: number, review: number }} Motion */
/** @typedef {{ rows: () => Row[], pending: () => boolean, unavailable: () => boolean }} SourceBinding */
/** @typedef {Record<string, SourceBinding>} SourceBindings */
/** @typedef {{ total: number, registered: number, unavailable: boolean, registeredUnavailable: boolean }} Coverage */
/**
 * Values shared by more than one bound element. Each one is memoised so a
 * source update recomputes it once instead of once per element.
 * @typedef {{ successfulRuns: () => number, failedRuns: () => number, activeRuns: () => number, valueGains: () => number, coverage: () => Coverage, workers: () => number, dispatches: () => number, failedDispatches: () => number, usefulOutputs: () => number, deliveredRepositories: () => number, motion: () => Motion }} OverviewMetrics
 */
/** @typedef {import('../presenter.js').LogicalSourceInput} LogicalSourceInput */
/** @typedef {{ singular: string, plural: string }} PluralText */

/**
 * Operations in motion right now.
 * @type {import('../reactive.js').State<Motion>}
 */
const factoryMotionState = state(/** @type {Motion} */ ({ operations: 0, live: 0, review: 0 }));

/**
 * Lifetime of the rendered overview. Effects and memoised values are bound to
 * its signal, which is the disposal channel `reactive.js` already supports.
 */
let overviewLifetime = new AbortController();

/** Releases the reactive resources owned by a previously rendered overview. */
export function resetFactoryOverviewState() {
  releaseFactoryOverviewEffects();
  clearSources(OVERVIEW_SOURCE_NAMES);
  factoryMotionState.set({ operations: 0, live: 0, review: 0 });
}

/** Stops the effects and memoised values owned by a superseded render. */
function releaseFactoryOverviewEffects() {
  overviewLifetime.abort();
  overviewLifetime = new AbortController();
}

/**
 * Memoises one derived value for the lifetime of the rendered overview.
 * @template T
 * @param {() => T} compute
 * @returns {() => T}
 */
function memo(compute) {
  return derived(compute, { signal: overviewLifetime.signal }).get;
}

/** @type {Record<string, PluralText>} */
const DEFAULT_STATION_LABELS = {
  repositories: { singular: 'Repository registered', plural: 'Repositories registered' },
  'successful-runs': { singular: 'Successful run', plural: 'Successful runs' },
  dispatches: { singular: 'Dispatch', plural: 'Dispatches' },
  'value-gains': { singular: 'Value gain', plural: 'Value gains' }
};

/**
 * @param {Record<string, unknown> | undefined} elementConfig
 * @returns {(labelId: string, count: number) => string}
 */
function pluralLabelResolver(elementConfig) {
  const declared = elementConfig && typeof elementConfig === 'object' && elementConfig.labels && typeof elementConfig.labels === 'object'
    ? /** @type {Record<string, unknown>} */ (elementConfig.labels)
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

/**
 * Binds every declared overview query to reactive state. Rows a rendered view
 * already holds are published immediately; anything still missing is requested
 * asynchronously and reaches the bound elements when its query resolves.
 * @param {{ sources?: Record<string, LogicalSourceInput> }} context
 * @returns {SourceBindings}
 */
function bindOverviewSources(context) {
  /** @type {SourceBindings} */
  const bindings = {};
  // Grouped so bound elements observe one settled set of sources per render.
  batch(() => {
    for (const name of OVERVIEW_SOURCE_NAMES) {
      const provided = context.sources?.[name];
      if (provided && Array.isArray(provided.rows)) publishSource(name, provided);
      else requestSource(name);
    }
  });
  for (const name of OVERVIEW_SOURCE_NAMES) {
    const entryState = sourceState(name);
    bindings[name] = {
      rows: () => {
        const entry = entryState.get();
        if (!entry.source || !Array.isArray(entry.source.rows)) return [];
        return entry.source.rows;
      },
      // A requested query is `loading` until it settles; a source nothing ever
      // queried stays `idle` and renders the rows it has.
      pending: () => entryState.get().status === 'loading',
      unavailable: () => {
        const entry = entryState.get();
        return entry.status === 'failed' || entry.source?.metadata?.availability === 'unavailable';
      }
    };
  }
  return bindings;
}

/** @param {{ title?: string, sources?: Record<string, LogicalSourceInput>, elementConfig?: Record<string, unknown> }} context */
export function renderFactoryOverview(context) {
  releaseFactoryOverviewEffects();
  const sources = bindOverviewSources(context);
  const metrics = createOverviewMetrics(sources);
  const sections = factoryOverviewSections(context.elementConfig);
  const scope = { signal: overviewLifetime.signal, motion: factoryMotionState };
  effect(() => {
    const next = metrics.motion();
    factoryMotionState.set((current) => (
      current.operations === next.operations && current.live === next.live && current.review === next.review
        ? current
        : next
    ));
  }, { signal: overviewLifetime.signal });
  /** @type {Record<string, () => HTMLElement>} */
  const sectionRenderers = {
    header: () => renderFactoryHeader(sources, metrics, scope),
    floor: () => renderFactoryFloor(
      sources,
      metrics,
      pluralLabelResolver(context.elementConfig),
      context.elementConfig?.animate === 'number',
      scope
    )
  };
  return renderPanel({
    className: 'agent-factory',
    labelledBy: sections.includes('header') ? 'agent-factory-heading' : undefined,
    label: context.title ?? 'Factory overview',
    children: sections.map((section) => sectionRenderers[section]())
  });
}


/**
 * @param {SourceBindings} sources
 * @returns {OverviewMetrics}
 */
function createOverviewMetrics(sources) {
  const outcome = memo(() => firstRow(sources['overview-outcome-summary']));
  const runs = memo(() => firstRow(sources['overview-run-summary']));
  const dispatch = memo(() => firstRow(sources['overview-dispatch-summary']));
  const delivery = memo(() => firstRow(sources['overview-delivery-summary']));
  const value = memo(() => firstRow(sources['overview-value-summary']));
  const registeredRepositories = memo(() => firstRow(sources['overview-registered-repository-summary']));
  const workers = memo(() => firstRow(sources['overview-worker-summary']));
  return {
    successfulRuns: memo(() => numberField(runs(), 'successful-runs')),
    failedRuns: memo(() => numberField(runs(), 'failed-runs')),
    activeRuns: memo(() => numberField(runs(), 'active-runs')),
    valueGains: memo(() => numberField(value(), 'value-gains')),
    coverage: memo(() => ({
      total: numberField(delivery(), 'delivered-repositories'),
      registered: numberField(registeredRepositories(), 'registered-repositories'),
      unavailable: sources['overview-delivery-summary'].unavailable(),
      registeredUnavailable: sources['overview-registered-repository-summary'].unavailable()
    })),
    workers: memo(() => numberField(workers(), 'workers')),
    dispatches: memo(() => numberField(dispatch(), 'dispatches')),
    failedDispatches: memo(() => numberField(dispatch(), 'failed-dispatches')),
    usefulOutputs: memo(() => numberField(outcome(), 'useful-outputs')),
    deliveredRepositories: memo(() => numberField(outcome(), 'delivered-repositories')),
    motion: memo(() => ({
      operations: numberField(runs(), 'active-runs'),
      live: numberField(runs(), 'active-live'),
      review: numberField(runs(), 'active-review')
    }))
  };
}

/** @param {SourceBinding} source */
function firstRow(source) {
  return source.rows()[0] ?? {};
}

/** @param {Row} row @param {string} field */
function numberField(row, field) {
  const value = Number(row[field]);
  return Number.isFinite(value) ? value : 0;
}
