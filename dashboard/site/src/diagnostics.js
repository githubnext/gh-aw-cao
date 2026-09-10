import { relationshipErrors } from './data/model/schema.js';
import {
  DATABASE_VERSION,
  readCollection
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

  const collections = await Promise.all(
    ENTITY_STORES.map((store) => readCollection(indexedDB, store))
  );
  const records = Object.fromEntries(ENTITY_STORES.map((store, index) => [store, collections[index]]));
  const counts = Object.fromEntries(ENTITY_STORES.map((store) => [store, records[store].length]));
  const relationships = relationshipErrors(/** @type {import('./data/model/schema.js').CanonicalBatch} */ (records));
  const activePage = document.querySelector('[data-page-id]:not([hidden])');
  const renderedViews = [...document.querySelectorAll('[data-view-id]')];
  const unavailableViews = [...document.querySelectorAll('[aria-label^="Unable to load "]')]
    .map((element) => element.getAttribute('aria-label'));
  const busyElements = document.querySelectorAll('[aria-busy="true"]');
  const duplicateRecordIds = Object.fromEntries(ENTITY_STORES.map((store) => {
    const ids = records[store].map((record) => record.id).filter((id) => typeof id === 'string');
    return [store, ids.filter((id, index) => ids.indexOf(id) !== index)];
  }));
  const checks = [
    check('canonical database is available', true, `Schema version ${DATABASE_VERSION}`),
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
    check('no busy views remain', busyElements.length === 0, `${busyElements.length} busy element(s)`),
    check('no view hydration failures', unavailableViews.length === 0, `${unavailableViews.length} failure(s)`)
  ];
  const report = {
    generatedAt: new Date().toISOString(),
    url: location?.href ?? '',
    passed: checks.every((item) => item.passed),
    checks,
    database: {
      schemaVersion: DATABASE_VERSION,
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
      busyElements: busyElements.length,
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
