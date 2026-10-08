import { ingestDashboardSources } from '../ingest/coordinator.js';
import databaseQueries from './database.json' with { type: 'json' };
import {
  CANONICAL_DATABASE_SCHEMA,
  CANONICAL_QUERY_INDEX_FIELDS,
  countCollections,
  queryCollection,
  queryCollectionCountGroups,
  readCollectionQueryKeys,
  readCollectionQueryKeyRecords,
  readCollections,
  readRecord,
  readTransactions
} from '../storage/indexeddb.js';
import {
  createDashboardQueryBudget,
  DASHBOARD_QUERY_LIMITS,
  dashboardQueryDefects,
  dashboardQueryIndex,
  executeDashboardQueries,
  resolveDashboardQuerySources
} from './declarative.js';
import { SYNTHETIC_SOURCE_FIELDS, TABLE_FIELDS } from '../../specification.js';
import { SIMULATION_DAYS, simulationDaysSource } from './simulation-days.js';
import { createDebug } from '../../debug.js';

const debugDatabase = createDebug('database');
const monotonicNow = () => globalThis.performance?.now() ?? Date.now();
const databaseQueryIndex = dashboardQueryIndex(databaseQueries);
const RUN_RECORD_STORES = new Set(['domains', 'tools', 'skills', 'friction', 'audits', 'issues']);
const DIRECT_EVIDENCE_SOURCES = new Set([
  'experiments', 'experiment-assignments', 'graders',
  'grader-observations', 'evals', 'eval-observations'
]);
const DATABASE_TABLE_SOURCES = new Set([
  'campaigns',
  'repositories',
  'workflows',
  'runs',
  ...RUN_RECORD_STORES,
  'operational-values',
  'marketplace-packages',
  'experiments',
  'experiment-assignments',
  'graders',
  'grader-observations',
  'evals',
  'eval-observations',
  'transactions'
]);
/** @type {Record<string, Set<string>>} */
const NATIVE_COUNT_FIELDS = {
  campaigns: new Set(['id', 'campaign']),
  repositories: new Set(['id', 'repository'])
};
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
  const projectionClock = sources['$projection-clock'];
  const asOf = typeof metadata['as-of'] === 'string' && metadata['as-of']
    ? metadata['as-of'] : typeof projectionClock === 'string' ? projectionClock : '';
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

/** @param {unknown} source */
function hasUsableRows(source) {
  if (!hasRows(source)) return false;
  return /** @type {{ metadata?: { availability?: unknown } }} */ (source).metadata?.availability !== 'unavailable';
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
  const result = executeDatabaseProjection(definition, inputs);
  const unavailable = result.metadata.availability === 'unavailable';
  return /** @type {import('../../presenter.js').LogicalSourceInput} */ ({
    ...result,
    metadata: unavailable
      ? result.metadata
      : {
          ...queryMetadata(DIRECT_EVIDENCE_SOURCES.has(queryName) ? {} : sources, metadataSource, queryName, true),
          availability: result.rows.length > 0 ? 'available' : 'empty'
        }
  });
}

/**
 * Canonical row-local mappings are adapters, not bounded view results. Partition
 * only their primary input; joins and the execution budget remain shared.
 * @param {import('./declarative.js').DashboardQuery} definition
 * @param {Record<string, import('../../presenter.js').LogicalSourceInput>} inputs
 * @returns {import('../../presenter.js').LogicalSourceInput}
 */
