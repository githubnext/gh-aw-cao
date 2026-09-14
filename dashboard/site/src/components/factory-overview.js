import { h } from '../dom.js';
import { octicon } from '../octicons.js';
import { batch, derived, effect, state } from '../reactive.js';
import { clearSources, publishSource, requestSource, sourceState } from '../source-store.js';
import { formatCount } from './count-formatters.js';

const DAY_MS = 86_400_000;
const DELIVERED_STATES = new Set(['accepted', 'completed', 'lifecycle-close']);
const FAILURE_STATES = new Set(['failure', 'startup-failure', 'stale', 'timed-out']);

/**
 * Queries the overview binds to. Each one is requested on its own and renders
 * into its own UI elements, so the page never waits for the slowest query.
 */
const OVERVIEW_SOURCE_NAMES = ['outcomes', 'runs', 'dispatches', 'grader-observations', 'repositories', 'workflows'];

/** @typedef {Record<string, unknown>} Row */
/** @typedef {{ label: string, date: string, start: number, end: number, count: number }} RhythmDay */
/** @typedef {{ packages: number, operations: number, live: number, review: number }} Motion */
/** @typedef {{ rows: () => Row[], pending: () => boolean, unavailable: () => boolean }} SourceBinding */
/** @typedef {Record<string, SourceBinding>} SourceBindings */
/** @typedef {{ total: number, live: number, review: number }} Coverage */
/**
 * Values shared by more than one bound element. Each one is memoised so a
 * source update recomputes it once instead of once per element.
 * @typedef {{ dispatchRows: () => Row[], successfulRunRows: () => Row[], failedRunRows: () => Row[], activeRunRows: () => Row[], valueGains: () => number, coverage: () => Coverage, workers: () => number, outcomes: () => Row[], usefulOutputs: () => number }} OverviewMetrics
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
 * @param {{ sources?: Record<string, LogicalSourceInput>, filterRows?: (rows: Row[]) => Row[] }} context
 * @returns {SourceBindings}
 */
function bindOverviewSources(context) {
  const filterRows = typeof context.filterRows === 'function' ? context.filterRows : null;
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
        // View-provided rows are already filtered by the presenter; rows read
        // straight from a query still need the view's own row filter.
        return entry.origin === 'query' && filterRows ? filterRows(entry.source.rows) : entry.source.rows;
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

/** @param {{ sources?: Record<string, LogicalSourceInput>, elementConfig?: Record<string, unknown>, filterRows?: (rows: Row[]) => Row[] }} context */
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
  const dispatchRows = memo(() => {
    const dispatches = sources.dispatches.rows();
    return dispatches.length > 0
      ? dispatches
      : sources.runs.rows().filter((row) => String(row.event) === 'workflow_dispatch');
  });
  const outcomes = memo(() => latestOutcomes(sources.outcomes.rows()));
  return {
    dispatchRows,
    usefulOutputs: memo(() => outcomes().filter((row) => ['issue', 'pull-request'].includes(outputKind(row))).length),
    outcomes,
    failedRunRows: memo(() => sources.runs.rows().filter((row) => FAILURE_STATES.has(String(row['run-conclusion'])))),
    activeRunRows: memo(() => sources.runs.rows().filter((row) => ['queued', 'in-progress'].includes(normalizedStatus(row['run-status'])))),
    successfulRunRows: memo(() => sources.runs.rows().filter((row) => String(row['run-conclusion']) === 'success')),
    valueGains: memo(() => sources['grader-observations'].rows().filter(exceedsThreshold).length),
    coverage: memo(() => connectedRepositoryCoverage(sources.workflows.rows(), sources.repositories.rows(), sources.runs.rows())),
    workers: memo(() => workerCount(sources.workflows.rows(), dispatchRows()))
  };
}

/** @param {SourceBindings} sources @param {OverviewMetrics} metrics */
function renderIntroduction(sources, metrics) {
  const running = h('p', { className: 'factory-running' });
  const heading = h('h2', { id: 'agent-factory-heading' });
  const summary = h('p', {});

  const liveMotion = memo(() => factoryMotion(sources.runs.rows(), sources.workflows.rows()));
  bind(() => {
    const motion = liveMotion();
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
    const outcomes = metrics.outcomes();
    const usefulOutputs = metrics.usefulOutputs();
    const delivered = outcomes.filter((row) => DELIVERED_STATES.has(String(row['outcome-state'])));
    const deliveredRepositories = new Set(delivered.map((row) => String(row.repository ?? '')).filter(Boolean)).size;
    const successfulRuns = metrics.successfulRunRows().length;
    const dispatches = metrics.dispatchRows().length;
    summary.textContent = usefulOutputs > 0
      ? `${formatCount(usefulOutputs)} retained issue and pull request ${usefulOutputs === 1 ? 'output is' : 'outputs are'} backed by Actions evidence${deliveredRepositories > 0 ? ` across ${formatCount(deliveredRepositories)} ${deliveredRepositories === 1 ? 'repository' : 'repositories'}` : ''}.`
      : `${formatCount(successfulRuns)} successful ${successfulRuns === 1 ? 'run' : 'runs'} and ${formatCount(dispatches)} workflow ${dispatches === 1 ? 'dispatch' : 'dispatches'} are retained in this period.`;
  });

  return h(
    'header',
    { className: 'factory-intro' },
    h('div', { className: 'factory-intro-copy' }, running, heading, summary),
    renderFactoryRhythm(sources, metrics)
  );
}

