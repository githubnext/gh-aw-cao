import { spawnSync } from 'node:child_process';
import { readFile, readdir, mkdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { canonicalTimestamp } from '../dashboard/site/src/data/model/schema.js';
import { readCollection } from '../dashboard/site/src/data/storage/indexeddb.js';

export const REPOSITORY_COORDINATE = /^[A-Za-z0-9][A-Za-z0-9-]*\/[A-Za-z0-9._-]+$/;
const OPERATIONAL_VALUE_ID = /^[a-z0-9]+(?:[._-][a-z0-9]+)*$/;
const WORKER_TIMEOUT_MS = 2 * 60 * 1000;
const WORKER_ENVIRONMENT = [
  'CI',
  'HOME',
  'LANG',
  'LC_ALL',
  'PATH',
  'Path',
  'SystemRoot',
  'TEMP',
  'TMP',
  'TMPDIR',
  'USERPROFILE',
  'GH_HOST',
  'GITHUB_API_URL',
  'GITHUB_SERVER_URL',
  'CAO_DEPENDABOT_ALERTS_MAX_PAGES'
];

function commandFailureMessage(result, fallback) {
  return (result.stderr || '').trim() || result.error?.message || fallback;
}

async function discoverOperationalValueScripts(root) {
  const directory = path.resolve(root);
  const entries = await readdir(directory, { withFileTypes: true });
  const scripts = [];
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
    const script = path.join(directory, entry.name, 'operational-value.mjs');
    try {
      if ((await stat(script)).isFile()) scripts.push({ package: entry.name, script });
    } catch (error) {
      if (!(error && error.code === 'ENOENT')) throw error;
    }
  }
  return scripts;
}

function githubApiRemaining(env) {
  const result = spawnSync('gh', ['api', 'rate_limit', '--jq', '.resources.core.remaining'], {
    encoding: 'utf8',
    env
  });
  if (result.error || result.status !== 0) {
    throw new Error(`Unable to read GitHub API rate limit: ${commandFailureMessage(result, 'gh api rate_limit failed')}`);
  }
  const remaining = Number(String(result.stdout).trim());
  if (!Number.isSafeInteger(remaining) || remaining < 0) {
    throw new Error('GitHub API returned an invalid core rate limit');
  }
  return remaining;
}

function operationalValueWorkerEnvironment(databasePath, observedAt, rateLimitReserve) {
  const env = Object.fromEntries(WORKER_ENVIRONMENT.flatMap((name) => (
    process.env[name] === undefined ? [] : [[name, process.env[name]]]
  )));
  const token = process.env.CAO_OPERATIONAL_VALUE_GH_TOKEN || process.env.GH_TOKEN;
  if (token) env.GH_TOKEN = token;
  env.CAO_DATABASE = path.resolve(databasePath);
  env.CAO_OPERATIONAL_VALUE_TIMESTAMP = observedAt;
  if (rateLimitReserve !== undefined) {
    env.CAO_GITHUB_API_MIN_REMAINING = String(rateLimitReserve);
  }
  return { env, token };
}

function redactToken(message, token) {
  return token ? String(message).replaceAll(token, '***') : String(message);
}

function runOperationalValueWorker(entry, request, env) {
  const result = spawnSync(process.execPath, [entry.script], {
    encoding: 'utf8',
    input: request,
    maxBuffer: 16 * 1024 * 1024,
    timeout: WORKER_TIMEOUT_MS,
    killSignal: 'SIGKILL',
    env
  });
  if (result.error || result.status !== 0) {
    throw new Error(`${entry.script} failed: ${commandFailureMessage(result, 'operational-value.mjs failed')}`);
  }
  return result.stdout;
}

export function operationalValueReserve(value, UsageError = Error) {
  if (value === undefined) return undefined;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed === 0) {
    throw new UsageError('--max-github-api-rate-limit must be a non-zero integer');
  }
  return Math.abs(parsed);
}

function parseOperationalValueOutput(content, source, repositories) {
  const allowedRepositories = new Set(repositories.map((repository) => repository.toLowerCase()));
  return String(content).split(/\r?\n/).flatMap((line, index) => {
    if (!line.trim()) return [];
    let record;
    try {
      record = JSON.parse(line);
    } catch (error) {
      throw new Error(`${source}:${index + 1} emitted invalid JSON: ${error.message}`);
    }
    if (!record || typeof record !== 'object' || Array.isArray(record)) {
      throw new Error(`${source}:${index + 1} must emit a JSON object`);
    }
    const timestamp = canonicalTimestamp(record.timestamp, `${source}:${index + 1}.timestamp`);
    const repository = String(record.repository ?? '');
    const valueId = String(record.valueId ?? '');
    const value = record.value;
    if (!REPOSITORY_COORDINATE.test(repository) || !allowedRepositories.has(repository.toLowerCase())) {
      throw new Error(`${source}:${index + 1}.repository must identify a requested repository`);
    }
    if (!OPERATIONAL_VALUE_ID.test(valueId)) {
      throw new Error(`${source}:${index + 1}.valueId must be a lowercase metric identifier`);
    }
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      throw new Error(`${source}:${index + 1}.value must be a finite number`);
    }
    return [{ timestamp, repository, valueId, value }];
  });
}

