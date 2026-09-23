import { ingestDashboardSources } from '../ingest/coordinator.js';
import databaseQueries from './database.json' with { type: 'json' };
import {
  CANONICAL_DATABASE_SCHEMA,
  countCollections,
  queryCollection,
  readCollections,
  readTransactions
} from '../storage/indexeddb.js';
import {
  dashboardQueryDefects,
  dashboardQueryIndex,
  executeDashboardQueries,
  resolveDashboardQuerySources
} from './declarative.js';
import { SOURCE_FIELDS } from '../../specification.js';

const monotonicNow = () => globalThis.performance?.now() ?? Date.now();
const databaseQueryIndex = dashboardQueryIndex(databaseQueries);
const RUN_RECORD_STORES = new Set(['domains', 'tools', 'audits', 'issues']);
const DATABASE_TABLE_SOURCES = new Set([
  'campaigns',
  'repositories',
  'workflows',
  'runs',
  ...RUN_RECORD_STORES,
  'transactions'
]);

const HEALTH_DATABASE_SOURCES = [
  'repositories',
  'workflows',
  'runs',
  'usage',
  'detection-observations',
  'firewall-observations',
  'safe-output-performance',
  'outcomes'
];

/**
 * @param {Record<string, unknown>} sources
 * @param {string} sourceName
 * @param {string} queryName
 * @param {boolean} available
 * @returns {import('../../presenter.js').SourceMetadata}
 */
function queryMetadata(sources, sourceName, queryName, available) {
  const input = sources[sourceName] && typeof sources[sourceName] === 'object'
    ? /** @type {{ metadata?: Record<string, unknown> }} */ (sources[sourceName])
    : {};
  const metadata = input.metadata ?? {};
  const asOf = typeof metadata['as-of'] === 'string' ? metadata['as-of'] : '';
  return /** @type {import('../../presenter.js').SourceMetadata} */ ({
    ...metadata,
    'source-id': queryName,
    'source-kind': 'database-query',
    'as-of': asOf,
    'retrieved-at': typeof metadata['retrieved-at'] === 'string' ? metadata['retrieved-at'] : asOf,
    availability: available ? 'available' : 'unavailable',
    completeness: available && ['complete', 'partial'].includes(String(metadata.completeness))
      ? metadata.completeness : 'unknown',
    freshness: available && ['fresh', 'stale'].includes(String(metadata.freshness))
      ? metadata.freshness : 'unknown'
  });
}

/** @param {Record<string, unknown>} sources */
function namedSources(sources) {
  return Object.fromEntries(Object.entries(sources).map(([name, source]) => [
    name,
    source && typeof source === 'object' && !Array.isArray(source)
      ? { source: name, ...source }
      : source
  ]));
}

/** @param {unknown} source */
function hasRows(source) {
  return Boolean(
    source
    && typeof source === 'object'
    && !Array.isArray(source)
    && Array.isArray(/** @type {{ rows?: unknown }} */ (source).rows)
    && /** @type {{ rows: unknown[] }} */ (source).rows.length > 0
  );
}

/**
 * @param {string} queryName
 * @param {Record<string, import('../../presenter.js').LogicalSourceInput>} inputs
 * @param {Record<string, unknown>} sources
 * @param {string} metadataSource
 */
function executeDatabaseQuery(queryName, inputs, sources, metadataSource) {
  const definition = databaseQueryIndex.get(queryName);
  if (!definition) throw new Error(`Missing database query: ${queryName}`);
  const result = executeDashboardQueries(
    [definition],
    inputs,
    [queryName]
  )[queryName];
  const unavailable = result.metadata.availability === 'unavailable';
  return /** @type {import('../../presenter.js').LogicalSourceInput} */ ({
    ...result,
    metadata: unavailable
      ? result.metadata
      : {
          ...queryMetadata(sources, metadataSource, queryName, true),
          availability: result.rows.length > 0 ? 'available' : 'empty'
        }
  });
}

/**
 * @param {string} sourceName
 * @param {Record<string, unknown>[]} records
 * @param {Record<string, unknown>[]} runs
 * @param {Record<string, unknown>} sources
 */
