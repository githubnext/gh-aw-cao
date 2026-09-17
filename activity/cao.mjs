#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream, realpathSync } from 'node:fs';
import { readFile, readdir, mkdir, mkdtemp, rename, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { createInterface } from 'node:readline';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { pathToFileURL } from 'node:url';
import { createDebug } from './debug.mjs';
import { adaptCachedGhAwJsonlStream, createCachedJsonlPayloadHasher } from '../dashboard/site/src/data/adapters/gh-aw-logs.js';
import {
  ingestCachedGhAwJsonl,
  ingestGhAwLogs,
  ingestNormalizedJson,
  isCachedGhAwJsonlCurrent,
  NORMALIZED_JSON_INGESTION_VERSION
} from '../dashboard/site/src/data/ingest/coordinator.js';
import { normalize } from '../dashboard/site/src/data/normalize/index.js';
import { CANONICAL_SCHEMA_VERSION } from '../dashboard/site/src/data/model/schema.js';
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
  'events'
];
const QUERY_COLLECTIONS = [...ENTITY_COLLECTIONS, 'transactions'];
const DEFAULT_DEPLOYED_DATA_URL = 'https://githubnext.github.io/gh-aw-cao/cao/payload-hashes.json';
const DEFAULT_OUTPUT_DIRECTORY = '.cao';
const DEFAULT_SHARDS_PATH = `${DEFAULT_OUTPUT_DIRECTORY}/gh-aw-logs-shards`;
const DEFAULT_DATABASE_PATH = `${DEFAULT_OUTPUT_DIRECTORY}/gh-aw-logs.sqlite`;
const DAY_MS = 24 * 60 * 60 * 1000;
const DEFAULT_ACTIVITY_STATS_WORKFLOW = 'cao-activity.yml';
const DEFAULT_ACTIVITY_STATS_ARTIFACT = 'cao-activity-index';
const DEFAULT_ACTIVITY_STATS_LIMIT = 5;
const DEFAULT_GH_LIMIT = 30;
const GH_AW_INSTALLER_COMMAND = 'curl --fail --silent --show-error --location https://raw.githubusercontent.com/github/gh-aw/main/install-gh-aw.sh | bash -s -- "$1"';
const CAO_SCHEMA_URL = 'https://raw.githubusercontent.com/githubnext/gh-aw-cao/main/.github/workflows/shared/cao.schema.json';
const DEFAULT_POLICY_PATH = '.github/workflows/cao.json';
const GH_RESOURCES = new Set(['runs', 'issues', 'prs']);
const COMMANDS = new Set(['init', 'add', 'update', 'mode', 'ingest', 'ingest-jsonl', 'audit-jsonl', 'compact-jsonl', 'query', 'doctor', 'download', 'hash-payloads', 'activity-stats', 'gh']);

// Intentional CLI misuse that should print usage without an internal stack trace.
class UsageError extends Error {}

const USAGE = `Usage:
  cao init
  cao add PACKAGE [GH_AW_ADD_OPTIONS...]
  cao update [GH_AW_UPDATE_OPTIONS...]
  cao mode (live|preview) PACKAGE...
  cao ingest [--database FILE] --context CONTEXT_JSON --logs LOG_DIRECTORY [--retention-days DAYS|all] [--run-retention-days DAYS|all]
  cao ingest-jsonl [--database FILE] [--input FILE|--input-dir SHARD_DIRECTORY|--runs-dir DIRECTORY --events-dir DIRECTORY] [--context CONTEXT_JSON] [--retention-days DAYS|all] [--run-retention-days DAYS|all]
  cao audit-jsonl [--input-dir SHARD_DIRECTORY]
  cao compact-jsonl --input-dir SHARD_DIRECTORY --group OWNER/REPOSITORY=SHARD_PREFIX [--group OWNER/REPOSITORY=SHARD_PREFIX...]
  cao query [--database FILE] (--collection NAME [--id ID] [--where FIELD=VALUE] [--limit COUNT] | --stdin)
  cao doctor [--database FILE] [--ttl-days DAYS|all] [--run-ttl-days DAYS|all]
  cao download [--url URL] [--output DIRECTORY]
  cao hash-payloads [--database FILE] [--shard-dir SHARD_DIRECTORY] [--normalized-dir DIRECTORY] [--runs-dir DIRECTORY] [--events-dir DIRECTORY] [--inventory FILE] [--output FILE]
  cao activity-stats [--repo OWNER/REPO] [--workflow FILE] [--artifact NAME] [--limit COUNT] [--keep] [--output FILE]
  cao gh runs [--database FILE] [--repo OWNER/REPO] [--workflow NAME|FILE] [--status STATUS] [--since TIME] [--until TIME] [--limit COUNT]
  cao gh issues [--database FILE] [--repo OWNER/REPO] [--workflow NAME|FILE] [--since TIME] [--until TIME] [--limit COUNT]
  cao gh prs [--database FILE] [--repo OWNER/REPO] [--workflow NAME|FILE] [--since TIME] [--until TIME] [--limit COUNT]

Query local CAO data as JSON. Download the deployed snapshot before querying:
  cao download
  cao gh runs -R githubnext/gh-aw-cao -w cao-activity --status failure --since 2026-09-01 --until 2026-09-15
  cao gh issues -R githubnext/gh-aw-cao --since 2026-09-01
  cao gh prs -R githubnext/gh-aw-cao -w cao-activity -L 10

Resources:
  runs    Workflow runs executed in --repo
  issues  Issues created through safe outputs in the target --repo
  prs     Pull requests created through safe outputs in the target --repo

gh query options:
  -R, --repo       Exact OWNER/REPO; execution repo for runs, target repo for issues and prs
  -w, --workflow   Producing workflow name, path, file name, or ID
  -s, --status     Runs only: workflow status or conclusion, such as completed or failure
  -L, --limit      Maximum results, newest first (default ${DEFAULT_GH_LIMIT})
  --since          Include results at or after ISO 8601 time (example: 2026-09-01T12:00:00Z)
  --until          Include results at or before ISO 8601 time; a date includes the full day
  --database       Local SQLite snapshot (default ${DEFAULT_DATABASE_PATH})

Data preparation:
  cao download writes the deployed JSONL and query-ready SQLite snapshot to ${DEFAULT_OUTPUT_DIRECTORY}/.
  To query other gh-aw JSONL shards, first run cao ingest-jsonl --input-dir SHARD_DIRECTORY [--database FILE].

Collections: ${QUERY_COLLECTIONS.join(', ')}

Query stdin JSON:
  {"name":"failed-runs","from":"runs","filter":{"predicates":[{"field":"conclusion","equals":"failure"}]},"limit":20}

Download defaults:
  URL        DASHBOARD_DATA_URL or ${DEFAULT_DEPLOYED_DATA_URL}
  DIRECTORY  ${DEFAULT_OUTPUT_DIRECTORY}
  SHARDS     ${DEFAULT_SHARDS_PATH}
  DATABASE   ${DEFAULT_DATABASE_PATH}

Activity stats defaults (uses the "gh" CLI and requires GH_TOKEN):
  REPO      GITHUB_REPOSITORY
  WORKFLOW  ${DEFAULT_ACTIVITY_STATS_WORKFLOW}
  ARTIFACT  ${DEFAULT_ACTIVITY_STATS_ARTIFACT}
  LIMIT     ${DEFAULT_ACTIVITY_STATS_LIMIT}

`;

