import { spawn, spawnSync } from 'node:child_process';
import { readFile, readdir, mkdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { canonicalTimestamp } from '../dashboard/site/src/data/model/schema.js';
import { readCollection } from '../dashboard/site/src/data/storage/indexeddb.js';

export const REPOSITORY_COORDINATE = /^[A-Za-z0-9][A-Za-z0-9-]*\/[A-Za-z0-9._-]+$/;
const OPERATIONAL_VALUE_ID = /^[a-z0-9]+(?:[._-][a-z0-9]+)*$/;
const WORKER_TIMEOUT_MS = 2 * 60 * 1000;
const RATE_LIMIT_TIMEOUT_MS = 30 * 1000;
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

async function githubApiRemaining(env, signal) {
  const result = await runChildProcess('gh', ['api', 'rate_limit', '--jq', '.resources.core.remaining'], {
    env,
    signal,
    timeoutMs: RATE_LIMIT_TIMEOUT_MS
  });
  signal?.throwIfAborted();
  if (result.error || result.status !== 0) {
    const message = result.timedOut
      ? `timed out after ${RATE_LIMIT_TIMEOUT_MS} ms`
      : commandFailureMessage(result, 'gh api rate_limit failed');
    throw new Error(`Unable to read GitHub API rate limit: ${message}`);
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

function terminateProcessTree(child) {
  if (!child.pid) return;
  if (process.platform === 'win32') {
    const script = [
      '$processes = Get-CimInstance Win32_Process',
      '$children = @{}',
      'foreach ($process in $processes) { $children[$process.ParentProcessId] += @($process.ProcessId) }',
      'function Stop-Tree([int]$id) {',
      '  foreach ($descendant in @($children[$id])) { Stop-Tree $descendant }',
      '  Stop-Process -Id $id -Force -ErrorAction SilentlyContinue',
      '}',
      `Stop-Tree ${child.pid}`
    ].join('; ');
    spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
      windowsHide: true
    });
    return;
  }
  try {
    process.kill(-child.pid, 'SIGKILL');
    return;
  } catch {}
  const processes = spawnSync('ps', ['-eo', 'pid=,ppid='], { encoding: 'utf8' });
  const children = new Map();
  for (const line of String(processes.stdout ?? '').split(/\r?\n/)) {
    const [pid, parent] = line.trim().split(/\s+/).map(Number);
    if (!Number.isSafeInteger(pid) || !Number.isSafeInteger(parent)) continue;
    const siblings = children.get(parent) ?? [];
    siblings.push(pid);
    children.set(parent, siblings);
  }
  const tree = [];
  const visit = (pid) => {
    tree.push(pid);
    for (const descendant of children.get(pid) ?? []) visit(descendant);
  };
  visit(child.pid);
  for (const pid of tree) {
    try {
      process.kill(pid, 'SIGSTOP');
    } catch {}
  }
  for (const pid of tree.reverse()) {
    try {
      process.kill(pid, 'SIGKILL');
    } catch {}
  }
}

function runChildProcess(command, args, {
  env,
  input,
  maxBuffer = 16 * 1024 * 1024,
  signal,
  timeoutMs
} = {}) {
  const timeoutSignal = AbortSignal.timeout(timeoutMs);
  const workerSignal = signal
    ? AbortSignal.any([signal, timeoutSignal])
    : timeoutSignal;
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      detached: process.platform !== 'win32',
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true
    });
    const stdout = [];
    const stderr = [];
    let stdoutLength = 0;
    let stderrLength = 0;
    let error;
    const collect = (chunks, chunk, stream) => {
      chunks.push(chunk);
      if (stream === 'stdout') stdoutLength += chunk.length;
      else stderrLength += chunk.length;
      if (stdoutLength > maxBuffer || stderrLength > maxBuffer) {
        error ??= new Error(`${stream} exceeded maxBuffer`);
        terminateProcessTree(child);
      }
    };
    child.stdout.on('data', (chunk) => collect(stdout, chunk, 'stdout'));
    child.stderr.on('data', (chunk) => collect(stderr, chunk, 'stderr'));
    child.once('error', (cause) => {
      error = cause;
    });
    child.once('exit', () => terminateProcessTree(child));
    child.once('close', (status) => {
      workerSignal.removeEventListener('abort', abortWorker);
      terminateProcessTree(child);
      resolve({
        error,
        status,
        stdout: Buffer.concat(stdout).toString('utf8'),
        stderr: Buffer.concat(stderr).toString('utf8'),
        timedOut: timeoutSignal.aborted && !signal?.aborted
      });
    });
    const abortWorker = () => terminateProcessTree(child);
    workerSignal.addEventListener('abort', abortWorker, { once: true });
    if (workerSignal.aborted) abortWorker();
    child.stdin.end(input, () => {});
  });
}

