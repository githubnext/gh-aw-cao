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
  'overview-value-summary',
  'overview-repository-summary',
  'overview-capacity-summary',
  'overview-worker-summary',
  'overview-rhythm'
];

/** @typedef {Record<string, unknown>} Row */
/** @typedef {{ label: string, date: string, count: number }} RhythmDay */
/** @typedef {{ packages: number, operations: number, live: number, review: number }} Motion */
/** @typedef {{ rows: () => Row[], pending: () => boolean, unavailable: () => boolean }} SourceBinding */
/** @typedef {Record<string, SourceBinding>} SourceBindings */
/** @typedef {{ total: number, maximum: number }} Coverage */
/**
 * Values shared by more than one bound element. Each one is memoised so a
 * source update recomputes it once instead of once per element.
 * @typedef {{ successfulRuns: () => number, failedRuns: () => number, activeRuns: () => number, valueGains: () => number, coverage: () => Coverage, workers: () => number, dispatches: () => number, usefulOutputs: () => number, deliveredRepositories: () => number, motion: () => Motion }} OverviewMetrics
 */
/** @typedef {import('../presenter.js').LogicalSourceInput} LogicalSourceInput */
/** @typedef {{ singular: string, plural: string }} PluralText */

/**
 * Horizon selected from the factory rhythm. The selection outlives a single
 * render so a refreshed overview restores the pressed bar and its summary.
 * @type {import('../reactive.js').State<RhythmDay | null>}
 */
const rhythmSelection = state(/** @type {RhythmDay | null} */ (null));

/**
 * Operations in motion right now. It is not refreshed while the horizon is
 * scoped to a single rhythm day, because a past day cannot report live motion.
 * @type {import('../reactive.js').State<Motion>}
 */
const factoryMotionState = state(/** @type {Motion} */ ({ packages: 0, operations: 0, live: 0, review: 0 }));

/**
 * Lifetime of the rendered overview. Effects and memoised values are bound to
 * its signal, which is the disposal channel `reactive.js` already supports.
 */
let overviewLifetime = new AbortController();

/** Releases the reactive resources owned by a previously rendered overview. */
export function resetFactoryOverviewState() {
  releaseFactoryOverviewEffects();
  clearSources(OVERVIEW_SOURCE_NAMES);
  rhythmSelection.set(null);
  factoryMotionState.set({ packages: 0, operations: 0, live: 0, review: 0 });
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
  return current.packages === next.packages
    && current.operations === next.operations
    && current.live === next.live
    && current.review === next.review;
}

