import { DatabaseSync } from 'node:sqlite';
import { aggregateToolEvents, toolMeasureId } from '../dashboard/site/src/data/model/tool-usage.js';

const MAX_RUN_EVENTS = 200000;

/** Consume buffered inputs in memory, materializing at most one Run for aggregation. */
export async function compactToolEventBuffers(buffers, attempts) {
  const database = new DatabaseSync(':memory:');
  try {
    database.exec(`PRAGMA temp_store=MEMORY;
    CREATE TABLE events (
      id TEXT PRIMARY KEY, run_id TEXT NOT NULL, attempt INTEGER NOT NULL,
      timestamp TEXT NOT NULL, value TEXT NOT NULL
    ); CREATE INDEX by_run ON events(run_id,timestamp,id);`);
    const put = database.prepare('INSERT OR REPLACE INTO events VALUES(?,?,?,?,?)');
    for await (const buffer of buffers) {
      if (!Buffer.isBuffer(buffer)) throw new TypeError('Tool compaction inputs must be buffers');
      const events = JSON.parse(buffer.toString('utf8'));
      if (!Array.isArray(events)) throw new TypeError('Tool event buffer must contain an event array');
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
    return {
      batch: { tools, toolIdentities: [...identities.values()], toolCounters: counters },
      revisions
    };
  } finally {
    database.close();
  }
}