function executeRunRecordsQuery(sourceName, records, runs, sources) {
  return {
    ...executeDatabaseQuery('run-records', {
      $records: {
        source: '$records',
        rows: records,
        metadata: queryMetadata(sources, sourceName, sourceName, true)
      },
      $runs: {
        source: '$runs',
        rows: runs,
        metadata: queryMetadata(sources, 'runs', 'runs', true)
      }
    }, sources, sourceName),
    source: sourceName
  };
}

/**
 * Executes declarative queries with safe IndexedDB pushdown. Whole-table counts
 * use native count, while compatible filters read indexed candidates before
 * final execution by the query engine.
 *
 * @param {IDBFactory} indexedDB
 * @param {Record<string, unknown>} logicalSources
 * @param {unknown} definitions
 * @param {Iterable<string>} requested
 */
export async function queryIndexedDatabaseSources(indexedDB, logicalSources, definitions, requested) {
  const index = dashboardQueryIndex(definitions);
  const defects = dashboardQueryDefects(definitions);
  const countPlans = [...requested].flatMap((name) => {
    const definition = index.get(name);
    if (!definition || defects.has(name)) return [];
    const table = CANONICAL_DATABASE_SCHEMA[definition.from];
    const values = definition.aggregate?.values;
    if (!table
        || typeof table.keyPath !== 'string'
        || definition.union?.length
        || definition.joins?.length
        || definition.filter
        || definition.compute?.length
        || definition['temporal-series']
        || definition.predict?.length
        || definition.select?.length
        || definition['order-by']?.length
        || definition.limit !== undefined
        || definition.aggregate?.by?.length
        || !Array.isArray(values)
        || values.length === 0
        || values.some((value) => value.reducer !== 'count' || value.field !== table.keyPath || value.filter)) {
      return [];
    }
    return [{ name, source: definition.from, values }];
  });
  const filterPlans = [...requested].flatMap((name) => {
    const definition = index.get(name);
    const operators = definition && !defects.has(name) ? indexedRunOperators(definition) : null;
    return operators ? [{ name, definition, operators }] : [];
  });
  const stores = [...new Set(countPlans.map(({ source }) => source))];
  const counts = await countCollections(
    indexedDB,
    /** @type {typeof import('../storage/indexeddb.js').DATABASE_STORES[number][]} */ (stores)
  );
  const counted = Object.fromEntries(countPlans.map(({ name, source, values }) => {
    const metadata = queryMetadata(logicalSources, source, source, true);
    return [name, {
      source: name,
      rows: [Object.fromEntries(values.map((value) => [value.as, counts[source]]))],
      metadata: {
        ...metadata,
        'source-id': `${name}-query`,
        'source-kind': 'derived',
        availability: 'available',
        'query-name': name
      }
    }];
  }));
  const filtered = await Promise.all(filterPlans.map(async ({ name, definition, operators }) => {
    const records = await queryCollection(indexedDB, 'runs', operators);
    const runs = executeDatabaseQuery('runs', {
      $runs: {
        source: '$runs',
        rows: records,
        metadata: queryMetadata(logicalSources, 'runs', 'runs', true)
      },
      $workflows: {
        source: '$workflows',
        rows: [],
        metadata: queryMetadata(logicalSources, 'workflows', 'workflows', true)
      }
    }, logicalSources, 'runs');
    return [name, executeDashboardQueries([definition], { runs }, [name])[name]];
  }));
  return { ...counted, ...Object.fromEntries(filtered) };
}

const RUN_QUERY_FIELDS = new Map([
  ['run-conclusion', 'conclusion'],
  ['started-at', 'startedAt']
]);

