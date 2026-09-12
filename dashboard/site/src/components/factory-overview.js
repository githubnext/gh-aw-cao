import { h } from '../dom.js';
import { octicon } from '../octicons.js';
import { effect, state } from '../reactive.js';
import { formatCount } from './count-formatters.js';
import { rowsFor } from './source-rows.js';

const DAY_MS = 86_400_000;
const DELIVERED_STATES = new Set(['accepted', 'completed', 'lifecycle-close']);
const FAILURE_STATES = new Set(['failure', 'startup-failure', 'stale', 'timed-out']);

/** @typedef {Record<string, unknown>} Row */
/** @typedef {{ label: string, date: string, start: number, end: number, count: number }} RhythmDay */
/** @typedef {{ packages: number, operations: number, live: number, review: number }} Motion */

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

/** @type {import('../reactive.js').EffectHandle | null} */
let rhythmEffect = null;
/** @type {import('../reactive.js').EffectHandle | null} */
let motionEffect = null;

/** Releases the reactive resources owned by a previously rendered overview. */
export function resetFactoryOverviewState() {
  releaseFactoryOverviewEffects();
  rhythmSelection.set(null);
  factoryMotionState.set({ packages: 0, operations: 0, live: 0, review: 0 });
}

/** Stops the effects owned by a superseded overview render. */
function releaseFactoryOverviewEffects() {
  rhythmEffect?.stop();
  rhythmEffect = null;
  motionEffect?.stop();
  motionEffect = null;
}

/** @param {Motion} current @param {Motion} next */
function sameMotion(current, next) {
  return current.packages === next.packages
    && current.operations === next.operations
    && current.live === next.live
    && current.review === next.review;
}
/** @typedef {import('../presenter.js').LogicalSourceInput} LogicalSourceInput */
/** @typedef {{ singular: string, plural: string }} PluralText */

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

/** @param {{ sources: Record<string, LogicalSourceInput>, elementConfig?: Record<string, unknown> }} context */
export function renderFactoryOverview(context) {
  const outcomes = latestOutcomes(rowsFor(context.sources, 'outcomes'));
  const runs = rowsFor(context.sources, 'runs');
  const dispatches = rowsFor(context.sources, 'dispatches');
  const dispatchRows = dispatches.length > 0
    ? dispatches
    : runs.filter((row) => String(row.event) === 'workflow_dispatch');
  const graderObservations = rowsFor(context.sources, 'grader-observations');
  const repositories = rowsFor(context.sources, 'repositories');
  const workflows = rowsFor(context.sources, 'workflows');
  const repositoryCoverage = connectedRepositoryCoverage(workflows, repositories, runs);
  const motion = factoryMotion(runs, workflows);
  const activeRuns = motion.operations;
  releaseFactoryOverviewEffects();
  if (rhythmSelection.get() === null) {
    factoryMotionState.set((current) => (sameMotion(current, motion) ? current : motion));
  }
  const successfulRunRows = runs.filter((row) => String(row['run-conclusion']) === 'success');
  const successfulRuns = successfulRunRows.length;
  const failedRuns = runs.filter((row) => FAILURE_STATES.has(String(row['run-conclusion']))).length;
  const configuredWorkers = workflows.filter((row) => String(row['workflow-role']) === 'worker');
  const workers = configuredWorkers.length > 0
    ? configuredWorkers.length
    : new Set(dispatchRows.map((row) => String(row.workflow ?? '')).filter(Boolean)).size;
  const issues = outcomes.filter((row) => outputKind(row) === 'issue').length;
  const pullRequests = outcomes.filter((row) => outputKind(row) === 'pull-request').length;
  const usefulOutputs = issues + pullRequests;
  const valueGains = graderObservations.filter(exceedsThreshold).length;
  const delivered = outcomes.filter((row) => DELIVERED_STATES.has(String(row['outcome-state'])));
  const deliveredRepositories = new Set(delivered.map((row) => String(row.repository ?? '')).filter(Boolean)).size;

  return h(
    'section',
    { className: 'agent-factory', 'aria-labelledby': 'agent-factory-heading' },
    renderIntroduction(factoryHeading(context.sources, valueGains, activeRuns, successfulRuns, failedRuns), usefulOutputs, deliveredRepositories, successfulRuns, dispatchRows.length, successfulRunRows, latestTimestamp(runs)),
    renderFactoryFloor(repositoryCoverage, successfulRuns, failedRuns, dispatchRows.length, workers, valueGains, issues, pullRequests, activeRuns, pluralLabelResolver(context.elementConfig))
  );
}