function isMapping(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function validatePackageDeclaration(document, source) {
  if (!isMapping(document)) throw new Error(`${source} must contain a JSON object`);
  const keys = Object.keys(document);
  const unknown = keys.filter((key) => !['package', 'orchestrator', 'workers'].includes(key));
  if (unknown.length > 0) throw new Error(`${source} contains unknown key: ${unknown[0]}`);
  const slug = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
  if (typeof document.package !== 'string' || !slug.test(document.package)) {
    throw new Error(`${source} package must be a kebab-case identifier`);
  }
  if (typeof document.orchestrator !== 'string' || !slug.test(document.orchestrator)) {
    throw new Error(`${source} orchestrator must be a kebab-case workflow identifier`);
  }
  if (!isMapping(document.workers) || Object.keys(document.workers).length === 0) {
    throw new Error(`${source} workers must be a non-empty object`);
  }
  const workflows = new Set();
  for (const [worker, workflow] of Object.entries(document.workers)) {
    if (!slug.test(worker)) throw new Error(`${source} worker ${worker} must be a kebab-case identifier`);
    if (typeof workflow !== 'string' || !slug.test(workflow)) {
      throw new Error(`${source} worker ${worker} must name a kebab-case workflow`);
    }
    if (workflows.has(workflow)) throw new Error(`${source} workers must name unique workflows`);
    workflows.add(workflow);
  }
  return document;
}

function parseGhAwVersion(result) {
  if (result.error || result.status !== 0) {
    throw new Error(`Unable to determine gh-aw version: ${(result.stderr || '').trim() || result.error?.message || 'gh aw version failed'}`);
  }
  const version = String(result.stdout || '').match(/\bv[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?\b/)?.[0];
  if (!version) throw new Error('Unable to determine gh-aw version from "gh aw version" output');
  return version;
}

function ghAwVersionParts(version) {
  const match = String(version).match(/^v([0-9]+)\.([0-9]+)\.([0-9]+)(?:-([0-9A-Za-z.-]+))?$/);
  if (!match) throw new Error(`Invalid gh-aw version: ${version}`);
  return {
    numbers: match.slice(1, 4).map(Number),
    prerelease: match[4] ?? ''
  };
}

function compareGhAwVersions(left, right) {
  const leftParts = ghAwVersionParts(left);
  const rightParts = ghAwVersionParts(right);
  for (let index = 0; index < leftParts.numbers.length; index += 1) {
    if (leftParts.numbers[index] !== rightParts.numbers[index]) {
      return leftParts.numbers[index] - rightParts.numbers[index];
    }
  }
  if (leftParts.prerelease === rightParts.prerelease) return 0;
  if (!leftParts.prerelease) return 1;
  if (!rightParts.prerelease) return -1;
  return leftParts.prerelease.localeCompare(rightParts.prerelease, 'en', { numeric: true });
}

function commandFailureMessage(result, fallback) {
  return (result.stderr || '').trim() || result.error?.message || fallback;
}

async function writeJsonAtomically(filePath, document) {
  const absolutePath = path.resolve(filePath);
  await mkdir(path.dirname(absolutePath), { recursive: true });
  const temporaryPath = `${absolutePath}.tmp-${process.pid}-${Date.now()}`;
  try {
    await writeFile(temporaryPath, `${JSON.stringify(document, null, 2)}\n`, { flag: 'wx' });
    await rename(temporaryPath, absolutePath);
  } finally {
    await rm(temporaryPath, { force: true });
  }
}

function minimalPolicy(version) {
  return {
    $schema: CAO_SCHEMA_URL,
    version: 1,
    'gh-aw-version': version,
    'control-plane': { packages: {} }
  };
}

export async function initializeCaoPolicy({
  policyPath = DEFAULT_POLICY_PATH,
  execute = spawnSync
} = {}) {
  const absolutePath = path.resolve(policyPath);
  try {
    await stat(absolutePath);
    throw new Error(`${policyPath} already exists`);
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
  const version = parseGhAwVersion(execute('gh', ['aw', 'version'], { encoding: 'utf8' }));
  await writeJsonAtomically(absolutePath, minimalPolicy(version));
  return { command: 'init', policy: policyPath, 'gh-aw-version': version };
}

function validateGlobalPolicy(document, source) {
  if (!isMapping(document) || document.version !== 1) throw new Error(`${source} must declare version 1`);
  if (document['control-plane'] !== undefined && !isMapping(document['control-plane'])) {
    throw new Error(`${source} control-plane must be an object`);
  }
  if (document['control-plane']?.packages !== undefined && !isMapping(document['control-plane'].packages)) {
    throw new Error(`${source} control-plane.packages must be an object`);
  }
  return document;
}

async function readCaoPolicy(policyPath, command = 'update') {
  try {
    return validateGlobalPolicy(JSON.parse(await readFile(path.resolve(policyPath), 'utf8')), policyPath);
  } catch (error) {
    if (error?.code === 'ENOENT') throw new Error(`${policyPath} is required for cao ${command}`);
    if (error instanceof SyntaxError) throw new Error(`${policyPath} contains invalid JSON: ${error.message}`);
    throw error;
  }
}

function ghAwMinimumVersion(policy, source) {
  const version = policy['gh-aw-version'];
  if (typeof version !== 'string' || !/^v[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?$/.test(version)) {
    throw new Error(`${source} gh-aw-version must be a v-prefixed semantic version`);
  }
  return version;
}

function mergeCaoPackageDeclaration(policy, declaration) {
  const controlPlane = policy['control-plane'] ?? {};
  const packages = controlPlane.packages ?? {};
  const existingPackage = isMapping(packages[declaration.package]) ? packages[declaration.package] : {};
  const existingWorkers = isMapping(existingPackage.workers) ? existingPackage.workers : {};
  const workers = Object.fromEntries(Object.entries(declaration.workers).map(([worker, workflow]) => {
    const existing = isMapping(existingWorkers[worker]) ? existingWorkers[worker] : {};
    const preserved = {};
    if (typeof existing.enabled === 'boolean') preserved.enabled = existing.enabled;
    if (existing['max-mode'] === 'review' || existing['max-mode'] === 'live') preserved['max-mode'] = existing['max-mode'];
    return [worker, { workflow, ...preserved }];
  }));
  policy['control-plane'] = {
    ...controlPlane,
    packages: {
      ...packages,
      [declaration.package]: {
        ...existingPackage,
        workers
      }
    }
  };
}

function packageSlugFromSpec(spec) {
  const refSeparator = spec.lastIndexOf('@');
  const withoutRef = refSeparator > spec.indexOf('/') ? spec.slice(0, refSeparator) : spec;
  const slug = withoutRef.replace(/\/+$/, '').split('/').pop();
  if (!slug || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug)) {
    throw new Error(`Unable to determine package name from ${spec}`);
  }
  return slug;
}

async function installedPackageRecords(root = process.cwd()) {
  const recordsDirectory = path.resolve(root, '.github', 'aw', 'packages');
  let entries;
  try {
    entries = await readdir(recordsDirectory, { withFileTypes: true });
  } catch (error) {
    if (error?.code === 'ENOENT') return [];
    throw error;
  }
  const records = new Map();
  for (const entry of entries) {
    if (entry.isDirectory() || !entry.name.endsWith('.json')) continue;
    const source = path.join(recordsDirectory, entry.name);
    let record;
    try {
      record = JSON.parse(await readFile(source, 'utf8'));
    } catch (error) {
      if (error instanceof SyntaxError) throw new Error(`${path.relative(root, source)} contains invalid JSON: ${error.message}`);
      throw error;
    }
    const packageName = typeof record.package === 'string' && record.package.trim()
      ? record.package.trim()
      : typeof record.source === 'string'
        ? record.source.split('@')[0].trim()
        : '';
    if (!packageName) throw new Error(`${path.relative(root, source)} does not identify an installed package`);
    records.set(packageName, {
      package: packageName,
      source: typeof record.source === 'string' ? record.source : packageName
    });
  }
  return [...records.values()].sort((left, right) => left.package.localeCompare(right.package));
}

async function readInstalledCaoDeclaration(packageName) {
  const expectedPackage = packageSlugFromSpec(packageName);
  const declarationPath = path.resolve('.github', 'aw', expectedPackage, 'cao.json');
  let declaration;
  try {
    declaration = validatePackageDeclaration(
      JSON.parse(await readFile(declarationPath, 'utf8')),
      path.relative(process.cwd(), declarationPath)
    );
  } catch (error) {
    if (error?.code === 'ENOENT') return undefined;
    if (error instanceof SyntaxError) throw new Error(`Package ${expectedPackage} installed invalid cao.json: ${error.message}`);
    throw error;
  }
  if (declaration.package !== expectedPackage) {
    throw new Error(`Installed CAO declaration names package ${declaration.package}, expected ${expectedPackage}`);
  }
  return declaration;
}

export async function ensureGhAwMinimumVersion({
  policyPath = DEFAULT_POLICY_PATH,
  execute = spawnSync
} = {}) {
  const policy = await readCaoPolicy(policyPath);
  const required = ghAwMinimumVersion(policy, policyPath);
  let current = null;
  try {
    current = parseGhAwVersion(execute('gh', ['aw', 'version'], { encoding: 'utf8' }));
  } catch {
    current = null;
  }
  const installRequired = !current || compareGhAwVersions(current, required) < 0;
  if (installRequired) {
    const install = execute('bash', ['-c', GH_AW_INSTALLER_COMMAND, 'cao-gh-aw-install', required], {
      encoding: 'utf8',
      maxBuffer: 16 * 1024 * 1024
    });
    if (install.error || install.status !== 0) {
      throw new Error(`Unable to install gh-aw ${required}: ${commandFailureMessage(install, 'installer failed')}`);
    }
    const verified = parseGhAwVersion(execute('gh', ['aw', 'version'], { encoding: 'utf8' }));
    if (compareGhAwVersions(verified, required) < 0) {
      throw new Error(`Installed gh-aw ${verified} is older than required ${required}`);
    }
    return { required, previous: current, current: verified, updated: true };
  }
  return { required, previous: current, current, updated: false };
}

export async function addCaoPackage(packageSpec, ghAwOptions = [], {
  policyPath = DEFAULT_POLICY_PATH,
  execute = spawnSync
} = {}) {
  if (!packageSpec || packageSpec.startsWith('-')) throw new UsageError('cao add requires a package');
  const install = execute('gh', ['aw', 'add', packageSpec, ...ghAwOptions], {
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024
  });
  if (install.error || install.status !== 0) {
    throw new Error(`gh aw add failed: ${commandFailureMessage(install, 'unknown error')}`);
  }

  const expectedPackage = packageSlugFromSpec(packageSpec);
  const declaration = await readInstalledCaoDeclaration(packageSpec);
  if (!declaration) throw new Error(`Package ${expectedPackage} did not install .github/aw/${expectedPackage}/cao.json`);

  const absolutePolicyPath = path.resolve(policyPath);
  let policy;
  try {
    policy = validateGlobalPolicy(JSON.parse(await readFile(absolutePolicyPath, 'utf8')), policyPath);
  } catch (error) {
    if (error?.code !== 'ENOENT') {
      if (error instanceof SyntaxError) throw new Error(`${policyPath} contains invalid JSON: ${error.message}`);
      throw error;
    }
    const version = parseGhAwVersion(execute('gh', ['aw', 'version'], { encoding: 'utf8' }));
    policy = minimalPolicy(version);
  }

  mergeCaoPackageDeclaration(policy, declaration);
  await writeJsonAtomically(absolutePolicyPath, policy);
  return {
    command: 'add',
    package: declaration.package,
    orchestrator: declaration.orchestrator,
    workers: Object.keys(declaration.workers),
    policy: policyPath
  };
}

export async function updateCaoPackages(ghAwOptions = [], {
  policyPath = DEFAULT_POLICY_PATH,
  execute = spawnSync
} = {}) {
  const policy = await readCaoPolicy(policyPath);
  const ghAw = await ensureGhAwMinimumVersion({ policyPath, execute });
  const packages = await installedPackageRecords();
  if (packages.length === 0) {
    throw new Error('No installed gh-aw package records found under .github/aw/packages');
  }

  const updatedPackages = [];
  const mergedDeclarations = [];
  for (const record of packages) {
    const update = execute('gh', ['aw', 'update', record.package, ...ghAwOptions], {
      encoding: 'utf8',
      maxBuffer: 16 * 1024 * 1024
    });
    if (update.error || update.status !== 0) {
      throw new Error(`gh aw update failed for ${record.package}: ${commandFailureMessage(update, 'unknown error')}`);
    }
    const declaration = await readInstalledCaoDeclaration(record.package);
    if (declaration) {
      mergeCaoPackageDeclaration(policy, declaration);
      mergedDeclarations.push(declaration.package);
    }
    updatedPackages.push(record.package);
  }
  if (mergedDeclarations.length > 0) await writeJsonAtomically(path.resolve(policyPath), policy);
  return {
    command: 'update',
    policy: policyPath,
    'gh-aw': ghAw,
    packages: updatedPackages,
    declarations: mergedDeclarations
  };
}

export async function setCaoPackageMode(mode, packageNames, {
  policyPath = DEFAULT_POLICY_PATH
} = {}) {
  if (mode !== 'live' && mode !== 'preview') {
    throw new UsageError('cao mode requires live or preview');
  }
  if (!Array.isArray(packageNames) || packageNames.length === 0) {
    throw new UsageError(`cao mode ${mode} requires at least one package`);
  }

  const slug = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
  const invalidPackage = packageNames.find((packageName) => typeof packageName !== 'string' || !slug.test(packageName));
  if (invalidPackage !== undefined) {
    throw new UsageError(`Invalid CAO package name: ${invalidPackage}`);
  }

  const policy = await readCaoPolicy(policyPath, 'mode');
  const packages = policy['control-plane']?.packages ?? {};
  const unknownPackages = [...new Set(packageNames)].filter((packageName) => !Object.hasOwn(packages, packageName));
  if (unknownPackages.length > 0) {
    throw new UsageError(`Unknown CAO package${unknownPackages.length === 1 ? '' : 's'}: ${unknownPackages.join(', ')}`);
  }
  for (const packageName of packageNames) {
    if (!isMapping(packages[packageName])) {
      throw new Error(`${policyPath} control-plane package ${packageName} must be an object`);
    }
  }

  const policyMode = mode === 'preview' ? 'review' : 'live';
  for (const packageName of new Set(packageNames)) {
    packages[packageName] = { ...packages[packageName], mode: policyMode };
  }
  await writeJsonAtomically(path.resolve(policyPath), policy);
  return {
    command: 'mode',
    mode,
    packages: [...new Set(packageNames)],
    policy: policyPath
  };
}

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
  const aliases = { '-R': 'repo', '-w': 'workflow', '-s': 'status', '-L': 'limit' };
  /** @type {Record<string, string | string[]>} */
  const options = {};
  for (let index = 0; index < arguments_.length; index += 1) {
    const argument = arguments_[index];
    if (!argument.startsWith('--') && !aliases[argument]) throw new UsageError(`Unexpected argument: ${argument}`);
    const name = aliases[argument] ?? argument.slice(2);
    if (name === 'help' || name === 'stdin' || name === 'keep') {
      options[name] = 'true';
      continue;
    }
    const value = arguments_[index + 1];
    if (!value || value.startsWith('--')) throw new UsageError(`Missing value for --${name}`);
    index += 1;
    if (name === 'where' || name === 'group') {
      const existing = options[name];
      options[name] = [...(Array.isArray(existing) ? existing : []), value];
    } else if (options[name] !== undefined) {
      throw new UsageError(`Option --${name} may only be specified once`);
    } else {
      options[name] = value;
    }
  }
  return options;
}

async function rawQueryFromStdin(options, input) {
  for (const name of ['collection', 'id', 'where', 'limit']) {
    if (options[name] !== undefined) {
      throw new UsageError(`Option --${name} cannot be combined with --stdin`);
    }
  }

  let content = '';
  for await (const chunk of input) content += chunk;
  if (!content.trim()) throw new UsageError('--stdin requires a JSON object');

  let query;
  try {
    query = JSON.parse(content);
  } catch (error) {
    throw new Error(`Invalid query JSON from stdin: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!query || typeof query !== 'object' || Array.isArray(query)) {
    throw new UsageError('--stdin requires a JSON object');
  }
  if (typeof query.name !== 'string' || typeof query.from !== 'string') {
    throw new UsageError('--stdin query requires string fields "name" and "from"');
  }
  return query;
}

function option(options, name, required = true) {
  const value = options[name];
  if (Array.isArray(value)) throw new UsageError(`Option --${name} may only be specified once`);
  if (required && !value) throw new UsageError(`Missing required option --${name}`);
  return value;
}

function rejectUnknownOptions(options, allowed) {
  for (const name of Object.keys(options)) {
    if (!allowed.includes(name)) throw new UsageError(`Unknown option --${name}`);
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
    if (separator < 1) throw new UsageError(`Invalid --where value: ${filter}`);
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
  if (!Number.isInteger(limit) || limit < 1) throw new UsageError('--limit must be a positive integer');
  return limit;
}

function ghQueryLimit(options) {
  return queryLimit(options) ?? DEFAULT_GH_LIMIT;
}

function timeBoundary(options, name) {
  const value = option(options, name, false);
  if (!value) return undefined;
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) throw new UsageError(`--${name} must be a valid ISO 8601 time`);
  if (name === 'until' && /^\d{4}-\d{2}-\d{2}$/.test(value)) return timestamp + DAY_MS - 1;
  return timestamp;
}

function ghTimeRange(options) {
  const since = timeBoundary(options, 'since');
  const until = timeBoundary(options, 'until');
  if (since !== undefined && until !== undefined && since > until) {
    throw new UsageError('--since must not be later than --until');
  }
  return { since, until };
}

function ttlDays(options) {
  const value = option(options, 'ttl-days', false);
  if (!value) return undefined;
  if (value === 'all') return 'all';
  const days = Number(value);
  if (!Number.isFinite(days) || days <= 0) throw new UsageError('--ttl-days must be a positive number or all');
  return days;
}

function retentionWindowMs(options) {
  const value = option(options, 'retention-days', false);
  if (!value) return undefined;
  if (value === 'all') return Number.MAX_SAFE_INTEGER;
  const days = Number(value);
  const milliseconds = days * DAY_MS;
  if (!Number.isFinite(days) || days <= 0 || !Number.isSafeInteger(milliseconds)) {
    throw new UsageError('--retention-days must be a positive number or all');
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
    throw new UsageError('--run-retention-days must be a positive number or all');
  }
  return milliseconds;
}

function runTtlDays(options) {
  const value = option(options, 'run-ttl-days', false);
  if (!value) return undefined;
  if (value === 'all') return 'all';
  const days = Number(value);
  if (!Number.isFinite(days) || days <= 0) {
    throw new UsageError('--run-ttl-days must be a positive number or all');
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

async function auditJsonlDirectory(inputDirectory) {
  const directory = path.resolve(inputDirectory);
  const names = (await readdir(directory)).filter((name) => name.endsWith('.jsonl')).sort();
  const audits = [];
  for (const name of names) audits.push(await auditJsonl(path.join(directory, name)));
  const sourceKeys = Object.keys(audits[0]?.source ?? {});
  const source = Object.fromEntries(sourceKeys.map((key) => [
    key,
    audits.reduce((sum, audit) => sum + (Number(audit.source[key]) || 0), 0)
  ]));
  const canonical = Object.fromEntries(ENTITY_COLLECTIONS.map((collection) => [
    collection,
    audits.reduce((sum, audit) => sum + audit.canonical[collection], 0)
  ]));
  source.enrichmentCoveragePercent = canonical.runs === 0
    ? 0
    : Number((source.uniqueEnrichedRuns / canonical.runs * 100).toFixed(1));
  return {
    command: 'audit-jsonl',
    inputDirectory: directory,
    shards: names.length,
    source,
    canonical
  };
}

async function* jsonlLines(paths) {
  for (const filePath of paths) {
    const lines = createInterface({
      input: createReadStream(filePath),
      crlfDelay: Infinity
    });
    for await (const line of lines) {
      if (line) yield line;
    }
  }
}

async function compactJsonlShardGroup(directory, prefix, names) {
  const sourcePaths = names.map((name) => path.join(directory, name));
  const sourceBytes = (await Promise.all(sourcePaths.map(async (filePath) => (await stat(filePath)).size)))
    .reduce((sum, size) => sum + size, 0);
  if (sourcePaths.length <= 1) {
    let sourceRecords = 0;
    for await (const line of jsonlLines(sourcePaths)) sourceRecords += 1;
    return {
      prefix,
      sourceFiles: sourcePaths.length,
      sourceRecords,
      retainedRecords: sourceRecords,
      sourceBytes,
      compactedBytes: sourceBytes,
      output: sourcePaths[0] ?? null
    };
  }

  const temporaryPath = path.join(directory, `.${prefix}${process.pid}.tmp`);
  const outputHash = createHash('sha256');
  let retainedRecords = 0;
  await pipeline(
    (async function* compactedLines() {
      for await (const line of jsonlLines(sourcePaths)) {
        const outputLine = `${line}\n`;
        outputHash.update(outputLine);
        retainedRecords += 1;
        yield outputLine;
      }
    })(),
    createWriteStream(temporaryPath, { flags: 'wx' })
  );
  const latestSequence = names.reduce((latest, name) => {
    const match = name.slice(prefix.length).match(/^(\d+)-/);
    return match ? Math.max(latest, Number(match[1])) : latest;
  }, 0);
  const sequence = Math.max(Math.floor(Date.now() / 1000), latestSequence + 1);
  const outputName = `${prefix}${sequence}-${outputHash.digest('hex').slice(0, 16)}.jsonl`;
  const outputPath = path.join(directory, outputName);
  await rename(temporaryPath, outputPath);
  await Promise.all(sourcePaths.filter((filePath) => filePath !== outputPath).map((filePath) => rm(filePath)));
  const compactedBytes = (await stat(outputPath)).size;
  return {
    prefix,
    sourceFiles: sourcePaths.length,
    sourceRecords: retainedRecords,
    retainedRecords,
    sourceBytes,
    compactedBytes,
    output: outputPath
  };
}

async function shardRepository(filePath) {
  for await (const line of jsonlLines([filePath])) {
    const record = JSON.parse(line);
    const requested = record?.request?.repository;
    if (typeof requested === 'string' && requested.includes('/')) return requested.toLowerCase();
    const run = record?.run;
    if (!run || typeof run !== 'object' || Array.isArray(run)) continue;
    const repository = run.repository_full_name ?? run.repository;
    if (typeof repository === 'string' && repository.includes('/')) return repository.toLowerCase();
    if (typeof run.organization === 'string' && typeof repository === 'string') {
      return `${run.organization}/${repository}`.toLowerCase();
    }
  }
  return null;
}

export async function compactJsonlShards(inputDirectory, groupDefinitions) {
  if (groupDefinitions.length === 0) throw new UsageError('At least one --group is required');
  const groupsByRepository = new Map();
  for (const definition of groupDefinitions) {
    const separator = definition.indexOf('=');
    const repository = definition.slice(0, separator).toLowerCase();
    const prefix = definition.slice(separator + 1);
    if (separator < 1 || !/^[A-Za-z0-9][A-Za-z0-9-]*\/[A-Za-z0-9._-]+$/.test(repository)) {
      throw new UsageError('--group must start with an OWNER/REPOSITORY coordinate');
    }
    if (!/^[A-Za-z0-9._-]+$/.test(prefix)) {
      throw new UsageError('--group shard prefix must contain only letters, numbers, dots, underscores, and hyphens');
    }
    if (groupsByRepository.has(repository)) throw new UsageError(`Duplicate compact-jsonl repository: ${repository}`);
    groupsByRepository.set(repository, { prefix, names: [] });
  }
  const directory = path.resolve(inputDirectory);
  for (const name of (await readdir(directory)).filter((name) => name.endsWith('.jsonl')).sort()) {
    const repository = await shardRepository(path.join(directory, name));
    if (repository && groupsByRepository.has(repository)) {
      groupsByRepository.get(repository).names.push(name);
    }
  }
  const groups = [];
  for (const [repository, { prefix, names }] of [...groupsByRepository].sort(([left], [right]) => left.localeCompare(right))) {
    groups.push({
      repository,
      ...await compactJsonlShardGroup(directory, prefix, names)
    });
  }
  return {
    command: 'compact-jsonl',
    inputDirectory: directory,
    groups
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

async function downloadFile(url, destination, { allowEmpty = false } = {}) {
  const response = await fetch(url, {
    headers: { accept: 'application/x-ndjson, application/json, text/plain' },
    redirect: 'follow',
    signal: AbortSignal.timeout(120_000)
  });
  if (!response.ok) throw new Error(`Unable to download ${url}: HTTP ${response.status}`);
  if (!response.body) throw new Error(`Unable to download ${url}: response body is empty`);
  await pipeline(Readable.fromWeb(response.body), createWriteStream(destination, { flags: 'wx' }));
  const size = (await stat(destination)).size;
  if (!allowEmpty && size === 0) {
    throw new Error(`Unable to download ${url}: response body is empty`);
  }
  return size;
}

async function replaceFile(source, destination) {
  await rm(destination, { force: true });
  await rename(source, destination);
}

export async function downloadDeployedDashboardData({
  url = process.env.DASHBOARD_DATA_URL || DEFAULT_DEPLOYED_DATA_URL,
  output = DEFAULT_OUTPUT_DIRECTORY
} = {}) {
  const manifestUrl = deployedDataUrl(url);
  if (!manifestUrl.pathname.endsWith('/payload-hashes.json')) {
    throw new Error('Dashboard data URL must identify payload-hashes.json.');
  }
  const databaseUrl = new URL('gh-aw-logs.sqlite', manifestUrl);
  const outputDirectory = path.resolve(output);
  await mkdir(outputDirectory, { recursive: true });
  const temporaryDirectory = await mkdtemp(path.join(outputDirectory, '.deployed-dashboard-'));
  const temporaryManifest = path.join(temporaryDirectory, 'payload-hashes.json');
  const temporaryShards = path.join(temporaryDirectory, 'gh-aw-logs-shards');
  const temporaryDatabase = path.join(temporaryDirectory, 'gh-aw-logs.sqlite');
  const manifestPath = path.join(outputDirectory, 'payload-hashes.json');
  const shardsPath = path.join(outputDirectory, 'gh-aw-logs-shards');
  const databasePath = path.join(outputDirectory, 'gh-aw-logs.sqlite');

  try {
    await Promise.all([
      downloadFile(manifestUrl, temporaryManifest),
      downloadFile(databaseUrl, temporaryDatabase)
    ]);
    const hashes = JSON.parse(await readFile(temporaryManifest, 'utf8'));
    const shardEntries = Object.entries(hashes)
      .filter(([name, digest]) => /^gh-aw-logs-shards\/[^/]+\.jsonl$/.test(name)
        && /^[a-f0-9]{64}$/i.test(String(digest)))
      .sort(([left], [right]) => left.localeCompare(right));
    if (shardEntries.length === 0) throw new Error('Activity shard manifest contains no valid JSONL shards.');
    await mkdir(temporaryShards);
    for (const [name, expectedDigest] of shardEntries) {
      const destination = path.join(temporaryShards, path.basename(name));
      const size = await downloadFile(new URL(name, manifestUrl), destination, { allowEmpty: true });
      const hash = createHash('sha256');
      for await (const chunk of createReadStream(destination)) hash.update(chunk);
      if (hash.digest('hex') !== expectedDigest.toLowerCase()) {
        throw new Error(`Activity shard checksum mismatch: ${name}`);
      }
      if (size === 0) {
        delete hashes[name];
        await rm(destination);
      }
    }
    await writeFile(temporaryManifest, `${JSON.stringify(hashes, null, 2)}\n`);
    await rm(shardsPath, { recursive: true, force: true });
    await rename(temporaryShards, shardsPath);
    await replaceFile(temporaryManifest, manifestPath);
    await replaceFile(temporaryDatabase, databasePath);
    return {
      manifestUrl: manifestUrl.href,
      databaseUrl: databaseUrl.href,
      manifest: manifestPath,
      shards: shardsPath,
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
  return { ...totals, updated, committedRecords, shards };
}

async function ingestNormalizedShardDirectories(indexedDB, directories, options = {}) {
  const shards = [];
  let updated = false;
  let committedRecords = 0;
  for (const [phase, directory] of directories) {
    const names = (await readdir(directory)).filter((name) => name.endsWith('.json')).sort();
    for (const name of names) {
      const shardPath = path.join(directory, name);
      const content = await readFile(shardPath);
      const payloadIdentity = createHash('sha256').update(content).digest('hex');
      const result = await ingestNormalizedJson(
        indexedDB,
        JSON.parse(content.toString('utf8')),
        {
          ...options,
          expectedPhase: phase,
          payloadScope: `gh-aw-${phase}:${name}`,
          payloadIdentity
        }
      );
      updated ||= result.updated;
      committedRecords += result.committedRecords ?? 0;
      shards.push({ phase, shard: name, skipped: Boolean(result.skipped), committedRecords: result.committedRecords ?? 0 });
    }
  }
  return { updated, committedRecords, shards };
}

async function ingestJsonlFile(indexedDB, inputPath, options = {}) {
  return ingestCachedGhAwJsonl(indexedDB, createReadStream(inputPath), options);
}

/**
 * Computes SHA-256 checksums for the activity snapshot payloads: the
 * SQLite projection and every retained `--cached-logs` wildcard shard file.
 * Missing files are tolerated (an
 * absent shard directory yields no shard entries) so this can run
 * immediately after ingestion in the same workflow step.
 */
function workflowHintsFromInventory(input) {
  const rows = input?.workflows?.rows;
  if (!Array.isArray(rows)) return [];
  return rows.flatMap((candidate) => (
    candidate
      && typeof candidate === 'object'
      && typeof candidate.organization === 'string'
      && typeof candidate.repository === 'string'
      && typeof candidate['workflow-name'] === 'string'
      && typeof candidate.workflow === 'string'
      ? [{
          owner: candidate.organization,
          repository: candidate.repository,
          name: candidate['workflow-name'],
          path: candidate.workflow
        }]
      : []
  ));
}

async function hashActivityPayloads({
  databasePath,
  shardDirectory,
  normalizedDirectory,
  runsDirectory,
  eventsDirectory,
  inventoryPath
}) {
  const hashFile = async (filePath) => {
    const hash = createHash('sha256');
    for await (const chunk of createReadStream(filePath)) hash.update(chunk);
    const digest = hash.digest('hex');
    debugHash('hashed %s -> %s', filePath, digest);
    return digest;
  };
  const payloadHasRecords = async (filePath) => {
    const payload = JSON.parse(await readFile(filePath, 'utf8'));
    return payload?.batch
      && typeof payload.batch === 'object'
      && Object.values(payload.batch).some((records) => Array.isArray(records) && records.length > 0);
  };
  const hashes = {};
  if (databasePath) hashes[path.basename(databasePath)] = await hashFile(databasePath);
  if (shardDirectory) {
    let shardNames = [];
    try {
      shardNames = (await readdir(shardDirectory)).filter((name) => name.endsWith('.jsonl')).sort();
    } catch (error) {
      if (!(error && error.code === 'ENOENT')) throw error;
    }
    debugHash('hashing %d shard(s) in %s', shardNames.length, shardDirectory);
    const inventorySource = inventoryPath ? await readFile(inventoryPath, 'utf8') : '{}';
    const workflowHints = workflowHintsFromInventory(JSON.parse(inventorySource));
    const normalizationContext = createHash('sha256')
      .update(`${CANONICAL_SCHEMA_VERSION}\0${NORMALIZED_JSON_INGESTION_VERSION}\0${JSON.stringify(workflowHints)}`)
      .digest('hex')
      .slice(0, 16);
    const retainedPayloads = {
      normalized: new Set(),
      runs: new Set(),
      events: new Set()
    };
    if (normalizedDirectory) await mkdir(normalizedDirectory, { recursive: true });
    if (runsDirectory) await mkdir(runsDirectory, { recursive: true });
    if (eventsDirectory) await mkdir(eventsDirectory, { recursive: true });
    for (const name of shardNames) {
      const shardPath = path.join(shardDirectory, name);
      if ((await stat(shardPath)).size === 0) {
        await rm(shardPath);
        debugHash('dropped empty source shard %s', shardPath);
        continue;
      }
      const rawHash = await hashFile(shardPath);
      hashes[`${path.basename(shardDirectory)}/${name}`] = rawHash;
      if (!normalizedDirectory && !runsDirectory && !eventsDirectory) continue;
      const payloadName = `${rawHash}-${normalizationContext}.json`;
      const phasedPayloadName = `${path.parse(name).name}-${payloadName}`;
      const outputPaths = [
        normalizedDirectory ? ['normalized', path.join(normalizedDirectory, payloadName)] : null,
        runsDirectory ? ['runs', path.join(runsDirectory, phasedPayloadName)] : null,
        eventsDirectory ? ['events', path.join(eventsDirectory, phasedPayloadName)] : null
      ].filter(Boolean);
      const missing = [];
      for (const output of outputPaths) {
        try {
          await stat(output[1]);
        } catch (error) {
          if (!(error && error.code === 'ENOENT')) throw error;
          missing.push(output);
        }
      }
      if (missing.length > 0) {
        const adapted = await adaptCachedGhAwJsonlStream(createReadStream(shardPath), {
          workflowHints,
          payloadIdentity: rawHash
        });
        const batch = normalize(adapted.observations);
        const metadata = {
          schemaVersion: CANONICAL_SCHEMA_VERSION,
          ingestionVersion: NORMALIZED_JSON_INGESTION_VERSION,
          sourceRecords: adapted.records
        };
        const payloads = {
          normalized: { ...metadata, batch },
          runs: {
            ...metadata,
            phase: 'runs',
            batch: {
              packages: batch.packages,
              repositories: batch.repositories,
              workflows: batch.workflows,
              runs: batch.runs,
              events: []
            }
          },
          events: {
            ...metadata,
            phase: 'events',
            batch: {
              packages: [],
              repositories: [],
              workflows: [],
              runs: [],
              events: batch.events
            }
          }
        };
        await Promise.all(missing.map(async ([phase, outputPath]) => {
          const temporaryPath = `${outputPath}.${process.pid}.tmp`;
          await writeFile(temporaryPath, JSON.stringify(payloads[phase]));
          await rename(temporaryPath, outputPath);
        }));
      }
      for (const [phase, outputPath] of outputPaths) {
        if (!await payloadHasRecords(outputPath)) {
          await rm(outputPath, { force: true });
          debugHash('dropped empty %s shard %s', phase, outputPath);
          continue;
        }
        retainedPayloads[phase].add(path.basename(outputPath));
        hashes[`${path.basename(path.dirname(outputPath))}/${path.basename(outputPath)}`] = await hashFile(outputPath);
      }
    }
    for (const [phase, directory] of [
      ['normalized', normalizedDirectory],
      ['runs', runsDirectory],
      ['events', eventsDirectory]
    ].filter(([, directory]) => Boolean(directory))) {
      for (const name of await readdir(directory)) {
        if (name.endsWith('.json') && !retainedPayloads[phase].has(name)) {
          await rm(path.join(directory, name), { force: true });
        }
      }
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
 * and reports the size of the SQLite payload, retained wildcard shard files,
 * and recorded payload hash files. Shards are audited sequentially so the
 * raw/duplicate run-observation counts are available per inspected run.
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
    stats.sqlite = await fileSizeStats(path.join(directory, 'gh-aw-logs.sqlite'));
    stats.shards = await shardSizeStats(path.join(directory, 'gh-aw-logs-shards'));
    stats.hashFiles = await hashFileNames(path.join(directory, 'payload-hashes.json'));
    if (stats.shards.length > 0) {
      const audit = await auditJsonlDirectory(path.join(directory, 'gh-aw-logs-shards'));
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
 * duration, SQLite payload size, retained shard files, recorded
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
  if (!repo) throw new UsageError('Missing required option --repo (or GITHUB_REPOSITORY environment variable)');
  const limitCount = Number(limit);
  if (!Number.isInteger(limitCount) || limitCount < 1) throw new UsageError('--limit must be a positive integer');

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
    totalShardBytes: withArtifact.reduce(
      (sum, entry) => sum + entry.shards.reduce((shardSum, shard) => shardSum + shard.sizeBytes, 0),
      0
    ),
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

function normalizedWorkflowAliases(workflow) {
  return [workflow.id, workflow.name, workflow.path]
    .filter((value) => typeof value === 'string' && value)
    .flatMap((value) => {
      const normalized = value.toLowerCase();
      const basename = normalized.split('/').at(-1) ?? normalized;
      return [normalized, basename, basename.replace(/\.(?:md|ya?ml)$/, '')];
    });
}

function matchesWorkflow(workflow, value) {
  if (!value) return true;
  const normalized = value.toLowerCase();
  const basename = normalized.split('/').at(-1) ?? normalized;
  const aliases = normalizedWorkflowAliases(workflow);
  return aliases.includes(normalized)
    || aliases.includes(basename)
    || aliases.includes(basename.replace(/\.(?:md|ya?ml)$/, ''));
}

function githubEntityUrl(value) {
  if (typeof value !== 'string') return undefined;
  try {
    const url = new URL(value);
    if (url.hostname.toLowerCase() !== 'github.com') return undefined;
    const match = url.pathname.match(/^\/([^/]+\/[^/]+)\/(issues|pull)\/(\d+)(?:\/|$)/);
    if (!match) return undefined;
    return { repository: match[1], number: Number(match[3]), url: value };
  } catch {
    return undefined;
  }
}

function recordTimestamp(record, fields) {
  for (const field of fields) {
    const timestamp = Date.parse(String(record[field] ?? ''));
    if (Number.isFinite(timestamp)) return timestamp;
  }
  return Number.NEGATIVE_INFINITY;
}

function inTimeRange(timestamp, range) {
  return (range.since === undefined || timestamp >= range.since)
    && (range.until === undefined || timestamp <= range.until);
}

export async function queryGhData(indexedDB, resource, options) {
  if (!GH_RESOURCES.has(resource)) throw new Error(`Unknown gh resource: ${resource}`);
  const [repositories, workflows, runs, events] = await Promise.all([
    readCollection(indexedDB, 'repositories'),
    readCollection(indexedDB, 'workflows'),
    readCollection(indexedDB, 'runs'),
    readCollection(indexedDB, 'events')
  ]);
  const repositoryFilter = option(options, 'repo', false)?.toLowerCase();
  const workflowFilter = option(options, 'workflow', false);
  const range = ghTimeRange(options);
  const repositoriesById = new Map(repositories.map((record) => [record.id, record]));
  const workflowsById = new Map(workflows.map((record) => [record.id, record]));
  const runsById = new Map(runs.map((record) => [record.id, record]));
  const sourceRepository = (run) => repositoriesById.get(run.repositoryId) ?? {};
  const sourceWorkflow = (run) => workflowsById.get(run.workflowId) ?? {};

  let records;
  if (resource === 'runs') {
    const statusFilter = option(options, 'status', false)?.toLowerCase();
    records = runs.filter((run) => {
      const repository = sourceRepository(run);
      const workflow = sourceWorkflow(run);
      const fullName = String(repository.fullName ?? run.repositoryFullName ?? '').toLowerCase();
      const timestamp = recordTimestamp(run, ['startedAt', 'createdAt', 'updatedAt', 'observedAt']);
      return (!repositoryFilter || fullName === repositoryFilter)
        && matchesWorkflow(workflow, workflowFilter)
        && (!statusFilter || [run.status, run.conclusion]
          .some((value) => String(value ?? '').toLowerCase() === statusFilter))
        && inTimeRange(timestamp, range);
    });
  } else {
    const entityType = resource === 'issues' ? 'issue' : 'pull_request';
    const safeOutputType = resource === 'issues' ? 'create_issue' : 'create_pull_request';
    records = events
      .filter((event) => (
        event.type === 'safe_output.created'
        && event.githubEntityType === entityType
        && event.safeOutputType === safeOutputType
      ))
      .map((event) => {
        const run = runsById.get(event.runId) ?? {};
        const workflow = sourceWorkflow(run);
        const executionRepository = sourceRepository(run);
        const target = githubEntityUrl(event.correlationId);
        return {
          id: event.id,
          number: target?.number ?? null,
          repository: target?.repository ?? executionRepository.fullName ?? null,
          workflow: workflow.path ?? workflow.name ?? null,
          workflowName: workflow.name ?? null,
          workflowId: workflow.id ?? null,
          createdAt: event.timestamp ?? event.observedAt ?? null,
          url: target?.url ?? null,
          type: event.safeOutputType ?? null,
          status: event.status ?? null,
          summary: event.summary ?? null,
          runId: run.id ?? null,
          githubRunId: run.githubRunId ?? null
        };
      })
      .filter((record) => (
        (!repositoryFilter || String(record.repository ?? '').toLowerCase() === repositoryFilter)
        && matchesWorkflow({
          id: record.workflowId,
          path: record.workflow,
          name: record.workflowName
        }, workflowFilter)
        && inTimeRange(recordTimestamp(record, ['createdAt']), range)
      ));
  }

  const timestampFields = resource === 'runs'
    ? ['startedAt', 'createdAt', 'updatedAt', 'observedAt']
    : ['createdAt'];
  return records
    .sort((left, right) => recordTimestamp(right, timestampFields) - recordTimestamp(left, timestampFields))
    .slice(0, ghQueryLimit(options));
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
    const events = (await Promise.all(
      runs.map((run) => queries.events.forRun(String(run.id)))
    )).flat();
    return { result, runs, events };
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

export async function runCli(arguments_, input = process.stdin) {
  const [command, ...optionArguments] = arguments_;
  if (!command || command === '--help' || command === 'help') return USAGE;
  if (command === 'init') {
    if (optionArguments.length > 0) throw new UsageError(`Unexpected argument: ${optionArguments[0]}`);
    return initializeCaoPolicy();
  }
  if (command === 'add') {
    return addCaoPackage(optionArguments[0], optionArguments.slice(1));
  }
  if (command === 'update') {
    return updateCaoPackages(optionArguments);
  }
  if (command === 'mode') {
    return setCaoPackageMode(optionArguments[0], optionArguments.slice(1));
  }
  if (!COMMANDS.has(command) && arguments_.length === 2) {
    return runLegacyIngestion(command, optionArguments[0]);
  }
  const ghResource = command === 'gh' ? optionArguments[0] : undefined;
  if (command === 'gh' && (!ghResource || ghResource === 'help' || ghResource === '--help')) return USAGE;
  const options = parseOptions(command === 'gh' ? optionArguments.slice(1) : optionArguments);
  if (options.help) return USAGE;
  if (command === 'download') {
    rejectUnknownOptions(options, ['url', 'output']);
    return downloadDeployedDashboardData({
      url: option(options, 'url', false),
      output: option(options, 'output', false)
    });
  }
  if (command === 'audit-jsonl') {
    rejectUnknownOptions(options, ['input-dir']);
    return auditJsonlDirectory(option(options, 'input-dir', false) || DEFAULT_SHARDS_PATH);
  }
  if (command === 'compact-jsonl') {
    rejectUnknownOptions(options, ['input-dir', 'group']);
    const groups = options.group
      ? Array.isArray(options.group) ? options.group : [options.group]
      : [];
    return compactJsonlShards(
      path.resolve(option(options, 'input-dir')),
      groups
    );
  }
  if (command === 'hash-payloads') {
    rejectUnknownOptions(options, ['database', 'shard-dir', 'normalized-dir', 'runs-dir', 'events-dir', 'inventory', 'output']);
    const hashes = await hashActivityPayloads({
      databasePath: option(options, 'database', false) ? path.resolve(option(options, 'database', false)) : undefined,
      shardDirectory: option(options, 'shard-dir', false) ? path.resolve(option(options, 'shard-dir', false)) : undefined,
      normalizedDirectory: option(options, 'normalized-dir', false)
        ? path.resolve(option(options, 'normalized-dir', false))
        : undefined,
      runsDirectory: option(options, 'runs-dir', false)
        ? path.resolve(option(options, 'runs-dir', false))
        : undefined,
      eventsDirectory: option(options, 'events-dir', false)
        ? path.resolve(option(options, 'events-dir', false))
        : undefined,
      inventoryPath: option(options, 'inventory', false) ? path.resolve(option(options, 'inventory', false)) : undefined
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

  if (command === 'gh') {
    rejectUnknownOptions(options, ['database', 'repo', 'workflow', 'status', 'since', 'until', 'limit']);
    if (ghResource !== 'runs' && options.status) {
      throw new UsageError('--status is only supported for cao gh runs');
    }
    return queryGhData(indexedDB, ghResource, options);
  }

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
    rejectUnknownOptions(options, ['database', 'input', 'input-dir', 'runs-dir', 'events-dir', 'context', 'retention-days', 'run-retention-days']);
    const inputPath = option(options, 'input', false);
    const inputDirectory = option(options, 'input-dir', false);
    if (inputPath && inputDirectory) throw new UsageError('Options --input and --input-dir cannot be combined');
    const contextPath = option(options, 'context', false);
    const context = contextPath
      ? JSON.parse(await readFile(path.resolve(contextPath), 'utf8'))
      : undefined;
    const ingestOptions = {
      retentionWindowMs: retentionWindowMs(options),
      retentionWindowMsByStore: { runs: runRetentionWindowMs(options) },
      context
    };
    const runsDirectory = option(options, 'runs-dir', false);
    const eventsDirectory = option(options, 'events-dir', false);
    if (Boolean(runsDirectory) !== Boolean(eventsDirectory)) {
      throw new Error('--runs-dir and --events-dir must be provided together');
    }
    if ((inputPath || inputDirectory) && runsDirectory) {
      throw new Error('Phased shard directories cannot be combined with --input or --input-dir');
    }
    const result = runsDirectory && eventsDirectory
      ? await ingestNormalizedShardDirectories(indexedDB, [
          ['runs', path.resolve(runsDirectory)],
          ['events', path.resolve(eventsDirectory)]
        ], ingestOptions)
      : inputPath
        ? await ingestJsonlFile(indexedDB, path.resolve(inputPath), ingestOptions)
        : await ingestJsonlShardDirectory(indexedDB, path.resolve(inputDirectory || DEFAULT_SHARDS_PATH), ingestOptions);
    return { result, counts: await databaseCounts(indexedDB) };
  }
  if (command === 'query') {
    rejectUnknownOptions(options, ['database', 'collection', 'id', 'where', 'limit', 'stdin']);
    return rawQuery
      ? queryRawCanonicalData(indexedDB, rawQuery)
      : queryCanonicalData(indexedDB, options);
  }
  throw new UsageError(`Unknown command: ${command}`);
}

async function main() {
  const output = await runCli(process.argv.slice(2));
  process.stdout.write(`${typeof output === 'string' ? output : JSON.stringify(output, null, 2)}\n`);
  if (typeof output === 'object' && output?.command === 'doctor' && !output.healthy) process.exitCode = 2;
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  main().catch((error) => {
    const message = error instanceof UsageError
      ? `Error: ${error.message}`
      : error instanceof Error
        ? error.stack || `${error.name}: ${error.message}`
        : String(error);
    process.stderr.write(`${message}\n\n${USAGE}\n`);
    process.exitCode = 1;
  });
}
