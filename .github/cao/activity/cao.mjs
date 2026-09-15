#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream, realpathSync } from 'node:fs';
import { readFile, readdir, mkdir, mkdtemp, rename, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { pathToFileURL } from 'node:url';
import { createDebug } from './debug.mjs';
import { adaptCachedGhAwJsonlStream, cachedJsonlPayloadIdentity } from '../dashboard/site/src/data/adapters/gh-aw-logs.js';
import { ingestCachedGhAwJsonl, ingestGhAwLogs, isCachedGhAwJsonlCurrent } from '../dashboard/site/src/data/ingest/coordinator.js';
import { normalize } from '../dashboard/site/src/data/normalize/index.js';
import { executeDashboardQuery, queryInputNames } from '../dashboard/site/src/data/queries/declarative.js';
import { createCanonicalQueries } from '../dashboard/site/src/data/queries/index.js';
import { readCollection, readRecord, readTransactions } from '../dashboard/site/src/data/storage/indexeddb.js';
import { doctorSqliteDatabase } from '../dashboard/site/src/data/storage/sqlite-doctor.js';
import { installSqliteIndexedDB } from '../dashboard/site/src/data/storage/sqlite-indexeddb.js';

const debug = createDebug('ingest');
const debugHash = createDebug('hash-payloads');

const ENTITY_COLLECTIONS = [
  'repositories',
  'workflows',
  'runs',
  'jobs',
  'sessions',
  'events'
];
const QUERY_COLLECTIONS = [...ENTITY_COLLECTIONS, 'transactions'];
const DEFAULT_DEPLOYED_DATA_URL = 'https://githubnext.github.io/gh-aw-cao/cao/gh-aw-logs.jsonl';
const DEFAULT_OUTPUT_DIRECTORY = '.cao';
const DEFAULT_LOGS_PATH = `${DEFAULT_OUTPUT_DIRECTORY}/gh-aw-logs.jsonl`;
const DEFAULT_DATABASE_PATH = `${DEFAULT_OUTPUT_DIRECTORY}/gh-aw-logs.sqlite`;
const DAY_MS = 24 * 60 * 60 * 1000;
const DEFAULT_ACTIVITY_STATS_WORKFLOW = 'cao-activity.yml';
const DEFAULT_ACTIVITY_STATS_ARTIFACT = 'cao-activity-index';
const DEFAULT_ACTIVITY_STATS_LIMIT = 5;
const COMMANDS = new Set(['ingest', 'ingest-jsonl', 'audit-jsonl', 'query', 'doctor', 'download', 'hash-payloads', 'activity-stats']);

const USAGE = `Usage:
  cao ingest [--database FILE] --context CONTEXT_JSON --logs LOG_DIRECTORY [--retention-days DAYS|all] [--run-retention-days DAYS|all]
  cao ingest-jsonl [--database FILE] [--input GH_AW_LOGS_JSONL | --input-dir SHARD_DIRECTORY] [--context CONTEXT_JSON] [--retention-days DAYS|all] [--run-retention-days DAYS|all]
  cao audit-jsonl [--input GH_AW_LOGS_JSONL]
  cao query [--database FILE] (--collection NAME [--id ID] [--where FIELD=VALUE] [--limit COUNT] | --stdin)
  cao doctor [--database FILE] [--ttl-days DAYS|all] [--run-ttl-days DAYS|all]
  cao download [--url URL] [--output DIRECTORY]
  cao hash-payloads [--input GH_AW_LOGS_JSONL] [--database FILE] [--shard-dir SHARD_DIRECTORY] [--output FILE]
  cao activity-stats [--repo OWNER/REPO] [--workflow FILE] [--artifact NAME] [--limit COUNT] [--keep] [--output FILE]

Collections: ${QUERY_COLLECTIONS.join(', ')}

Query stdin JSON:
  {"name":"failed-runs","from":"runs","filter":{"predicates":[{"field":"conclusion","equals":"failure"}]},"limit":20}

Download defaults:
  URL        DASHBOARD_DATA_URL or ${DEFAULT_DEPLOYED_DATA_URL}
  DIRECTORY  ${DEFAULT_OUTPUT_DIRECTORY}
  INPUT      ${DEFAULT_LOGS_PATH}
  DATABASE   ${DEFAULT_DATABASE_PATH}

Activity stats defaults (uses the "gh" CLI and requires GH_TOKEN):
  REPO      GITHUB_REPOSITORY
  WORKFLOW  ${DEFAULT_ACTIVITY_STATS_WORKFLOW}
  ARTIFACT  ${DEFAULT_ACTIVITY_STATS_ARTIFACT}
  LIMIT     ${DEFAULT_ACTIVITY_STATS_LIMIT}`;

async function jsonlFiles(root) {
  const files = [];
  const pending = [root];
  while (pending.length > 0) {
    const directory = pending.pop();
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      const candidate = path.join(directory, entry.name);
      if (entry.isDirectory()) pending.push(candidate);
      else if (entry.isFile() && entry.name.endsWith('.jsonl')) {
        files.push({
          path: path.relative(root, candidate).split(path.sep).join('/'),
          content: await readFile(candidate, 'utf8')
        });
      }
    }
  }
  return files.sort((left, right) => left.path.localeCompare(right.path));
}

