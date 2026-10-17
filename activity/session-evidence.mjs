import { readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseUnifiedSessionDocument } from '../dashboard/site/src/data/adapters/unified-session.js';
import { experimentAssignmentArtifact, parseExperimentAssignments } from '../dashboard/site/src/data/adapters/experiment-evidence.js';
import { classifiedEval, isSupportedGhAwJsonlSchemaVersion } from '../dashboard/site/src/data/adapters/gh-aw-logs.js';
import { runId as canonicalRunId } from '../dashboard/site/src/data/model/ids.js';
import { readJsonlRecords } from './jsonl.mjs';

async function artifactFile(directory, filename) {
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
  const candidates = entries.flatMap((entry) => {
    if (entry.isFile() && entry.name === filename) return [path.join(directory, entry.name)];
    if (entry.isDirectory() && (/(^|-)usage$/.test(entry.name)
        || (filename === 'evals.jsonl' && /(^|-)evals$/.test(entry.name)))) {
      if (filename === 'assignments.json') {
        return [path.join(directory, entry.name, 'experiment', filename)];
      }
      return [path.join(directory, entry.name, filename)];
    }
    if (filename === 'assignments.json' && entry.isDirectory() && /(^|-)experiments?$/.test(entry.name)) {
      return [path.join(directory, entry.name, filename)];
    }
    return [];
  });
  const found = [];
  for (const candidate of candidates) {
    try {
      found.push({ path: candidate, content: await readFile(candidate, 'utf8') });
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  }
  if (filename === 'assignments.json') {
    const file = experimentAssignmentArtifact(found.map((file) => ({
      ...file, path: path.relative(directory, file.path).split(path.sep).join('/')
    })));
    return file ? { ...file, path: path.join(directory, file.path) } : null;
  }
  if (found.length > 1) throw new TypeError('Multiple evidence artifacts found for one run');
  return found[0] ?? null;
}

async function sessionIdentity(runDirectory, sessionPath) {
  const artifactDirectory = path.dirname(sessionPath);
  const directories = [artifactDirectory];
  if (/(^|-)experiments?$/.test(path.basename(artifactDirectory))) {
    directories.push(path.dirname(artifactDirectory));
  }
  directories.push(runDirectory);
  for (const directory of new Set(directories)) {
    try {
      return JSON.parse(await readFile(path.join(directory, 'aw_info.json'), 'utf8'));
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  }
  if (/(^|-)experiments?$/.test(path.basename(artifactDirectory))) {
    const file = await artifactFile(runDirectory, 'aw_info.json');
    if (file) return JSON.parse(file.content);
  }
  return null;
}

async function experimentEvidence(runDirectory, runId, attempt, repository) {
  try {
    const file = await artifactFile(runDirectory, 'assignments.json');
    if (!file) return null;
    const info = await sessionIdentity(runDirectory, file.path);
    if (!info || String(info.run_id) !== String(runId)
        || String(info.repository).toLowerCase() !== repository.toLowerCase()
        || !Number.isInteger(Number(info.run_attempt)) || Number(info.run_attempt) < 1) {
      throw new TypeError('Experiment artifact identity unavailable or mismatched');
    }
    if (Number(info.run_attempt) !== Number(attempt)) return null;
    return parseExperimentAssignments(file.content, file.path);
  } catch (error) {
    if (!(error instanceof SyntaxError) && !(error instanceof TypeError)) throw error;
    console.warn(`Skipping invalid experiment evidence for run ${runId}`);
    return null;
  }
}

async function evalEvidence(runDirectory, runId, attempt, repository, observedAt) {
  try {
    const file = await artifactFile(runDirectory, 'evals.jsonl');
    if (!file) return null;
    const info = await sessionIdentity(runDirectory, file.path);
    if (!info || String(info.run_id) !== String(runId)
        || String(info.repository).toLowerCase() !== repository.toLowerCase()
        || !Number.isInteger(Number(info.run_attempt)) || Number(info.run_attempt) < 1) {
      throw new TypeError('Eval artifact identity unavailable or mismatched');
    }
    if (Number(info.run_attempt) !== Number(attempt)) return null;
    const [owner, name] = repository.split('/');
    return file.content.split(/\r?\n/).filter((line) => line.trim()).map((line) => {
      const candidate = JSON.parse(line);
      const result = classifiedEval(candidate, String(runId), canonicalRunId(owner, name, runId), observedAt, attempt);
      if (!result) throw new TypeError('Invalid eval artifact record');
      return {
        id: result.name, answer: result.answer, runId: String(runId), timestamp: result.eventAt,
        ...(typeof candidate.experimentId === 'string' ? { experimentId: candidate.experimentId } : {}),
        ...(typeof candidate.variant === 'string' ? { variant: candidate.variant } : {})
      };
    });
  } catch (error) {
    if (!(error instanceof SyntaxError) && !(error instanceof TypeError)) throw error;
    console.warn(`Skipping invalid eval evidence for run ${runId}`);
    return null;
  }
}

/**
 * Persist only safe session projections in the existing per-repository run
 * cache, so Actions, hosted collection and later snapshot ingestion share it.
 */
export async function enrichSessionEvidence(logDirectory, shardPrefix, repository) {
  const directory = path.dirname(shardPrefix);
  const prefix = path.basename(shardPrefix);
  const names = (await readdir(directory)).filter((name) => name.startsWith(prefix) && name.endsWith('.jsonl')).sort();
  const sessions = new Map();
  const evals = new Map();
  const experiments = new Map();
  let enriched = 0;
  for (const name of names) {
    const filename = path.join(directory, name);
    let changed = false;
    const output = [];
    for (const { value: envelope } of readJsonlRecords(filename)) {
      const run = envelope.run;
      const runId = run?.run_id ?? run?.database_id;
      const runRepository = run && String(run.repository).includes('/')
        ? String(run.repository) : `${run?.organization}/${run?.repository}`;
      if (isSupportedGhAwJsonlSchemaVersion(envelope.schema_version) && envelope.kind === 'run'
          && run && runRepository.toLowerCase() === repository.toLowerCase()) {
        if (!/^\d+$/.test(String(runId))) throw new Error('Invalid session evidence run ID');
        const key = `${runId}:${run.run_attempt ?? 1}`;
        if (!sessions.has(key)) {
          const runDirectory = path.join(logDirectory, `run-${runId}`);
          let evidence = null;
          try {
            const file = await artifactFile(runDirectory, 'aw_session.jsonl');
            if (file) {
              // The download directory is keyed by run ID, not attempt. Verify
              // attempt identity before associating retained artifacts with a rerun.
              const info = await sessionIdentity(runDirectory, file.path);
              if (!info || String(info.run_id) !== String(runId)
                  || String(info.repository).toLowerCase() !== repository.toLowerCase()) {
                throw new TypeError(`Unified session identity unavailable or mismatched for run ${runId}`);
              }
              if (Number(info.run_attempt) === Number(run.run_attempt ?? 1)) {
                const relativePath = path.relative(runDirectory, file.path).split(path.sep).join('/');
                evidence = {
                  version: 1, path: relativePath,
                  ...parseUnifiedSessionDocument(file.content, relativePath, {
                    runId: String(runId), attempt: Number(run.run_attempt ?? 1)
                  })
                };
              } else if (!Number.isInteger(Number(info.run_attempt)) || Number(info.run_attempt) < 1) {
                throw new TypeError(`Unified session attempt identity unavailable for run ${runId}`);
              }
            }
          } catch (error) {
            if (!(error instanceof SyntaxError) && !(error instanceof TypeError)) throw error;
            console.warn(`Skipping invalid unified session evidence for run ${runId}`);
          }
          sessions.set(key, evidence);
        }
        const evidence = sessions.get(key);
        if (!evidence?.experiments && !experiments.has(key)) {
          experiments.set(key, await experimentEvidence(
            path.join(logDirectory, `run-${runId}`), runId, run.run_attempt ?? 1, repository
          ));
        }
        const observedAt = run.updated_at ?? run.created_at;
        if (!evidence?.evals && !evals.has(key)) {
          evals.set(key, await evalEvidence(
            path.join(logDirectory, `run-${runId}`), runId, run.run_attempt ?? 1, repository, observedAt
          ));
        }
        let runChanged = false;
        const assignments = evidence?.experiments ? null : experiments.get(key);
        if (assignments && JSON.stringify(assignments) !== JSON.stringify(run.experiments)) {
          run.experiments = assignments;
          changed = true;
          runChanged = true;
        }
        if (evidence) {
          const previous = JSON.stringify(run.cao_unified_session);
          run.cao_unified_session = evidence;
          if (JSON.stringify(evidence) !== previous) {
            changed = true;
            runChanged = true;
          }
        }
        const answers = evidence?.evals ? null : evals.get(key);
        if (answers && JSON.stringify(answers) !== JSON.stringify(run.evals)) {
          run.evals = answers;
          changed = true;
          runChanged = true;
        }
        if (runChanged) enriched += 1;
      }
      output.push(JSON.stringify(envelope));
    }
    if (changed) {
      const temporary = `${filename}.tmp-${process.pid}`;
      try {
        await writeFile(temporary, `${output.join('\n')}\n`, { flag: 'wx' });
        await rename(temporary, filename);
      } finally {
        await rm(temporary, { force: true });
      }
    }
  }
  return { enriched };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const [logs, prefix, repository] = process.argv.slice(2);
  if (!logs || !prefix || !repository) throw new Error('Expected log directory, shard prefix, and repository');
  console.log(JSON.stringify(await enrichSessionEvidence(logs, prefix, repository)));
}
