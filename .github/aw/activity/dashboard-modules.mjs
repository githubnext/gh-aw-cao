import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// The activity runtime lives at its installed location (.github/aw/activity) in
// both the catalog and control repositories. The dashboard package is still
// authored at the repository root (dashboard/) in the catalog, so resolve the
// installed layout first and fall back to the catalog source layout.
const DASHBOARD_ROOT_CANDIDATES = ['../dashboard/', '../../../dashboard/'];
const PROBE_MODULE = 'site/src/data/normalize/index.js';

function resolveDashboardRoot() {
  for (const candidate of DASHBOARD_ROOT_CANDIDATES) {
    const root = new URL(candidate, import.meta.url);
    if (existsSync(fileURLToPath(new URL(PROBE_MODULE, root)))) {
      return root;
    }
  }
  throw new Error('Dashboard data modules are unavailable for the activity runtime');
}

const dashboardRoot = resolveDashboardRoot();

function loadDataModule(specifier) {
  return import(new URL(`site/src/data/${specifier}`, dashboardRoot).href);
}

export const { adaptCachedGhAwJsonlStream, cachedJsonlPayloadIdentity } = await loadDataModule('adapters/gh-aw-logs.js');
export const { ingestCachedGhAwJsonl, ingestGhAwLogs, isCachedGhAwJsonlCurrent } = await loadDataModule('ingest/coordinator.js');
export const { normalize } = await loadDataModule('normalize/index.js');
export const { executeDashboardQuery, queryInputNames } = await loadDataModule('queries/declarative.js');
export const { createCanonicalQueries } = await loadDataModule('queries/index.js');
export const { readCollection, readRecord, readTransactions } = await loadDataModule('storage/indexeddb.js');
export const { doctorSqliteDatabase } = await loadDataModule('storage/sqlite-doctor.js');
export const { installSqliteIndexedDB } = await loadDataModule('storage/sqlite-indexeddb.js');
