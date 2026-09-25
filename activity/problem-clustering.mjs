import { spawn } from 'node:child_process';
import { mkdtemp, readdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { backup, DatabaseSync } from 'node:sqlite';
import { canonicalTimestamp } from '../dashboard/site/src/data/model/schema.js';
import { createDebug } from './debug.mjs';
import { REPOSITORY_COORDINATE } from './operational-value.mjs';

const PROBLEM_ID = /^[a-z0-9]+(?:[._:-][a-z0-9]+)*$/;
const SEVERITIES = new Set(['critical', 'high', 'medium', 'low', 'info']);
const SCRIPT_NAME = 'problem-clustering.mjs';
const MAX_PROBLEMS_PER_PACKAGE = 1_000;
const MAX_FIX_PROMPT_CHARACTERS = 8_000;
const MAX_EVIDENCE_BYTES = 128 * 1_024;
const MAX_WORKER_OUTPUT_BYTES = 16 * 1_024 * 1_024;
const WORKER_TIMEOUT_MS = 2 * 60 * 1_000;
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
  'USERPROFILE'
];
const debug = createDebug('problem-clustering');

const PROBLEMS_SCHEMA = `
  CREATE TABLE IF NOT EXISTS cao_problems (
    producer TEXT NOT NULL,
    problem_id TEXT NOT NULL,
    observed_at TEXT NOT NULL,
    severity TEXT NOT NULL,
    title TEXT NOT NULL,
    summary TEXT NOT NULL,
    campaign TEXT NOT NULL,
    repository TEXT NOT NULL,
    workflow TEXT NOT NULL,
    target_repository TEXT NOT NULL,
    fix_prompt TEXT NOT NULL DEFAULT '',
    evidence TEXT NOT NULL,
    PRIMARY KEY (producer, problem_id)
  ) STRICT;
  CREATE INDEX IF NOT EXISTS cao_problems_observed_at
    ON cao_problems (observed_at DESC, producer, problem_id);
  CREATE INDEX IF NOT EXISTS cao_problems_repository
    ON cao_problems (repository, severity, observed_at DESC);
`;

function ensureProblemsSchema(database) {
  database.exec(PROBLEMS_SCHEMA);
  const columns = database.prepare('PRAGMA table_info(cao_problems)').all();
  if (!columns.some((column) => column.name === 'fix_prompt')) {
    database.exec("ALTER TABLE cao_problems ADD COLUMN fix_prompt TEXT NOT NULL DEFAULT ''");
  }
}

function text(value, field, source, { required = false, maximum = 1_000 } = {}) {
  if (value === undefined || value === null || value === '') {
    if (required) throw new Error(`${source}.${field} is required`);
    return '';
  }
  if (typeof value !== 'string') throw new Error(`${source}.${field} must be a string`);
  const result = value.trim();
  if (required && !result) throw new Error(`${source}.${field} is required`);
  if (result.length > maximum) throw new Error(`${source}.${field} exceeds ${maximum} characters`);
  return result;
}

async function discoverProblemClusteringScripts(root) {
  const directory = path.resolve(root);
  const entries = await readdir(directory, { withFileTypes: true });
  const scripts = [];
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
    const script = path.join(directory, entry.name, SCRIPT_NAME);
    try {
      if ((await stat(script)).isFile()) scripts.push({ package: entry.name, script });
    } catch (error) {
      if (!(error && error.code === 'ENOENT')) throw error;
    }
  }
  debug('discovery completed scripts=%d packages=%o', scripts.length, scripts.map((entry) => entry.package));
  return scripts;
}

function workerEnvironment(databasePath, timestamp) {
  return {
    ...Object.fromEntries(WORKER_ENVIRONMENT.flatMap((name) => (
      process.env[name] === undefined ? [] : [[name, process.env[name]]]
    ))),
    CAO_DATABASE: databasePath,
    CAO_PROBLEM_CLUSTERING_TIMESTAMP: timestamp
  };
}