/** @param {Record<string, any>} definition */
function indexedRunOperators(definition) {
  if (definition.from !== 'runs'
      || definition.union?.length
      || definition.joins?.length
      || definition.compute?.length
      || definition.aggregate
      || definition['temporal-series']
      || definition.predict?.length
      || definition.select?.length
      || definition.filter?.search) return null;
  const predicates = definition.filter?.predicates;
  if (!Array.isArray(predicates)
      || !predicates.some((predicate) => predicate.field === 'run-conclusion')
      || predicates.some((predicate) => !RUN_QUERY_FIELDS.has(predicate.field))) return null;
  const order = definition['order-by'];
  if (order !== undefined
      && (!Array.isArray(order) || order.some((field) => !RUN_QUERY_FIELDS.has(field.field)))) return null;
  return [
    {
      op: /** @type {const} */ ('filter'),
      predicates: predicates.map((predicate) => ({
        ...predicate,
        field: RUN_QUERY_FIELDS.get(predicate.field)
      }))
    },
    ...(Array.isArray(order) ? [{
      op: /** @type {const} */ ('arrange'),
      by: order.map((field) => ({ ...field, field: RUN_QUERY_FIELDS.get(field.field) }))
    }] : []),
    ...(Number.isInteger(definition.limit) ? [{
      op: /** @type {const} */ ('slice'),
      limit: definition.limit
    }] : [])
  ];
}

/** @param {string} name */
function queryStores(name) {
  const definition = databaseQueryIndex.get(name);
  const mapped = [...databaseQueryIndex.values()]
    .map((candidate) => candidate['stores-by-source']?.[name])
    .find(Array.isArray);
  const configured = definition?.stores ?? mapped;
  return Array.isArray(configured)
    ? configured.filter((store) => typeof store === 'string')
    : [];
}

/**
 * Loads only database stores needed by requested JSON query definitions.
 *
 * @param {IDBFactory} indexedDB
 * @param {Record<string, unknown>} logicalSources
 * @param {string[]} sourceNames
 * @param {{ onMetrics?: (metrics: { databaseMs: number, projectionMs: number, totalMs: number, recordsRead: number, stores: string[] }) => void }} [options]
 */
