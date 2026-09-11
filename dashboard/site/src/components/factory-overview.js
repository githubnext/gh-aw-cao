import { h } from '../dom.js';
import { octicon } from '../octicons.js';
import { formatCount } from './count-formatters.js';
import { rowsFor } from './source-rows.js';

const DAY_MS = 86_400_000;
const DELIVERED_STATES = new Set(['accepted', 'completed', 'lifecycle-close']);
const FAILURE_STATES = new Set(['failure', 'startup-failure', 'stale', 'timed-out']);

/** @typedef {Record<string, unknown>} Row */
/** @typedef {import('../presenter.js').LogicalSourceInput} LogicalSourceInput */

/** @param {{ sources: Record<string, LogicalSourceInput> }} context */
export function renderFactoryOverview(context) {
  const outcomes = latestOutcomes(rowsFor(context.sources, 'outcomes'));
  const runs = rowsFor(context.sources, 'runs');
  const dispatches = rowsFor(context.sources, 'dispatches');
  const dispatchRows = dispatches.length > 0
    ? dispatches
    : runs.filter((row) => String(row.event) === 'workflow_dispatch');
  const graderObservations = rowsFor(context.sources, 'grader-observations');
  const rhythmBaseline = rowsFor(context.sources, 'factory-rhythm-baseline')[0];
  const repositories = rowsFor(context.sources, 'repositories');
  const workflows = rowsFor(context.sources, 'workflows');
  const repositoryCoverage = connectedRepositoryCoverage(workflows, repositories, runs);
  const activeRuns = runs.filter((row) => ['queued', 'in-progress'].includes(normalizedStatus(row['run-status']))).length;
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
    renderIntroduction(factoryHeading(context.sources, valueGains, activeRuns, successfulRuns, failedRuns), usefulOutputs, deliveredRepositories, successfulRuns, dispatchRows.length, activeRuns, successfulRunRows, latestTimestamp(runs), rhythmBaseline),
    renderFactoryFloor(repositoryCoverage, successfulRuns, failedRuns, dispatchRows.length, workers, valueGains, issues, pullRequests, activeRuns)
  );
}

/**
 * @param {string} heading
 * @param {number} usefulOutputs
 * @param {number} deliveredRepositories
 * @param {number} successfulRuns
 * @param {number} dispatches
 * @param {number} activeRuns
 * @param {Row[]} successfulRunRows
 * @param {number} referenceTime
 * @param {Row | undefined} rhythmBaseline
 */
function renderIntroduction(heading, usefulOutputs, deliveredRepositories, successfulRuns, dispatches, activeRuns, successfulRunRows, referenceTime, rhythmBaseline) {
  const summary = usefulOutputs > 0
    ? `${formatCount(usefulOutputs)} retained issue and pull request ${usefulOutputs === 1 ? 'output is' : 'outputs are'} backed by Actions evidence${deliveredRepositories > 0 ? ` across ${formatCount(deliveredRepositories)} ${deliveredRepositories === 1 ? 'repository' : 'repositories'}` : ''}.`
    : `${formatCount(successfulRuns)} successful ${successfulRuns === 1 ? 'run' : 'runs'} and ${formatCount(dispatches)} workflow ${dispatches === 1 ? 'dispatch' : 'dispatches'} are retained in this period.`;
  return h(
    'header',
    { className: 'factory-intro' },
    h(
      'div',
      { className: 'factory-intro-copy' },
      h(
        'p',
        { className: `factory-running${activeRuns > 0 ? ' factory-running-active' : ''}` },
        activeRuns > 0
          ? h('span', {}, h('strong', {}, formatCount(activeRuns)), activeRuns === 1 ? ' run in motion' : ' runs in motion')
          : 'Actions activity observed'
      ),
      h('h2', { id: 'agent-factory-heading' }, heading),
      h('p', {}, summary)
    ),
    renderFactoryRhythm(successfulRunRows, referenceTime, rhythmBaseline)
  );
}

/**
 * @param {Record<string, LogicalSourceInput>} sources
 * @param {number} valueGains
 * @param {number} activeRuns
 * @param {number} successfulRuns
 * @param {number} failedRuns
 */