async function retainedOperationalValueEnvelopes(outputPath, cutoff) {
  let content;
  try {
    content = await readFile(outputPath, 'utf8');
  } catch (error) {
    if (error && error.code === 'ENOENT') return [];
    throw error;
  }
  return content.split(/\r?\n/).flatMap((line, index) => {
    if (!line.trim()) return [];
    const envelope = JSON.parse(line);
    if (envelope?.schema_version !== 2 || envelope?.kind !== 'operational_value') {
      throw new Error(`${outputPath}:${index + 1} is not an operational value envelope`);
    }
    const timestamp = Date.parse(envelope.operational_value?.timestamp);
    if (!Number.isFinite(timestamp)) {
      throw new Error(`${outputPath}:${index + 1} has an invalid operational value timestamp`);
    }
    return timestamp >= cutoff ? [envelope] : [];
  });
}

export async function runOperationalValue({
  indexedDB,
  databasePath,
  root = '.',
  outputPath,
  timestamp = new Date().toISOString(),
  repositories = [],
  rateLimitReserve,
  retentionWindow
}) {
  const observedAt = canonicalTimestamp(timestamp, '--timestamp');
  const selectedRepositories = repositories.length > 0
    ? repositories
    : (await readCollection(indexedDB, 'repositories'))
      .map((record) => String(record.fullName ?? ''))
      .filter((repository) => REPOSITORY_COORDINATE.test(repository));
  const uniqueRepositories = [...new Map(
    selectedRepositories.map((repository) => [repository.toLowerCase(), repository])
  ).values()].sort((left, right) => left.localeCompare(right));
  if (uniqueRepositories.length === 0) {
    throw new Error('Operational value requires at least one repository in the dashboard database or --repository');
  }
  const scripts = await discoverOperationalValueScripts(root);
  const request = `${JSON.stringify({
    schemaVersion: 1,
    timestamp: observedAt,
    repositories: uniqueRepositories,
    database: path.resolve(databasePath)
  })}\n`;
  const values = [];
  const warnings = [];
  const worker = operationalValueWorkerEnvironment(databasePath, observedAt, rateLimitReserve);
  const warn = (entry, error) => {
    const message = redactToken(error instanceof Error ? error.message : error, worker.token);
    const warning = { package: entry?.package ?? null, message };
    warnings.push(warning);
    console.warn(`Warning: ${message}`);
  };
  for (const entry of scripts) {
    try {
      if (rateLimitReserve !== undefined && githubApiRemaining(worker.env) <= rateLimitReserve) {
        throw new Error(`GitHub API core remaining is at or below the reserved ${rateLimitReserve} requests`);
      }
      const output = runOperationalValueWorker(entry, request, worker.env);
      values.push(...parseOperationalValueOutput(output, entry.script, uniqueRepositories)
        .map((record) => ({ ...record, campaign: entry.package })));
    } catch (error) {
      warn(entry, error);
    }
  }
  if (rateLimitReserve !== undefined) {
    try {
      if (githubApiRemaining(worker.env) < rateLimitReserve) {
        throw new Error(`Operational value crossed the reserved GitHub API floor of ${rateLimitReserve} requests`);
      }
    } catch (error) {
      warn(null, error);
    }
  }
  const output = outputPath ? path.resolve(outputPath) : undefined;
  if (output) {
    await mkdir(path.dirname(output), { recursive: true });
    const envelopes = values.map((record) => ({
      schema_version: 2,
      kind: 'operational_value',
      operational_value: {
        timestamp: record.timestamp,
        repository: record.repository,
        campaign: record.campaign,
        campaign_id: `campaign:${record.campaign}`,
        value_id: record.valueId,
        value: record.value
      }
    }));
    const retained = retentionWindow === undefined
      ? []
      : await retainedOperationalValueEnvelopes(output, Date.parse(observedAt) - retentionWindow);
    const merged = new Map([...retained, ...envelopes].map((envelope) => {
      const value = envelope.operational_value;
      return [`${String(value.repository).toLowerCase()}\0${value.value_id}\0${value.timestamp}`, envelope];
    }));
    const jsonl = [...merged.values()].map((envelope) => JSON.stringify(envelope)).join('\n');
    const temporary = `${output}.tmp-${process.pid}-${Date.now()}`;
    try {
      await writeFile(temporary, jsonl ? `${jsonl}\n` : '', { flag: 'wx' });
      await rename(temporary, output);
    } finally {
      await rm(temporary, { force: true });
    }
  }
  return {
    command: 'operational-value',
    timestamp: observedAt,
    repositories: uniqueRepositories.length,
    scripts: scripts.map((entry) => entry.package),
    values,
    warnings,
    output: output ?? null
  };
}