export async function queryDatabaseSources(indexedDB, logicalSources, sourceNames, options = {}) {
  const startedAt = monotonicNow();
  if (!Array.isArray(sourceNames) || sourceNames.some((name) => typeof name !== 'string')) {
    throw new TypeError('Dashboard source names must be an array of strings.');
  }
  const requested = new Set(sourceNames);
  if (requested.has('data-health-collections') || requested.has('data-health-coverage')) {
    for (const name of HEALTH_DATABASE_SOURCES) requested.add(name);
  }
  const databaseRequested = [...requested].filter((name) => (
    DATABASE_TABLE_SOURCES.has(name)
    || !hasRows(logicalSources[name])
  ));
  const stores = [...new Set(databaseRequested.flatMap(queryStores))];
  const transactionRequested = stores.includes('transactions');
  const collectionStores = /** @type {Array<'campaigns'|'repositories'|'workflows'|'runs'|'domains'|'tools'|'audits'|'issues'>} */ (
    stores.filter((name) => name !== 'transactions')
  );
  const databaseStartedAt = monotonicNow();
  const [collections, transactions] = await Promise.all([
    readCollections(indexedDB, collectionStores),
    transactionRequested ? readTransactions(indexedDB) : []
  ]);
  const databaseMs = monotonicNow() - databaseStartedAt;
  const sources = namedSources(logicalSources);
  /** @type {Record<string, import('../../presenter.js').LogicalSourceInput>} */
  const result = {};
  for (const name of requested) {
    const logical = /** @type {import('../../presenter.js').LogicalSourceInput | undefined} */ (sources[name]);
    if (logical
        && !DATABASE_TABLE_SOURCES.has(name)
        && (!databaseQueryIndex.has(name) || logical.rows.length > 0)) {
      result[name] = logical;
      continue;
    }
    if (!databaseQueryIndex.has(name) && !RUN_RECORD_STORES.has(name)) {
      result[name] = logical ?? {
        source: name,
        rows: [],
        metadata: {
          ...queryMetadata(sources, name, name, Object.hasOwn(SOURCE_FIELDS, name)),
          availability: Object.hasOwn(SOURCE_FIELDS, name) ? 'empty' : 'unavailable'
        }
      };
      continue;
    }
    if (RUN_RECORD_STORES.has(name)) {
      result[name] = executeRunRecordsQuery(name, collections[name] ?? [], collections.runs ?? [], sources);
      continue;
    }
    if (name === 'mcp-calls' || name === 'findings' || name === 'firewall-observations') {
      const store = name === 'mcp-calls' ? 'tools' : name === 'findings' ? 'audits' : 'domains';
      const records = executeRunRecordsQuery(store, collections[store] ?? [], collections.runs ?? [], sources);
      result[name] = executeDatabaseQuery(name, {
        'run-records': records
      }, sources, store);
      continue;
    }
    if (name === 'outcomes') {
      const records = executeRunRecordsQuery('issues', collections.issues ?? [], collections.runs ?? [], sources);
      const workflowRows = executeDatabaseQuery('workflows', {
        $workflows: {
          source: '$workflows',
          rows: collections.workflows ?? [],
          metadata: queryMetadata(sources, 'workflows', 'workflows', true)
        },
        $repositories: {
          source: '$repositories',
          rows: collections.repositories ?? [],
          metadata: queryMetadata(sources, 'repositories', 'repositories', true)
        }
      }, sources, 'workflows');
      const linkedRecords = {
        ...records,
        rows: records.rows.map((row) => {
          const correlationId = typeof row['correlation-id'] === 'string' ? row['correlation-id'] : '';
          const isPullRequest = row['is-pull-request'] === true;
          const link = correlationId ? { href: correlationId, label: isPullRequest ? 'View pull request' : 'View issue' } : null;
          return {
            ...row,
            'issue-link': !isPullRequest ? link : null,
            'pull-request-link': isPullRequest ? link : null,
            'external-link': link
          };
        })
      };
      result[name] = executeDatabaseQuery(name, {
        'run-records': linkedRecords,
        workflows: workflowRows
      }, sources, 'issues');
      continue;
    }
    if (name === 'detection-observations' || name === 'safe-output-performance') {
      const inputName = name === 'detection-observations' ? '$security-findings' : '$outcomes';
      const logicalName = inputName.slice(1);
      const input = /** @type {import('../../presenter.js').LogicalSourceInput | undefined} */ (sources[logicalName]);
      result[name] = input
        ? executeDatabaseQuery(name, { [inputName]: input }, sources, logicalName)
        : {
            source: name,
            rows: [],
            metadata: { ...queryMetadata(sources, name, name, true), availability: 'empty' }
          };
      continue;
    }
    const inputs = Object.fromEntries(queryStores(name).map((store) => [
      `$${store}`,
      {
        source: `$${store}`,
        rows: store === 'transactions' ? transactions : collections[store] ?? [],
        metadata: queryMetadata(sources, store, store, true)
      }
    ]));
    result[name] = executeDatabaseQuery(name, inputs, sources, name);
  }
  const totalMs = monotonicNow() - startedAt;
  options.onMetrics?.({
    databaseMs,
    projectionMs: Math.max(0, totalMs - databaseMs),
    totalMs,
    recordsRead: Object.values(collections).reduce((total, records) => total + records.length, 0)
      + transactions.length,
    stores
  });
  return result;
}

/**
 * @param {IDBFactory} indexedDB
 * @param {Record<string, unknown>} sources
 * @param {{ ingest?: boolean, storage?: StorageManager, sourceNames?: string[], queries?: unknown[] }} [options]
 */
export async function loadDatabaseQuerySources(indexedDB, sources, options = {}) {
  if (options.ingest) await ingestDashboardSources(indexedDB, sources, { storage: options.storage });
  const sourceNames = Array.isArray(options.sourceNames) ? options.sourceNames : Object.keys(sources);
  const required = resolveDashboardQuerySources(options.queries ?? [], sourceNames);
  const database = await queryDatabaseSources(indexedDB, sources, required);
  return {
    ...namedSources(sources),
    ...database,
    ...executeDashboardQueries(options.queries ?? [], database, sourceNames)
  };
}
