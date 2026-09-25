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
import { setTimeout as delay } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';
import { createDebug } from './debug.mjs';
import { adaptCachedGhAwJsonlStream, createCachedJsonlPayloadHasher } from '../dashboard/site/src/data/adapters/gh-aw-logs.js';
import {
  finalizeNormalizedJsonlIngestion,
  ingestCachedGhAwJsonl,
  ingestGhAwLogs,
  ingestNormalizedJsonl,
  isCachedGhAwJsonlCurrent,
  NORMALIZED_JSONL_INGESTION_VERSION
} from '../dashboard/site/src/data/ingest/coordinator.js';
import { normalize } from '../dashboard/site/src/data/normalize/index.js';
import { CANONICAL_SCHEMA_VERSION } from '../dashboard/site/src/data/model/schema.js';
import { executeDashboardQuery, queryInputNames } from '../dashboard/site/src/data/queries/declarative.js';
import { createCanonicalQueries } from '../dashboard/site/src/data/queries/index.js';
import { readCollection, readRecord, readTransactions } from '../dashboard/site/src/data/storage/indexeddb.js';
import { mergeActivityStructuralRecord } from '../dashboard/site/src/data/storage/retention.js';
import { doctorSqliteDatabase } from '../dashboard/site/src/data/storage/sqlite-doctor.js';
import { installSqliteIndexedDB } from '../dashboard/site/src/data/storage/sqlite-indexeddb.js';
import {
  operationalValueReserve,
  REPOSITORY_COORDINATE,
  runOperationalValue
} from './operational-value.mjs';
import { runProblemClustering } from './problem-clustering.mjs';
import { discoverInventory } from './inventory.mjs';
import { discoverInventoryDashboardSources } from './inventory-sources.mjs';
import { hasComputation, queryComputation } from './computations/index.mjs';
import {
  analyzeDashboardComplexity,
  formatDashboardComplexityMarkdown,
  readDashboardTableCounts
} from './dashboard-complexity.mjs';
import { pruneDashboardDocument } from './dashboard-prune.mjs';

const debug = createDebug('ingest');
const debugHash = createDebug('hash-payloads');

const ENTITY_COLLECTIONS = [
  'repositories',
  'workflows',
  'runs',
  'domains',
  'tools',
  'audits',
  'issues',
  'operationalValues'
];
const NORMALIZED_COLLECTIONS = ['campaigns', ...ENTITY_COLLECTIONS];
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
const DEFAULT_ISSUE_STATUS_BATCH_SIZE = 50;
const DEFAULT_ISSUE_STATUS_GRAPHQL_COST_BUDGET = 25;
const DEFAULT_ISSUE_STATUS_GRAPHQL_MIN_REMAINING = 500;
const DEFAULT_COMPACTED_JSONL_SHARD_BYTES = 4 * 1024 * 1024;
// Per-shard normalization output is retained only as an incremental cache. It lives
// in a subdirectory so it is never published, hashed into the manifest, or ingested.
const PAYLOAD_CACHE_DIRECTORY = '.payloads';
// Structural collections are owned by inventory discovery rather than by any single
// run, so they are consolidated into one leading bucket that sorts before day buckets.
const STRUCTURAL_CONSOLIDATION_COLLECTIONS = new Set(['campaigns', 'repositories', 'workflows']);
const STRUCTURAL_CONSOLIDATION_BUCKET = '0000-00-00';
const CONSOLIDATION_TIMESTAMP_FIELDS = [
  'startedAt',
  'observedAt',
  'timestamp',
  'completedAt',
  'createdAt',
  'updatedAt'
];
const GH_AW_INSTALLER_COMMAND = 'curl --fail --silent --show-error --location https://raw.githubusercontent.com/github/gh-aw/main/install-gh-aw.sh | bash -s -- "$1"';
const CAO_SCHEMA_URL = 'https://raw.githubusercontent.com/githubnext/gh-aw-cao/main/.github/workflows/shared/cao.schema.json';
const DEFAULT_POLICY_PATH = '.github/workflows/cao.json';
const GH_RESOURCES = new Set(['runs', 'issues', 'prs']);
const COMMANDS = new Set(['init', 'setup-auth', 'add', 'update', 'mode', 'enable', 'disable', 'discover-workflows', 'dashboard-complexity', 'prune-dashboard', 'ingest', 'ingest-jsonl', 'audit-jsonl', 'compact-jsonl', 'issue-status', 'query', 'computation', 'operational-value', 'cluster-problems', 'doctor', 'download', 'hash-payloads', 'activity-stats', 'gh']);

// Intentional CLI misuse that should print usage without an internal stack trace.
class UsageError extends Error {}

const USAGE = `Usage:
  cao init
  cao setup-auth github-app [--repo OWNER/REPO] [APP_SETUP_OPTIONS...]
  cao setup-auth enterprise-app --repo OWNER/REPO --read-client-id ID --write-client-id ID [--dry-run]
  cao setup-auth token [--repo OWNER/REPO] --acknowledge-token-risks
  cao setup-auth workflow-token
  cao add CAMPAIGN [GH_AW_ADD_OPTIONS...]
  cao update [--pre-releases] [GH_AW_UPDATE_OPTIONS...]
  cao mode (live|preview) CAMPAIGN...
  cao enable CAMPAIGN...
  cao disable CAMPAIGN...
  cao discover-workflows --control-settings FILE --inventory FILE --output FILE --repo OWNER/REPO [--root DIRECTORY]
  cao dashboard-complexity [QUERY_ID] --input FILE [--database FILE] [--format json|markdown] [--limit COUNT]
  cao prune-dashboard --input FILE [--output FILE]
  cao ingest [--database FILE] --context CONTEXT_JSON --logs LOG_DIRECTORY [--retention-days DAYS|all] [--run-retention-days DAYS|all]
  cao ingest-jsonl [--database FILE] [--input FILE|--input-dir SHARD_DIRECTORY|--runs-dir DIRECTORY --records-dir DIRECTORY] [--context CONTEXT_JSON] [--retention-days DAYS|all] [--run-retention-days DAYS|all]
  cao audit-jsonl [--input-dir SHARD_DIRECTORY]
  cao compact-jsonl --input-dir SHARD_DIRECTORY --group OWNER/REPOSITORY=SHARD_PREFIX [--group OWNER/REPOSITORY=SHARD_PREFIX...] [--max-bytes BYTES]
  cao issue-status [--database FILE] --input-dir SHARD_DIRECTORY [--batch-size COUNT] [--graphql-cost-budget POINTS] [--graphql-min-remaining POINTS]
  cao query [--database FILE] (--collection NAME [--id ID] [--where FIELD=VALUE] [--limit COUNT] | --stdin)
  cao computation runtime-health [--database FILE] [--inventory FILE] [--campaign SLUG] [--diagnose]
  cao operational-value [--database FILE] [--root DIRECTORY] [--output FILE] [--timestamp TIME] [--repository OWNER/REPO] [--retention-days DAYS|all] [--max-github-api-rate-limit LIMIT]
  cao cluster-problems [--database FILE] [--root DIRECTORY] [--timestamp TIME]
  cao doctor [--database FILE] [--ttl-days DAYS|all] [--run-ttl-days DAYS|all]
  cao download [--url URL] [--output DIRECTORY]
  cao hash-payloads [--database FILE] [--shard-dir SHARD_DIRECTORY] [--normalized-dir DIRECTORY] [--runs-dir DIRECTORY] [--records-dir DIRECTORY] [--inventory FILE] [--output FILE]
  cao activity-stats [--repo OWNER/REPO] [--workflow FILE] [--artifact NAME] [--limit COUNT] [--keep] [--output FILE]
  cao gh runs [--database FILE] [--repo OWNER/REPO] [--workflow NAME|FILE] [--status STATUS] [--since TIME] [--until TIME] [--limit COUNT]
  cao gh issues [--database FILE] [--repo OWNER/REPO] [--workflow NAME|FILE] [--since TIME] [--until TIME] [--limit COUNT]
  cao gh prs [--database FILE] [--repo OWNER/REPO] [--workflow NAME|FILE] [--since TIME] [--until TIME] [--limit COUNT]

Query local CAO data as JSON. Download the deployed snapshot before querying:
  cao download
  cao dashboard-complexity --input dashboard/site/dashboard.json
  cao dashboard-complexity campaign-inventory --input dashboard/site/dashboard.json
  cao prune-dashboard --input dashboard.json --output dashboard.pruned.json
  cao issue-status --input-dir .cao/gh-aw-logs-shards --graphql-cost-budget 25 --graphql-min-remaining 500
  cao computation runtime-health
  cao computation runtime-health --campaign dependabot
  cao computation runtime-health --campaign dependabot --diagnose
  cao operational-value --output .cao/gh-aw-logs-shards/operational-values.jsonl --max-github-api-rate-limit -2000
  cao cluster-problems
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

Operational value scripts:
  cao operational-value discovers <package>/operational-value.mjs below --root.
  Each script receives one JSON request on stdin and emits JSONL records with
  timestamp, repository, valueId, and a finite numeric value.

Problem clustering scripts:
  cao cluster-problems discovers <package>/problem-clustering.mjs below --root.
  Each script receives one JSON request on stdin and emits bounded JSONL problem
  records with actionable fixPrompt fields. Successful output replaces that
  package's rows in cao_problems.

`;

