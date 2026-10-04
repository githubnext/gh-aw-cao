import { DatabaseSync } from 'node:sqlite';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { aggregateToolEvents, toolMeasureId } from '../dashboard/site/src/data/model/tool-usage.js';
import { writeToolEvidence } from './tool-evidence.mjs';

const MAX_RUN_EVENTS = 200000;

/** Deduplicate raw evidence on disposable disk, keeping at most one Run's events in memory. */
export async function compactToolEventCaches(paths, attempts, outputDirectory, maxBytes) {
  const temporary = await mkdtemp(path.join(path.dirname(outputDirectory), '.tool-compaction-'));
  const filename = path.join(temporary, 'events.sqlite');
  const database = new DatabaseSync(filename);
  try {
    database.exec(`CREATE TABLE events (
      id TEXT PRIMARY KEY, run_id TEXT NOT NULL, attempt INTEGER NOT NULL,
      timestamp TEXT NOT NULL, value TEXT NOT NULL
    ); CREATE INDEX by_run ON events(run_id,timestamp,id);`);
    const put = database.prepare('INSERT OR REPLACE INTO events VALUES(?,?,?,?,?)');
    for (const file of paths) {
      const events = JSON.parse(await readFile(file, 'utf8'));
      if (!Array.isArray(events)) throw new TypeError('Tool event cache must contain an event array');
      database.exec('BEGIN');
      try {
        for (const event of events) {
          if (!attempts.has(event.runId) || event.runAttempt !== attempts.get(event.runId)) continue;
          put.run(event.id, event.runId, event.runAttempt, event.timestamp, JSON.stringify(event));
        }
        database.exec('COMMIT');
      } catch (error) {
        database.exec('ROLLBACK');
        throw error;
      }
    }
    const identities = new Map();
    const tools = [];
    const counters = [];
    const revisions = new Map();
    const readRun = database.prepare('SELECT value FROM events WHERE run_id=? ORDER BY timestamp,id LIMIT ?');
    for (const runId of [...attempts.keys()].sort()) {
      const records = readRun.all(runId, MAX_RUN_EVENTS + 1);
      if (records.length > MAX_RUN_EVENTS) throw new RangeError('Tool compaction exceeds the per-Run event budget');
      const events = records.map(row => JSON.parse(row.value));
      const aggregated = aggregateToolEvents(events);
      for (const identity of aggregated.toolIdentities) {
        const current = identities.get(identity.id);
        if (!current || current.observedAt < identity.observedAt) identities.set(identity.id, identity);
      }
      tools.push(...aggregated.tools);
      counters.push(...aggregated.toolCounters);
      revisions.set(runId, aggregated.tools[0]?.evidenceRevision ?? toolMeasureId('tool-evidence-revision', []));
    }
    const stream = async function* () {
      for (const row of database.prepare('SELECT value FROM events ORDER BY run_id,timestamp,id').iterate()) {
        yield JSON.parse(row.value);
      }
    };
    const evidence = await writeToolEvidence(stream(), outputDirectory, maxBytes);
    for (const reference of evidence.references) reference.evidenceRevision = revisions.get(reference.runId);
    return {
      batch: { tools, toolIdentities: [...identities.values()], toolCounters: counters, toolEvidence: evidence.references },
      revisions, names: evidence.names
    };
  } finally {
    database.close();
    await rm(temporary, { recursive: true });
  }
}