function parseOptions(arguments_) {
  /** @type {Record<string, string | string[]>} */
  const options = {};
  for (let index = 0; index < arguments_.length; index += 1) {
    const argument = arguments_[index];
    if (!argument.startsWith('--')) throw new Error(`Unexpected argument: ${argument}`);
    const name = argument.slice(2);
    if (name === 'help' || name === 'stdin' || name === 'keep') {
      options[name] = 'true';
      continue;
    }
    const value = arguments_[index + 1];
    if (!value || value.startsWith('--')) throw new Error(`Missing value for --${name}`);
    index += 1;
    if (name === 'where') {
      const existing = options.where;
      options.where = [...(Array.isArray(existing) ? existing : []), value];
    } else if (options[name] !== undefined) {
      throw new Error(`Option --${name} may only be specified once`);
    } else {
      options[name] = value;
    }
  }
  return options;
}

async function rawQueryFromStdin(options, input) {
  for (const name of ['collection', 'id', 'where', 'limit']) {
    if (options[name] !== undefined) {
      throw new Error(`Option --${name} cannot be combined with --stdin`);
    }
  }

  let content = '';
  for await (const chunk of input) content += chunk;
  if (!content.trim()) throw new Error('--stdin requires a JSON object');

  let query;
  try {
    query = JSON.parse(content);
  } catch (error) {
    throw new Error(`Invalid query JSON from stdin: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!query || typeof query !== 'object' || Array.isArray(query)) {
    throw new Error('--stdin requires a JSON object');
  }
  if (typeof query.name !== 'string' || typeof query.from !== 'string') {
    throw new Error('--stdin query requires string fields "name" and "from"');
  }
  return query;
}

function option(options, name, required = true) {
  const value = options[name];
  if (Array.isArray(value)) throw new Error(`Option --${name} may only be specified once`);
  if (required && !value) throw new Error(`Missing required option --${name}`);
  return value;
}

function rejectUnknownOptions(options, allowed) {
  for (const name of Object.keys(options)) {
    if (!allowed.includes(name)) throw new Error(`Unknown option --${name}`);
  }
}

function fieldValue(record, field) {
  return field.split('.').reduce((value, part) => (
    value && typeof value === 'object'
      ? /** @type {Record<string, unknown>} */ (value)[part]
      : undefined
  ), record);
}

function filters(options) {
  const values = options.where;
  if (!values) return [];
  return (Array.isArray(values) ? values : [values]).map((filter) => {
    const separator = filter.indexOf('=');
    if (separator < 1) throw new Error(`Invalid --where value: ${filter}`);
    return {
      field: filter.slice(0, separator),
      value: filter.slice(separator + 1)
    };
  });
}

function queryLimit(options) {
  const value = option(options, 'limit', false);
  if (!value) return undefined;
  const limit = Number(value);
  if (!Number.isInteger(limit) || limit < 1) throw new Error('--limit must be a positive integer');
  return limit;
}

function ttlDays(options) {
  const value = option(options, 'ttl-days', false);
  if (!value) return undefined;
  if (value === 'all') return 'all';
  const days = Number(value);
  if (!Number.isFinite(days) || days <= 0) throw new Error('--ttl-days must be a positive number or all');
  return days;
}

function retentionWindowMs(options) {
  const value = option(options, 'retention-days', false);
  if (!value) return undefined;
  if (value === 'all') return Number.MAX_SAFE_INTEGER;
  const days = Number(value);
  const milliseconds = days * DAY_MS;
  if (!Number.isFinite(days) || days <= 0 || !Number.isSafeInteger(milliseconds)) {
    throw new Error('--retention-days must be a positive number or all');
  }
  return milliseconds;
}

function runRetentionWindowMs(options) {
  const value = option(options, 'run-retention-days', false);
  if (!value) return undefined;
  if (value === 'all') return Number.MAX_SAFE_INTEGER;
  const days = Number(value);
  const milliseconds = days * DAY_MS;
  if (!Number.isFinite(days) || days <= 0 || !Number.isSafeInteger(milliseconds)) {
    throw new Error('--run-retention-days must be a positive number or all');
  }
  return milliseconds;
}

function runTtlDays(options) {
  const value = option(options, 'run-ttl-days', false);
  if (!value) return undefined;
  if (value === 'all') return 'all';
  const days = Number(value);
  if (!Number.isFinite(days) || days <= 0) {
    throw new Error('--run-ttl-days must be a positive number or all');
  }
  return days;
}

async function databaseCounts(indexedDB) {
  const counts = await Promise.all(ENTITY_COLLECTIONS.map(async (collection) => [
    collection,
    (await readCollection(indexedDB, collection)).length
  ]));
  return Object.fromEntries(counts);
}

async function auditJsonl(inputPath) {
  const input = path.resolve(inputPath);
  const adapted = await adaptCachedGhAwJsonlStream(createReadStream(input));
  const canonical = normalize(adapted.observations);
  return {
    command: 'audit-jsonl',
    input,
    source: {
      records: adapted.records,
      rawRunObservations: adapted.rawPayloadRecords,
      uniqueRawRuns: adapted.rawRuns,
      duplicateRawRunObservations: adapted.duplicateRawRunObservations,
      enrichedRunObservations: adapted.agenticRunRecords,
      uniqueEnrichedRuns: adapted.agenticRuns,
      duplicateEnrichedRunObservations: adapted.duplicateAgenticRunObservations,
      unenrichedRuns: adapted.unenrichedRuns,
      enrichmentCoveragePercent: canonical.runs.length === 0
        ? 0
        : Number((adapted.agenticRuns / canonical.runs.length * 100).toFixed(1))
    },
    canonical: Object.fromEntries(ENTITY_COLLECTIONS.map((collection) => [
      collection,
      canonical[collection].length
    ]))
  };
}

function deployedDataUrl(value) {
  const url = new URL(value);
  if (!['http:', 'https:'].includes(url.protocol)) {
    throw new Error('Dashboard data URL must use HTTP or HTTPS.');
  }
  if (url.username || url.password) {
    throw new Error('Dashboard data URL must not contain credentials.');
  }
  return url;
}

async function downloadFile(url, destination) {
  const response = await fetch(url, {
    headers: { accept: 'application/x-ndjson, application/json, text/plain' },
    redirect: 'follow',
    signal: AbortSignal.timeout(120_000)
  });
  if (!response.ok) throw new Error(`Unable to download ${url}: HTTP ${response.status}`);
  if (!response.body) throw new Error(`Unable to download ${url}: response body is empty`);
  await pipeline(Readable.fromWeb(response.body), createWriteStream(destination, { flags: 'wx' }));
  if ((await stat(destination)).size === 0) {
    throw new Error(`Unable to download ${url}: response body is empty`);
  }
}

async function replaceFile(source, destination) {
  await rm(destination, { force: true });
  await rename(source, destination);
}

export async function downloadDeployedDashboardData({
  url = process.env.DASHBOARD_DATA_URL || DEFAULT_DEPLOYED_DATA_URL,
  output = DEFAULT_OUTPUT_DIRECTORY
} = {}) {
  const logsUrl = deployedDataUrl(url);
  const databaseUrl = new URL('gh-aw-logs.sqlite', logsUrl);
  const outputDirectory = path.resolve(output);
  await mkdir(outputDirectory, { recursive: true });
  const temporaryDirectory = await mkdtemp(path.join(outputDirectory, '.deployed-dashboard-'));
  const temporaryLogs = path.join(temporaryDirectory, 'gh-aw-logs.jsonl');
  const temporaryDatabase = path.join(temporaryDirectory, 'gh-aw-logs.sqlite');
  const logsPath = path.join(outputDirectory, 'gh-aw-logs.jsonl');
  const databasePath = path.join(outputDirectory, 'gh-aw-logs.sqlite');

  try {
    await Promise.all([
      downloadFile(logsUrl, temporaryLogs),
      downloadFile(databaseUrl, temporaryDatabase)
    ]);
    await replaceFile(temporaryLogs, logsPath);
    await replaceFile(temporaryDatabase, databasePath);
    return {
      logsUrl: logsUrl.href,
      databaseUrl: databaseUrl.href,
      logs: logsPath,
      database: databasePath
    };
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
}

export async function ingestGhAwLogDirectory(indexedDB, contextPath, logDirectory, options = {}) {
  const context = JSON.parse(await readFile(contextPath, 'utf8'));
  return ingestGhAwLogs(indexedDB, {
    ...context,
    files: await jsonlFiles(logDirectory)
  }, options);
}

/**
 * Ingests every `--cached-logs` wildcard shard file in a directory one by
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
async function ingestJsonlShardDirectory(indexedDB, shardDirectory, options = {}) {
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
  let updated = false;
  let committedRecords = 0;
  debug('scanning shard directory %s (%d shard(s) found)', shardDirectory, shardNames.length);
  for (const name of shardNames) {
    const shardPath = path.join(shardDirectory, name);
    const scope = `gh-aw-jsonl:${name}`;
    const content = await readFile(shardPath);
    const payloadIdentity = cachedJsonlPayloadIdentity(content);
    const current = await isCachedGhAwJsonlCurrent(indexedDB, {
      payloadIdentity,
      payloadScope: scope,
      context: options.context,
      workflowHints: options.workflowHints
    });
    if (current) {
      debug('skipping shard %s: content hash already recorded in transactions table', name);
      shards.push({ shard: name, skipped: true, committedRecords: 0 });
      continue;
    }
    debug('ingesting shard %s: content hash is new or changed', name);
    const result = await ingestCachedGhAwJsonl(indexedDB, content, {
      ...options,
      payloadScope: scope,
      payloadIdentity
    });
    if (result.updated) updated = true;
    committedRecords += result.committedRecords ?? 0;
    debug('ingested shard %s: committedRecords=%d', name, result.committedRecords ?? 0);
    shards.push({ shard: name, skipped: Boolean(result.skipped), committedRecords: result.committedRecords ?? 0 });
  }
  return { updated, committedRecords, shards };
}

/**
 * Computes SHA-256 checksums for the activity snapshot payloads: the
 * consolidated JSONL file, the SQLite projection, and every retained
 * `--cached-logs` wildcard shard file. Missing files are tolerated (an
 * absent shard directory yields no shard entries) so this can run
 * immediately after ingestion in the same workflow step.
 */
async function hashActivityPayloads({ jsonlPath, databasePath, shardDirectory }) {
  const hashFile = async (filePath) => {
    const hash = createHash('sha256');
    for await (const chunk of createReadStream(filePath)) hash.update(chunk);
    const digest = hash.digest('hex');
    debugHash('hashed %s -> %s', filePath, digest);
    return digest;
  };
  const hashes = {};
  if (jsonlPath) hashes[path.basename(jsonlPath)] = await hashFile(jsonlPath);
  if (databasePath) hashes[path.basename(databasePath)] = await hashFile(databasePath);
  if (shardDirectory) {
    let shardNames = [];
    try {
      shardNames = (await readdir(shardDirectory)).filter((name) => name.endsWith('.jsonl')).sort();
    } catch (error) {
      if (!(error && error.code === 'ENOENT')) throw error;
    }
    debugHash('hashing %d shard(s) in %s', shardNames.length, shardDirectory);
    for (const name of shardNames) {
      hashes[`${path.basename(shardDirectory)}/${name}`] = await hashFile(path.join(shardDirectory, name));
    }
  }
  return hashes;
}

async function fileSizeStats(filePath) {
  try {
    const info = await stat(filePath);
    return { path: filePath, exists: true, sizeBytes: info.size };
  } catch (error) {
    if (error && error.code === 'ENOENT') return { path: filePath, exists: false, sizeBytes: 0 };
    throw error;
  }
}

async function shardSizeStats(shardDirectory) {
  let names = [];
  try {
    names = (await readdir(shardDirectory)).filter((name) => name.endsWith('.jsonl')).sort();
  } catch (error) {
    if (error && error.code === 'ENOENT') return [];
    throw error;
  }
  return Promise.all(names.map(async (name) => {
    const info = await stat(path.join(shardDirectory, name));
    return { name, sizeBytes: info.size };
  }));
}

async function hashFileNames(hashesPath) {
  let content;
  try {
    content = JSON.parse(await readFile(hashesPath, 'utf8'));
  } catch (error) {
    if (error && (error.code === 'ENOENT' || error instanceof SyntaxError)) return [];
    throw error;
  }
  if (!content || typeof content !== 'object' || Array.isArray(content)) return [];
  return Object.keys(content).sort();
}

/**
 * Downloads the `cao-activity-index` artifact for a single workflow run
 * (via `gh run download`) into a throwaway directory, times the download,
 * and reports the size of the consolidated JSONL/SQLite payloads, the
 * retained wildcard shard files, and the recorded payload hash files.
 * When the JSONL payload is non-empty it is also run through
 * `auditJsonl` so the raw/duplicate run-observation counts already used
 * by `cao audit-jsonl` are available per inspected run.
 */
async function inspectActivityRun(repo, run, artifact, execute, keep) {
  const runId = String(run.databaseId ?? run.id ?? '');
  const stats = {
    runId,
    status: run.status ?? null,
    conclusion: run.conclusion ?? null,
    createdAt: run.createdAt ?? null,
    updatedAt: run.updatedAt ?? null,
    url: run.url ?? null
  };
  if (!runId) {
    stats.error = 'Run is missing a database id';
    return stats;
  }
  const directory = await mkdtemp(path.join(tmpdir(), 'cao-activity-stats-'));
  try {
    const started = Date.now();
    const download = execute('gh', [
      'run', 'download', runId,
      '--repo', repo,
      '--name', artifact,
      '--dir', directory
    ], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
    stats.downloadDurationMs = Date.now() - started;
    if (download.error || download.status !== 0) {
      stats.error = (download.stderr || '').trim() || download.error?.message || 'gh run download failed';
      return stats;
    }
    const jsonlPath = path.join(directory, 'gh-aw-logs.jsonl');
    stats.jsonl = await fileSizeStats(jsonlPath);
    stats.sqlite = await fileSizeStats(path.join(directory, 'gh-aw-logs.sqlite'));
    stats.shards = await shardSizeStats(path.join(directory, 'gh-aw-logs-shards'));
    stats.hashFiles = await hashFileNames(path.join(directory, 'payload-hashes.json'));
    if (stats.jsonl.exists && stats.jsonl.sizeBytes > 0) {
      const audit = await auditJsonl(jsonlPath);
      stats.uniqueRuns = audit.source.uniqueRawRuns;
      stats.duplicateRunObservations = audit.source.duplicateRawRunObservations;
      stats.rawRunObservations = audit.source.rawRunObservations;
    }
    if (keep) stats.directory = directory;
    return stats;
  } finally {
    if (!keep) await rm(directory, { recursive: true, force: true });
  }
}

/**
 * Investigates the performance and health of recent `cao-activity.yml`
 * workflow runs: for each of the most recent runs, the `cao-activity-index`
 * artifact is downloaded via the `gh` CLI and inspected for download
 * duration, JSONL/SQLite payload sizes, retained shard files, recorded
 * payload hash files, and raw/duplicate run-observation counts. Intended
 * to be run as `cao activity-stats` so an agent investigating indexing
 * performance can consume a single JSON report.
 */
export async function activityWorkflowStats({
  repo = process.env.GITHUB_REPOSITORY,
  workflow = DEFAULT_ACTIVITY_STATS_WORKFLOW,
  artifact = DEFAULT_ACTIVITY_STATS_ARTIFACT,
  limit = DEFAULT_ACTIVITY_STATS_LIMIT,
  keep = false
} = {}, execute = spawnSync) {
  if (!repo) throw new Error('Missing required option --repo (or GITHUB_REPOSITORY environment variable)');
  const limitCount = Number(limit);
  if (!Number.isInteger(limitCount) || limitCount < 1) throw new Error('--limit must be a positive integer');

  const list = execute('gh', [
    'run', 'list',
    '--repo', repo,
    '--workflow', workflow,
    '--json', 'databaseId,status,conclusion,createdAt,updatedAt,url',
    '--limit', String(limitCount)
  ], { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
  if (list.error || list.status !== 0) {
    throw new Error(`Unable to list runs for ${workflow}: ${(list.stderr || '').trim() || list.error?.message || 'unknown error'}`);
  }
  let runs;
  try {
    runs = JSON.parse(list.stdout || '[]');
  } catch (error) {
    throw new Error(`Unable to parse "gh run list" output: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!Array.isArray(runs)) throw new Error('Unable to parse "gh run list" output: expected a JSON array');

  const runStats = [];
  for (const run of runs) {
    runStats.push(await inspectActivityRun(repo, run, artifact, execute, keep));
  }

  const withArtifact = runStats.filter((entry) => !entry.error);
  const summary = {
    repository: repo,
    workflow,
    artifact,
    runsInspected: runStats.length,
    runsWithArtifact: withArtifact.length,
    runsMissingArtifact: runStats.length - withArtifact.length,
    totalDownloadDurationMs: runStats.reduce((sum, entry) => sum + (entry.downloadDurationMs || 0), 0),
    averageDownloadDurationMs: withArtifact.length === 0
      ? 0
      : Math.round(withArtifact.reduce((sum, entry) => sum + (entry.downloadDurationMs || 0), 0) / withArtifact.length),
    totalJsonlBytes: withArtifact.reduce((sum, entry) => sum + (entry.jsonl?.sizeBytes || 0), 0),
    totalSqliteBytes: withArtifact.reduce((sum, entry) => sum + (entry.sqlite?.sizeBytes || 0), 0),
    totalShardFiles: withArtifact.reduce((sum, entry) => sum + (entry.shards?.length || 0), 0),
    totalHashFiles: withArtifact.reduce((sum, entry) => sum + (entry.hashFiles?.length || 0), 0),
    totalUniqueRuns: withArtifact.reduce((sum, entry) => sum + (entry.uniqueRuns || 0), 0),
    totalDuplicateRunObservations: withArtifact.reduce((sum, entry) => sum + (entry.duplicateRunObservations || 0), 0)
  };

  return { command: 'activity-stats', summary, runs: runStats };
}

export async function queryCanonicalData(indexedDB, options) {
  const collection = option(options, 'collection');
  if (!QUERY_COLLECTIONS.includes(collection)) {
    throw new Error(`Unknown collection: ${collection}`);
  }

  const id = option(options, 'id', false);
  let records;
  if (id && collection !== 'transactions') {
    const record = await readRecord(indexedDB, collection, id);
    records = record ? [record] : [];
  } else {
    records = collection === 'transactions'
      ? await readTransactions(indexedDB)
      : await readCollection(indexedDB, collection);
    if (id) records = records.filter((record) => record.id === id);
  }

  for (const filter of filters(options)) {
    records = records.filter((record) => String(fieldValue(record, filter.field)) === filter.value);
  }
  const limit = queryLimit(options);
  return limit ? records.slice(0, limit) : records;
}

async function queryRawCanonicalData(indexedDB, query) {
  const inputNames = queryInputNames(query);
  const unknown = inputNames.find((name) => !QUERY_COLLECTIONS.includes(name));
  if (unknown) throw new Error(`Unknown collection: ${unknown}`);
  const sources = Object.fromEntries(await Promise.all(inputNames.map(async (name) => [
    name,
    {
      source: name,
      rows: name === 'transactions'
        ? await readTransactions(indexedDB)
        : await readCollection(indexedDB, name),
      metadata: {
        'source-id': name,
        'source-kind': 'canonical-query',
        availability: 'available',
        completeness: 'complete',
        freshness: 'unknown'
      }
    }
  ])));
  const time = console.time;
  const timeEnd = console.timeEnd;
  let rows;
  try {
    console.time = () => {};
    console.timeEnd = () => {};
    const result = executeDashboardQuery(query, sources);
    if (result.metadata?.availability === 'unavailable') {
      throw new Error(String(result.metadata['query-diagnostic'] ?? 'Query is unavailable'));
    }
    rows = result.rows;
  } finally {
    console.time = time;
    console.timeEnd = timeEnd;
  }
  return rows;
}

async function createDatabase(databasePath) {
  const filename = path.resolve(databasePath);
  await mkdir(path.dirname(filename), { recursive: true });
  return installSqliteIndexedDB(filename);
}

async function runLegacyIngestion(contextPath, logDirectory) {
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
    const sessions = (await Promise.all(
      runs.map((run) => queries.sessions.forRun(String(run.id)))
    )).flat();
    const events = (await Promise.all(
      sessions.map((session) => queries.events.forSession(String(session.id)))
    )).flat();
    return { result, runs, sessions, events };
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

export async function runCli(arguments_, input = process.stdin) {
  const [command, ...optionArguments] = arguments_;
  if (!command || command === '--help' || command === 'help') return USAGE;
  if (!COMMANDS.has(command) && arguments_.length === 2) {
    return runLegacyIngestion(command, optionArguments[0]);
  }
  const options = parseOptions(optionArguments);
  if (options.help) return USAGE;
  if (command === 'download') {
    rejectUnknownOptions(options, ['url', 'output']);
    return downloadDeployedDashboardData({
      url: option(options, 'url', false),
      output: option(options, 'output', false)
    });
  }
  if (command === 'audit-jsonl') {
    rejectUnknownOptions(options, ['input']);
    return auditJsonl(option(options, 'input', false) || DEFAULT_LOGS_PATH);
  }
  if (command === 'hash-payloads') {
    rejectUnknownOptions(options, ['input', 'database', 'shard-dir', 'output']);
    const hashes = await hashActivityPayloads({
      jsonlPath: option(options, 'input', false) ? path.resolve(option(options, 'input', false)) : undefined,
      databasePath: option(options, 'database', false) ? path.resolve(option(options, 'database', false)) : undefined,
      shardDirectory: option(options, 'shard-dir', false) ? path.resolve(option(options, 'shard-dir', false)) : undefined
    });
    const outputPath = option(options, 'output', false);
    if (outputPath) {
      await writeFile(path.resolve(outputPath), `${JSON.stringify(hashes, null, 2)}\n`);
    }
    return hashes;
  }
  if (command === 'activity-stats') {
    rejectUnknownOptions(options, ['repo', 'workflow', 'artifact', 'limit', 'keep', 'output']);
    const stats = await activityWorkflowStats({
      repo: option(options, 'repo', false),
      workflow: option(options, 'workflow', false),
      artifact: option(options, 'artifact', false),
      limit: option(options, 'limit', false),
      keep: Boolean(options.keep)
    });
    const outputPath = option(options, 'output', false);
    if (outputPath) {
      await writeFile(path.resolve(outputPath), `${JSON.stringify(stats, null, 2)}\n`);
    }
    return stats;
  }
  const rawQuery = command === 'query' && options.stdin
    ? await rawQueryFromStdin(options, input)
    : undefined;
  const databasePath = option(options, 'database', false) || DEFAULT_DATABASE_PATH;
  if (command === 'doctor') {
    rejectUnknownOptions(options, ['database', 'ttl-days', 'run-ttl-days']);
    return doctorSqliteDatabase(databasePath, {
      ttlDays: ttlDays(options),
      runTtlDays: runTtlDays(options)
    });
  }
  const indexedDB = await createDatabase(databasePath);

  if (command === 'ingest') {
    rejectUnknownOptions(options, ['database', 'context', 'logs', 'retention-days', 'run-retention-days']);
    const result = await ingestGhAwLogDirectory(
      indexedDB,
      path.resolve(option(options, 'context')),
      path.resolve(option(options, 'logs')),
      {
        retentionWindowMs: retentionWindowMs(options),
        retentionWindowMsByStore: { runs: runRetentionWindowMs(options) }
      }
    );
    return { result, counts: await databaseCounts(indexedDB) };
  }
  if (command === 'ingest-jsonl') {
    rejectUnknownOptions(options, ['database', 'input', 'input-dir', 'context', 'retention-days', 'run-retention-days']);
    const inputDirectory = option(options, 'input-dir', false);
    if (inputDirectory && option(options, 'input', false)) {
      throw new Error('Options --input and --input-dir cannot be combined');
    }
    const contextPath = option(options, 'context', false);
    const context = contextPath
      ? JSON.parse(await readFile(path.resolve(contextPath), 'utf8'))
      : undefined;
    const ingestOptions = {
      retentionWindowMs: retentionWindowMs(options),
      retentionWindowMsByStore: { runs: runRetentionWindowMs(options) },
      context
    };
    if (inputDirectory) {
      const result = await ingestJsonlShardDirectory(indexedDB, path.resolve(inputDirectory), ingestOptions);
      return { result, counts: await databaseCounts(indexedDB) };
    }
    const result = await ingestCachedGhAwJsonl(
      indexedDB,
      createReadStream(path.resolve(option(options, 'input', false) || DEFAULT_LOGS_PATH)),
      ingestOptions
    );
    return { result, counts: await databaseCounts(indexedDB) };
  }
  if (command === 'query') {
    rejectUnknownOptions(options, ['database', 'collection', 'id', 'where', 'limit', 'stdin']);
    return rawQuery
      ? queryRawCanonicalData(indexedDB, rawQuery)
      : queryCanonicalData(indexedDB, options);
  }
  throw new Error(`Unknown command: ${command}`);
}

async function main() {
  const output = await runCli(process.argv.slice(2));
  process.stdout.write(`${typeof output === 'string' ? output : JSON.stringify(output, null, 2)}\n`);
  if (typeof output === 'object' && output?.command === 'doctor' && !output.healthy) process.exitCode = 2;
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n\n${USAGE}\n`);
    process.exitCode = 1;
  });
}