function factoryHeading(sources, valueGains, activeRuns, successfulRuns, failedRuns) {
  if (['runs', 'outcomes'].some((name) => sources[name]?.metadata?.availability === 'unavailable')) return 'Factory status is unavailable.';
  if (valueGains > 0) return 'The factory is delivering value.';
  if (activeRuns > 0) return 'The factory is humming.';
  if (failedRuns > successfulRuns && failedRuns > 0) return 'The factory is under strain.';
  if (failedRuns > 0) return 'The factory needs attention.';
  if (successfulRuns > 0) return 'The factory completed its shift.';
  return 'The factory is idle.';
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
 */
function renderFactoryFloor(repositories, successfulRuns, failedRuns, dispatches, workers, valueGains, issues, pullRequests, activeRuns) {
  const usefulOutputs = issues + pullRequests;
  return h(
    'section',
    {
      className: `factory-floor${activeRuns > 0 ? ' factory-floor-active' : ''}`,
      'aria-label': `${formatCount(repositories.total)} repositories in scope, ${formatCount(repositories.review)} in review and ${formatCount(repositories.live)} live, ${formatCount(successfulRuns)} successful runs, ${formatCount(dispatches)} workflow dispatches across ${formatCount(workers)} workers, ${formatCount(valueGains)} grader values above threshold, and ${formatCount(usefulOutputs)} issue or pull request outputs.`
    },
    h(
      'ol',
      { className: 'factory-stations' },
      renderStation('repo', 'Repositories', repositories.total, repositoryModeDetail(repositories), false, '#page-repositories'),
      renderStation('check-circle', 'Successful runs', successfulRuns, h('a', { href: '#page-runs?runs-runs-source.run-conclusion=failure' }, `${formatCount(failedRuns)} failed`), false, '#page-runs?runs-runs-source.run-conclusion=success'),
      renderStation('workflow', 'Dispatches', dispatches, `${formatCount(workers)} ${workers === 1 ? 'workflow' : 'workflows'} observed`, false, '#page-runs'),
      renderStation('trophy', 'Value gains', valueGains, 'Coming soon', true)
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

/** @param {Row[]} successfulRuns @param {number} referenceTime @param {Row | undefined} baseline */
function renderFactoryRhythm(successfulRuns, referenceTime, baseline) {
  const days = activityDays(successfulRuns, referenceTime);
  const baselineAverage = Number(baseline?.['daily-average']);
  const hasBaseline = Number.isFinite(baselineAverage) && baselineAverage >= 0;
  const maximum = Math.max(...days.map((day) => day.count), hasBaseline ? baselineAverage : 0, 1);
  const baselinePosition = hasBaseline ? Math.min(100, baselineAverage / maximum * 100) : 0;
  return h(
    'section',
    { className: 'factory-rhythm', 'aria-label': 'Successful Actions runs over the last seven observed days' },
    h(
      'div',
      { className: 'factory-rhythm-heading' },
      h('span', {}, 'Factory rhythm')
    ),
    h('div', { className: 'factory-rhythm-bars' },
      ...(hasBaseline ? [h(
        'div',
        {
          className: 'factory-rhythm-baseline',
          style: `--factory-baseline-position: ${17 + (baselinePosition * 0.55)}px`,
          'aria-label': `Prior ${formatCount(Number(baseline?.weeks))} week daily average: ${formatCount(Math.round(baselineAverage))} successful runs`
        },
        h('i', {}),
        h('small', {}, `${formatCount(Math.round(baselineAverage))} avg`)
      )] : []),
      ...days.map((day) => h(
      'span',
      { tabindex: '0', 'aria-label': `${day.label}: ${formatCount(day.count)} successful ${day.count === 1 ? 'run' : 'runs'}` },
      h('strong', { className: 'factory-rhythm-tooltip', role: 'tooltip', 'aria-hidden': 'true' }, formatCount(day.count)),
      h('i', { style: `height: ${Math.max(5, day.count / maximum * 100)}%` }),
      h('small', {}, day.label)
      )))
  );
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

/** @param {Row[]} rows @param {number} referenceTime */
function activityDays(rows, referenceTime) {
  return Array.from({ length: 7 }, (_, index) => {
    const start = startOfDay(referenceTime) - (6 - index) * DAY_MS;
    const end = start + DAY_MS;
    return {
      label: new Date(start).toLocaleDateString('en', { weekday: 'short' }),
      count: rows.filter((row) => rowTimestamp(row) >= start && rowTimestamp(row) < end).length
    };
  });
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
