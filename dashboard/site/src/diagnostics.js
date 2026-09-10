import { relationshipErrors } from './data/model/schema.js';
import {
  activeGenerationIsUsable,
  activeGenerationMetadata,
  generationState,
  listGenerationStates,
  readActiveCollection
} from './data/storage/indexeddb.js';

const ENTITY_STORES = /** @type {const} */ ([
  'repositories',
  'workflows',
  'runs',
  'jobs',
  'sessions',
  'events',
  'workItems',
  'findings'
]);
const REQUIRED_POPULATED_STORES = ['repositories', 'workflows', 'runs', 'events'];

/** @param {string} name @param {boolean} passed @param {string} detail */
function check(name, passed, detail) {
  return { name, passed, detail };
}

/**
 * Runs database, relationship, and rendered-UI consistency checks intended for
 * browser debugging and deployed-dashboard health tests.
 * @param {{ indexedDB?: IDBFactory, document?: Document, location?: Location }} [options]
 */
export async function collectFullDiagnostics(options = {}) {
  const indexedDB = options.indexedDB ?? globalThis.indexedDB;
  const document = options.document ?? globalThis.document;
  const location = options.location ?? globalThis.location;
  if (!indexedDB) throw new Error('IndexedDB is unavailable.');
  if (!document) throw new Error('Document is unavailable.');

  const metadata = await activeGenerationMetadata(indexedDB);
  const generation = metadata?.generation ?? null;
  const [states, state, collections] = await Promise.all([
    listGenerationStates(indexedDB),
    generation ? generationState(indexedDB, generation) : Promise.resolve(null),
    Promise.all(ENTITY_STORES.map((store) => readActiveCollection(indexedDB, store)))
  ]);
  const records = Object.fromEntries(ENTITY_STORES.map((store, index) => [store, collections[index]]));
  const counts = Object.fromEntries(ENTITY_STORES.map((store) => [store, records[store].length]));
  const relationships = relationshipErrors(/** @type {import('./data/model/schema.js').CanonicalBatch} */ (records));
  const generationUsable = generation
    ? await activeGenerationIsUsable(indexedDB, generation)
    : false;
  const activePage = document.querySelector('[data-page-id]:not([hidden])');
  const renderedViews = [...document.querySelectorAll('[data-view-id]')];
  const unavailableViews = [...document.querySelectorAll('[aria-label^="Unable to load "]')]
    .map((element) => element.getAttribute('aria-label'));
  const duplicateRecordIds = Object.fromEntries(ENTITY_STORES.map((store) => {
    const ids = records[store].map((record) => record.id).filter((id) => typeof id === 'string');
    return [store, ids.filter((id, index) => ids.indexOf(id) !== index)];
  }));
  const checks = [
    check('active generation exists', Boolean(generation), generation ?? 'No active generation'),
    check('active generation is complete', state === 'complete', state ?? 'Unavailable'),
    check(
      'active generation is usable',
      generationUsable,
      generation ?? 'No active generation'
    ),
    ...REQUIRED_POPULATED_STORES.map((store) =>
      check(`${store} populated`, counts[store] > 0, `${counts[store]} record(s)`)),
    check('canonical relationships are valid', relationships.length === 0, `${relationships.length} error(s)`),
    check(
      'record IDs are unique',
      Object.values(duplicateRecordIds).every((ids) => ids.length === 0),
      `${Object.values(duplicateRecordIds).reduce((total, ids) => total + ids.length, 0)} duplicate(s)`
    ),
    check('dashboard root rendered', Boolean(document.querySelector('.dashboard-root')), 'Expected .dashboard-root'),
    check('active page rendered', Boolean(activePage), activePage?.getAttribute('data-page-id') ?? 'No active page'),
    check('views rendered', renderedViews.length > 0, `${renderedViews.length} view(s)`),
    check('no busy views remain', document.querySelectorAll('[aria-busy="true"]').length === 0,
      `${document.querySelectorAll('[aria-busy="true"]').length} busy element(s)`),
    check('no view hydration failures', unavailableViews.length === 0, `${unavailableViews.length} failure(s)`)
  ];
  const report = {
    generatedAt: new Date().toISOString(),
    url: location?.href ?? '',
    passed: checks.every((item) => item.passed),
    checks,
    database: {
      metadata,
      state,
      generations: states,
      counts,
      relationshipErrors: relationships,
      duplicateRecordIds
    },
    ui: {
      activePageId: activePage?.getAttribute('data-page-id') ?? null,
      pageIds: [...document.querySelectorAll('[data-page-id]')]
        .map((element) => element.getAttribute('data-page-id')),
      renderedViewIds: renderedViews.map((element) => element.getAttribute('data-view-id')),
      lazyViewIds: [...document.querySelectorAll('[data-lazy-view]')]
        .map((element) => element.getAttribute('data-view-id')),
      unavailableViews,
      busyElements: document.querySelectorAll('[aria-busy="true"]').length,
      domNodes: document.querySelectorAll('*').length
    }
  };

  console.group('Central Agentic Ops full diagnostics');
  console.info('Summary', { passed: report.passed, generatedAt: report.generatedAt, url: report.url });
  console.table(checks);
  console.info('Database', report.database);
  console.info('UI', report.ui);
  console.groupEnd();
  return report;
}
