import { readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseUnifiedSession } from '../dashboard/site/src/data/adapters/unified-session.js';
import { isSupportedGhAwJsonlSchemaVersion } from '../dashboard/site/src/data/adapters/gh-aw-logs.js';

async function sessionFile(directory) {
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
  const candidates = entries.flatMap((entry) => {
    if (entry.isFile() && entry.name === 'aw_session.jsonl') return [path.join(directory, entry.name)];
    if (entry.isDirectory() && /(^|-)usage$/.test(entry.name)) {
      return [path.join(directory, entry.name, 'aw_session.jsonl')];
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
  if (found.length > 1) throw new TypeError('Multiple unified sessions found for one run');
  return found[0] ?? null;
}

async function sessionIdentity(runDirectory, sessionPath) {
  for (const directory of new Set([path.dirname(sessionPath), runDirectory])) {
    try {
      return JSON.parse(await readFile(path.join(directory, 'aw_info.json'), 'utf8'));
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  }
  return null;
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
  let enriched = 0;
  for (const name of names) {
    const filename = path.join(directory, name);
    const content = await readFile(filename, 'utf8');
    let changed = false;
    const output = [];
    for (const line of content.split(/\r?\n/)) {
      if (!line.trim()) continue;
      const envelope = JSON.parse(line);
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
            const file = await sessionFile(runDirectory);
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
                evidence = { version: 1, path: relativePath, events: parseUnifiedSession(file.content, relativePath) };
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
        if (evidence) {
          const previous = JSON.stringify(run.cao_unified_session);
          run.cao_unified_session = evidence;
          if (JSON.stringify(evidence) !== previous) {
            changed = true;
            enriched += 1;
          }
        }
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
