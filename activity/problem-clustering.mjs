import { spawnSync } from 'node:child_process';
import { mkdtemp, readdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { backup, DatabaseSync } from 'node:sqlite';
import { canonicalTimestamp } from '../dashboard/site/src/data/model/schema.js';
import { REPOSITORY_COORDINATE } from './operational-value.mjs';

const PROBLEM_ID = /^[a-z0-9]+(?:[._:-][a-z0-9]+)*$/;
const SEVERITIES = new Set(['critical', 'high', 'medium', 'low', 'info']);
const SCRIPT_NAME = 'problem-clustering.mjs';
const MAX_PROBLEMS_PER_PACKAGE = 1_000;
const MAX_EVIDENCE_BYTES = 128 * 1_024;
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
    evidence TEXT NOT NULL,
    PRIMARY KEY (producer, problem_id)
  ) STRICT;
  CREATE INDEX IF NOT EXISTS cao_problems_observed_at
    ON cao_problems (observed_at DESC, producer, problem_id);
  CREATE INDEX IF NOT EXISTS cao_problems_repository
    ON cao_problems (repository, severity, observed_at DESC);
`;

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

function runWorker(entry, request, databasePath) {
  const result = spawnSync(process.execPath, [entry.script], {
    encoding: 'utf8',
    input: request,
    maxBuffer: 16 * 1024 * 1024,
    timeout: WORKER_TIMEOUT_MS,
    killSignal: 'SIGKILL',
    env: workerEnvironment(databasePath, JSON.parse(request).timestamp)
  });
  if (result.error || result.status !== 0) {
    const detail = String(result.stderr || '').trim() || result.error?.message || 'problem clustering failed';
    throw new Error(`${entry.script} failed: ${detail}`);
  }
  return result.stdout;
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
    database.exec(PROBLEMS_SCHEMA);
    const remove = database.prepare('DELETE FROM cao_problems WHERE producer = ?');
    const insert = database.prepare(`
      INSERT INTO cao_problems (
        producer, problem_id, observed_at, severity, title, summary,
        campaign, repository, workflow, target_repository, evidence
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
          problem.evidence
        );
      }
      database.exec('COMMIT');
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
    database.exec(PROBLEMS_SCHEMA);
    if (producers.length === 0) {
      database.exec('DELETE FROM cao_problems');
      return;
    }
    const placeholders = producers.map(() => '?').join(', ');
    database.prepare(`DELETE FROM cao_problems WHERE producer NOT IN (${placeholders})`).run(...producers);
  } finally {
    database.close();
  }
}

export async function runProblemClustering({
  databasePath,
  root = '.',
  timestamp = new Date().toISOString()
}) {
  const observedAt = canonicalTimestamp(timestamp, '--timestamp');
  const resolvedDatabase = path.resolve(databasePath);
  const scripts = await discoverProblemClusteringScripts(root);
  removeUninstalledProducerProblems(resolvedDatabase, scripts.map((entry) => entry.package));
  const temporaryDirectory = await mkdtemp(path.join(tmpdir(), 'cao-problem-clustering-'));
  const snapshot = path.join(temporaryDirectory, 'activity.sqlite');
  const values = [];
  const warnings = [];
  try {
    const source = new DatabaseSync(resolvedDatabase);
    try {
      await backup(source, snapshot);
    } finally {
      source.close();
    }
    const request = `${JSON.stringify({
      schemaVersion: 1,
      timestamp: observedAt,
      database: snapshot
    })}\n`;
    for (const entry of scripts) {
      try {
        const output = runWorker(entry, request, snapshot);
        const problems = parseOutput(output, entry, observedAt);
        replaceProblems(resolvedDatabase, entry.package, problems);
        values.push(...problems.map(({ evidence, ...problem }) => ({
          ...problem,
          evidence: JSON.parse(evidence)
        })));
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        warnings.push({ package: entry.package, message });
        console.warn(`Warning: ${message}`);
      }
    }
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
  return {
    command: 'cluster-problems',
    timestamp: observedAt,
    scripts: scripts.map((entry) => entry.package),
    problems: values,
    warnings
  };
}