/** @type {Record<string, PluralText>} */
const DEFAULT_STATION_LABELS = {
  repositories: { singular: 'Repository', plural: 'Repositories' },
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
  const value = memo(() => firstRow(sources['overview-value-summary']));
  const repositories = memo(() => firstRow(sources['overview-repository-summary']));
  const capacity = memo(() => firstRow(sources['overview-capacity-summary']));
  const workers = memo(() => firstRow(sources['overview-worker-summary']));
  return {
    successfulRuns: memo(() => numberField(runs(), 'successful-runs')),
    failedRuns: memo(() => numberField(runs(), 'failed-runs')),
    activeRuns: memo(() => numberField(runs(), 'active-runs')),
    valueGains: memo(() => numberField(value(), 'value-gains')),
    coverage: memo(() => ({
      total: numberField(repositories(), 'repositories'),
      maximum: numberField(capacity(), 'repository-max')
    })),
    workers: memo(() => numberField(workers(), 'workers')),
    dispatches: memo(() => numberField(dispatch(), 'dispatches')),
    usefulOutputs: memo(() => numberField(outcome(), 'useful-outputs')),
    deliveredRepositories: memo(() => numberField(outcome(), 'delivered-repositories')),
    motion: memo(() => ({
      packages: numberField(runs(), 'active-packages'),
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
    if (rhythmSelection.get() !== null) return;
    factoryMotionState.set((current) => (sameMotion(current, motion) ? current : motion));
  });

  bind(() => {
    const motion = factoryMotionState.get();
    running.className = `factory-running${motion.operations > 0 ? ' factory-running-active' : ''}`;
    running.replaceChildren(motion.operations > 0
      ? h(
        'span',
        {},
        h('strong', {}, formatCount(motion.packages)),
        motion.packages === 1 ? ' package in motion ' : ' packages in motion ',
        h('span', { className: 'factory-running-detail' }, `(${formatCount(motion.live)} live, ${formatCount(motion.review)}, in review)`)
      )
      : 'Actions activity observed');
  });

  bind(() => {
    heading.textContent = factoryHeading(sources, metrics);
  });

  bind(() => {
    const usefulOutputs = metrics.usefulOutputs();
    const deliveredRepositories = metrics.deliveredRepositories();
    const successfulRuns = metrics.successfulRuns();
    const dispatches = metrics.dispatches();
    summary.textContent = usefulOutputs > 0
      ? `${formatCount(usefulOutputs)} retained issue and pull request ${usefulOutputs === 1 ? 'output is' : 'outputs are'} backed by Actions evidence${deliveredRepositories > 0 ? ` across ${formatCount(deliveredRepositories)} ${deliveredRepositories === 1 ? 'repository' : 'repositories'}` : ''}.`
      : `${formatCount(successfulRuns)} successful ${successfulRuns === 1 ? 'run' : 'runs'} and ${formatCount(dispatches)} workflow ${dispatches === 1 ? 'dispatch' : 'dispatches'} are retained in this period.`;
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
  if (sources['overview-run-summary'].unavailable() || sources['overview-outcome-summary'].unavailable()) {
    return 'Your factory status is unavailable.';
  }
  const successfulRuns = metrics.successfulRuns();
  const failedRuns = metrics.failedRuns();
  const activeRuns = metrics.activeRuns();
  if (metrics.valueGains() > 0) return 'Your factory is delivering value.';
  if (activeRuns > 0) return 'Your factory is humming.';
  if (failedRuns > successfulRuns && failedRuns > 0) return 'Your factory is under strain.';
  if (failedRuns > 0) return 'Your factory needs attention.';
  if (successfulRuns > 0) return 'Your factory completed its shift.';
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
      pending: sources['overview-repository-summary'].pending() || sources['overview-capacity-summary'].pending(),
      label: label('repositories', coverage.total),
      value: coverage.total,
      detail: `${formatCount(coverage.maximum)} repository max`
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
    const workers = metrics.workers();
    return {
      pending: sources['overview-dispatch-summary'].pending() || sources['overview-worker-summary'].pending(),
      label: label('dispatches', dispatchCount),
      value: dispatchCount,
      detail: `${formatCount(workers)} ${workers === 1 ? 'workflow' : 'workflows'} observed`
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
    floor.setAttribute(
      'aria-label',
      `${formatCount(coverage.total)} ${label('repositories', coverage.total).toLowerCase()} regularly shipped to against a repository max of ${formatCount(coverage.maximum)}, ${formatCount(successfulRuns)} ${label('successful-runs', successfulRuns).toLowerCase()}, ${formatCount(dispatchCount)} workflow ${label('dispatches', dispatchCount).toLowerCase()} across ${formatCount(workers)} ${workers === 1 ? 'worker' : 'workers'}, ${formatCount(gains)} grader ${gains === 1 ? 'value' : 'values'} above threshold, and ${formatCount(usefulOutputs)} issue or pull request ${usefulOutputs === 1 ? 'output' : 'outputs'}.`
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
 * @returns {{ element: HTMLElement, bind: (read: () => { pending: boolean, label: string, value: number, detail: string | HTMLElement }) => void }}
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
          + `${!station.pending && station.value === 0 ? ' factory-station-empty' : ''}`;
        if (station.pending) element.setAttribute('aria-busy', 'true');
        else element.removeAttribute('aria-busy');
        stationLabel.textContent = station.label;
        const count = station.pending ? '' : formatCount(station.value);
        value.replaceChildren(options.href && !station.pending ? h('a', { href: options.href }, count) : count);
        detail.replaceChildren(station.pending ? '' : station.detail);
      });
    }
  };
}

/** @param {SourceBindings} sources */
function renderFactoryRhythm(sources) {
  const summary = h('p', { className: 'factory-rhythm-summary', role: 'status' }, '');
  const bars = h('div', { className: 'factory-rhythm-bars' });
  const rhythmDays = memo(() => sources['overview-rhythm'].rows().map((row) => {
    const date = String(row['activity-date'] ?? '');
    return {
      date,
      label: date ? new Date(`${date}T00:00:00Z`).toLocaleDateString('en', { weekday: 'short', timeZone: 'UTC' }) : '',
      count: numberField(row, 'successful-runs')
    };
  }));
  const showFullWeek = () => {
    section.dispatchEvent(new CustomEvent('dashboard-time-window-range-change', {
      bubbles: true,
      detail: { range: '1w' }
    }));
  };
  /** @param {number} index */
  const selectDay = (index) => {
    const day = rhythmDays()[index];
    if (!day) return;
    rhythmSelection.set(day);
    showFullWeek();
  };
  /** @param {MouseEvent} event */
  const resetDay = (event) => {
    if (event.target instanceof Element && event.target.closest('.factory-rhythm-day')) return;
    if (rhythmSelection.get() === null) return;
    rhythmSelection.set(null);
    showFullWeek();
  };
  const section = h(
    'section',
    {
      className: 'factory-rhythm',
      'aria-label': 'Successful Actions runs over the last seven observed days',
      onClick: resetDay
    },
    h(
      'div',
      { className: 'factory-rhythm-heading' },
      h('span', {}, 'Factory rhythm'),
      summary
    ),
    bars
  );

  // The daily runs chart owns the runs query alone: its bars are computed and
  // drawn as soon as rows arrive, without waiting for any other query.
  bind(() => {
    const days = rhythmDays();
    const maximum = Math.max(...days.map((day) => day.count), 1);
    // The bars are updated in place so an arriving query never discards the
    // focused or pressed day button.
    if (bars.childElementCount !== days.length) {
      bars.replaceChildren(...days.map((_, index) => createRhythmDayButton(() => selectDay(index))));
    }
    for (const [index, button] of dayButtonsOf(bars).entries()) {
      const day = days[index];
      button.setAttribute('aria-label', `${day.label} ${day.date}: ${formatCount(day.count)} successful ${day.count === 1 ? 'run' : 'runs'}`);
      const bar = button.querySelector('.factory-rhythm-current');
      if (bar instanceof HTMLElement) bar.style.height = `${Math.max(5, day.count / maximum * 100)}%`;
      const label = button.querySelector('small');
      if (label) label.textContent = day.label;
    }
  });

  bind(() => {
    const days = rhythmDays();
    const selected = rhythmSelection.get();
    const index = selected ? days.findIndex((day) => day.date === selected.date) : -1;
    for (const [buttonIndex, button] of dayButtonsOf(bars).entries()) {
      button.setAttribute('aria-pressed', buttonIndex === index ? 'true' : 'false');
    }
    const day = days[index];
    summary.textContent = day
      ? `${day.label} ${day.date}: ${formatCount(day.count)} successful ${day.count === 1 ? 'run' : 'runs'}.`
      : '';
  });

  return section;
}

/** @param {HTMLElement} bars @returns {HTMLButtonElement[]} */
function dayButtonsOf(bars) {
  return [...bars.querySelectorAll('.factory-rhythm-day')].filter((button) => button instanceof HTMLButtonElement);
}

/** @param {() => void} onSelect */
function createRhythmDayButton(onSelect) {
  return /** @type {HTMLButtonElement} */ (h(
    'button',
    {
      className: 'factory-rhythm-day',
      type: 'button',
      'aria-pressed': 'false',
      onClick: onSelect
    },
    h('span', { className: 'factory-rhythm-bar-pair', 'aria-hidden': 'true' },
      h('i', { className: 'factory-rhythm-current' })
    ),
    h('small', {})
  ));
}