function isMapping(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function validateCampaignDeclaration(document, source) {
  if (!isMapping(document)) throw new Error(`${source} must contain a JSON object`);
  const keys = Object.keys(document);
  const unknown = keys.filter((key) => !['campaign', 'orchestrator', 'workers'].includes(key));
  if (unknown.length > 0) throw new Error(`${source} contains unknown key: ${unknown[0]}`);
  const slug = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
  if (typeof document.campaign !== 'string' || !slug.test(document.campaign)) {
    throw new Error(`${source} campaign must be a kebab-case identifier`);
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
    'control-plane': { campaigns: {} }
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

export function setupCaoAuthentication(method, arguments_ = [], {
  execute = spawnSync
} = {}) {
  if (method === 'github-app') {
    const script = path.join('.github', 'workflows', 'shared', 'setup-github-apps.mjs');
    const result = execute(process.execPath, [script, ...arguments_], { stdio: 'inherit' });
    if (result.error || result.status !== 0) {
      throw new Error(`GitHub App setup failed: ${commandFailureMessage(result, `exit ${result.status}`)}`);
    }
    return { command: 'setup-auth', profile: 'github-app' };
  }
  if (method === 'enterprise-app') {
    const options = parseOptions(arguments_);
    rejectUnknownOptions(options, ['repo', 'read-client-id', 'write-client-id', 'dry-run']);
    const repo = option(options, 'repo');
    const credentials = [
      {
        role: 'read',
        clientId: option(options, 'read-client-id'),
        variable: 'GH_AW_GITHUB_READ_APP_ID',
        secret: 'GH_AW_GITHUB_READ_APP_PRIVATE_KEY',
      },
      {
        role: 'write',
        clientId: option(options, 'write-client-id'),
        variable: 'GH_AW_GITHUB_WRITE_APP_ID',
        secret: 'GH_AW_GITHUB_WRITE_APP_PRIVATE_KEY',
      },
    ];
    if (options['dry-run']) {
      return {
        command: 'setup-auth',
        profile: 'enterprise-app',
        repo,
        credentials: credentials.map(({ role, clientId, variable, secret }) => ({
          role, clientId, variable, secret,
        })),
      };
    }
    const auth = execute('gh', ['auth', 'status'], { encoding: 'utf8' });
    if (auth.error || auth.status !== 0) {
      throw new Error(`GitHub CLI authentication check failed: ${commandFailureMessage(auth, 'gh auth status failed')}`);
    }
    for (const credential of credentials) {
      const variableResult = execute('gh', [
        'variable', 'set', credential.variable, '--repo', repo, '--body', credential.clientId,
      ], { encoding: 'utf8' });
      if (variableResult.error || variableResult.status !== 0) {
        throw new Error(`Enterprise App variable setup failed: ${commandFailureMessage(variableResult, `exit ${variableResult.status}`)}`);
      }
      const secretResult = execute('gh', [
        'secret', 'set', credential.secret, '--repo', repo,
      ], { stdio: 'inherit' });
      if (secretResult.error || secretResult.status !== 0) {
        throw new Error(`Enterprise App private-key setup failed: ${commandFailureMessage(secretResult, `exit ${secretResult.status}`)}`);
      }
    }
    return { command: 'setup-auth', profile: 'enterprise-app', repo };
  }
  if (method === 'token') {
    const options = parseOptions(arguments_);
    rejectUnknownOptions(options, ['repo', 'acknowledge-token-risks']);
    if (!options['acknowledge-token-risks']) {
      throw new UsageError(
        'token setup requires --acknowledge-token-risks after reviewing the user-bound, '
        + 'single-owner, expiration, approval, rotation, and API compatibility limits',
      );
    }
    const repo = option(options, 'repo', false);
    const auth = execute('gh', ['auth', 'status'], { encoding: 'utf8' });
    if (auth.error || auth.status !== 0) {
      throw new Error(`GitHub CLI authentication check failed: ${commandFailureMessage(auth, 'gh auth status failed')}`);
    }
    const secretArguments = ['secret', 'set', 'GH_AW_GITHUB_TOKEN'];
    if (repo) secretArguments.push('--repo', repo);
    const result = execute('gh', secretArguments, { stdio: 'inherit' });
    if (result.error || result.status !== 0) {
      throw new Error(`Fine-grained token setup failed: ${commandFailureMessage(result, `exit ${result.status}`)}`);
    }
    return {
      command: 'setup-auth',
      profile: 'fine-grained-token',
      secret: 'GH_AW_GITHUB_TOKEN',
      ...(repo ? { repo } : {}),
    };
  }
  if (method === 'workflow-token') {
    if (arguments_.length > 0) throw new UsageError(`Unexpected argument: ${arguments_[0]}`);
    return {
      command: 'setup-auth',
      profile: 'workflow-token',
      configured: true,
      limitation: 'Use only for control-repository work or bounded public-target review.',
    };
  }
  throw new UsageError('cao setup-auth requires github-app, enterprise-app, token, or workflow-token');
}

function validateGlobalPolicy(document, source) {
  if (!isMapping(document) || document.version !== 1) throw new Error(`${source} must declare version 1`);
  if (document['control-plane'] !== undefined && !isMapping(document['control-plane'])) {
    throw new Error(`${source} control-plane must be an object`);
  }
  if (document['control-plane']?.campaigns !== undefined && !isMapping(document['control-plane'].campaigns)) {
    throw new Error(`${source} control-plane.campaigns must be an object`);
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

function mergeCaoCampaignDeclaration(policy, declaration) {
  const controlPlane = policy['control-plane'] ?? {};
  const campaigns = controlPlane.campaigns ?? {};
  const existingCampaign = isMapping(campaigns[declaration.campaign]) ? campaigns[declaration.campaign] : {};
  const existingWorkers = isMapping(existingCampaign.workers) ? existingCampaign.workers : {};
  const workers = Object.fromEntries(Object.entries(declaration.workers).map(([worker, workflow]) => {
    const existing = isMapping(existingWorkers[worker]) ? existingWorkers[worker] : {};
    const preserved = {};
    if (typeof existing.enabled === 'boolean') preserved.enabled = existing.enabled;
    if (existing['max-mode'] === 'review' || existing['max-mode'] === 'live') preserved['max-mode'] = existing['max-mode'];
    return [worker, { workflow, ...preserved }];
  }));
  policy['control-plane'] = {
    ...controlPlane,
    campaigns: {
      ...campaigns,
      [declaration.campaign]: {
        ...existingCampaign,
        workers
      }
    }
  };
}

function campaignSlugFromSpec(spec) {
  const refSeparator = spec.lastIndexOf('@');
  const withoutRef = refSeparator > spec.indexOf('/') ? spec.slice(0, refSeparator) : spec;
  const slug = withoutRef.replace(/\/+$/, '').split('/').pop();
  if (!slug || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug)) {
    throw new Error(`Unable to determine campaign name from ${spec}`);
  }
  return slug;
}

function resolvePathWithinRoot(root, destination) {
  const resolved = path.resolve(root, destination);
  const canonicalRoot = realpathSync(root);
  let canonicalPath;
  try {
    canonicalPath = realpathSync(resolved);
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
    const missingSegments = [];
    let existingAncestor = resolved;
    while (true) {
      missingSegments.unshift(path.basename(existingAncestor));
      existingAncestor = path.dirname(existingAncestor);
      try {
        canonicalPath = path.join(realpathSync(existingAncestor), ...missingSegments);
        break;
      } catch (ancestorError) {
        if (ancestorError?.code !== 'ENOENT') throw ancestorError;
      }
    }
  }
  const relative = path.relative(canonicalRoot, canonicalPath);
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error(`Installed package destination escapes the repository: ${destination}`);
  }
  return resolved;
}

async function installedCampaignRecords(root = process.cwd(), { caoOnly = true } = {}) {
  const records = new Map();
  for (const directory of ['campaigns', 'packages']) {
    let recordsDirectory;
    let entries;
    try {
      recordsDirectory = resolvePathWithinRoot(root, path.join('.github', 'aw', directory));
      entries = await readdir(recordsDirectory, { withFileTypes: true });
    } catch (error) {
      if (error?.code === 'ENOENT') continue;
      throw error;
    }
    for (const entry of entries) {
      if (entry.isDirectory() || !entry.name.endsWith('.json')) continue;
      const recordPath = resolvePathWithinRoot(root, path.join(recordsDirectory, entry.name));
      let record;
      try {
        record = JSON.parse(await readFile(recordPath, 'utf8'));
      } catch (error) {
        if (error instanceof SyntaxError) throw new Error(`${path.relative(root, recordPath)} contains invalid JSON: ${error.message}`);
        throw error;
      }
      const campaignName = typeof record.package === 'string' && record.package.trim()
        ? record.package.trim()
        : typeof record.campaign === 'string' && record.campaign.trim()
          ? record.campaign.trim()
          : typeof record.source === 'string'
            ? record.source.split('@')[0].trim()
            : '';
      if (!campaignName || (caoOnly
        && campaignName !== 'githubnext/gh-aw-cao'
        && !campaignName.startsWith('githubnext/gh-aw-cao/'))) {
        continue;
      }
      records.set(campaignName, {
        campaign: campaignName,
        source: typeof record.source === 'string' ? record.source : campaignName,
        resolvedCommit: typeof record.resolvedCommit === 'string' && record.resolvedCommit.trim()
          ? record.resolvedCommit.trim()
          : '',
        record,
        recordPath
      });
    }
  }
  return [...records.values()].sort((left, right) => left.campaign.localeCompare(right.campaign));
}

function materializeInstalledCao(campaign, execute = spawnSync) {
  const script = path.join('.github', 'workflows', 'shared', 'materialize-cao.mjs');
  const result = execute(process.execPath, [script, 'materialize', campaign], {
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024
  });
  if (result.error || result.status !== 0) {
    throw new Error(`Unable to materialize CAO ${campaign}: ${commandFailureMessage(result, 'materializer failed')}`);
  }
}

function installedPackageUpdateTarget(campaign) {
  return `https://github.com/${campaign}`;
}

async function prepareInstalledPackageReleaseSource(
  record,
  releaseTags,
  execute,
  { includePrereleases = false, allowMajor = false } = {}
) {
  if (!record.record || !record.recordPath) return undefined;
  const sourceRef = record.source.split('@').at(-1);
  const sourceIsCommit = /^[0-9a-f]{40}$/i.test(sourceRef);
  const sourceIsRelease = /^v[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?$/.test(sourceRef);
  if (!sourceIsCommit && !(includePrereleases && sourceIsRelease)) return undefined;
  if (sourceIsCommit && !/^[0-9a-f]{40}$/i.test(record.resolvedCommit)) {
    throw new Error(`Installed CAO package record has an invalid resolvedCommit: ${record.resolvedCommit || '(missing)'}`);
  }
  let releaseTag = sourceIsRelease ? sourceRef : releaseTags.get(record.resolvedCommit);
  if (!releaseTag) {
    const tags = execute('gh', [
      'api',
      '--paginate',
      '/repos/githubnext/gh-aw-cao/tags',
      '--jq',
      `.[] | select(.commit.sha == "${record.resolvedCommit}") | .name`
    ], { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
    if (tags.error || tags.status !== 0) {
      throw new Error(`Unable to resolve CAO tag for ${record.resolvedCommit}: ${commandFailureMessage(tags, 'gh api failed')}`);
    }
    const candidates = String(tags.stdout || '').trim().split(/\s+/)
      .filter((tag) => /^v[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?$/.test(tag));
    for (const candidate of candidates) {
      const prereleaseFilter = includePrereleases ? 'true' : '.prerelease == false';
      const release = execute('gh', [
        'api',
        `/repos/githubnext/gh-aw-cao/releases/tags/${encodeURIComponent(candidate)}`,
        '--jq',
        `select(.draft == false and ${prereleaseFilter}) | .tag_name`
      ], { encoding: 'utf8' });
      if (!release.error && release.status === 0 && String(release.stdout || '').trim() === candidate) {
        releaseTag = candidate;
        break;
      }
    }
    if (!releaseTag) {
      throw new Error(`No CAO release tag found for ${record.resolvedCommit}`);
    }
    releaseTags.set(record.resolvedCommit, releaseTag);
  }
  if (includePrereleases) {
    const releases = execute('gh', [
      'api',
      '--paginate',
      '/repos/githubnext/gh-aw-cao/releases?per_page=100',
      '--jq',
      '.[] | select(.draft == false) | .tag_name'
    ], { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
    if (releases.error || releases.status !== 0) {
      throw new Error(`Unable to list CAO releases: ${commandFailureMessage(releases, 'gh api failed')}`);
    }
    const currentMajor = ghAwVersionParts(releaseTag).numbers[0];
    releaseTag = String(releases.stdout || '').trim().split(/\s+/)
      .filter((tag) => /^v[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?$/.test(tag))
      .filter((tag) => allowMajor || ghAwVersionParts(tag).numbers[0] === currentMajor)
      .filter((tag) => compareGhAwVersions(tag, releaseTag) >= 0)
      .sort(compareGhAwVersions)
      .at(-1) ?? releaseTag;
  }
  const prepared = {
    record: structuredClone(record.record),
    writtenRecord: undefined,
    workflows: new Map()
  };
  try {
    record.record.source = `${record.campaign}@${releaseTag}`;
    for (const file of record.record.files ?? []) {
      if (!file.destination?.endsWith('.md')) continue;
      const workflowPath = resolvePathWithinRoot(process.cwd(), file.destination);
      let content;
      try {
        content = await readFile(workflowPath, 'utf8');
      } catch (error) {
        if (error?.code === 'ENOENT') continue;
        throw error;
      }
      const sourcePrefix = `source: ${record.campaign}@`;
      const lines = content.split(/\r?\n/);
      const sourceIndex = lines.findIndex((line) => line.startsWith(sourcePrefix));
      if (sourceIndex === -1) continue;
      lines[sourceIndex] = `${sourcePrefix}${releaseTag}`;
      const updated = lines.join(content.includes('\r\n') ? '\r\n' : '\n');
      prepared.workflows.set(workflowPath, { original: content, written: updated });
      await writeFile(workflowPath, updated);
      file.sha256 = createHash('sha256').update(updated).digest('hex');
    }
    prepared.writtenRecord = structuredClone(record.record);
    await writeJsonAtomically(record.recordPath, record.record);
    return prepared;
  } catch (error) {
    for (const [workflowPath, content] of prepared.workflows) await writeFile(workflowPath, content.original);
    await writeJsonAtomically(record.recordPath, prepared.record);
    throw error;
  }
}

async function restorePreparedPackageSource(record, prepared) {
  if (!prepared) return;
  for (const [workflowPath, content] of prepared.workflows) {
    let current;
    try {
      current = await readFile(workflowPath, 'utf8');
    } catch (error) {
      if (error?.code === 'ENOENT') continue;
      throw error;
    }
    if (current === content.written) await writeFile(workflowPath, content.original);
  }
  let currentRecord;
  try {
    currentRecord = JSON.parse(await readFile(record.recordPath, 'utf8'));
  } catch {
    return;
  }
  if (JSON.stringify(currentRecord) === JSON.stringify(prepared.writtenRecord)) {
    await writeJsonAtomically(record.recordPath, prepared.record);
  }
}

async function readInstalledCaoDeclaration(campaignName) {
  const expectedCampaign = campaignSlugFromSpec(campaignName);
  const declarationPath = path.resolve(expectedCampaign, 'cao.json');
  let declaration;
  try {
    declaration = validateCampaignDeclaration(
      JSON.parse(await readFile(declarationPath, 'utf8')),
      path.relative(process.cwd(), declarationPath)
    );
  } catch (error) {
    if (error?.code === 'ENOENT') return undefined;
    if (error instanceof SyntaxError) throw new Error(`Campaign ${expectedCampaign} installed invalid cao.json: ${error.message}`);
    throw error;
  }
  if (declaration.campaign !== expectedCampaign) {
    throw new Error(`Installed CAO declaration names campaign ${declaration.campaign}, expected ${expectedCampaign}`);
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

export async function addCaoCampaign(campaignSpec, ghAwOptions = [], {
  policyPath = DEFAULT_POLICY_PATH,
  execute = spawnSync
} = {}) {
  if (!campaignSpec || campaignSpec.startsWith('-')) throw new UsageError('cao add requires a campaign');
  const expectedCampaign = campaignSlugFromSpec(campaignSpec);
  if (expectedCampaign === 'gh-aw-cao') {
    throw new UsageError('cao add cannot install the CAO root package; use install.sh');
  }
  const install = execute('gh', ['aw', 'add', campaignSpec, ...ghAwOptions], {
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024
  });
  if (install.error || install.status !== 0) {
    throw new Error(`gh aw add failed: ${commandFailureMessage(install, 'unknown error')}`);
  }

  materializeInstalledCao(expectedCampaign, execute);
  const declaration = await readInstalledCaoDeclaration(campaignSpec);
  if (!declaration) throw new Error(`Campaign ${expectedCampaign} did not install ${expectedCampaign}/cao.json`);

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

  mergeCaoCampaignDeclaration(policy, declaration);
  await writeJsonAtomically(absolutePolicyPath, policy);
  return {
    command: 'add',
    campaign: declaration.campaign,
    orchestrator: declaration.orchestrator,
    workers: Object.keys(declaration.workers),
    policy: policyPath
  };
}

export async function updateCaoCampaigns(ghAwOptions = [], {
  policyPath = DEFAULT_POLICY_PATH,
  execute = spawnSync
} = {}) {
  const includePrereleases = ghAwOptions.includes('--pre-releases');
  const updateOptions = ghAwOptions.filter((option) => option !== '--pre-releases');
  const policy = await readCaoPolicy(policyPath);
  const ghAw = await ensureGhAwMinimumVersion({ policyPath, execute });
  const campaigns = await installedCampaignRecords();
  if (campaigns.length === 0) {
    throw new Error('No installed gh-aw package records found under .github/aw/packages');
  }
  for (const record of campaigns) {
    if (!/^[0-9a-f]{40}$/i.test(record.resolvedCommit)) {
      throw new Error(`Installed CAO package record must contain a full resolvedCommit SHA: ${record.resolvedCommit || '(missing)'}`);
    }
  }

  const updatedCampaigns = [];
  const mergedDeclarations = [];
  const releaseTags = new Map();
  for (const record of campaigns) {
    const preparedSource = await prepareInstalledPackageReleaseSource(record, releaseTags, execute, {
      includePrereleases,
      allowMajor: updateOptions.includes('--major')
    });
    const update = execute('gh', ['aw', 'update', installedPackageUpdateTarget(record.campaign), ...updateOptions], {
      encoding: 'utf8',
      maxBuffer: 16 * 1024 * 1024
    });
    if (update.error || update.status !== 0) {
      await restorePreparedPackageSource(record, preparedSource);
      throw new Error(`gh aw update failed for ${record.campaign}: ${commandFailureMessage(update, 'unknown error')}`);
    }
    const campaign = record.campaign === 'githubnext/gh-aw-cao'
      ? 'root'
      : record.campaign.split('/').at(-1);
    materializeInstalledCao(campaign, execute);
    const declaration = await readInstalledCaoDeclaration(record.campaign);
    if (declaration) {
      mergeCaoCampaignDeclaration(policy, declaration);
      mergedDeclarations.push(declaration.campaign);
    }
    updatedCampaigns.push(record.campaign);
  }
  if (mergedDeclarations.length > 0) await writeJsonAtomically(path.resolve(policyPath), policy);
  return {
    command: 'update',
    policy: policyPath,
    'gh-aw': ghAw,
    campaigns: updatedCampaigns,
    declarations: mergedDeclarations
  };
}

export async function setCaoCampaignMode(mode, campaignNames, {
  policyPath = DEFAULT_POLICY_PATH
} = {}) {
  if (mode !== 'live' && mode !== 'preview') {
    throw new UsageError('cao mode requires live or preview');
  }
  if (!Array.isArray(campaignNames) || campaignNames.length === 0) {
    throw new UsageError(`cao mode ${mode} requires at least one campaign`);
  }

  const slug = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
  const invalidCampaign = campaignNames.find((campaignName) => typeof campaignName !== 'string' || !slug.test(campaignName));
  if (invalidCampaign !== undefined) {
    throw new UsageError(`Invalid CAO campaign name: ${invalidCampaign}`);
  }

  const policy = await readCaoPolicy(policyPath, 'mode');
  const campaigns = policy['control-plane']?.campaigns ?? {};
  const unknownCampaigns = [...new Set(campaignNames)].filter((campaignName) => !Object.hasOwn(campaigns, campaignName));
  if (unknownCampaigns.length > 0) {
    throw new UsageError(`Unknown CAO campaign${unknownCampaigns.length === 1 ? '' : 's'}: ${unknownCampaigns.join(', ')}`);
  }
  for (const campaignName of campaignNames) {
    if (!isMapping(campaigns[campaignName])) {
      throw new Error(`${policyPath} control-plane campaign ${campaignName} must be an object`);
    }
  }

  const policyMode = mode === 'preview' ? 'review' : 'live';
  for (const campaignName of new Set(campaignNames)) {
    campaigns[campaignName] = { ...campaigns[campaignName], mode: policyMode };
  }
  await writeJsonAtomically(path.resolve(policyPath), policy);
  return {
    command: 'mode',
    mode,
    campaigns: [...new Set(campaignNames)],
    policy: policyPath
  };
}

export async function setCaoCampaignWorkflowsEnabled(action, campaignNames, {
  execute = spawnSync
} = {}) {
  if (action !== 'enable' && action !== 'disable') {
    throw new UsageError('CAO campaign workflow action must be enable or disable');
  }
  if (!Array.isArray(campaignNames) || campaignNames.length === 0) {
    throw new UsageError(`cao ${action} requires at least one campaign`);
  }
  const campaigns = [...new Set(campaignNames)];
  const invalidCampaign = campaigns.find((campaignName) => !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(campaignName));
  if (invalidCampaign !== undefined) {
    throw new UsageError(`Invalid CAO campaign name: ${invalidCampaign}`);
  }

  const declarations = [];
  for (const campaignName of campaigns) {
    const declaration = await readInstalledCaoDeclaration(campaignName);
    if (!declaration) {
      throw new Error(`Campaign ${campaignName} is not installed or does not declare CAO workflows`);
    }
    declarations.push(declaration);
  }
  const workflows = [...new Set(declarations.flatMap((declaration) => [
    declaration.orchestrator,
    ...Object.values(declaration.workers)
  ]))];
  for (const workflow of workflows) {
    const workflowFile = `${workflow}.lock.yml`;
    const result = execute('gh', ['workflow', action, workflowFile], {
      encoding: 'utf8',
      maxBuffer: 16 * 1024 * 1024
    });
    if (result.error || result.status !== 0) {
      throw new Error(`gh workflow ${action} failed for ${workflow}: ${commandFailureMessage(result, 'unknown error')}`);
    }
  }
  return { command: action, campaigns, workflows };
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
    if (name === 'help' || name === 'stdin' || name === 'keep' || name === 'diagnose'
      || name === 'acknowledge-token-risks' || name === 'dry-run') {
      options[name] = 'true';
      continue;
    }
    const value = arguments_[index + 1];
    if (!value || value.startsWith('--')) throw new UsageError(`Missing value for --${name}`);
    index += 1;
    if (name === 'where' || name === 'group' || name === 'repository') {
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

async function hashFileContents(filePath) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(filePath)) hash.update(chunk);
  return hash.digest('hex');
}

function workflowRunId(value) {
  return value === undefined || value === null ? null : String(value);
}

function isAgenticWorkflowRun(record) {
  return typeof record?.run?.workflow_path === 'string'
    && record.run.workflow_path.endsWith('.lock.yml');
}

function compactedJsonlLine(line, agenticRunIds) {
  const record = JSON.parse(line);
  if (record?.kind === 'run' || record?.kind === 'token_efficiency_run_context') {
    return isAgenticWorkflowRun(record) ? line : null;
  }
  if (record?.kind === 'safe_output_item') {
    return agenticRunIds.has(workflowRunId(record.safe_output?.run_id)) ? line : null;
  }
  if (
    record?.kind === 'token_efficiency_observation'
    || record?.kind === 'token_efficiency_lifecycle_observation'
  ) {
    return agenticRunIds.has(workflowRunId(record.observation?.optimizerRunId)) ? line : null;
  }
  if (record?.kind !== 'workflow_runs' || !Array.isArray(record.payload)) return line;
  const payload = record.payload.filter((run) =>
    agenticRunIds.has(workflowRunId(run?.databaseId))
  );
  if (payload.length === 0) return null;
  return payload.length === record.payload.length ? line : JSON.stringify({ ...record, payload });
}

async function inspectJsonlCompaction(sourcePaths) {
  const agenticRunIds = new Set();
  for await (const line of jsonlLines(sourcePaths)) {
    const record = JSON.parse(line);
    if (isAgenticWorkflowRun(record)) {
      const runId = workflowRunId(record.run.run_id);
      if (runId !== null) agenticRunIds.add(runId);
    }
  }
  let sourceRecords = 0;
  let retainedRecords = 0;
  let filtered = false;
  for await (const line of jsonlLines(sourcePaths)) {
    sourceRecords += 1;
    const retained = compactedJsonlLine(line, agenticRunIds);
    if (retained === null) {
      filtered = true;
      continue;
    }
    retainedRecords += 1;
    if (retained !== line) filtered = true;
  }
  return { agenticRunIds, sourceRecords, retainedRecords, filtered };
}

function* normalizedJsonlLines(payload) {
  const records = Object.values(payload.batch)
    .reduce((total, collection) => total + collection.length, 0);
  yield `${JSON.stringify({
    kind: 'metadata',
    schemaVersion: payload.schemaVersion,
    ingestionVersion: payload.ingestionVersion,
    sourceRecords: payload.sourceRecords,
    phase: payload.phase ?? 'all',
    records
  })}\n`;
  for (const collection of NORMALIZED_COLLECTIONS) {
    for (const record of payload.batch[collection]) {
      yield `${JSON.stringify({ kind: 'record', collection, record })}\n`;
    }
  }
}

async function compactJsonlShardGroup(directory, prefix, names, maxBytes) {
  const sourcePaths = names.map((name) => path.join(directory, name));
  const sourceBytes = (await Promise.all(sourcePaths.map(async (filePath) => (await stat(filePath)).size)))
    .reduce((sum, size) => sum + size, 0);
  const inspection = await inspectJsonlCompaction(sourcePaths);
  if (sourcePaths.length <= 1 && sourceBytes <= maxBytes && !inspection.filtered) {
    return {
      prefix,
      sourceFiles: sourcePaths.length,
      sourceRecords: inspection.sourceRecords,
      retainedRecords: inspection.retainedRecords,
      sourceBytes,
      compactedBytes: sourceBytes,
      output: sourcePaths[0] ?? null,
      outputs: sourcePaths
    };
  }

  const latestSequence = names.reduce((latest, name) => {
    const match = name.slice(prefix.length).match(/^(\d+)-/);
    return match ? Math.max(latest, Number(match[1])) : latest;
  }, 0);
  const sequence = Math.max(Math.floor(Date.now() / 1000), latestSequence + 1);
  const outputPaths = [];
  const temporaryPaths = [];
  let bufferedLines = [];
  let bufferedBytes = 0;
  let retainedRecords = 0;
  const flush = async () => {
    if (bufferedLines.length === 0) return;
    const content = bufferedLines.join('');
    const hash = createHash('sha256').update(content).digest('hex').slice(0, 16);
    const part = String(outputPaths.length).padStart(4, '0');
    const outputPath = path.join(directory, `${prefix}${sequence}-${part}-${hash}.jsonl`);
    const temporaryPath = path.join(directory, `.${path.basename(outputPath)}.${process.pid}.tmp`);
    temporaryPaths.push(temporaryPath);
    await writeFile(temporaryPath, content, { flag: 'wx' });
    await rename(temporaryPath, outputPath);
    temporaryPaths.pop();
    outputPaths.push(outputPath);
    bufferedLines = [];
    bufferedBytes = 0;
  };
  try {
    for await (const line of jsonlLines(sourcePaths)) {
      const retained = compactedJsonlLine(line, inspection.agenticRunIds);
      if (retained === null) continue;
      const outputLine = `${retained}\n`;
      const lineBytes = Buffer.byteLength(outputLine);
      if (bufferedLines.length > 0 && bufferedBytes + lineBytes > maxBytes) await flush();
      bufferedLines.push(outputLine);
      bufferedBytes += lineBytes;
      retainedRecords += 1;
    }
    await flush();
  } catch (error) {
    await Promise.all([...temporaryPaths, ...outputPaths].map((filePath) => rm(filePath, { force: true })));
    throw error;
  }
  await Promise.all(sourcePaths.filter((filePath) => !outputPaths.includes(filePath)).map((filePath) => rm(filePath)));
  const compactedBytes = (await Promise.all(outputPaths.map(async (filePath) => (await stat(filePath)).size)))
    .reduce((sum, size) => sum + size, 0);
  return {
    prefix,
    sourceFiles: sourcePaths.length,
    sourceRecords: inspection.sourceRecords,
    retainedRecords,
    sourceBytes,
    compactedBytes,
    output: outputPaths[0] ?? null,
    outputs: outputPaths
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

export async function compactJsonlShards(
  inputDirectory,
  groupDefinitions,
  maxBytes = DEFAULT_COMPACTED_JSONL_SHARD_BYTES
) {
  if (groupDefinitions.length === 0) throw new UsageError('At least one --group is required');
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) {
    throw new UsageError('--max-bytes must be a positive integer');
  }
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
      ...await compactJsonlShardGroup(directory, prefix, names, maxBytes)
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

class TransientDownloadError extends Error {}

function isTransientTransportError(error) {
  const transientCodes = new Set([
    'EAI_AGAIN',
    'ECONNREFUSED',
    'ECONNRESET',
    'ENETUNREACH',
    'EPIPE',
    'ETIMEDOUT',
    'UND_ERR_SOCKET'
  ]);
  return error instanceof TypeError
    || error?.name === 'AbortError'
    || error?.name === 'TimeoutError'
    || transientCodes.has(error?.code)
    || (error?.cause && isTransientTransportError(error.cause));
}

async function downloadFile(url, destination, { allowEmpty = false, signal } = {}) {
  let response;
  try {
    response = await fetch(url, {
      headers: { accept: 'application/x-ndjson, application/json, text/plain' },
      redirect: 'follow',
      signal: signal
        ? AbortSignal.any([signal, AbortSignal.timeout(120_000)])
        : AbortSignal.timeout(120_000)
    });
  } catch (error) {
    throw new TransientDownloadError(`Unable to download ${url}: transport failure`, { cause: error });
  }
  if (!response.ok) throw new Error(`Unable to download ${url}: HTTP ${response.status}`);
  if (!response.body) throw new Error(`Unable to download ${url}: response body is empty`);
  try {
    await pipeline(Readable.fromWeb(response.body), createWriteStream(destination, { flags: 'wx' }));
  } catch (error) {
    if (isTransientTransportError(error)) {
      throw new TransientDownloadError(`Unable to download ${url}: interrupted response`, { cause: error });
    }
    throw error;
  }
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
  const inventoryUrl = new URL('inventory-sources.json', manifestUrl);
  const outputDirectory = path.resolve(output);
  await mkdir(outputDirectory, { recursive: true });
  const manifestPath = path.join(outputDirectory, 'payload-hashes.json');
  const databasePath = path.join(outputDirectory, 'gh-aw-logs.sqlite');
  const inventoryPath = path.join(outputDirectory, 'inventory-sources.json');
  const isChecksumMismatch = (error) => error instanceof Error
    && /^Activity (?:SQLite|shard) checksum mismatch: /.test(error.message);
  const isTransientDownloadFailure = (error) => error instanceof TransientDownloadError
    || (error instanceof Error && /: HTTP (?:408|425|429|5\d\d)$/.test(error.message));

  const downloadAttempt = async () => {
    const temporaryDirectory = await mkdtemp(path.join(outputDirectory, '.deployed-dashboard-'));
    const temporaryManifest = path.join(temporaryDirectory, 'payload-hashes.json');
    const temporaryPayloads = path.join(temporaryDirectory, 'payloads');
    const temporaryDatabase = path.join(temporaryDirectory, 'gh-aw-logs.sqlite');
    const temporaryInventory = path.join(temporaryDirectory, 'inventory-sources.json');
    const abortController = new AbortController();
    try {
      const downloads = [
        downloadFile(manifestUrl, temporaryManifest, { signal: abortController.signal }),
        downloadFile(databaseUrl, temporaryDatabase, { signal: abortController.signal }),
        downloadFile(inventoryUrl, temporaryInventory, { signal: abortController.signal })
      ];
      await Promise.all(downloads).catch(async (error) => {
        abortController.abort();
        await Promise.allSettled(downloads);
        throw error;
      });
      const inventorySources = JSON.parse(await readFile(temporaryInventory, 'utf8'));
      if (!isMapping(inventorySources)) {
        throw new Error('Deployed inventory sources must contain a JSON object.');
      }
      const hashes = JSON.parse(await readFile(temporaryManifest, 'utf8'));
      const validDigest = (digest) => /^[a-f0-9]{64}$/i.test(String(digest));
      const expectedDatabaseDigest = hashes['gh-aw-logs.sqlite'];
      if (!validDigest(expectedDatabaseDigest)) {
        throw new Error('Activity snapshot manifest contains no valid SQLite checksum.');
      }
      const databaseDigest = await hashFileContents(temporaryDatabase);
      if (databaseDigest !== expectedDatabaseDigest.toLowerCase()) {
        throw new Error('Activity SQLite checksum mismatch: gh-aw-logs.sqlite');
      }
      const runEntries = Object.entries(hashes)
        .filter(([name, digest]) => /^gh-aw-logs-runs\/[^/]+\.jsonl$/.test(name)
          && validDigest(digest))
        .sort(([left], [right]) => left.localeCompare(right));
      const recordEntries = Object.entries(hashes)
        .filter(([name, digest]) => /^gh-aw-logs-records\/[^/]+\.jsonl$/.test(name)
          && validDigest(digest))
        .sort(([left], [right]) => left.localeCompare(right));
      const rawEntries = Object.entries(hashes)
        .filter(([name, digest]) => /^gh-aw-logs-shards\/[^/]+\.jsonl$/.test(name)
          && validDigest(digest))
        .sort(([left], [right]) => left.localeCompare(right));
      const payloadEntries = runEntries.length > 0 ? [...runEntries, ...recordEntries] : rawEntries;
      if (payloadEntries.length === 0) throw new Error('Activity shard manifest contains no valid JSONL shards.');
      await mkdir(temporaryPayloads);
      for (const [name, expectedDigest] of payloadEntries) {
        const destination = path.join(temporaryPayloads, name);
        await mkdir(path.dirname(destination), { recursive: true });
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
      const payloadDirectories = [...new Set(payloadEntries.map(([name]) => name.split('/')[0]))];
      for (const directory of payloadDirectories) {
        const destination = path.join(outputDirectory, directory);
        await rm(destination, { recursive: true, force: true });
        await rename(path.join(temporaryPayloads, directory), destination);
      }
      await replaceFile(temporaryManifest, manifestPath);
      await replaceFile(temporaryDatabase, databasePath);
      await replaceFile(temporaryInventory, inventoryPath);
      return {
        manifestUrl: manifestUrl.href,
        databaseUrl: databaseUrl.href,
        inventoryUrl: inventoryUrl.href,
        manifest: manifestPath,
        payloadDirectories: payloadDirectories.map((directory) => path.join(outputDirectory, directory)),
        database: databasePath,
        inventory: inventoryPath
      };
    } finally {
      abortController.abort();
      await rm(temporaryDirectory, { recursive: true, force: true });
    }
  };

  let lastError;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      return await downloadAttempt();
    } catch (error) {
      lastError = error;
      if ((!isChecksumMismatch(error) && !isTransientDownloadFailure(error)) || attempt === 3) throw error;
      if (isTransientDownloadFailure(error)) await delay(attempt * 1_000);
    }
  }
  throw lastError;
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
  if (updated) {
    const maintenanceStartedAt = Date.now();
    await finalizeNormalizedJsonlIngestion(indexedDB, options);
    debug('applied deferred canonical maintenance durationMs=%d', Date.now() - maintenanceStartedAt);
  }
  return { updated, committedRecords, shards };
}

async function ingestJsonlFile(indexedDB, inputPath, options = {}) {
  return ingestCachedGhAwJsonl(indexedDB, createReadStream(inputPath), options);
}

/**
 * Computes SHA-256 checksums for the activity snapshot payloads: the
 * SQLite projection and every retained `--cached-jsonl` wildcard shard file.
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

/**
 * Assigns a record to a stable partition. Day buckets keep historical output
 * byte-identical across runs so the browser's content-hash skip receipt still
 * matches and the shard is never redownloaded.
 *
 * @param {string} collection
 * @param {Record<string, unknown>} record
 */
function consolidationBucket(collection, record) {
  if (STRUCTURAL_CONSOLIDATION_COLLECTIONS.has(collection)) return STRUCTURAL_CONSOLIDATION_BUCKET;
  for (const field of CONSOLIDATION_TIMESTAMP_FIELDS) {
    const value = record[field];
    if (typeof value !== 'string') continue;
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) return new Date(parsed).toISOString().slice(0, 10);
  }
  return STRUCTURAL_CONSOLIDATION_BUCKET;
}

/**
 * Collapses every per-shard payload for one phase into deduplicated, day-bucketed
 * shards. Published shards repeat a canonical record once per source shard that
 * observed it; keying on (collection, id) keeps exactly one copy.
 *
 * @param {string} phase
 * @param {string[]} cachePaths per-shard payloads in ingestion order
 * @param {string} outputDirectory
 * @param {number} maxBytes
 */
async function consolidatePhasePayloads(phase, cachePaths, outputDirectory, maxBytes) {
  /** @type {Map<string, Map<string, Record<string, unknown>>>} */
  const deduped = new Map(NORMALIZED_COLLECTIONS.map((collection) => [collection, new Map()]));
  let sourceRecords = 0;
  for (const cachePath of cachePaths) {
    for await (const line of jsonlLines([cachePath])) {
      const entry = JSON.parse(line);
      if (entry?.kind !== 'record') continue;
      const records = deduped.get(entry.collection);
      if (!records) continue;
      const record = entry.record;
      const id = String(record.id);
      sourceRecords += 1;
      const existing = records.get(id);
      // Mirrors canonical ingestion precedence: discovery owns repository and
      // workflow inventory fields, every other collection is last-observation-wins.
      if (existing && (entry.collection === 'repositories' || entry.collection === 'workflows')) {
        records.set(id, mergeActivityStructuralRecord(entry.collection, existing, record));
        continue;
      }
      records.set(id, record);
    }
  }
  /** @type {Map<string, string[]>} */
  const buckets = new Map();
  let uniqueRecords = 0;
  for (const collection of NORMALIZED_COLLECTIONS) {
    const records = deduped.get(collection);
    for (const record of records.values()) {
      const bucket = consolidationBucket(collection, record);
      const lines = buckets.get(bucket) ?? buckets.set(bucket, []).get(bucket);
      lines.push(`${JSON.stringify({ kind: 'record', collection, record })}\n`);
      uniqueRecords += 1;
    }
    records.clear();
  }
  debugHash(
    'consolidating phase=%s sourceRecords=%d uniqueRecords=%d buckets=%d',
    phase,
    sourceRecords,
    uniqueRecords,
    buckets.size
  );
  /** @type {string[]} */
  const written = [];
  for (const bucket of [...buckets.keys()].sort()) {
    const lines = buckets.get(bucket);
    /** @type {string[][]} */
    const parts = [];
    let current = [];
    let currentBytes = 0;
    for (const line of lines) {
      const size = Buffer.byteLength(line);
      if (current.length > 0 && currentBytes + size > maxBytes) {
        parts.push(current);
        current = [];
        currentBytes = 0;
      }
      current.push(line);
      currentBytes += size;
    }
    if (current.length > 0) parts.push(current);
    for (const [index, part] of parts.entries()) {
      const header = `${JSON.stringify({
        kind: 'metadata',
        schemaVersion: CANONICAL_SCHEMA_VERSION,
        ingestionVersion: NORMALIZED_JSONL_INGESTION_VERSION,
        sourceRecords: part.length,
        phase,
        records: part.length
      })}\n`;
      const content = header + part.join('');
      const digest = createHash('sha256').update(content).digest('hex');
      const name = `${bucket}-${String(index).padStart(4, '0')}-${digest.slice(0, 16)}.jsonl`;
      const outputPath = path.join(outputDirectory, name);
      written.push(name);
      try {
        await stat(outputPath);
        continue;
      } catch (error) {
        if (!(error && error.code === 'ENOENT')) throw error;
      }
      const temporaryPath = `${outputPath}.${process.pid}.tmp`;
      await writeFile(temporaryPath, content, { flag: 'wx' });
      await rename(temporaryPath, outputPath);
    }
    buckets.delete(bucket);
  }
  return written;
}

async function hashActivityPayloads({
  databasePath,
  shardDirectory,
  normalizedDirectory,
  runsDirectory,
  recordsDirectory,
  inventoryPath
}) {
  const hashFile = async (filePath) => {
    const digest = await hashFileContents(filePath);
    debugHash('hashed %s -> %s', filePath, digest);
    return digest;
  };
  const payloadHasRecords = async (filePath) => {
    let lines = 0;
    for await (const line of jsonlLines([filePath])) {
      lines += 1;
      if (lines > 1) return true;
    }
    return false;
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
      .update(`${CANONICAL_SCHEMA_VERSION}\0${NORMALIZED_JSONL_INGESTION_VERSION}\0${JSON.stringify(workflowHints)}`)
      .digest('hex')
      .slice(0, 16);
    const retainedPayloads = {
      normalized: new Set(),
      runs: new Set(),
      records: new Set()
    };
    const retainedCachePayloads = {
      runs: new Set(),
      records: new Set()
    };
    const cachePaths = { runs: [], records: [] };
    const cacheDirectories = {
      runs: runsDirectory ? path.join(runsDirectory, PAYLOAD_CACHE_DIRECTORY) : null,
      records: recordsDirectory ? path.join(recordsDirectory, PAYLOAD_CACHE_DIRECTORY) : null
    };
    if (normalizedDirectory) await mkdir(normalizedDirectory, { recursive: true });
    if (runsDirectory) await mkdir(cacheDirectories.runs, { recursive: true });
    if (recordsDirectory) await mkdir(cacheDirectories.records, { recursive: true });
    for (const name of shardNames) {
      const shardPath = path.join(shardDirectory, name);
      if ((await stat(shardPath)).size === 0) {
        await rm(shardPath);
        debugHash('dropped empty source shard %s', shardPath);
        continue;
      }
      const rawHash = await hashFile(shardPath);
      hashes[`${path.basename(shardDirectory)}/${name}`] = rawHash;
      if (!normalizedDirectory && !runsDirectory && !recordsDirectory) continue;
      const payloadName = `${rawHash}-${normalizationContext}.jsonl`;
      const phasedPayloadName = `${path.parse(name).name}-${payloadName}`;
      const outputPaths = [
        normalizedDirectory ? ['normalized', path.join(normalizedDirectory, payloadName)] : null,
        runsDirectory ? ['runs', path.join(cacheDirectories.runs, phasedPayloadName)] : null,
        recordsDirectory ? ['records', path.join(cacheDirectories.records, phasedPayloadName)] : null
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
          ingestionVersion: NORMALIZED_JSONL_INGESTION_VERSION,
          sourceRecords: adapted.records
        };
        const payloads = {
          normalized: { ...metadata, batch },
          runs: {
            ...metadata,
            phase: 'runs',
            batch: {
              campaigns: batch.campaigns,
              repositories: batch.repositories,
              workflows: batch.workflows,
              runs: batch.runs,
              domains: [],
              tools: [],
              audits: [],
              issues: [],
              operationalValues: []
            }
          },
          records: {
            ...metadata,
            phase: 'records',
            batch: {
              campaigns: [],
              repositories: [],
              workflows: [],
              runs: [],
              domains: batch.domains,
              tools: batch.tools,
              audits: batch.audits.filter((audit) =>
                String(audit.status ?? '').trim().toLowerCase() !== 'info'
              ),
              issues: batch.issues,
              operationalValues: batch.operationalValues
            }
          }
        };
        await Promise.all(missing.map(async ([phase, outputPath]) => {
          const temporaryPath = `${outputPath}.${process.pid}.tmp`;
          await pipeline(
            Readable.from(normalizedJsonlLines(payloads[phase])),
            createWriteStream(temporaryPath, { flags: 'wx' })
          );
          await rename(temporaryPath, outputPath);
        }));
      }
      for (const [phase, outputPath] of outputPaths) {
        if (!await payloadHasRecords(outputPath)) {
          await rm(outputPath, { force: true });
          debugHash('dropped empty %s shard %s', phase, outputPath);
          continue;
        }
        if (phase === 'normalized') {
          retainedPayloads.normalized.add(path.basename(outputPath));
          hashes[`${path.basename(path.dirname(outputPath))}/${path.basename(outputPath)}`] = await hashFile(outputPath);
          continue;
        }
        retainedCachePayloads[phase].add(path.basename(outputPath));
        cachePaths[phase].push(outputPath);
      }
    }
    for (const [phase, directory] of [
      ['runs', runsDirectory],
      ['records', recordsDirectory]
    ].filter(([, directory]) => Boolean(directory))) {
      const names = await consolidatePhasePayloads(
        phase,
        cachePaths[phase],
        directory,
        DEFAULT_COMPACTED_JSONL_SHARD_BYTES
      );
      for (const name of names) {
        retainedPayloads[phase].add(name);
        hashes[`${path.basename(directory)}/${name}`] = await hashFile(path.join(directory, name));
      }
      for (const name of await readdir(cacheDirectories[phase])) {
        if (name.endsWith('.jsonl') && !retainedCachePayloads[phase].has(name)) {
          await rm(path.join(cacheDirectories[phase], name), { force: true });
        }
      }
    }
    for (const [phase, directory] of [
      ['normalized', normalizedDirectory],
      ['runs', runsDirectory],
      ['records', recordsDirectory]
    ].filter(([, directory]) => Boolean(directory))) {
      for (const name of await readdir(directory)) {
        if ((name.endsWith('.json') || name.endsWith('.jsonl')) && !retainedPayloads[phase].has(name)) {
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

function boundedPositiveInteger(value, name, defaultValue, maximum) {
  if (value === undefined) return defaultValue;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > maximum) {
    throw new UsageError(`--${name} must be an integer from 1 to ${maximum}`);
  }
  return parsed;
}

function nonNegativeInteger(value, name, defaultValue) {
  if (value === undefined) return defaultValue;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new UsageError(`--${name} must be a non-negative integer`);
  }
  return parsed;
}

function graphqlDocument(query, variables = {}) {
  const arguments_ = ['api', 'graphql', '-f', `query=${query}`];
  for (const [name, value] of Object.entries(variables)) {
    arguments_.push('-f', `${name}=${value}`);
  }
  const result = spawnSync('gh', arguments_, {
    encoding: 'utf8',
    env: { ...process.env, GH_PAGER: 'cat' },
    maxBuffer: 16 * 1024 * 1024
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`GitHub GraphQL query failed: ${String(result.stderr || result.stdout).trim() || `exit ${result.status}`}`);
  }
  let document;
  try {
    document = JSON.parse(result.stdout);
  } catch {
    throw new Error('GitHub GraphQL query returned invalid JSON');
  }
  if (Array.isArray(document.errors) && document.errors.length > 0) {
    throw new Error(`GitHub GraphQL query failed: ${document.errors.map((error) => error.message).join('; ')}`);
  }
  return document;
}

function graphqlRateLimit(document) {
  const rateLimit = document?.data?.rateLimit;
  if (![rateLimit?.cost, rateLimit?.remaining].every(Number.isSafeInteger)) {
    throw new Error('GitHub GraphQL response did not include rate-limit cost and remaining points');
  }
  return {
    cost: rateLimit.cost,
    remaining: rateLimit.remaining,
    resetAt: typeof rateLimit.resetAt === 'string' ? rateLimit.resetAt : null
  };
}

function issueStatusKey(repository, number) {
  return `${repository.toLowerCase()}#${number}`;
}

function issueStatusTargets(issues) {
  const targets = new Map();
  for (const issue of issues) {
    if (issue.isPullRequest === true) continue;
    const repository = String(issue.repositoryFullName ?? (
      typeof issue.owner === 'string' && typeof issue.repository === 'string'
        ? `${issue.owner}/${issue.repository}`
        : ''
    ));
    const number = Number(issue.number);
    if (!repository.includes('/') || !Number.isSafeInteger(number) || number < 1) continue;
    const [owner, ...repositoryParts] = repository.split('/');
    const name = repositoryParts.join('/');
    if (!owner || !name || name.includes('/')) continue;
    targets.set(issueStatusKey(repository, number), {
      owner,
      name,
      repository: `${owner}/${name}`,
      number,
      statusObservedAt: issue.statusObservedAt
    });
  }
  return [...targets.values()].sort((left, right) => {
    const leftObserved = Date.parse(String(left.statusObservedAt ?? ''));
    const rightObserved = Date.parse(String(right.statusObservedAt ?? ''));
    const freshness = (Number.isFinite(leftObserved) ? leftObserved : Number.NEGATIVE_INFINITY)
      - (Number.isFinite(rightObserved) ? rightObserved : Number.NEGATIVE_INFINITY);
    return freshness || left.repository.localeCompare(right.repository) || left.number - right.number;
  });
}

function issueStatusQuery(batch) {
  const fields = batch.map((target, index) => (
    `i${index}: issue(number: ${target.number}) { number state stateReason closedAt url }`
  )).join('\n');
  return `query($owner: String!, $name: String!) {
  repository(owner: $owner, name: $name) {
    ${fields}
  }
  rateLimit { cost remaining resetAt }
}`;
}

async function applyIssueStatuses(directory, statuses) {
  let updatedFiles = 0;
  let updatedRecords = 0;
  const names = (await readdir(directory)).filter((name) => name.endsWith('.jsonl')).sort();
  for (const name of names) {
    const filePath = path.join(directory, name);
    const lines = [];
    let changed = false;
    for await (const line of jsonlLines([filePath])) {
      const envelope = JSON.parse(line);
      const entity = envelope?.kind === 'safe_output_item'
        ? githubEntityUrl(envelope.safe_output?.url)
        : undefined;
      const status = entity && !entity.url.includes('/pull/')
        ? statuses.get(issueStatusKey(entity.repository, entity.number))
        : undefined;
      if (status) {
        envelope.safe_output = { ...envelope.safe_output, github_issue_status: status };
        changed = true;
        updatedRecords += 1;
        lines.push(JSON.stringify(envelope));
      } else {
        lines.push(line);
      }
    }
    if (!changed) continue;
    const temporaryPath = `${filePath}.${process.pid}.tmp`;
    await writeFile(temporaryPath, `${lines.join('\n')}\n`, { flag: 'wx' });
    await rename(temporaryPath, filePath);
    updatedFiles += 1;
  }
  return { updatedFiles, updatedRecords };
}

export async function updateIssueStatuses(indexedDB, inputDirectory, options) {
  const batchSize = boundedPositiveInteger(
    option(options, 'batch-size', false),
    'batch-size',
    DEFAULT_ISSUE_STATUS_BATCH_SIZE,
    100
  );
  const costBudget = boundedPositiveInteger(
    option(options, 'graphql-cost-budget', false),
    'graphql-cost-budget',
    DEFAULT_ISSUE_STATUS_GRAPHQL_COST_BUDGET,
    5000
  );
  const minimumRemaining = nonNegativeInteger(
    option(options, 'graphql-min-remaining', false),
    'graphql-min-remaining',
    DEFAULT_ISSUE_STATUS_GRAPHQL_MIN_REMAINING
  );
  const targets = issueStatusTargets(await readCollection(indexedDB, 'issues'));
  if (targets.length === 0) {
    return {
      command: 'issue-status',
      issues: 0,
      queried: 0,
      statuses: 0,
      updatedFiles: 0,
      updatedRecords: 0,
      rateLimit: {
        budget: costBudget,
        cost: 0,
        minimumRemaining,
        remaining: null,
        resetAt: null
      },
      stopped: null,
      errors: []
    };
  }
  const initialDocument = graphqlDocument('query { rateLimit { cost remaining resetAt } }');
  let rateLimit = graphqlRateLimit(initialDocument);
  let cost = rateLimit.cost;
  const statuses = new Map();
  const errors = [];
  let queried = 0;
  let stopped = null;

  const byRepository = Map.groupBy(targets, (target) => target.repository);
  outer: for (const repositoryTargets of byRepository.values()) {
    for (let offset = 0; offset < repositoryTargets.length; offset += batchSize) {
      if (cost + 1 > costBudget) {
        stopped = 'cost-budget';
        break outer;
      }
      if (rateLimit.remaining - 1 < minimumRemaining) {
        stopped = 'remaining-floor';
        break outer;
      }
      const batch = repositoryTargets.slice(offset, offset + batchSize);
      const [{ owner, name, repository }] = batch;
      let document;
      try {
        document = graphqlDocument(issueStatusQuery(batch), { owner, name });
      } catch (error) {
        errors.push({
          repository,
          message: error instanceof Error ? error.message : String(error)
        });
        stopped = 'query-error';
        break outer;
      }
      rateLimit = graphqlRateLimit(document);
      cost += rateLimit.cost;
      const result = document.data?.repository;
      for (let index = 0; index < batch.length; index += 1) {
        queried += 1;
        const issue = result?.[`i${index}`];
        if (!issue) continue;
        const target = batch[index];
        statuses.set(issueStatusKey(target.repository, target.number), {
          state: issue.state,
          closed: issue.state === 'CLOSED',
          state_reason: issue.stateReason ?? null,
          closed_at: issue.closedAt ?? null,
          observed_at: new Date().toISOString()
        });
      }
      if (cost > costBudget) {
        stopped = 'cost-budget';
        break outer;
      }
    }
  }

  const updates = await applyIssueStatuses(path.resolve(inputDirectory), statuses);
  return {
    command: 'issue-status',
    issues: targets.length,
    queried,
    statuses: statuses.size,
    ...updates,
    rateLimit: {
      budget: costBudget,
      cost,
      minimumRemaining,
      remaining: rateLimit.remaining,
      resetAt: rateLimit.resetAt
    },
    stopped,
    errors
  };
}

export async function queryGhData(indexedDB, resource, options) {
  if (!GH_RESOURCES.has(resource)) throw new Error(`Unknown gh resource: ${resource}`);
  const [repositories, workflows, runs, issues] = await Promise.all([
    readCollection(indexedDB, 'repositories'),
    readCollection(indexedDB, 'workflows'),
    readCollection(indexedDB, 'runs'),
    readCollection(indexedDB, 'issues')
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
    const safeOutputType = resource === 'issues' ? 'create_issue' : 'create_pull_request';
    records = issues
      .filter((event) => (
        event.type === 'safe_output.created'
        && event.isPullRequest === (resource === 'prs')
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
    const records = (await Promise.all(
      ['domains', 'tools', 'audits', 'issues'].map((collection) =>
        Promise.all(runs.map((run) => queries[collection].forRun(String(run.id)))))
    )).flat(2);
    return { result, runs, records };
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

export async function discoverWorkflows({
  root = ".",
  controlSettingsPath,
  inventoryPath,
  outputPath,
  repository,
} = {}) {
  const inventory = discoverInventory(path.resolve(root));
  const controlSettings = JSON.parse(await readFile(path.resolve(controlSettingsPath), "utf8"));
  const sources = await discoverInventoryDashboardSources({
    inventory,
    controlSettings,
    repository,
  });
  await Promise.all([
    writeJsonAtomically(inventoryPath, inventory),
    writeJsonAtomically(outputPath, sources),
  ]);
  return {
    command: "discover-workflows",
    repositories: sources.repositories.rows.length,
    campaigns: sources.campaigns.rows.length,
    workflows: sources.workflows.rows.length,
  };
}

export async function pruneDashboardFile({ inputPath, outputPath } = {}) {
  let document;
  try {
    document = JSON.parse(await readFile(path.resolve(inputPath), 'utf8'));
  } catch (error) {
    if (error instanceof SyntaxError) {
      throw new Error(`${inputPath} contains invalid JSON: ${error.message}`);
    }
    throw error;
  }
  const result = pruneDashboardDocument(document);
  if (outputPath) await writeJsonAtomically(outputPath, result.document);
  return {
    command: 'prune-dashboard',
    input: inputPath,
    ...(outputPath ? { output: outputPath } : {}),
    ...result.report
  };
}

export async function analyzeDashboardComplexityFile({
  inputPath,
  queryId,
  format = 'json',
  limit,
  databasePath
} = {}) {
  let document;
  try {
    document = JSON.parse(await readFile(path.resolve(inputPath), 'utf8'));
  } catch (error) {
    if (error instanceof SyntaxError) {
      throw new Error(`${inputPath} contains invalid JSON: ${error.message}`);
    }
    throw error;
  }
  if (!['json', 'markdown'].includes(format)) {
    throw new UsageError('--format must be json or markdown');
  }
  if (limit !== undefined && (!Number.isInteger(limit) || limit < 1)) {
    throw new UsageError('--limit must be a positive integer');
  }
  const tableCounts = databasePath === undefined
    ? undefined
    : readDashboardTableCounts(path.resolve(databasePath));
  const analysis = analyzeDashboardComplexity(document, { tableCounts });
  const selected = queryId === undefined
    ? undefined
    : analysis.inventory.find((query) => query.name === queryId);
  if (queryId !== undefined && !selected) {
    throw new UsageError(`Unknown dashboard query: ${queryId}`);
  }
  if (format === 'markdown') {
    return formatDashboardComplexityMarkdown(analysis, { limit, queryId });
  }
  return {
    command: 'dashboard-complexity',
    input: inputPath,
    ...(selected ? { query: selected } : analysis)
  };
}

export async function runCli(arguments_, input = process.stdin, { signal } = {}) {
  const [command, ...rawOptionArguments] = arguments_;
  if (!command || command === '--help' || command === 'help') return USAGE;
  if (command === 'init') {
    if (rawOptionArguments.length > 0) throw new UsageError(`Unexpected argument: ${rawOptionArguments[0]}`);
    return initializeCaoPolicy();
  }
  if (command === 'setup-auth') {
    return setupCaoAuthentication(rawOptionArguments[0], rawOptionArguments.slice(1));
  }
  if (command === 'add') {
    return addCaoCampaign(rawOptionArguments[0], rawOptionArguments.slice(1));
  }
  if (command === 'update') {
    return updateCaoCampaigns(rawOptionArguments);
  }
  if (command === 'mode') {
    return setCaoCampaignMode(rawOptionArguments[0], rawOptionArguments.slice(1));
  }
  if (command === 'enable' || command === 'disable') {
    return setCaoCampaignWorkflowsEnabled(command, rawOptionArguments);
  }
  if (!COMMANDS.has(command) && arguments_.length === 2) {
    return runLegacyIngestion(command, rawOptionArguments[0]);
  }
  const optionArguments = [...rawOptionArguments];
  const dashboardQueryId = command === 'dashboard-complexity' && !optionArguments[0]?.startsWith('--')
    ? optionArguments.shift()
    : undefined;
  const ghResource = command === 'gh' ? optionArguments[0] : undefined;
  if (command === 'gh' && (!ghResource || ghResource === 'help' || ghResource === '--help')) return USAGE;
  const computation = command === 'computation' ? optionArguments[0] : undefined;
  if (command === 'computation' && (!computation || computation === 'help' || computation === '--help')) return USAGE;
  const options = parseOptions(
    command === 'gh' || command === 'computation' ? optionArguments.slice(1) : optionArguments
  );
  if (options.help) return USAGE;
  if (command === 'download') {
    rejectUnknownOptions(options, ['url', 'output']);
    return downloadDeployedDashboardData({
      url: option(options, 'url', false),
      output: option(options, 'output', false)
    });
  }
  if (command === 'discover-workflows') {
    rejectUnknownOptions(options, ['root', 'control-settings', 'inventory', 'output', 'repo']);
    return discoverWorkflows({
      root: option(options, 'root', false) || '.',
      controlSettingsPath: option(options, 'control-settings'),
      inventoryPath: option(options, 'inventory'),
      outputPath: option(options, 'output'),
      repository: option(options, 'repo'),
    });
  }
  if (command === 'dashboard-complexity') {
    rejectUnknownOptions(options, ['input', 'database', 'format', 'limit']);
    const limit = option(options, 'limit', false);
    return analyzeDashboardComplexityFile({
      inputPath: option(options, 'input'),
      queryId: dashboardQueryId,
      databasePath: option(options, 'database', false),
      format: option(options, 'format', false) || 'json',
      limit: limit === undefined ? undefined : Number(limit)
    });
  }
  if (command === 'prune-dashboard') {
    rejectUnknownOptions(options, ['input', 'output']);
    return pruneDashboardFile({
      inputPath: option(options, 'input'),
      outputPath: option(options, 'output', false)
    });
  }
  if (command === 'audit-jsonl') {
    rejectUnknownOptions(options, ['input-dir']);
    return auditJsonlDirectory(option(options, 'input-dir', false) || DEFAULT_SHARDS_PATH);
  }
  if (command === 'compact-jsonl') {
    rejectUnknownOptions(options, ['input-dir', 'group', 'max-bytes']);
    const groups = options.group
      ? Array.isArray(options.group) ? options.group : [options.group]
      : [];
    return compactJsonlShards(
      path.resolve(option(options, 'input-dir')),
      groups,
      option(options, 'max-bytes', false) === undefined
        ? DEFAULT_COMPACTED_JSONL_SHARD_BYTES
        : Number(option(options, 'max-bytes', false))
    );
  }
  if (command === 'hash-payloads') {
    rejectUnknownOptions(options, ['database', 'shard-dir', 'normalized-dir', 'runs-dir', 'records-dir', 'inventory', 'output']);
    const hashes = await hashActivityPayloads({
      databasePath: option(options, 'database', false) ? path.resolve(option(options, 'database', false)) : undefined,
      shardDirectory: option(options, 'shard-dir', false) ? path.resolve(option(options, 'shard-dir', false)) : undefined,
      normalizedDirectory: option(options, 'normalized-dir', false)
        ? path.resolve(option(options, 'normalized-dir', false))
        : undefined,
      runsDirectory: option(options, 'runs-dir', false)
        ? path.resolve(option(options, 'runs-dir', false))
        : undefined,
      recordsDirectory: option(options, 'records-dir', false)
        ? path.resolve(option(options, 'records-dir', false))
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
  if (command === 'cluster-problems') {
    rejectUnknownOptions(options, ['database', 'root', 'timestamp']);
    return runProblemClustering({
      databasePath,
      root: option(options, 'root', false) || '.',
      timestamp: option(options, 'timestamp', false) || new Date().toISOString(),
      signal
    });
  }
  const indexedDB = await createDatabase(databasePath);

  if (command === 'issue-status') {
    rejectUnknownOptions(options, [
      'database',
      'input-dir',
      'batch-size',
      'graphql-cost-budget',
      'graphql-min-remaining'
    ]);
    return updateIssueStatuses(
      indexedDB,
      option(options, 'input-dir'),
      options
    );
  }
  if (command === 'gh') {
    rejectUnknownOptions(options, ['database', 'repo', 'workflow', 'status', 'since', 'until', 'limit']);
    if (ghResource !== 'runs' && options.status) {
      throw new UsageError('--status is only supported for cao gh runs');
    }
    return queryGhData(indexedDB, ghResource, options);
  }
  if (command === 'computation') {
    rejectUnknownOptions(options, ['database', 'inventory', 'campaign', 'diagnose']);
    if (!hasComputation(computation)) {
      throw new UsageError(`Unknown computation: ${computation}`);
    }
    if (options.diagnose && !options.campaign) {
      throw new UsageError('--diagnose requires --campaign SLUG');
    }
    const inventoryPath = path.resolve(
      option(options, 'inventory', false)
        || path.join(path.dirname(path.resolve(databasePath)), 'inventory-sources.json')
    );
    let inventorySources;
    try {
      inventorySources = JSON.parse(await readFile(inventoryPath, 'utf8'));
    } catch (error) {
      if (error && error.code === 'ENOENT') {
        throw new Error(`Runtime health requires campaign inventory: ${inventoryPath}. Run "cao download" first or pass --inventory FILE.`);
      }
      throw new Error(`Unable to read computation inventory ${inventoryPath}: ${error instanceof Error ? error.message : String(error)}`);
    }
    return queryComputation(indexedDB, computation, {
      campaign: option(options, 'campaign', false),
      diagnose: Boolean(options.diagnose),
      inventorySources
    });
  }
  if (command === 'operational-value') {
    rejectUnknownOptions(options, ['database', 'root', 'output', 'timestamp', 'repository', 'retention-days', 'max-github-api-rate-limit']);
    const repositoryOptions = options.repository === undefined
      ? []
      : Array.isArray(options.repository) ? options.repository : [options.repository];
    for (const repository of repositoryOptions) {
      if (!REPOSITORY_COORDINATE.test(repository)) {
        throw new UsageError('--repository must use OWNER/REPO form');
      }
    }
    return runOperationalValue({
      indexedDB,
      databasePath,
      root: option(options, 'root', false) || '.',
      outputPath: option(options, 'output', false),
      timestamp: option(options, 'timestamp', false) || new Date().toISOString(),
      repositories: repositoryOptions,
      rateLimitReserve: operationalValueReserve(option(options, 'max-github-api-rate-limit', false), UsageError),
      retentionWindow: retentionWindowMs(options),
      signal
    });
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
    rejectUnknownOptions(options, ['database', 'input', 'input-dir', 'runs-dir', 'records-dir', 'context', 'retention-days', 'run-retention-days']);
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
    const recordsDirectory = option(options, 'records-dir', false);
    if (Boolean(runsDirectory) !== Boolean(recordsDirectory)) {
      throw new Error('--runs-dir and --records-dir must be provided together');
    }
    if ((inputPath || inputDirectory) && runsDirectory) {
      throw new Error('Phased shard directories cannot be combined with --input or --input-dir');
    }
    const result = runsDirectory && recordsDirectory
      ? await ingestNormalizedShardDirectories(indexedDB, [
          ['runs', path.resolve(runsDirectory)],
          ['records', path.resolve(recordsDirectory)]
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
  const arguments_ = process.argv.slice(2);
  const controller = new AbortController();
  let terminationSignal;
  const terminate = (signal) => {
    terminationSignal = signal;
    controller.abort(new Error(`Received ${signal}`));
  };
  const onSigint = () => terminate('SIGINT');
  const onSigterm = () => terminate('SIGTERM');
  if (arguments_[0] === 'operational-value' || arguments_[0] === 'cluster-problems') {
    process.once('SIGINT', onSigint);
    process.once('SIGTERM', onSigterm);
  }
  try {
    const output = await runCli(arguments_, process.stdin, { signal: controller.signal });
    process.stdout.write(`${typeof output === 'string' ? output : JSON.stringify(output, null, 2)}\n`);
    if (typeof output === 'object' && output?.command === 'doctor' && !output.healthy) process.exitCode = 2;
  } catch (error) {
    if (!controller.signal.aborted || error !== controller.signal.reason) throw error;
    process.exitCode = terminationSignal === 'SIGINT' ? 130 : 143;
  } finally {
    process.removeListener('SIGINT', onSigint);
    process.removeListener('SIGTERM', onSigterm);
  }
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
