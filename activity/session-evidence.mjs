import { lstat, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseUnifiedSessionDocument } from '../dashboard/site/src/data/adapters/unified-session.js';
import { experimentAssignmentArtifact, parseExperimentAssignments } from '../dashboard/site/src/data/adapters/experiment-evidence.js';
import { parseGraderArtifacts } from '../dashboard/site/src/data/adapters/grader-evidence.js';
import { classifiedEval, isSupportedGhAwJsonlSchemaVersion } from '../dashboard/site/src/data/adapters/gh-aw-logs.js';
import { runId as canonicalRunId } from '../dashboard/site/src/data/model/ids.js';
import { readJsonlRecords } from './jsonl.mjs';

async function confinedPath(directory, candidate) {
  const root = path.resolve(directory);
  const resolved = path.resolve(candidate);
  const relative = path.relative(root, resolved);
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new TypeError('Evidence path is outside the repository log directory');
  }
  let current = root;
  for (const segment of relative.split(path.sep).filter(Boolean)) {
    current = path.join(current, segment);
    try {
      if ((await lstat(current)).isSymbolicLink()) {
        throw new TypeError('Evidence symlinks are not supported');
      }
    } catch (error) {
      if (error.code === 'ENOENT') break;
      throw error;
    }
  }
  return resolved;
}

async function runDirectoryFor(logDirectory, run, runId) {
  if (run.logs_path !== undefined) {
    if (typeof run.logs_path !== 'string' || !run.logs_path.trim() || run.logs_path.includes('\0')) {
      throw new TypeError('Invalid evidence log directory');
    }
    return confinedPath(logDirectory, path.isAbsolute(run.logs_path)
      ? run.logs_path : path.resolve(logDirectory, run.logs_path));
  }
  return confinedPath(logDirectory, path.resolve(logDirectory, `run-${runId}`));
}

async function evidenceFile(directory, filename) {
  return readFile(await confinedPath(directory, filename), 'utf8');
}

async function downloadedUsage(directory) {
  try {
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isDirectory() && /(^|-)usage$/.test(entry.name)) {
        if ((await readdir(await confinedPath(directory, path.join(directory, entry.name)))).length) return true;
      }
    }
    // Compact downloads can also be flattened into the run directory.
    return entries.some((entry) => entry.isFile()
      && ['aw_session.jsonl', 'agent_usage.json'].includes(entry.name));
  } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }
}