function runWorker(entry, request, databasePath, { signal, timeoutMs }) {
  signal?.throwIfAborted();
  const startedAt = performance.now();
  debug('worker starting package=%s timeout_ms=%d', entry.package, timeoutMs);
  const timeout = AbortSignal.timeout(timeoutMs);
  const workerSignal = signal ? AbortSignal.any([signal, timeout]) : timeout;
  const child = spawn(process.execPath, [entry.script], {
    stdio: ['pipe', 'pipe', 'pipe'],
    killSignal: 'SIGKILL',
    signal: workerSignal,
    env: workerEnvironment(databasePath, JSON.parse(request).timestamp)
  });
  return new Promise((resolve, reject) => {
    const stdout = [];
    const stderr = [];
    let outputBytes = 0;
    let outputError;
    const collect = (chunks) => (chunk) => {
      outputBytes += chunk.length;
      if (outputBytes > MAX_WORKER_OUTPUT_BYTES) {
        outputError = `output exceeded ${MAX_WORKER_OUTPUT_BYTES} bytes`;
        debug('worker output limit exceeded package=%s output_bytes=%d', entry.package, outputBytes);
        child.kill('SIGKILL');
        return;
      }
      chunks.push(chunk);
    };
    child.stdout.on('data', collect(stdout));
    child.stderr.on('data', collect(stderr));
    child.on('error', (error) => {
      if (signal?.aborted) reject(signal.reason);
      else if (timeout.aborted) reject(new Error(`${entry.script} timed out after ${timeoutMs} ms`));
      else reject(new Error(`${entry.script} failed: ${error.message}`));
    });
    child.on('close', (code) => {
      if (signal?.aborted) {
        debug('worker cancelled package=%s duration_ms=%d', entry.package, Math.round(performance.now() - startedAt));
        reject(signal.reason);
        return;
      }
      if (timeout.aborted) {
        debug('worker timed out package=%s duration_ms=%d', entry.package, Math.round(performance.now() - startedAt));
        reject(new Error(`${entry.script} timed out after ${timeoutMs} ms`));
        return;
      }
      const detail = Buffer.concat(stderr).toString('utf8').trim();
      if (outputError || code !== 0) {
        debug(
          'worker failed package=%s duration_ms=%d exit_code=%s output_bytes=%d',
          entry.package,
          Math.round(performance.now() - startedAt),
          code,
          outputBytes
        );
        reject(new Error(`${entry.script} failed: ${outputError || detail || 'problem clustering failed'}`));
        return;
      }
      debug(
        'worker completed package=%s duration_ms=%d output_bytes=%d',
        entry.package,
        Math.round(performance.now() - startedAt),
        outputBytes
      );
      resolve(Buffer.concat(stdout).toString('utf8'));
    });
    child.stdin.on('error', (error) => {
      if (workerSignal.aborted) return;
      child.kill('SIGKILL');
      reject(new Error(`${entry.script} failed to read its request: ${error.message}`));
    });
    child.stdin.end(request);
  });
}

function parseOutput(content, entry, defaultTimestamp) {
  const problems = String(content).split(/\r?\n/).flatMap((line, index) => {
    if (!line.trim()) return [];
    const source = `${entry.script}:${index + 1}`;
    let record;
    try {
      record = JSON.parse(line);
    } catch (error) {
      throw new Error(`${source} emitted invalid JSON: ${error.message}`);
    }
    if (!record || typeof record !== 'object' || Array.isArray(record)) {
      throw new Error(`${source} must emit a JSON object`);
    }
    const id = text(record.id, 'id', source, { required: true, maximum: 200 });
    if (!PROBLEM_ID.test(id)) throw new Error(`${source}.id must be a lowercase problem identifier`);
    const severity = text(record.severity ?? 'medium', 'severity', source);
    if (!SEVERITIES.has(severity)) {
      throw new Error(`${source}.severity must be critical, high, medium, low, or info`);
    }
    const repository = text(record.repository, 'repository', source);
    const targetRepository = text(record.targetRepository, 'targetRepository', source);
    if (repository && !REPOSITORY_COORDINATE.test(repository)) {
      throw new Error(`${source}.repository must use OWNER/REPO form`);
    }
    if (targetRepository && !REPOSITORY_COORDINATE.test(targetRepository)) {
      throw new Error(`${source}.targetRepository must use OWNER/REPO form`);
    }
    const evidence = record.evidence ?? {};
    if (!evidence || typeof evidence !== 'object' || Array.isArray(evidence)) {
      throw new Error(`${source}.evidence must be an object`);
    }
    const encodedEvidence = JSON.stringify(evidence);
    if (Buffer.byteLength(encodedEvidence) > MAX_EVIDENCE_BYTES) {
      throw new Error(`${source}.evidence exceeds ${MAX_EVIDENCE_BYTES} bytes`);
    }
    return [{
      producer: entry.package,
      id,
      observedAt: canonicalTimestamp(record.observedAt ?? defaultTimestamp, `${source}.observedAt`),
      severity,
      title: text(record.title, 'title', source, { required: true, maximum: 500 }),
      summary: text(record.summary, 'summary', source, { maximum: 4_000 }),
      campaign: text(record.campaign ?? entry.package, 'campaign', source, { maximum: 200 }),
      repository,
      workflow: text(record.workflow, 'workflow', source, { maximum: 500 }),
      targetRepository,
      fixPrompt: text(record.fixPrompt, 'fixPrompt', source, {
        required: true,
        maximum: MAX_FIX_PROMPT_CHARACTERS
      }),
      evidence: encodedEvidence
    }];
  });
  if (problems.length > MAX_PROBLEMS_PER_PACKAGE) {
    throw new Error(`${entry.script} emitted more than ${MAX_PROBLEMS_PER_PACKAGE} problems`);
  }
  const ids = new Set();
  for (const problem of problems) {
    if (ids.has(problem.id)) throw new Error(`${entry.script} emitted duplicate problem id: ${problem.id}`);
    ids.add(problem.id);
  }
  return problems;
}