/** @param {Row[]} runs @param {Row[]} workflows */
function factoryMotion(runs, workflows) {
  const active = runs.filter((row) => ['queued', 'in-progress'].includes(normalizedStatus(row['run-status'])));
  const workflowDetails = new Map();
  for (const workflow of workflows) {
    const path = String(workflow.workflow ?? '');
    if (!path) continue;
    workflowDetails.set(workflowIdentity(workflow), workflow);
    if (!workflowDetails.has(path)) workflowDetails.set(path, workflow);
  }
  const packages = new Set();
  let live = 0;
  let review = 0;
  for (const operation of active) {
    const workflow = workflowDetails.get(workflowIdentity(operation))
      ?? workflowDetails.get(String(operation.workflow ?? ''));
    const packageId = String(operation.package ?? workflow?.package ?? operation.workflow ?? operation.run ?? '').trim();
    if (packageId) packages.add(packageId);
    const mode = normalizedMode(operation['rollout-mode'] ?? workflow?.['rollout-mode']);
    if (mode === 'live') live += 1;
    if (mode === 'review') review += 1;
  }
  return { packages: packages.size || active.length, operations: active.length, live, review };
}

/** @param {Row} row */
function workflowIdentity(row) {
  return `${String(row.organization ?? '')}/${String(row.repository ?? '')}:${String(row.workflow ?? '')}`;
}

