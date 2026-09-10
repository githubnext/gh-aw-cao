import { h } from './dom.js';

export const DATABASE_COUNT_SOURCE_NAMES = [
  'database-repository-count',
  'database-workflow-count',
  'database-run-count',
  'database-event-count'
];

/**
 * @typedef {{ repositories: unknown, workflows: unknown, runs: unknown, events: unknown }} DatabaseCounts
 */

/**
 * @param {(() => Promise<Record<string, { rows?: Array<Record<string, unknown>> }>>) | undefined} loadSources
 * @returns {() => Promise<DatabaseCounts>}
 */
export function createDatabaseCountLoader(loadSources) {
  /** @type {Promise<DatabaseCounts> | undefined} */
  let countsPromise;
  return () => {
    if (!loadSources) return Promise.reject(new Error('Database count query unavailable'));
    countsPromise ??= loadSources().then((sources) => {
      const repositories = sources['database-repository-count']?.rows?.[0]?.repositories;
      const workflows = sources['database-workflow-count']?.rows?.[0]?.workflows;
      const runs = sources['database-run-count']?.rows?.[0]?.runs;
      const events = sources['database-event-count']?.rows?.[0]?.events;
      if ([repositories, workflows, runs, events].some((count) => count === undefined)) {
        throw new Error('Database count query unavailable');
      }
      return { repositories, workflows, runs, events };
    });
    return countsPromise;
  };
}

/**
 * @param {DatabaseCounts} counts
 * @returns {string}
 */
export function formatDatabaseCounts(counts) {
  return `${counts.repositories} repositories · ${counts.workflows} workflows · ${counts.runs} runs · ${counts.events} events`;
}

/**
 * @param {() => Promise<DatabaseCounts>} loadDatabaseCounts
 * @returns {{ element: HTMLElement, load: () => void }}
 */
export function renderSettingsDatabaseCounts(loadDatabaseCounts) {
  const fields = /** @type {const} */ ([
    ['repositories', 'Repositories'],
    ['workflows', 'Workflows'],
    ['runs', 'Runs'],
    ['events', 'Events']
  ]);
  const values = Object.fromEntries(fields.map(([name]) => [
    name,
    h('strong', { dataset: { databaseCount: name } }, '—')
  ]));
  const status = h('span', { className: 'database-counts-status', 'aria-live': 'polite' }, 'Open to load database counts');
  let started = false;
  const load = () => {
    if (started) return;
    started = true;
    status.textContent = 'Loading database counts…';
    loadDatabaseCounts()
      .then((counts) => {
        for (const [name] of fields) values[name].textContent = String(counts[name] ?? 0);
        status.textContent = 'Database totals';
      })
      .catch(() => {
        status.textContent = 'Database counts unavailable';
      });
  };
  return {
    element: h(
      'fieldset',
      { className: 'database-counts' },
      h('legend', null, 'Database'),
      h(
        'div',
        { className: 'database-count-grid' },
        fields.map(([name, label]) => h('span', null, values[name], h('small', null, label)))
      ),
      status
    ),
    load
  };
}