async function runOperationalValueWorker(entry, request, env, { signal, timeoutMs = WORKER_TIMEOUT_MS } = {}) {
  const result = await runChildProcess(process.execPath, [entry.script], {
    env,
    input: request,
    signal,
    timeoutMs
  });
  signal?.throwIfAborted();
  if (result.error || result.status !== 0) {
    const message = result.timedOut
      ? `timed out after ${timeoutMs} ms`
      : commandFailureMessage(result, 'operational-value.mjs failed');
    throw new Error(`${entry.script} failed: ${message}`, { cause: result.error });
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
    const metricRole = record.metricRole ?? 'primary';
    const metricName = record.metricName ?? valueId;
    const metricDirection = record.metricDirection ?? 'increase';
    const maturityStatus = record.maturityStatus ?? 'matured';
    const adoptionAt = record.adoptionAt;
    const evaluationMode = record.evaluationMode;
    const workflowSlug = record.workflowSlug;
    const workflowName = record.workflowName;
    if (!REPOSITORY_COORDINATE.test(repository) || !allowedRepositories.has(repository.toLowerCase())) {
      throw new Error(`${source}:${index + 1}.repository must identify a requested repository`);
    }
    if (!OPERATIONAL_VALUE_ID.test(valueId)) {
      throw new Error(`${source}:${index + 1}.valueId must be a lowercase metric identifier`);
    }
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      throw new Error(`${source}:${index + 1}.value must be a finite number`);
    }
    if (!['primary', 'diagnostic'].includes(metricRole)) {
      throw new Error(`${source}:${index + 1}.metricRole must be primary or diagnostic`);
    }
    if (typeof metricName !== 'string' || !metricName.trim()) {
      throw new Error(`${source}:${index + 1}.metricName must be a non-empty string`);
    }
    if (!['increase', 'decrease', 'maintain', 'target'].includes(metricDirection)) {
      throw new Error(`${source}:${index + 1}.metricDirection is invalid`);
    }
    if (!['matured', 'interim', 'unavailable'].includes(maturityStatus)) {
      throw new Error(`${source}:${index + 1}.maturityStatus is invalid`);
    }
    if (adoptionAt !== undefined && !Number.isFinite(Date.parse(adoptionAt))) {
      throw new Error(`${source}:${index + 1}.adoptionAt must be an ISO-8601 timestamp`);
    }
    if (evaluationMode !== undefined && !['baseline-comparable', 'attainment-only'].includes(evaluationMode)) {
      throw new Error(`${source}:${index + 1}.evaluationMode is invalid`);
    }
    for (const [field, candidate] of [['workflowSlug', workflowSlug], ['workflowName', workflowName]]) {
      if (candidate !== undefined && (typeof candidate !== 'string' || !candidate.trim())) {
        throw new Error(`${source}:${index + 1}.${field} must be a non-empty string`);
      }
    }
    return [{
      timestamp,
      repository,
      valueId,
      value,
      ...(Object.hasOwn(record, 'metricRole') ? { metricRole } : {}),
      ...(Object.hasOwn(record, 'metricName') ? { metricName: metricName.trim() } : {}),
      ...(Object.hasOwn(record, 'metricDirection') ? { metricDirection } : {}),
      ...(Object.hasOwn(record, 'maturityStatus') ? { maturityStatus } : {}),
      ...(Object.hasOwn(record, 'adoptionAt') ? { adoptionAt: canonicalTimestamp(adoptionAt, `${source}:${index + 1}.adoptionAt`) } : {}),
      ...(Object.hasOwn(record, 'evaluationMode') ? { evaluationMode } : {}),
      ...(Object.hasOwn(record, 'workflowSlug') ? { workflowSlug: workflowSlug.trim() } : {}),
      ...(Object.hasOwn(record, 'workflowName') ? { workflowName: workflowName.trim() } : {})
    }];
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
  retentionWindow,
  signal,
  workerTimeoutMs = WORKER_TIMEOUT_MS
}) {
  signal?.throwIfAborted();
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
      signal?.throwIfAborted();
      if (rateLimitReserve !== undefined && await githubApiRemaining(worker.env, signal) <= rateLimitReserve) {
        throw new Error(`GitHub API core remaining is at or below the reserved ${rateLimitReserve} requests`);
      }
      const output = await runOperationalValueWorker(entry, request, worker.env, {
        signal,
        timeoutMs: workerTimeoutMs
      });
      values.push(...parseOperationalValueOutput(output, entry.script, uniqueRepositories)
        .map((record) => ({ ...record, campaign: entry.package })));
    } catch (error) {
      signal?.throwIfAborted();
      warn(entry, error);
    }
  }
  signal?.throwIfAborted();
  if (rateLimitReserve !== undefined) {
    try {
      if (await githubApiRemaining(worker.env, signal) < rateLimitReserve) {
        throw new Error(`Operational value crossed the reserved GitHub API floor of ${rateLimitReserve} requests`);
      }
    } catch (error) {
      warn(null, error);
    }
  }
  signal?.throwIfAborted();
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
        value: record.value,
        metric_role: record.metricRole ?? 'primary',
        metric_name: record.metricName ?? record.valueId,
        metric_direction: record.metricDirection ?? 'increase',
        maturity_status: record.maturityStatus ?? 'matured',
        adoption_at: record.adoptionAt,
        evaluation_mode: record.evaluationMode,
        workflow_slug: record.workflowSlug,
        workflow_name: record.workflowName
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
  signal?.throwIfAborted();
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
