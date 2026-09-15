import { h } from '../dom.js';
import { octicon } from '../octicons.js';
import { batch, derived, effect, state } from '../reactive.js';
import { clearSources, publishSource, requestSource, sourceState } from '../source-store.js';
import { formatCount } from './count-formatters.js';

/**
 * Compact worker-query results consumed by the overview.
 */
const OVERVIEW_SOURCE_NAMES = [
  'overview-outcome-summary',
  'overview-run-summary',
  'overview-dispatch-summary',
  'overview-delivery-summary',
  'overview-value-summary',
  'overview-registered-repository-summary',
  'overview-worker-summary',
  'overview-rhythm'
];

/** @typedef {Record<string, unknown>} Row */
/** @typedef {{ label: string, date: string, count: number, previous: number, reached: boolean }} RhythmDay */
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

/**
 * Binds one effect to the elements it renders and keeps it alive until the
 * overview is rendered again.
 * @param {() => void} render
 */
function bind(render) {
  effect(render, { signal: overviewLifetime.signal });
}

/** @param {Motion} current @param {Motion} next */
function sameMotion(current, next) {
  return current.operations === next.operations
    && current.live === next.live
    && current.review === next.review;
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

/** @param {{ sources?: Record<string, LogicalSourceInput>, elementConfig?: Record<string, unknown> }} context */
export function renderFactoryOverview(context) {
  releaseFactoryOverviewEffects();
  const sources = bindOverviewSources(context);
  const metrics = createOverviewMetrics(sources);
  return h(
    'section',
    { className: 'agent-factory', 'aria-labelledby': 'agent-factory-heading' },
    renderIntroduction(sources, metrics),
    renderFactoryFloor(sources, metrics, pluralLabelResolver(context.elementConfig))
  );
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

/** @param {SourceBindings} sources @param {OverviewMetrics} metrics */
function renderIntroduction(sources, metrics) {
  const running = h('p', { className: 'factory-running' });
  const heading = h('h2', { id: 'agent-factory-heading' });
  const summary = h('p', {});

  bind(() => {
    const motion = metrics.motion();
    factoryMotionState.set((current) => (sameMotion(current, motion) ? current : motion));
  });

  bind(() => {
    const motion = factoryMotionState.get();
    running.className = `factory-running${motion.operations > 0 ? ' factory-running-active' : ''}`;
    running.replaceChildren(
      motion.operations > 0 ? h('span', {}, 'Work in motion') : 'Actions activity observed'
    );
  });

  bind(() => {
    heading.textContent = factoryHeading(sources, metrics);
  });

  bind(() => {
    const usefulOutputs = metrics.usefulOutputs();
    const deliveredRepositories = metrics.deliveredRepositories();
    summary.hidden = usefulOutputs === 0;
    summary.textContent = usefulOutputs > 0
      ? `${formatCount(usefulOutputs)} retained issue and pull request ${usefulOutputs === 1 ? 'output is' : 'outputs are'} backed by Actions evidence${deliveredRepositories > 0 ? ` across ${formatCount(deliveredRepositories)} ${deliveredRepositories === 1 ? 'repository' : 'repositories'}` : ''}.`
      : '';
  });

  return h(
    'header',
    { className: 'factory-intro' },
    h('div', { className: 'factory-intro-copy' }, running, heading, summary),
    renderFactoryRhythm(sources)
  );
}

/** @param {SourceBindings} sources @param {OverviewMetrics} metrics */
function factoryHeading(sources, metrics) {
  if (sources['overview-run-summary'].unavailable()) {
    return 'Your factory status is unavailable.';
  }
  const successfulRuns = metrics.successfulRuns();
  const failedRuns = metrics.failedRuns();
  const activeRuns = metrics.activeRuns();
  if (metrics.valueGains() > 0) return 'Your factory is delivering value.';
  if (activeRuns > 0) return 'Your factory is humming.';
  if (failedRuns > successfulRuns && failedRuns > 0) return 'Your factory is under strain.';
  if (failedRuns > 0) return 'Your factory needs attention.';
  if (successfulRuns > 0) return 'Your factory is humming.';
  return 'Your factory is idle.';
}

/**
 * @param {SourceBindings} sources
 * @param {OverviewMetrics} metrics
 * @param {(labelId: string, count: number) => string} label
 */
function renderFactoryFloor(sources, metrics, label) {
  const floor = h('section', { className: 'factory-floor' });
  const repositories = renderStation('repo', { href: '#page-repositories' });
  const runs = renderStation('play', { href: '#page-runs?runs-runs-source.run-conclusion=success' });
  const dispatches = renderStation('workflow', { href: '#page-runs' });
  const valueGains = renderStation('trophy', { final: true });

  repositories.bind(() => {
    const coverage = metrics.coverage();
    return {
      pending: sources['overview-registered-repository-summary'].pending(),
      unavailable: coverage.registeredUnavailable,
      label: label('repositories', coverage.registered),
      value: coverage.registered,
      detail: ''
    };
  });

  runs.bind(() => {
    const successfulRuns = metrics.successfulRuns();
    const failedRuns = metrics.failedRuns();
    return {
      pending: sources['overview-run-summary'].pending(),
      label: label('successful-runs', successfulRuns),
      value: successfulRuns,
      detail: h('a', { href: '#page-runs?runs-runs-source.run-conclusion=failure' }, `${formatCount(failedRuns)} failed`)
    };
  });

  dispatches.bind(() => {
    const dispatchCount = metrics.dispatches();
    const failedDispatches = metrics.failedDispatches();
    return {
      pending: sources['overview-dispatch-summary'].pending(),
      label: label('dispatches', dispatchCount),
      value: dispatchCount,
      detail: h(
        'a',
        { href: '#page-dispatches?package-worker-dispatches.status=failure' },
        `${formatCount(failedDispatches)} failed`
      )
    };
  });

  valueGains.bind(() => {
    const gains = metrics.valueGains();
    return {
      pending: sources['overview-value-summary'].pending(),
      label: label('value-gains', gains),
      value: gains,
      detail: 'Coming soon'
    };
  });

  bind(() => {
    const coverage = metrics.coverage();
    const successfulRuns = metrics.successfulRuns();
    const dispatchCount = metrics.dispatches();
    const workers = metrics.workers();
    const gains = metrics.valueGains();
    const usefulOutputs = metrics.usefulOutputs();
    const activeRuns = factoryMotionState.get().operations;
    floor.className = `factory-floor${activeRuns > 0 ? ' factory-floor-active' : ''}`;
    const repositoriesDescription = coverage.registeredUnavailable
      ? 'Registered repositories unavailable'
      : `${formatCount(coverage.registered)} ${label('repositories', coverage.registered).toLowerCase()}${coverage.unavailable ? '; repository delivery evidence unavailable' : ` with ${formatCount(coverage.total)} delivered to`}`;
    floor.setAttribute(
      'aria-label',
      `${repositoriesDescription}, ${formatCount(successfulRuns)} ${label('successful-runs', successfulRuns).toLowerCase()}, ${formatCount(dispatchCount)} workflow ${label('dispatches', dispatchCount).toLowerCase()} across ${formatCount(workers)} ${workers === 1 ? 'worker' : 'workers'}, ${formatCount(gains)} grader ${gains === 1 ? 'value' : 'values'} above threshold, and ${formatCount(usefulOutputs)} issue or pull request ${usefulOutputs === 1 ? 'output' : 'outputs'}.`
    );
  });

  floor.append(h(
    'ol',
    { className: 'factory-stations' },
    repositories.element,
    runs.element,
    dispatches.element,
    valueGains.element
  ));
  return floor;
}

/**
 * Renders one counter that owns its own effect, so it appears with the page and
 * counts up on its own when its query resolves.
 * @param {string} icon
 * @param {{ final?: boolean, href?: string }} [options]
 * @returns {{ element: HTMLElement, bind: (read: () => { pending: boolean, unavailable?: boolean, label: string, value: number, detail: string | HTMLElement }) => void }}
 */
function renderStation(icon, options = {}) {
  const stationLabel = h('span', {});
  const value = h('strong', {});
  const detail = h('small', {});
  const element = h(
    'li',
    { className: 'factory-station' },
    h('span', { className: 'factory-station-icon', 'aria-hidden': 'true' }, octicon(icon)),
    stationLabel,
    value,
    detail
  );
  return {
    element,
    bind(read) {
      bind(() => {
        const station = read();
        element.className = `factory-station${options.final ? ' factory-station-final' : ''}`
          + `${station.pending ? ' factory-station-pending' : ''}`
          + `${!station.pending && !station.unavailable && station.value === 0 ? ' factory-station-empty' : ''}`;
        if (station.pending) element.setAttribute('aria-busy', 'true');
        else element.removeAttribute('aria-busy');
        stationLabel.textContent = station.label;
        const count = station.pending ? '' : station.unavailable ? 'Unavailable' : formatCount(station.value);
        value.replaceChildren(options.href && !station.pending && !station.unavailable ? h('a', { href: options.href }, count) : count);
        detail.replaceChildren(station.pending ? '' : station.detail);
      });
    }
  };
}

/** @param {SourceBindings} sources */
function renderFactoryRhythm(sources) {
  const bars = h('div', { className: 'factory-rhythm-bars' });
  const rhythm = memo(() => rhythmPayload(sources['overview-rhythm']));
  const rhythmDays = memo(() => rhythm().days);
  const section = h(
    'section',
    {
      className: 'factory-rhythm',
      'aria-label': 'Successful Actions runs from Monday through Sunday'
    },
    h(
      'div',
      { className: 'factory-rhythm-heading' },
      h('span', {}, 'Factory rhythm'),
      h(
        'ul',
        { className: 'factory-rhythm-legend', 'aria-label': 'Factory rhythm legend' },
        h('li', {}, h('i', { className: 'factory-rhythm-legend-current', 'aria-hidden': 'true' }), 'This week'),
        h('li', {}, h('i', { className: 'factory-rhythm-legend-previous', 'aria-hidden': 'true' }), 'Last week')
      )
    ),
    bars
  );

  // The daily runs chart owns the runs query alone: its bars are computed and
  // drawn as soon as rows arrive, without waiting for any other query.
  bind(() => {
    const days = rhythmDays();
    const maximum = Math.max(...days.flatMap((day) => [day.count, day.previous]), 1);
    // The bars are updated in place so an arriving query does not rebuild the chart.
    if (bars.childElementCount !== days.length) {
      bars.replaceChildren(...days.map(() => createRhythmDay()));
    }
    for (const [index, element] of rhythmDayElements(bars).entries()) {
      const day = days[index];
      const value = day.reached ? day.count : day.previous;
      const description = rhythmDayDescription(day);
      element.classList.toggle('factory-rhythm-day-future', !day.reached);
      element.setAttribute('aria-label', description);
      element.title = description;
      const current = element.querySelector('.factory-rhythm-current');
      if (current instanceof HTMLElement) {
        current.hidden = !day.reached;
        current.style.height = `${Math.max(5, value / maximum * 100)}%`;
      }
      const baseline = element.querySelector('.factory-rhythm-baseline');
      if (baseline instanceof HTMLElement) {
        baseline.hidden = day.reached;
        baseline.style.height = `${Math.max(5, value / maximum * 100)}%`;
      }
      const label = element.querySelector('small');
      if (label) label.textContent = day.label;
    }
  });

  return section;
}

/** @param {RhythmDay} day */
function rhythmDayDescription(day) {
  const count = day.reached ? day.count : day.previous;
  const period = day.reached ? 'this week' : 'last week';
  return `${day.label} ${day.date}: ${formatCount(count)} successful ${count === 1 ? 'run' : 'runs'} ${period}.`;
}

/** @param {SourceBinding} source @returns {{ days: RhythmDay[] }} */
function rhythmPayload(source) {
  const row = source.rows()[0];
  const value = row?.rhythm;
  const configured = value && typeof value === 'object' && !Array.isArray(value)
    ? /** @type {Record<string, unknown>} */ (value)
    : {};
  const input = Array.isArray(configured.days) ? configured.days : [];
  const days = input.flatMap((candidate) => {
    if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) return [];
    const day = /** @type {Record<string, unknown>} */ (candidate);
    if (typeof day.label !== 'string' || typeof day.date !== 'string' || typeof day.reached !== 'boolean') return [];
    return [{
      label: day.label,
      date: day.date,
      count: numberField(day, 'current'),
      previous: numberField(day, 'previous'),
      reached: day.reached
    }];
  });
  return {
    days: days.length === 7
      ? days
      : ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].map((label) => ({
          label,
          date: '',
          count: 0,
          previous: 0,
          reached: false
        }))
  };
}

/** @param {HTMLElement} bars @returns {HTMLElement[]} */
function rhythmDayElements(bars) {
  return [...bars.querySelectorAll('.factory-rhythm-day')].filter((element) => element instanceof HTMLElement);
}

function createRhythmDay() {
  return h(
    'div',
    {
      className: 'factory-rhythm-day',
      role: 'img'
    },
    h('span', { className: 'factory-rhythm-bar-pair', 'aria-hidden': 'true' },
      h('i', { className: 'factory-rhythm-baseline' }),
      h('i', { className: 'factory-rhythm-current' })
    ),
    h('small', {})
  );
}

