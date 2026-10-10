import { createReadStream } from 'node:fs';
import { readFile, readdir, mkdir, mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createDebug } from '../debug.mjs';
import { createCachedJsonlPayloadHasher } from '../../dashboard/site/src/data/adapters/gh-aw-logs.js';
import { finalizeNormalizedJsonlIngestion, ingestCachedGhAwJsonl, ingestGhAwLogs, ingestNormalizedJsonl, isAuditCurationCurrent, isCachedGhAwJsonlCurrent } from '../../dashboard/site/src/data/ingest/coordinator.js';
import { createCanonicalQueries } from '../../dashboard/site/src/data/queries/index.js';
import { readCollection } from '../../dashboard/site/src/data/storage/indexeddb.js';
import { installSqliteIndexedDB } from '../../dashboard/site/src/data/storage/sqlite-indexeddb.js';
import { ENTITY_COLLECTIONS } from '../cli-usage.mjs';
import { jsonlFiles, hashFileContents } from './files.mjs';

const debug = createDebug('ingest');

export async function databaseCounts(indexedDB) {
  const counts = await Promise.all(ENTITY_COLLECTIONS.map(async (collection) => [
    collection,
    (await readCollection(indexedDB, collection)).length
  ]));
  return Object.fromEntries(counts);
}

export async function ingestGhAwLogDirectory(indexedDB, contextPath, logDirectory, options = {}) {
  const context = JSON.parse(await readFile(contextPath, 'utf8'));
  return ingestGhAwLogs(indexedDB, {
    ...context,
    files: await jsonlFiles(logDirectory)
  }, options);
}

/**
 * Ingests every `--cached-jsonl` wildcard shard file in a directory one by
 * one, using a payload scope derived from each shard's file name so the
 * transactions table can skip shards whose content hash was already
 * recorded instead of reprocessing the entire shard set on every run.
 *
 * Each shard's content hash is computed up front (a cheap byte-level hash,
 * not a JSONL parse) and checked against the transactions table via
 * `isCachedGhAwJsonlCurrent` *before* touching the adapter. Shards that are
 * already current are skipped without ever being parsed, so re-runs only
 * pay the parsing/normalization cost for shards that are new or changed.
 */
export async function ingestJsonlShardDirectory(indexedDB, shardDirectory, options = {}) {
  let shardNames = [];
  try {
    shardNames = (await readdir(shardDirectory))
      .filter((name) => name.endsWith('.jsonl'))
      .sort();
  } catch (error) {
    if (error && error.code === 'ENOENT') shardNames = [];
    else throw error;
  }
  const shards = [];
  const totals = {};
  let updated = false;
  let committedRecords = 0;
  debug('scanning shard directory %s (%d shard(s) found)', shardDirectory, shardNames.length);
  for (const name of shardNames) {
    const shardPath = path.join(shardDirectory, name);
    const scope = `gh-aw-jsonl:${name}`;
    const identityHasher = createCachedJsonlPayloadHasher();
    for await (const chunk of createReadStream(shardPath)) identityHasher.update(chunk);
    const payloadIdentity = identityHasher.digest();
    const current = await isCachedGhAwJsonlCurrent(indexedDB, { ...options, payloadIdentity, payloadScope: scope });
    if (current) {
      debug('skipping shard %s: content hash already recorded in transactions table', name);
      shards.push({ shard: name, skipped: true, committedRecords: 0 });
      continue;
    }
    debug('ingesting shard %s: content hash is new or changed', name);
    const result = await ingestCachedGhAwJsonl(indexedDB, createReadStream(shardPath), {
      ...options,
      payloadScope: scope,
      payloadIdentity
    });
    if (result.updated) updated = true;
    for (const [key, value] of Object.entries(result)) {
      if (typeof value === 'number' && key !== 'committedRecords') {
        totals[key] = (totals[key] ?? 0) + value;
      }
    }
    committedRecords += result.committedRecords ?? 0;
    debug('ingested shard %s: committedRecords=%d', name, result.committedRecords ?? 0);
    shards.push({ shard: name, skipped: Boolean(result.skipped), committedRecords: result.committedRecords ?? 0 });
  }
  if (!await isAuditCurationCurrent(indexedDB)) {
    const maintenance = await finalizeNormalizedJsonlIngestion(indexedDB, {
      ...options, repairAuditCuration: true
    });
    updated ||= maintenance.deletedRecords > 0;
  }
  return { ...totals, updated, committedRecords, shards };
}