async function artifactFiles(directory, filename) {
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
  const candidates = entries.flatMap((entry) => {
    if (entry.isFile() && entry.name === filename) return [path.join(directory, entry.name)];
    if (filename.startsWith('grader_') && entry.isDirectory()) {
      if (/(^|-)graders$/.test(entry.name)) return [path.join(directory, entry.name, filename)];
      if (/(^|-)usage$/.test(entry.name)) return [path.join(directory, entry.name, 'graders', filename)];
      return [];
    }
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
      found.push({ path: candidate, content: await evidenceFile(directory, candidate) });
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  }
  return found;
}

async function artifactFile(directory, filename) {
  const found = await artifactFiles(directory, filename);
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
  if (/(^|-)(?:experiments?|graders)$/.test(path.basename(artifactDirectory))) {
    directories.push(path.dirname(artifactDirectory));
  }
  directories.push(runDirectory);
  for (const directory of new Set(directories)) {
    try {
      return JSON.parse(await evidenceFile(runDirectory, path.join(directory, 'aw_info.json')));
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  }
  if (/(^|-)(?:experiments?|graders)$/.test(path.basename(artifactDirectory))
      || path.basename(sessionPath).startsWith('grader_')) {
    const file = await artifactFile(runDirectory, 'aw_info.json');
    if (file) return JSON.parse(file.content);
  }
  return null;
}

async function graderEvidence(runDirectory, runId, attempt, repository, session) {
  try {
    const results = await artifactFiles(runDirectory, 'grader_results.json');
    if (!results.length) return session;
    for (const file of results) {
      const info = await sessionIdentity(runDirectory, file.path);
      if (!info || String(info.run_id) !== String(runId)
          || String(info.repository).toLowerCase() !== repository.toLowerCase()
          || !Number.isInteger(Number(info.run_attempt)) || Number(info.run_attempt) < 1) {
        throw new TypeError('Grader artifact identity unavailable or mismatched');
      }
      if (Number(info.run_attempt) !== Number(attempt)) return session;
    }
    const manifests = await artifactFiles(runDirectory, 'grader_manifest.json');
    return parseGraderArtifacts([...results, ...manifests].map((file) => ({
      ...file, path: path.relative(runDirectory, file.path).split(path.sep).join('/')
    })), { runId: String(runId), attempt: Number(attempt) }, session);
  } catch (error) {
    if (!(error instanceof SyntaxError) && !(error instanceof TypeError)) throw error;
    console.warn(`Skipping invalid grader evidence for run ${runId}`);
    return session;
  }
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
  const graders = new Map();
  const directories = new Map();
  const coverage = new Map();
  const invalidPaths = new Set();
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
        const identity = `${runId}:${run.run_attempt ?? 1}`;
        const location = JSON.stringify({ identity, logsPath: run.logs_path });
        if (!directories.has(location)) {
          try {
            directories.set(location, await runDirectoryFor(logDirectory, run, runId));
          } catch (error) {
            if (!(error instanceof TypeError)) throw error;
            directories.set(location, null);
            if (!invalidPaths.has(identity)) {
              if (invalidPaths.size < 10) console.warn(`Skipping invalid evidence log directory for run ${runId}`);
              invalidPaths.add(identity);
            }
          }
        }
        const runDirectory = directories.get(location);
        if (!runDirectory) {
          if (run.cao_unified_session) {
            const state = coverage.get(identity);
            if (state) state.session = true;
            else coverage.set(identity, { runId, attempt: run.run_attempt ?? 1, usage: false, session: true });
          }
          output.push(JSON.stringify(envelope));
          continue;
        }
        const key = JSON.stringify([identity, runDirectory]);
        if (!sessions.has(key)) {
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
          const state = coverage.get(identity) ?? { runId, attempt: run.run_attempt ?? 1, usage: false, session: false };
          state.usage ||= await downloadedUsage(runDirectory);
          coverage.set(identity, state);
        }
        const evidence = sessions.get(key);
        if (!graders.has(key)) {
          graders.set(key, await graderEvidence(
            runDirectory, runId, run.run_attempt ?? 1, repository, evidence?.graders
          ));
        }
        const results = graders.get(key);
        if (evidence && results) evidence.graders = results;
        if (!evidence?.experiments && !experiments.has(key)) {
          experiments.set(key, await experimentEvidence(
            runDirectory, runId, run.run_attempt ?? 1, repository
          ));
        }
        const observedAt = run.updated_at ?? run.created_at;
        if (!evidence?.evals && !evals.has(key)) {
          evals.set(key, await evalEvidence(
            runDirectory, runId, run.run_attempt ?? 1, repository, observedAt
          ));
        }
        let runChanged = false;
        if (!evidence && results && JSON.stringify(results) !== JSON.stringify(run.graders)) {
          run.graders = results;
          changed = true;
          runChanged = true;
        }
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
        coverage.get(identity).session ||= Boolean(run.cao_unified_session);
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
  let missingSessions = 0;
  for (const state of coverage.values()) {
    if (!state.usage || state.session) continue;
    if (missingSessions < 10) {
      const attempt = Number(state.attempt);
      console.warn(`Downloaded usage has no unified session evidence for run ${state.runId} attempt ${Number.isSafeInteger(attempt) && attempt > 0 ? attempt : 'unknown'}`);
    }
    missingSessions += 1;
  }
  if (missingSessions) {
    console.warn(`Unified session evidence incomplete: ${missingSessions} distinct run attempts with downloaded usage; missing evidence is not zero activity`);
  }
  return { enriched, missingSessions };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const [logs, prefix, repository] = process.argv.slice(2);
  if (!logs || !prefix || !repository) throw new Error('Expected log directory, shard prefix, and repository');
  console.log(JSON.stringify(await enrichSessionEvidence(logs, prefix, repository)));
}