/** @param {SourceBindings} sources @param {OverviewMetrics} metrics */
function factoryHeading(sources, metrics) {
  if (sources.runs.unavailable() || sources.outcomes.unavailable()) return 'Your factory status is unavailable.';
  const successfulRuns = metrics.successfulRunRows().length;
  const failedRuns = metrics.failedRunRows().length;
  const activeRuns = metrics.activeRunRows().length;
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
      pending: sources.repositories.pending() || sources.workflows.pending() || sources.runs.pending(),
      label: label('repositories', coverage.total),
      value: coverage.total,
      detail: repositoryModeDetail(coverage)
    };
  });

  runs.bind(() => {
    const successfulRuns = metrics.successfulRunRows().length;
    const failedRuns = metrics.failedRunRows().length;
    return {
      pending: sources.runs.pending(),
      label: label('successful-runs', successfulRuns),
      value: successfulRuns,
      detail: h('a', { href: '#page-runs?runs-runs-source.run-conclusion=failure' }, `${formatCount(failedRuns)} failed`)
    };
  });

  dispatches.bind(() => {
    const dispatchRows = metrics.dispatchRows();
    const workers = metrics.workers();
    return {
      pending: sources.dispatches.pending() || sources.runs.pending() || sources.workflows.pending(),
      label: label('dispatches', dispatchRows.length),
      value: dispatchRows.length,
      detail: `${formatCount(workers)} ${workers === 1 ? 'workflow' : 'workflows'} observed`
    };
  });

  valueGains.bind(() => {
    const gains = metrics.valueGains();
    return {
      pending: sources['grader-observations'].pending(),
      label: label('value-gains', gains),
      value: gains,
      detail: 'Coming soon'
    };
  });

  bind(() => {
    const coverage = metrics.coverage();
    const successfulRuns = metrics.successfulRunRows().length;
    const dispatchRows = metrics.dispatchRows();
    const workers = metrics.workers();
    const gains = metrics.valueGains();
    const usefulOutputs = metrics.usefulOutputs();
    const activeRuns = factoryMotionState.get().operations;
    floor.className = `factory-floor${activeRuns > 0 ? ' factory-floor-active' : ''}`;
    floor.setAttribute(
      'aria-label',
      `${formatCount(coverage.total)} ${label('repositories', coverage.total).toLowerCase()} in scope, ${formatCount(coverage.review)} in review and ${formatCount(coverage.live)} live, ${formatCount(successfulRuns)} ${label('successful-runs', successfulRuns).toLowerCase()}, ${formatCount(dispatchRows.length)} workflow ${label('dispatches', dispatchRows.length).toLowerCase()} across ${formatCount(workers)} ${workers === 1 ? 'worker' : 'workers'}, ${formatCount(gains)} grader ${gains === 1 ? 'value' : 'values'} above threshold, and ${formatCount(usefulOutputs)} issue or pull request ${usefulOutputs === 1 ? 'output' : 'outputs'}.`
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

/** @param {Row[]} workflows @param {Row[]} dispatchRows */
function workerCount(workflows, dispatchRows) {
  const configuredWorkers = workflows.filter((row) => String(row['workflow-role']) === 'worker');
  return configuredWorkers.length > 0
    ? configuredWorkers.length
    : new Set(dispatchRows.map((row) => String(row.workflow ?? '')).filter(Boolean)).size;
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

/** @param {SourceBindings} sources @param {OverviewMetrics} metrics */
function renderFactoryRhythm(sources, metrics) {
  const summary = h('p', { className: 'factory-rhythm-summary', role: 'status' }, '');
  const bars = h('div', { className: 'factory-rhythm-bars' });
  const rhythmDays = memo(() => activityDays(metrics.successfulRunRows(), latestTimestamp(sources.runs.rows())));
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

/** @param {Row[]} successfulRuns @param {number} referenceTime */
function activityDays(successfulRuns, referenceTime) {
  return Array.from({ length: 7 }, (_, index) => {
    const start = startOfDay(referenceTime) - (6 - index) * DAY_MS;
    const end = start + DAY_MS;
    return {
      label: new Date(start).toLocaleDateString('en', { weekday: 'short', timeZone: 'UTC' }),
      date: new Date(start).toISOString().slice(0, 10),
      start,
      end,
      count: successfulRuns.filter((row) => rowTimestamp(row) >= start && rowTimestamp(row) < end).length
    };
  });
}

/** @param {Row[]} rows */
function latestOutcomes(rows) {
  const latest = new Map();
  for (const row of rows) {
    const key = String(row['safe-output'] ?? `${row['outcome-title']}:${row['observed-at']}`);
    const existing = latest.get(key);
    if (!existing || rowTimestamp(row) >= rowTimestamp(existing)) latest.set(key, row);
  }
  return [...latest.values()].sort((left, right) => rowTimestamp(right) - rowTimestamp(left));
}

/** @param {number} timestamp */
function startOfDay(timestamp) {
  const date = new Date(timestamp);
  return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate());
}

/** @param {Row[]} rows */
function latestTimestamp(rows) {
  const timestamps = rows.map(rowTimestamp).filter((value) => value > 0);
  return timestamps.length > 0 ? Math.max(...timestamps) : Date.now();
}

/** @param {Row} row */
function outputKind(row) {
  const category = String(row['outcome-category'] ?? '');
  const kind = String(row['safe-output-kind'] ?? '');
  if (category === 'issue' || kind === 'create-issue') return 'issue';
  if (category === 'pull-request' || kind === 'create-pull-request') return 'pull-request';
  return 'other';
}

/** @param {Row} row */
function exceedsThreshold(row) {
  const value = Number(row.value);
  const threshold = Number(row.threshold);
  return Number.isFinite(value) && Number.isFinite(threshold) && value > threshold;
}

/** @param {Row[]} workflows @param {Row[]} repositories @param {Row[]} runs */
function connectedRepositoryCoverage(workflows, repositories, runs) {
  const targets = new Map();
  for (const workflow of workflows) {
    if (!Array.isArray(workflow['package-targets'])) continue;
    for (const target of workflow['package-targets']) {
      const repository = String(target?.repository ?? '').trim();
      if (repository) targets.set(repository, normalizedMode(target?.mode));
    }
  }
  if (targets.size > 0) return modeCoverage(targets);
  const observed = new Map();
  for (const repository of [...repositories, ...runs]) {
    const name = String(repository.repository ?? '').trim();
    const owner = String(repository.organization ?? '').trim();
    const coordinate = name.includes('/') || !owner ? name : `${owner}/${name}`;
    if (coordinate) observed.set(coordinate, normalizedMode(repository['rollout-mode']));
  }
  return modeCoverage(observed);
}

/** @param {Map<string, string>} repositories */
function modeCoverage(repositories) {
  const modes = [...repositories.values()];
  return {
    total: repositories.size,
    review: modes.filter((mode) => mode === 'review').length,
    live: modes.filter((mode) => mode === 'live').length
  };
}

/** @param {unknown} value */
function normalizedMode(value) {
  const mode = String(value ?? '').toLowerCase();
  return mode === 'review' || mode === 'live' ? mode : 'unknown';
}

/** @param {{ review: number, live: number }} coverage */
function repositoryModeDetail(coverage) {
  if (coverage.review + coverage.live === 0) return 'connected';
  return `${formatCount(coverage.review)} review · ${formatCount(coverage.live)} live`;
}

/** @param {Row} row */
function rowTimestamp(row) {
  const timestamp = Date.parse(String(row['observed-at'] ?? row['published-at'] ?? row['started-at'] ?? ''));
  return Number.isFinite(timestamp) ? timestamp : 0;
}

/** @param {unknown} value */
function normalizedStatus(value) {
  return String(value ?? '').toLowerCase().replaceAll('_', '-');
}