export async function ingestNormalizedShardDirectories(indexedDB, directories, options = {}) {
  const shards = [];
  let updated = false;
  let committedRecords = 0;
  for (const [phase, directory] of directories) {
    const names = (await readdir(directory)).filter((name) => name.endsWith('.jsonl')).sort();
    debug('scanning normalized shard directory phase=%s directory=%s shards=%d', phase, directory, names.length);
    let phaseCommittedRecords = 0;
    const phaseStartedAt = Date.now();
    for (const [index, name] of names.entries()) {
      const shardPath = path.join(directory, name);
      const shardSize = (await stat(shardPath)).size;
      const shardStartedAt = Date.now();
      debug(
        'ingesting normalized shard phase=%s shard=%s progress=%d/%d sizeBytes=%d',
        phase,
        name,
        index + 1,
        names.length,
        shardSize
      );
      const payloadIdentity = await hashFileContents(shardPath);
      const result = await ingestNormalizedJsonl(
        indexedDB,
        createReadStream(shardPath),
        {
          ...options,
          deferMaintenance: true,
          expectedPhase: phase,
          payloadScope: `gh-aw-${phase}:${name}`,
          payloadIdentity
        }
      );
      updated ||= result.updated;
      committedRecords += result.committedRecords ?? 0;
      phaseCommittedRecords += result.committedRecords ?? 0;
      debug(
        'finished normalized shard phase=%s shard=%s skipped=%s committedRecords=%d durationMs=%d',
        phase,
        name,
        Boolean(result.skipped),
        result.committedRecords ?? 0,
        Date.now() - shardStartedAt
      );
      shards.push({ phase, shard: name, skipped: Boolean(result.skipped), committedRecords: result.committedRecords ?? 0 });
    }
    debug(
      'finished normalized shard phase=%s shards=%d committedRecords=%d durationMs=%d',
      phase,
      names.length,
      phaseCommittedRecords,
      Date.now() - phaseStartedAt
    );
  }
  const auditCurationCurrent = await isAuditCurationCurrent(indexedDB);
  if (updated || !auditCurationCurrent) {
    const maintenanceStartedAt = Date.now();
    const maintenance = await finalizeNormalizedJsonlIngestion(indexedDB, {
      ...options, repairAuditCuration: !updated && !auditCurationCurrent
    });
    updated ||= maintenance.deletedRecords > 0;
    debug('applied deferred canonical maintenance durationMs=%d', Date.now() - maintenanceStartedAt);
  }
  return { updated, committedRecords, shards };
}

export async function ingestJsonlFile(indexedDB, inputPath, options = {}) {
  return ingestCachedGhAwJsonl(indexedDB, createReadStream(inputPath), options);
}

export async function createDatabase(databasePath) {
  const filename = path.resolve(databasePath);
  await mkdir(path.dirname(filename), { recursive: true });
  return installSqliteIndexedDB(filename);
}

export async function runLegacyIngestion(contextPath, logDirectory) {
  const directory = await mkdtemp(path.join(tmpdir(), 'cao-dashboard-data-'));
  try {
    const indexedDB = await createDatabase(path.join(directory, 'dashboard.sqlite'));
    const result = await ingestGhAwLogDirectory(
      indexedDB,
      path.resolve(contextPath),
      path.resolve(logDirectory)
    );
    const queries = createCanonicalQueries(indexedDB);
    const runs = await queries.runs.list();
    const records = (await Promise.all(
      ['domains', 'tools', 'skills', 'friction', 'audits', 'issues'].map((collection) =>
        Promise.all(runs.map((run) => queries[collection].forRun(String(run.id)))))
    )).flat(2);
    return { result, runs, records };
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
