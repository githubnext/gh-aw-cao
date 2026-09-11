#!/usr/bin/env node

import { readFile, readdir, mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { ingestCachedGhAwJsonl, ingestGhAwLogs } from '../src/data/ingest/coordinator.js';
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

const USAGE = `Usage:
  npm run dashboard:data -- ingest --database FILE --context CONTEXT_JSON --logs LOG_DIRECTORY
  npm run dashboard:data -- ingest-jsonl --database FILE --input GH_AW_LOGS_JSONL [--context CONTEXT_JSON]
  npm run dashboard:data -- query --database FILE --collection NAME [--id ID] [--where FIELD=VALUE] [--limit COUNT]
  npm run dashboard:data -- doctor --database FILE [--ttl-days DAYS]

Collections: ${QUERY_COLLECTIONS.join(', ')}`;

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
  const days = Number(value);
  if (!Number.isFinite(days) || days <= 0) throw new Error('--ttl-days must be greater than zero');
  return days;
}

async function databaseCounts(indexedDB) {
  const counts = await Promise.all(ENTITY_COLLECTIONS.map(async (collection) => [
    collection,
    (await readCollection(indexedDB, collection)).length
  ]));
  return Object.fromEntries(counts);
}

export async function ingestGhAwLogDirectory(indexedDB, contextPath, logDirectory) {
  const context = JSON.parse(await readFile(contextPath, 'utf8'));
  return ingestGhAwLogs(indexedDB, {
    ...context,
    files: await jsonlFiles(logDirectory)
  });
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
  if (!['ingest', 'ingest-jsonl', 'query', 'doctor'].includes(command) && arguments_.length === 2) {
    return runLegacyIngestion(command, optionArguments[0]);
  }
  const options = parseOptions(optionArguments);
  if (options.help) return USAGE;
  const databasePath = option(options, 'database');
  if (command === 'doctor') {
    rejectUnknownOptions(options, ['database', 'ttl-days']);
    return doctorSqliteDatabase(databasePath, { ttlDays: ttlDays(options) });
  }
  const indexedDB = await createDatabase(databasePath);

  if (command === 'ingest') {
    rejectUnknownOptions(options, ['database', 'context', 'logs']);
    const result = await ingestGhAwLogDirectory(
      indexedDB,
      path.resolve(option(options, 'context')),
      path.resolve(option(options, 'logs'))
    );
    return { result, counts: await databaseCounts(indexedDB) };
  }
  if (command === 'ingest-jsonl') {
    rejectUnknownOptions(options, ['database', 'input', 'context']);
    const contextPath = option(options, 'context', false);
    const result = await ingestCachedGhAwJsonl(
      indexedDB,
      await readFile(path.resolve(option(options, 'input')), 'utf8'),
      {
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