function executeDatabaseProjection(definition, inputs) {
  const input = inputs[definition.from];
  const batchSize = DASHBOARD_QUERY_LIMITS['max-output-rows'];
  const rowLocal = !definition.union?.length
    && !definition.aggregate
    && !definition['temporal-series']
    && !definition.predict?.length
    && !definition.window?.length
    && !definition['order-by']?.length
    && definition.limit === undefined;
  if (!rowLocal || !input || input.rows.length <= batchSize) {
    return executeDashboardQueries([definition], inputs, [definition.name])[definition.name];
  }
  const budget = createDashboardQueryBudget();
  /** @type {Record<string, unknown>[]} */
  const rows = [];
  /** @type {import('../../presenter.js').LogicalSourceInput | undefined} */
  let result;
  for (let offset = 0; offset < input.rows.length; offset += batchSize) {
    result = executeDashboardQueries([definition], {
      ...inputs,
      [definition.from]: { ...input, rows: input.rows.slice(offset, offset + batchSize) }
    }, [definition.name], { budget })[definition.name];
    if (result.metadata.availability === 'unavailable') return result;
    for (const row of result.rows) rows.push(row);
  }
  if (!result) throw new Error(`Database projection produced no batches: ${definition.name}`);
  return {
    ...result,
    rows,
    metadata: { ...result.metadata, availability: rows.length > 0 ? 'available' : 'empty' }
  };
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
 * @param {{ signal?: { aborted?: boolean }, budget?: import('./declarative.js').QueryBudget }} [options]
 * @returns {Promise<Record<string, import('../../presenter.js').LogicalSourceInput>>}
 */
export async function queryIndexedDatabaseSources(indexedDB, logicalSources, definitions, requested, options = {}) {
  if (resolveDashboardQuerySources(definitions, requested).some((name) => (
    DATABASE_TABLE_SOURCES.has(name) || queryStores(name).length > 0
  ))) logicalSources = await withProjectionClock(indexedDB, logicalSources);
  const budget = options.budget ?? createDashboardQueryBudget(options);
  budget.checkpoint();
  const index = dashboardQueryIndex(definitions);
  const defects = dashboardQueryDefects(definitions);
  const keySelectionPlans = [...requested].flatMap((name) => {
    const definition = index.get(name);
    if (!definition || defects.has(name)) return [];
    const plan = indexedRecordKeySelectionPlan(index, definition);
    return plan ? [{ name, plan }] : [];
  });
  const keySelections = await Promise.all(keySelectionPlans.map(async ({ name, plan }) => {
    const source = plan.source;
    const unavailable = [logicalSources[source], logicalSources[plan.store]]
      .map((input) => /** @type {import('../../presenter.js').LogicalSourceInput | undefined} */ (input))
      .find((input) => input?.metadata?.availability === 'unavailable');
    if (unavailable) {
      return [name, executeRowLocalRecordGraph(plan.queries, { [source]: unavailable }, name, budget)];
    }
    const keys = await readCollectionQueryKeys(indexedDB, plan.store, plan.indexName, {
      maxKeys: DASHBOARD_QUERY_LIMITS['max-input-rows'], checkpoint: () => budget.spend(1)
    });
    if (!keys) return null;
    /** @type {string[]} */
    const selectedKeys = [];
    const batchSize = Math.min(1000, DASHBOARD_QUERY_LIMITS['max-output-rows']);
    for (let offset = 0; offset < keys.length; offset += batchSize) {
      budget.checkpoint();
      const batch = keys.slice(offset, offset + batchSize);
      const projected = executeRunRecordsQuery(source, batch.map(({ row, key }) => ({
        ...row, id: key
      })), [], logicalSources);
      const keyed = {
        ...projected,
        rows: projected.rows.map((row, position) => ({ ...row, [plan.keyField]: batch[position].key }))
      };
      const inputs = plan.projection
        ? executeDashboardQueries([plan.projection], { 'run-records': keyed }, [source], { budget })[source]
        : keyed;
      const result = executeDashboardQueries(plan.keyQueries, { [source]: inputs }, [name], { budget })[name];
      if (result.metadata.availability === 'unavailable') return [name, result];
      for (const row of result.rows) selectedKeys.push(String(row[plan.keyField]));
    }
    const records = await readCollectionQueryKeyRecords(indexedDB, plan.store, plan.indexName, selectedKeys, {
      maxRows: DASHBOARD_QUERY_LIMITS['max-input-rows'], checkpoint: () => budget.checkpoint()
    });
    const runs = (await readCollections(indexedDB, ['runs'])).runs ?? [];
    const projected = executeRunRecordsQuery(source, records, runs, logicalSources);
    const actual = plan.projection
      ? executeDatabaseQuery(source, { 'run-records': projected }, logicalSources, plan.store)
      : projected;
    return [name, executeRowLocalRecordGraph(plan.queries, {
      [source]: actual
    }, name, budget)];
  }));
  const recordPlans = [...requested].flatMap((name) => {
    const definition = index.get(name);
    const flattened = definition && !defects.has(name)
      ? flattenIndexedRecordQuery(index, definition)
      : null;
    const plan = flattened && !(flattened.joins ?? []).some((join) => index.has(join.source))
      ? indexedRecordAggregatePlan(flattened) : null;
    return plan ? [{ name, definition: flattened, plan }] : [];
  });
  const recordAggregates = await Promise.all(recordPlans.map(async ({ name, definition, plan }) => {
    if (!definition?.aggregate) return null;
    const joinedAliases = new Set((definition.joins ?? []).flatMap((join) => (
      join.fields.map((field) => field.as ?? field.field)
    )));
    let weightField = '_indexed-count';
    while (joinedAliases.has(weightField)) weightField += '-value';
    /** @type {Record<string, import('../../presenter.js').LogicalSourceInput>} */
    const inputs = await queryDatabaseSources(indexedDB, logicalSources, [
      ...(definition.joins ?? []).map((join) => join.source)
    ]);
    const runs = (await readCollections(indexedDB, ['runs'])).runs ?? [];
    for (const source of [definition.from, ...(definition.union ?? [])]) {
      const unavailable = /** @type {import('../../presenter.js').LogicalSourceInput | undefined} */ (logicalSources[source]);
      if (unavailable?.metadata?.availability === 'unavailable') {
        inputs[source] = unavailable;
        continue;
      }
      const groups = await queryCollectionCountGroups(
        indexedDB,
        /** @type {typeof import('../storage/indexeddb.js').ENTITY_STORES[number]} */ (source),
        { ...plan, maxGroups: DASHBOARD_QUERY_LIMITS['max-input-rows'], checkpoint: () => budget.spend(1) }
      );
      if (!groups) return null;
      const projected = executeRunRecordsQuery(source, groups, runs, logicalSources);
      inputs[source] = {
        ...projected,
        rows: projected.rows.map((row, position) => ({ ...row, [weightField]: groups[position].count }))
      };
    }
    const weighted = {
      ...definition,
      aggregate: {
        ...definition.aggregate,
        values: definition.aggregate.values.map((value) => (
          value.field === 'event' || value.field === 'id'
            ? { ...value, field: weightField, reducer: 'sum' }
            : value
        ))
      }
    };
    return [name, executeDashboardQueries([weighted], inputs, [name], { budget })[name]];
  }));
  const recordSelectionPlans = [...requested].flatMap((name) => {
    const definition = index.get(name);
    const flattened = definition && !defects.has(name)
      ? flattenIndexedRecordQuery(index, definition) : null;
    const predicates = flattened?.filter?.predicates?.filter((predicate) => RECORD_RUN_FIELDS.has(predicate.field));
    if (!flattened || flattened.aggregate || flattened['temporal-series'] || flattened.predict?.length || flattened.window?.length
        || !(predicates?.length)
        || [flattened.from, ...(flattened.union ?? [])].some((source) => !RUN_RECORD_STORES.has(source))
        || (flattened.joins ?? []).some((join) => index.has(join.source))
        || predicates.some((predicate) => (
          predicate.optional || predicate.equals === 'unknown' || predicate.in?.includes('unknown')
        ))) return [];
    return [{ name, definition: flattened, predicates }];
  });
  const recordSelections = await Promise.all(recordSelectionPlans.map(async ({ name, definition, predicates }) => {
    const runs = (await readCollections(indexedDB, ['runs'])).runs ?? [];
    const identities = executeRunRecordsQuery(definition.from, runs.map((run) => ({
      id: run.id, runId: run.id
    })), runs, logicalSources);
    const selected = executeDashboardQueries([{
      name: 'indexed-run-selection', from: definition.from,
      filter: { predicates }, select: [{ field: 'event' }]
    }], { [definition.from]: identities }, ['indexed-run-selection'], { budget })['indexed-run-selection'];
    if (selected.metadata.availability === 'unavailable') return [name, selected];
    const runIds = selected.rows.map((row) => row.event);
    /** @type {Record<string, import('../../presenter.js').LogicalSourceInput>} */
    const inputs = await queryDatabaseSources(indexedDB, logicalSources, [
      ...(definition.joins ?? []).map((join) => join.source)
    ]);
    for (const source of [definition.from, ...(definition.union ?? [])]) {
      const unavailable = /** @type {import('../../presenter.js').LogicalSourceInput | undefined} */ (logicalSources[source]);
      if (unavailable?.metadata?.availability === 'unavailable') {
        inputs[source] = unavailable;
        continue;
      }
      /** @type {Record<string, unknown>[]} */
      const records = [];
      for (let offset = 0; offset < runIds.length; offset += 32) {
        budget.checkpoint();
        const batch = await queryCollection(
          indexedDB,
          /** @type {typeof import('../storage/indexeddb.js').ENTITY_STORES[number]} */ (source),
          [{ op: 'filter', predicates: [{ field: 'runId', in: runIds.slice(offset, offset + 32) }] }],
          { maxRows: DASHBOARD_QUERY_LIMITS['max-input-rows'] - records.length }
        );
        for (const row of batch) records.push(row);
      }
      records.sort((left, right) => indexedDB.cmp(
        /** @type {IDBValidKey} */ (left.id), /** @type {IDBValidKey} */ (right.id)
      ));
      inputs[source] = executeRunRecordsQuery(source, records, runs, logicalSources);
    }
    return [name, executeDashboardQueries([definition], inputs, [name], { budget })[name]];
  }));
  const countPlans = [...requested].flatMap((name) => {
    const definition = index.get(name);
    if (!definition || defects.has(name)) return [];
    const table = CANONICAL_DATABASE_SCHEMA[definition.from];
    const values = definition.aggregate?.values;
    const computedLiterals = Object.fromEntries((definition.compute ?? []).flatMap((computed) => (
      computed.function === 'literal'
        && Array.isArray(computed.args)
        && computed.args.length === 1
        && 'value' in computed.args[0]
        ? [[computed.as, computed.args[0].value]]
        : []
    )));
    const computedFields = Object.keys(computedLiterals);
    const groupedFields = definition.aggregate?.by ?? [];
    const nativeCountFields = NATIVE_COUNT_FIELDS[definition.from]
      ?? new Set([table?.keyPath]);
    if (!table
        || (computedFields.length === 0 && typeof table.keyPath !== 'string')
        || definition.union?.length
        || definition.joins?.length
        || definition.filter
        || computedFields.length !== (definition.compute?.length ?? 0)
        || groupedFields.length !== computedFields.length
        || groupedFields.some((field) => !Object.hasOwn(computedLiterals, field))
        || definition['temporal-series']
        || definition.predict?.length || definition.window?.length
        || definition.select?.length
        || definition['order-by']?.length
        || definition.limit !== undefined
        || !Array.isArray(values)
        || values.length === 0
        || values.some((value) => (
          value.reducer !== 'count'
          || (computedFields.length === 0 && !nativeCountFields.has(value.field))
          || value.filter
        ))) {
      return [];
    }
    return [{ name, source: definition.from, values, computedLiterals }];
  });
  const filterPlans = [...requested].flatMap((name) => {
    const definition = index.get(name);
    const executable = definition && !defects.has(name)
      ? flattenIndexedRunQuery(index, definition)
      : null;
    const operators = executable
      ? indexedRunOperators(executable) ?? indexedRunAggregateOperators(executable)
      : null;
    return operators ? [{ name, definition: executable, operators }] : [];
  });
  const stores = [...new Set(countPlans.map(({ source }) => source))];
  debugDatabase({
    event: 'indexed-pushdown-resolved',
    countPlanCount: countPlans.length,
    filterPlanCount: filterPlans.length,
    storeCount: stores.length
  });
  /** @type {Record<string, number>} */
  const counts = stores.length > 0
    ? await countCollections(
        indexedDB,
        /** @type {typeof import('../storage/indexeddb.js').DATABASE_STORES[number][]} */ (stores)
      )
    : {};
  const counted = Object.fromEntries(countPlans.map(({ name, source, values, computedLiterals }) => {
    const metadata = queryMetadata(logicalSources, source, source, true);
    return [name, {
      source: name,
      rows: counts[source] === 0 && Object.keys(computedLiterals).length > 0
        ? []
        : [{
            ...computedLiterals,
            ...Object.fromEntries(values.map((value) => [value.as, counts[source]]))
          }],
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
    return [name, executeDashboardQueries([definition], { runs }, [name], { budget })[name]];
  }));
  budget.checkpoint();
  return {
    ...counted,
    ...Object.fromEntries(filtered),
    ...Object.fromEntries(recordAggregates.filter((entry) => entry !== null)),
    ...Object.fromEntries(recordSelections),
    ...Object.fromEntries(keySelections.filter((entry) => entry !== null))
  };
}

const RUN_RECORD_PROJECTION = databaseQueryIndex.get('run-records');
const RECORD_PROJECTED_FIELDS = new Set((RUN_RECORD_PROJECTION?.select ?? []).map((field) => field.as ?? field.field));
const RECORD_RUN_FIELDS = new Set([
  ...(RUN_RECORD_PROJECTION?.joins ?? []).flatMap((join) => join.fields.map((field) => field.as ?? field.field)),
  'run'
]);

/** @typedef {Map<string, Set<string> | null>} RecordFieldLineage */
/**
 * @param {RecordFieldLineage} fields
 * @param {import('./declarative.js').DashboardQuery} definition
 */
function computedRecordLineage(fields, definition) {
  const result = new Map(fields);
  for (const computed of definition.compute ?? []) {
    const dependencies = computed.args.filter((arg) => 'field' in arg).map((arg) => (
      result.get(/** @type {{ field: string }} */ (arg).field)
    ));
    result.set(computed.as, dependencies.some((value) => !value)
      ? null : new Set(dependencies.flatMap((value) => [...(value ?? [])])));
  }
  return result;
}

/**
 * @param {RecordFieldLineage} fields
 * @param {import('./declarative.js').DashboardQuery} definition
 */
function selectedRecordLineage(fields, definition) {
  const computed = computedRecordLineage(fields, definition);
  return definition.select
    ? new Map(definition.select.map((field) => [field.as ?? field.field, computed.get(field.field) ?? null]))
    : computed;
}

/**
 * Plan raw tuple-key selection by tracing a row-local declarative graph. Never
 * invert computed labels: evaluate their original expressions on index tuples.
 * @param {Map<string, import('./declarative.js').DashboardQuery>} index
 * @param {import('./declarative.js').DashboardQuery} definition
 */
function indexedRecordKeySelectionPlan(index, definition) {
  /** @type {import('./declarative.js').DashboardQuery[]} */
  const queries = [];
  let current = definition;
  const seen = new Set();
  while (true) {
    if (seen.has(current.name) || current.aggregate || current.joins?.length || current.union?.length
        || current['temporal-series'] || current.predict?.length || current.window?.length
        || (queries.length > 0 && (current['order-by']?.length || current.limit !== undefined))) return null;
    seen.add(current.name);
    queries.unshift(current);
    const parent = index.get(current.from);
    if (!parent) break;
    current = parent;
  }
  const source = current.from;
  const projection = RUN_RECORD_STORES.has(source) ? undefined : databaseQueryIndex.get(source);
  const stores = RUN_RECORD_STORES.has(source) ? [source]
    : (projection?.stores ?? []).filter((store) => RUN_RECORD_STORES.has(store));
  if (stores.length !== 1 || (projection && (
    projection.from !== 'run-records' || projection.joins?.length || projection.aggregate
    || projection.union?.length || projection['temporal-series'] || projection.predict?.length || projection.window?.length
  ))) return null;
  const store = /** @type {typeof import('../storage/indexeddb.js').ENTITY_STORES[number]} */ (stores[0]);
  /** @type {Set<string>} */
  const rawFields = new Set([
    ...(RUN_RECORD_PROJECTION?.select ?? []).map((field) => field.field),
    ...(RUN_RECORD_PROJECTION?.compute ?? []).flatMap((computed) => computed.args.flatMap((arg) => (
      'field' in arg ? [arg.field] : []
    )))
  ]);
  /** @type {RecordFieldLineage} */
  const canonical = new Map([...rawFields].map((field) => [field, new Set([field])]));
  for (const field of RECORD_RUN_FIELDS) canonical.set(field, null);
  const recordFields = selectedRecordLineage(canonical, RUN_RECORD_PROJECTION ?? { name: '', from: '' });
  /** @type {Array<{ definition: import('./declarative.js').DashboardQuery, fields: RecordFieldLineage }>} */
  const stages = [];
  let fields = recordFields;
  if (projection) {
    stages.push({ definition: projection, fields });
    fields = selectedRecordLineage(fields, projection);
  }
  for (const query of queries) {
    stages.push({ definition: query, fields });
    fields = selectedRecordLineage(fields, query);
  }
  const scope = stages[stages.length - 1];
  const candidates = Object.keys(CANONICAL_DATABASE_SCHEMA[store].indexes)
    .filter((name) => Object.hasOwn(CANONICAL_QUERY_INDEX_FIELDS, name))
    .map((indexName) => ({
      indexName, covered: new Set(CANONICAL_QUERY_INDEX_FIELDS[indexName])
    }));
  const candidate = candidates.filter(({ covered }) => scope.definition.filter?.predicates?.some((predicate) => {
    const lineage = scope.fields.get(predicate.field);
    return lineage && [...lineage].every((field) => covered.has(field));
  })).sort((left, right) => {
    const score = (/** @type {Set<string>} */ covered) => stages.reduce((total, stage) => total + (
      stage.definition.filter?.predicates?.filter((predicate) => {
        const fields = stage.fields.get(predicate.field);
        return fields && [...fields].every((field) => covered.has(field));
      }).length ?? 0
    ), 0);
    return score(right.covered) - score(left.covered);
  })[0];
  if (!candidate) return null;
  const used = new Set(stages.flatMap(({ definition: stage }) => [
    ...(stage.compute ?? []).map((computed) => computed.as),
    ...(stage.select ?? []).map((field) => field.as ?? field.field)
  ]));
  let keyField = '_native-index-key';
  while (used.has(keyField)) keyField += '-value';
  const pruned = stages.map(({ definition: stage, fields: lineage }) => {
    const predicates = stage.filter?.predicates?.filter((predicate) => {
      const fields = lineage.get(predicate.field);
      return fields && [...fields].every((field) => candidate.covered.has(field));
    }) ?? [];
    return {
      ...stage,
      filter: predicates.length > 0 ? { predicates } : undefined,
      select: stage.select ? [...stage.select, { field: keyField }] : undefined,
      'order-by': undefined, limit: undefined
    };
  });
  return {
    source, store, indexName: candidate.indexName, keyField, queries,
    projection: projection ? pruned[0] : undefined,
    keyQueries: projection ? pruned.slice(1) : pruned
  };
}

/**
 * Fuse only row-local ancestors with their selection, retaining one shared
 * budget. Sorting and limiting still operate once on the complete result.
 * @param {import('./declarative.js').DashboardQuery[]} queries
 * @param {Record<string, import('../../presenter.js').LogicalSourceInput>} inputs
 * @param {string} name
 * @param {import('./declarative.js').QueryBudget} budget
 */
function executeRowLocalRecordGraph(queries, inputs, name, budget) {
  const source = queries[0].from;
  const input = inputs[source];
  const final = queries[queries.length - 1];
  const rowLocal = queries.map((query) => ({ ...query, 'order-by': undefined, limit: undefined }));
  /** @type {import('../../presenter.js').LogicalSourceInput | undefined} */
  let result;
  /** @type {Record<string, unknown>[]} */
  const rows = [];
  const batchSize = Math.min(1000, DASHBOARD_QUERY_LIMITS['max-output-rows']);
  for (let offset = 0; offset < Math.max(1, input.rows.length); offset += batchSize) {
    result = executeDashboardQueries(rowLocal, {
      [source]: { ...input, rows: input.rows.slice(offset, offset + batchSize) }
    }, [name], { budget })[name];
    if (result.metadata.availability === 'unavailable') return result;
    for (const row of result.rows) rows.push(row);
  }
  if (!result) throw new Error('Native row-local selection produced no result');
  return executeDashboardQueries([{
    name, from: '$native-selected-records',
    'order-by': final['order-by'], limit: final.limit
  }], { '$native-selected-records': { ...result, rows } }, [name], { budget })[name];
}

/**
 * Filter-only ancestors can be pushed down without changing the order of
 * joins, computation, or aggregation. Other chains remain canonical.
 * @param {Map<string, import('./declarative.js').DashboardQuery>} index
 * @param {import('./declarative.js').DashboardQuery} definition
 * @param {Set<string>} [seen]
 * @returns {import('./declarative.js').DashboardQuery | null}
 */
function flattenIndexedRecordQuery(index, definition, seen = new Set()) {
  if (RUN_RECORD_STORES.has(definition.from)) return definition;
  if (seen.has(definition.name)) return null;
  seen.add(definition.name);
  const parent = index.get(definition.from);
  if (!parent) return null;
  const flattened = flattenIndexedRecordQuery(index, parent, seen);
  if (!flattened || Object.keys(flattened).some((key) => (
    !['name', 'subject', 'objective', 'acceptance', 'description', 'from', 'filter'].includes(key)
  )) || flattened.filter?.search || definition.filter?.search) return null;
  const predicates = [...(flattened.filter?.predicates ?? []), ...(definition.filter?.predicates ?? [])];
  return {
    ...definition, from: flattened.from,
    ...(predicates.length ? { filter: { predicates } } : {})
  };
}

/**
 * Prove that native index groups are a lossless weighted input to an aggregate.
 * Run-owned identifiers come from the shared canonical projection. Joins retain
 * their declarative uniqueness checks; distinct event counts cannot cross joins.
 * @param {import('./declarative.js').DashboardQuery} definition
 */
function indexedRecordAggregatePlan(definition) {
  const sources = [definition.from, ...(definition.union ?? [])];
  if (sources.some((source) => !RUN_RECORD_STORES.has(source))
      || definition.compute?.length || definition['temporal-series']
      || definition.predict?.length || definition.window?.length || definition.filter?.search) return null;
  const values = definition.aggregate?.values;
  if (!Array.isArray(values) || values.length === 0) return null;
  if (!definition.aggregate?.by?.length && !definition.filter && !definition.union?.length
      && !definition.joins?.length && !definition.select?.length
      && !definition['order-by']?.length && definition.limit === undefined
      && values.every((value) => (
        value.field === CANONICAL_DATABASE_SCHEMA[definition.from].keyPath
        && value.reducer === 'count' && !value.filter
      ))) return null;
  const joinedFields = new Set((definition.joins ?? []).flatMap((join) => (
    join.fields.map((field) => field.as ?? field.field)
  )));
  if ([...joinedFields].some((field) => RECORD_PROJECTED_FIELDS.has(field))) return null;
  const identityValues = values.filter((value) => ['id', 'event'].includes(value.field));
  if (identityValues.length === 0
      || values.some((value) => (
        !['count', 'distinct-count'].includes(value.reducer)
        || (value.reducer === 'count' && !['id', 'event'].includes(value.field))
        || (value.reducer === 'distinct-count' && ['id', 'event'].includes(value.field)
          && (definition.joins?.length || definition.union?.length))
      ))) return null;
  const predicates = [
    ...(definition.filter?.predicates ?? []),
    ...values.flatMap((value) => value.filter?.predicates ?? [])
  ];
  const fields = new Set([
    ...(definition.aggregate?.by ?? []),
    ...predicates.map((predicate) => predicate.field),
    ...(definition.joins ?? []).flatMap((join) => join.on.map((pair) => pair.left)),
    ...values.filter((value) => !['id', 'event'].includes(value.field)).map((value) => value.field)
  ]);
  const recordFields = [...fields].filter((field) => !RECORD_RUN_FIELDS.has(field) && !joinedFields.has(field));
  if (recordFields.length === 0) return { index: 'byRun' };
  if (recordFields.some((field) => (
    !['event-type', 'event-status', 'event-summary'].includes(field)
  )) || sources.some((source) => (
    !CANONICAL_DATABASE_SCHEMA[source].indexes.byTypeStatusRunSummary
  ))) return null;
  // Prefix indexes omit absent type/status keys. Require mandatory selection
  // of both dimensions so omitted records provably cannot match this query.
  const selected = ['event-type', 'event-status'].map((field) => (
    definition.filter?.predicates?.find((predicate) => (
      predicate.field === field && !predicate.optional
      && (typeof predicate.equals === 'string'
        || (Array.isArray(predicate.in) && predicate.in.length > 0
          && predicate.in.every((value) => typeof value === 'string')))
    ))
  ));
  if (selected.some((predicate) => !predicate)) return null;
  // The canonical projection renames firewall types. Do not approximate that
  // computed field with the raw index when those renamed values are selected.
  const types = selected[0]?.in ?? [selected[0]?.equals];
  if (types.some((value) => ['firewall.request.allowed', 'firewall.request.blocked', 'unknown'].includes(String(value)))
      || selected[1]?.equals === 'unknown' || selected[1]?.in?.includes('unknown')) return null;
  return {
    index: 'byTypeStatusRun',
    nullableIndex: 'byTypeStatusRunSummary',
    predicates: selected.filter((predicate) => predicate !== undefined).map((predicate) => ({
      ...predicate,
      field: predicate.field === 'event-type' ? 'type' : 'status'
    }))
  };
}

const RUN_QUERY_FIELDS = new Map([
  ['run-conclusion', 'conclusion'],
  ['started-at', 'startedAt'],
  ['event', 'event']
]);
/** Canonical run key paths the storage layer can resolve through an index. */
const QUERYABLE_RUN_KEY_PATHS = new Set(['conclusion', 'event']);
/**
 * Fields a count aggregate may reduce while reading candidates from storage.
 * Every entry is produced by the `runs` projection without the workflow join,
 * so a pushed-down read can never change what the aggregate counts.
 */
const COUNTABLE_RUN_FIELDS = new Set(['id', 'run', ...RUN_QUERY_FIELDS.keys()]);

/**
 * Flattens query chains whose ancestors add only a run filter. This preserves
 * IndexedDB predicate pushdown for generated base queries while leaving general
 * query composition to the declarative engine.
 *
 * @param {Map<string, Record<string, any>>} index
 * @param {Record<string, any>} definition
 * @param {Set<string>} [seen]
 * @returns {Record<string, any> | null}
 */
function flattenIndexedRunQuery(index, definition, seen = new Set()) {
  if (definition.from === 'runs') return definition;
  if (seen.has(definition.name)) return null;
  const parent = index.get(definition.from);
  if (!parent) return null;
  seen.add(definition.name);
  /** @type {Record<string, any> | null} */
  const flattenedParent = flattenIndexedRunQuery(index, parent, seen);
  if (!flattenedParent) return null;
  const operationalParentKeys = Object.keys(flattenedParent)
    .filter((key) => !['name', 'subject', 'objective', 'acceptance', 'description', 'from', 'filter'].includes(key));
  if (operationalParentKeys.length > 0 || (flattenedParent.filter && definition.filter)) return null;
  return {
    ...definition,
    from: flattenedParent.from,
    ...(flattenedParent.filter ? { filter: flattenedParent.filter } : {})
  };
}

/** @param {Record<string, any>} definition */
function indexedRunOperators(definition) {
  if (definition.from !== 'runs'
      || definition.union?.length
      || definition.joins?.length
      || definition.compute?.length
      || definition.aggregate
      || definition['temporal-series']
      || definition.predict?.length || definition.window?.length
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

/**
 * Plans an IndexedDB candidate read for counting queries whose predicates are
 * all indexable run fields, so declarative count aggregates over `runs` read
 * only matching records instead of the whole collection. The declarative
 * engine still executes the query itself; this only narrows what it reads.
 *
 * @param {Record<string, any>} definition
 */
function indexedRunAggregateOperators(definition) {
  if (definition.from !== 'runs'
      || definition.union?.length
      || definition.joins?.length
      || definition.compute?.length
      || definition['temporal-series']
      || definition.predict?.length || definition.window?.length
      || definition.select?.length
      || definition['order-by']?.length
      || definition.limit !== undefined
      || definition.filter?.search) return null;
  const values = definition.aggregate?.values;
  if (!Array.isArray(values) || values.length === 0) return null;
  const groupedBy = definition.aggregate?.by ?? [];
  if (!Array.isArray(groupedBy) || groupedBy.some((field) => !RUN_QUERY_FIELDS.has(field))) return null;
  const valuePredicates = values.flatMap((value) => {
    if (value?.reducer !== 'count') return [null];
    if (value.field !== undefined && !COUNTABLE_RUN_FIELDS.has(value.field)) return [null];
    const predicates = value.filter?.predicates;
    if (value.filter && (value.filter.search || !Array.isArray(predicates))) return [null];
    return predicates ?? [];
  });
  if (valuePredicates.some((predicate) => (
    !predicate || !RUN_QUERY_FIELDS.has(predicate.field)
  ))) return null;
  const predicates = definition.filter?.predicates;
  if (!Array.isArray(predicates)
      || predicates.length === 0
      || predicates.some((predicate) => !RUN_QUERY_FIELDS.has(predicate.field))
      || !predicates.some((predicate) => (
        QUERYABLE_RUN_KEY_PATHS.has(String(RUN_QUERY_FIELDS.get(predicate.field)))
      ))) return null;
  return [{
    op: /** @type {const} */ ('filter'),
    predicates: predicates.map((predicate) => ({
      ...predicate,
      field: RUN_QUERY_FIELDS.get(predicate.field)
    }))
  }];
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

/** @param {IDBFactory} indexedDB @param {Record<string, unknown>} sources */
async function withProjectionClock(indexedDB, sources) {
  if (typeof sources['$projection-clock'] === 'string') return sources;
  const transaction = await readRecord(indexedDB, 'transactions', 'projection-clock');
  return typeof transaction?.sourceClock === 'string'
    ? { ...sources, '$projection-clock': transaction.sourceClock } : sources;
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
  const databaseRequested = [...requested].filter((name) => (
    !Object.hasOwn(SYNTHETIC_SOURCE_FIELDS, name)
    && (DATABASE_TABLE_SOURCES.has(name) || !hasUsableRows(logicalSources[name]))
  ));
  const stores = [...new Set(databaseRequested.flatMap(queryStores))];
  if (stores.length > 0) logicalSources = await withProjectionClock(indexedDB, logicalSources);
  const transactionRequested = stores.includes('transactions');
  const collectionStores = /** @type {Array<typeof import('../storage/indexeddb.js').ENTITY_STORES[number]>} */ (
    stores.filter((name) => name !== 'transactions')
  );
  const databaseStartedAt = monotonicNow();
  /** @type {[Record<string, Record<string, unknown>[]>, Record<string, unknown>[]]} */
  const [collections, transactions] = await Promise.all([
    collectionStores.length > 0 ? readCollections(indexedDB, collectionStores) : {},
    transactionRequested ? readTransactions(indexedDB) : []
  ]);
  const databaseMs = monotonicNow() - databaseStartedAt;
  const sources = namedSources(logicalSources);
  /** @type {Record<string, import('../../presenter.js').LogicalSourceInput>} */
  const result = {};
  for (const name of requested) {
    if (name === SIMULATION_DAYS) {
      result[name] = simulationDaysSource();
      continue;
    }
    const logical = /** @type {import('../../presenter.js').LogicalSourceInput | undefined} */ (sources[name]);
    if (logical
        && !DATABASE_TABLE_SOURCES.has(name)
        && (!databaseQueryIndex.has(name) || hasUsableRows(logical))) {
      result[name] = logical;
      continue;
    }
    if (!databaseQueryIndex.has(name) && !RUN_RECORD_STORES.has(name)) {
      result[name] = logical ?? {
        source: name,
        rows: [],
        metadata: {
          ...queryMetadata(sources, name, name, Object.hasOwn(TABLE_FIELDS, name)),
          availability: Object.hasOwn(TABLE_FIELDS, name) ? 'empty' : 'unavailable'
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
      result[name] = executeDatabaseQuery(name, {
        'run-records': records,
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
  const recordsRead = Object.values(collections).reduce((total, records) => total + records.length, 0)
    + transactions.length;
  debugDatabase({
    event: 'query-sources-resolved',
    requestedCount: requested.size,
    databaseMs: Math.round(databaseMs),
    totalMs: Math.round(totalMs),
    recordsRead,
    storeCount: stores.length
  });
  options.onMetrics?.({
    databaseMs,
    projectionMs: Math.max(0, totalMs - databaseMs),
    totalMs,
    recordsRead,
    stores
  });
  return result;
}

/**
 * @param {IDBFactory} indexedDB
 * @param {Record<string, unknown>} sources
 * @param {{ ingest?: boolean, storage?: StorageManager, sourceNames?: string[], queries?: unknown[], signal?: AbortSignal, budget?: import('./declarative.js').QueryBudget }} [options]
 */
export async function loadDatabaseQuerySources(indexedDB, sources, options = {}) {
  if (options.ingest) await ingestDashboardSources(indexedDB, sources, { storage: options.storage, signal: options.signal });
  debugDatabase({ event: 'load-database-query-sources', ingested: Boolean(options.ingest), sourceCount: Object.keys(sources).length });
  const sourceNames = Array.isArray(options.sourceNames) ? options.sourceNames : Object.keys(sources);
  const queries = options.queries ?? [];
  const budget = options.budget ?? createDashboardQueryBudget({ signal: options.signal });
  const native = await queryIndexedDatabaseSources(
    indexedDB, sources, queries, resolveDashboardQuerySources(queries, sourceNames), { budget }
  );
  const nativeNames = new Set(Object.keys(native));
  const remaining = sourceNames.filter((name) => !nativeNames.has(name));
  const required = resolveDashboardQuerySources(queries, remaining, nativeNames)
    .filter((name) => !nativeNames.has(name));
  const database = await queryDatabaseSources(indexedDB, sources, required);
  return {
    ...namedSources(sources),
    ...database,
    ...native,
    ...executeDashboardQueries(queries, { ...database, ...native }, remaining, { budget })
  };
}