function replaceProblems(databasePath, producer, problems) {
  const database = new DatabaseSync(databasePath);
  try {
    database.exec('PRAGMA busy_timeout = 5000');
    ensureProblemsSchema(database);
    const remove = database.prepare('DELETE FROM cao_problems WHERE producer = ?');
    const insert = database.prepare(`
      INSERT INTO cao_problems (
        producer, problem_id, observed_at, severity, title, summary,
        campaign, repository, workflow, target_repository, fix_prompt, evidence
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    database.exec('BEGIN IMMEDIATE');
    try {
      remove.run(producer);
      for (const problem of problems) {
        insert.run(
          problem.producer,
          problem.id,
          problem.observedAt,
          problem.severity,
          problem.title,
          problem.summary,
          problem.campaign,
          problem.repository,
          problem.workflow,
          problem.targetRepository,
          problem.fixPrompt,
          problem.evidence
        );
      }
      database.exec('COMMIT');
      debug('problems replaced package=%s count=%d', producer, problems.length);
    } catch (error) {
      database.exec('ROLLBACK');
      throw error;
    }
  } finally {
    database.close();
  }
}

function removeUninstalledProducerProblems(databasePath, producers) {
  const database = new DatabaseSync(databasePath);
  try {
    database.exec('PRAGMA busy_timeout = 5000');
    ensureProblemsSchema(database);
    if (producers.length === 0) {
      const removed = database.prepare('DELETE FROM cao_problems').run().changes;
      debug('uninstalled producer cleanup active_producers=0 removed=%d', removed);
      return;
    }
    const placeholders = producers.map(() => '?').join(', ');
    const removed = database.prepare(`DELETE FROM cao_problems WHERE producer NOT IN (${placeholders})`)
      .run(...producers).changes;
    debug('uninstalled producer cleanup active_producers=%d removed=%d', producers.length, removed);
  } finally {
    database.close();
  }
}

export async function runProblemClustering({
  databasePath,
  root = '.',
  timestamp = new Date().toISOString(),
  signal,
  workerTimeoutMs = WORKER_TIMEOUT_MS
}) {
  signal?.throwIfAborted();
  const startedAt = performance.now();
  const observedAt = canonicalTimestamp(timestamp, '--timestamp');
  const resolvedDatabase = path.resolve(databasePath);
  debug('clustering started timestamp=%s', observedAt);
  const scripts = await discoverProblemClusteringScripts(root);
  signal?.throwIfAborted();
  removeUninstalledProducerProblems(resolvedDatabase, scripts.map((entry) => entry.package));
  const temporaryDirectory = await mkdtemp(path.join(tmpdir(), 'cao-problem-clustering-'));
  const snapshot = path.join(temporaryDirectory, 'activity.sqlite');
  const values = [];
  const warnings = [];
  let completedPackages = 0;
  try {
    const source = new DatabaseSync(resolvedDatabase);
    try {
      await backup(source, snapshot);
      debug('database snapshot completed');
    } finally {
      source.close();
    }
    const request = `${JSON.stringify({
      schemaVersion: 1,
      timestamp: observedAt,
      database: snapshot
    })}\n`;
    for (const entry of scripts) {
      signal?.throwIfAborted();
      try {
        const output = await runWorker(entry, request, snapshot, {
          signal,
          timeoutMs: workerTimeoutMs
        });
        const problems = parseOutput(output, entry, observedAt);
        replaceProblems(resolvedDatabase, entry.package, problems);
        values.push(...problems.map(({ evidence, ...problem }) => ({
          ...problem,
          evidence: JSON.parse(evidence)
        })));
        completedPackages += 1;
      } catch (error) {
        if (signal?.aborted) {
          debug('clustering cancelled completed_packages=%d duration_ms=%d', completedPackages, Math.round(performance.now() - startedAt));
          throw signal.reason;
        }
        const message = error instanceof Error ? error.message : String(error);
        warnings.push({ package: entry.package, message });
        debug('package retained after failure package=%s warnings=%d', entry.package, warnings.length);
        console.warn(`Warning: ${message}`);
      }
    }
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true });
    debug('temporary snapshot removed');
  }
  debug(
    'clustering completed scripts=%d problems=%d warnings=%d duration_ms=%d',
    scripts.length,
    values.length,
    warnings.length,
    Math.round(performance.now() - startedAt)
  );
  return {
    command: 'cluster-problems',
    timestamp: observedAt,
    scripts: scripts.map((entry) => entry.package),
    problems: values,
    warnings
  };
}
