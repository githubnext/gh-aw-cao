#!/usr/bin/env node

import { createWriteStream } from 'node:fs';
import { readFile, readdir, mkdir, mkdtemp, rename, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { pathToFileURL } from 'node:url';
import { adaptCachedGhAwJsonl } from '../src/data/adapters/gh-aw-logs.js';
import { ingestCachedGhAwJsonl, ingestGhAwLogs } from '../src/data/ingest/coordinator.js';
import { normalize } from '../src/data/normalize/index.js';
import { createCanonicalQueries } from '../src/data/queries/index.js';
import { readCollection, readRecord, readTransactions } from '../src/data/storage/indexeddb.js';
import { doctorSqliteDatabase } from '../src/data/storage/sqlite-doctor.js';
import { installSqliteIndexedDB } from '../src/data/storage/sqlite-indexeddb.js';

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
const DAY_MS = 24 * 60 * 60 * 1000;
const COMMANDS = new Set(['ingest', 'ingest-jsonl', 'audit-jsonl', 'query', 'doctor', 'download']);

const USAGE = `Usage:
  cao ingest --database FILE --context CONTEXT_JSON --logs LOG_DIRECTORY [--retention-days DAYS|all] [--run-retention-days DAYS|all]
  cao ingest-jsonl --database FILE --input GH_AW_LOGS_JSONL [--context CONTEXT_JSON] [--retention-days DAYS|all] [--run-retention-days DAYS|all]
  cao audit-jsonl --input GH_AW_LOGS_JSONL
  cao query --database FILE --collection NAME [--id ID] [--where FIELD=VALUE] [--limit COUNT]
  cao doctor --database FILE [--ttl-days DAYS|all] [--run-ttl-days DAYS|all]
  cao download [--url URL] [--output DIRECTORY]

Collections: ${QUERY_COLLECTIONS.join(', ')}

Download defaults:
  URL        DASHBOARD_DATA_URL or ${DEFAULT_DEPLOYED_DATA_URL}
  DIRECTORY  _activity`;

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
    if (name === 'help') {
      options.help = 'true';
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
  const adapted = adaptCachedGhAwJsonl(await readFile(input, 'utf8'));
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
  output = '_activity'
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

export async function runCli(arguments_) {
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
    return auditJsonl(option(options, 'input'));
  }
  const databasePath = option(options, 'database');
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
    rejectUnknownOptions(options, ['database', 'input', 'context', 'retention-days', 'run-retention-days']);
    const contextPath = option(options, 'context', false);
    const result = await ingestCachedGhAwJsonl(
      indexedDB,
      await readFile(path.resolve(option(options, 'input')), 'utf8'),
      {
        retentionWindowMs: retentionWindowMs(options),
        retentionWindowMsByStore: { runs: runRetentionWindowMs(options) },
        context: contextPath
          ? JSON.parse(await readFile(path.resolve(contextPath), 'utf8'))
          : undefined
      }
    );
    return { result, counts: await databaseCounts(indexedDB) };
  }
  if (command === 'query') {
    rejectUnknownOptions(options, ['database', 'collection', 'id', 'where', 'limit']);
    return queryCanonicalData(indexedDB, options);
  }
  throw new Error(`Unknown command: ${command}`);
}

async function main() {
  const output = await runCli(process.argv.slice(2));
  process.stdout.write(`${typeof output === 'string' ? output : JSON.stringify(output, null, 2)}\n`);
  if (typeof output === 'object' && output?.command === 'doctor' && !output.healthy) process.exitCode = 2;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n\n${USAGE}\n`);
    process.exitCode = 1;
  });
}