/**
 * @param {string} heading
 * @param {number} usefulOutputs
 * @param {number} deliveredRepositories
 * @param {number} successfulRuns
 * @param {number} dispatches
 * @param {Row[]} successfulRunRows
 * @param {number} referenceTime
 */
function renderIntroduction(heading, usefulOutputs, deliveredRepositories, successfulRuns, dispatches, successfulRunRows, referenceTime) {
  const summary = usefulOutputs > 0
    ? `${formatCount(usefulOutputs)} retained issue and pull request ${usefulOutputs === 1 ? 'output is' : 'outputs are'} backed by Actions evidence${deliveredRepositories > 0 ? ` across ${formatCount(deliveredRepositories)} ${deliveredRepositories === 1 ? 'repository' : 'repositories'}` : ''}.`
    : `${formatCount(successfulRuns)} successful ${successfulRuns === 1 ? 'run' : 'runs'} and ${formatCount(dispatches)} workflow ${dispatches === 1 ? 'dispatch' : 'dispatches'} are retained in this period.`;
  const running = h('p', { className: 'factory-running' });
  motionEffect = effect(() => {
    const motion = factoryMotionState.get();
    running.className = `factory-running${motion.operations > 0 ? ' factory-running-active' : ''}`;
    running.replaceChildren(motion.operations > 0
      ? h(
        'span',
        {},
        h('strong', {}, formatCount(motion.packages)),
        motion.packages === 1 ? ' package in motion ' : ' packages in motion ',
        `(${formatCount(motion.live)} ${motion.live === 1 ? 'op' : 'ops'} live, ${formatCount(motion.review)} in review)`
      )
      : 'Actions activity observed');
  });
  return h(
    'header',
    { className: 'factory-intro' },
    h(
      'div',
      { className: 'factory-intro-copy' },
      running,
      h('h2', { id: 'agent-factory-heading' }, heading),
      h('p', {}, summary)
    ),
    renderFactoryRhythm(successfulRunRows, referenceTime)
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

/**
 * @param {Record<string, LogicalSourceInput>} sources
 * @param {number} valueGains
 * @param {number} activeRuns
 * @param {number} successfulRuns
 * @param {number} failedRuns
 */
function factoryHeading(sources, valueGains, activeRuns, successfulRuns, failedRuns) {
  if (['runs', 'outcomes'].some((name) => sources[name]?.metadata?.availability === 'unavailable')) return 'Your factory status is unavailable.';
  if (valueGains > 0) return 'Your factory is delivering value.';
  if (activeRuns > 0) return 'Your factory is humming.';
  if (failedRuns > successfulRuns && failedRuns > 0) return 'Your factory is under strain.';
  if (failedRuns > 0) return 'Your factory needs attention.';
  if (successfulRuns > 0) return 'Your factory completed its shift.';
  return 'Your factory is idle.';
}

/**
 * @param {{ total: number, review: number, live: number }} repositories
 * @param {number} successfulRuns
 * @param {number} failedRuns
 * @param {number} dispatches
 * @param {number} workers
 * @param {number} valueGains
 * @param {number} issues
 * @param {number} pullRequests
 * @param {number} activeRuns
 * @param {(labelId: string, count: number) => string} label
 */
function renderFactoryFloor(repositories, successfulRuns, failedRuns, dispatches, workers, valueGains, issues, pullRequests, activeRuns, label) {
  const usefulOutputs = issues + pullRequests;
  return h(
    'section',
    {
      className: `factory-floor${activeRuns > 0 ? ' factory-floor-active' : ''}`,
      'aria-label': `${formatCount(repositories.total)} ${label('repositories', repositories.total).toLowerCase()} in scope, ${formatCount(repositories.review)} in review and ${formatCount(repositories.live)} live, ${formatCount(successfulRuns)} ${label('successful-runs', successfulRuns).toLowerCase()}, ${formatCount(dispatches)} workflow ${label('dispatches', dispatches).toLowerCase()} across ${formatCount(workers)} ${workers === 1 ? 'worker' : 'workers'}, ${formatCount(valueGains)} grader ${valueGains === 1 ? 'value' : 'values'} above threshold, and ${formatCount(usefulOutputs)} issue or pull request ${usefulOutputs === 1 ? 'output' : 'outputs'}.`
    },
    h(
      'ol',
      { className: 'factory-stations' },
      renderStation('repo', label('repositories', repositories.total), repositories.total, repositoryModeDetail(repositories), false, '#page-repositories'),
      renderStation('play', label('successful-runs', successfulRuns), successfulRuns, h('a', { href: '#page-runs?runs-runs-source.run-conclusion=failure' }, `${formatCount(failedRuns)} failed`), false, '#page-runs?runs-runs-source.run-conclusion=success'),
      renderStation('workflow', label('dispatches', dispatches), dispatches, `${formatCount(workers)} ${workers === 1 ? 'workflow' : 'workflows'} observed`, false, '#page-runs'),
      renderStation('trophy', label('value-gains', valueGains), valueGains, 'Coming soon', true)
    )
  );
}

/**
 * @param {string} icon
 * @param {string} label
 * @param {number} value
 * @param {string|HTMLElement} detail
 * @param {boolean} [final]
 * @param {string} [href]
 */
function renderStation(icon, label, value, detail, final = false, href) {
  return h(
    'li',
    { className: `factory-station${final ? ' factory-station-final' : ''}${value === 0 ? ' factory-station-empty' : ''}` },
    h('span', { className: 'factory-station-icon', 'aria-hidden': 'true' }, octicon(icon)),
    h('span', {}, label),
    h('strong', {}, href ? h('a', { href }, formatCount(value)) : formatCount(value)),
    h('small', {}, detail)
  );
}

/** @param {Row[]} successfulRuns @param {number} referenceTime */
function renderFactoryRhythm(successfulRuns, referenceTime) {
  const days = activityDays(successfulRuns, referenceTime);
  const maximum = Math.max(...days.map((day) => day.count), 1);
  const summary = h('p', { className: 'factory-rhythm-summary', role: 'status' }, '');
  /** @type {HTMLButtonElement[]} */
  const dayButtons = [];
  const showFullWeek = () => {
    section.dispatchEvent(new CustomEvent('dashboard-time-window-range-change', {
      bubbles: true,
      detail: { range: '1w' }
    }));
  };
  /** @param {number} index */
  const selectDay = (index) => {
    const day = days[index];
    if (!day) return;
    rhythmSelection.set(day);
    showFullWeek();
  };
  /** @param {MouseEvent} event */
  const resetDay = (event) => {
    if (event.target instanceof Element && event.target.closest('.factory-rhythm-day')) return;
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
    h('div', { className: 'factory-rhythm-bars' },
      ...days.map((day, index) => {
        const button = /** @type {HTMLButtonElement} */ (h(
          'button',
          {
            className: 'factory-rhythm-day',
            type: 'button',
            'aria-label': `${day.label} ${day.date}: ${formatCount(day.count)} successful ${day.count === 1 ? 'run' : 'runs'}`,
            'aria-pressed': 'false',
            onClick: () => selectDay(index)
          },
          h('span', { className: 'factory-rhythm-bar-pair', 'aria-hidden': 'true' },
            h('i', { className: 'factory-rhythm-current', style: `height: ${Math.max(5, day.count / maximum * 100)}%` })
          ),
          h('small', {}, day.label)
        ));
        dayButtons.push(button);
        return button;
      }))
  );
  rhythmEffect = effect(() => {
    const selected = rhythmSelection.get();
    const index = selected ? days.findIndex((day) => day.date === selected.date) : -1;
    for (const [buttonIndex, button] of dayButtons.entries()) {
      button.setAttribute('aria-pressed', buttonIndex === index ? 'true' : 'false');
    }
    const day = days[index];
    summary.textContent = day
      ? `${day.label} ${day.date}: ${formatCount(day.count)} successful ${day.count === 1 ? 'run' : 'runs'}.`
      : '';
  });
  return section;
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
