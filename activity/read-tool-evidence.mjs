import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { gunzipSync } from 'node:zlib';
import { CANONICAL_SCHEMA_VERSION } from '../dashboard/site/src/data/model/schema.js';
import { TOOL_EVIDENCE_DIRECTORY } from './tool-evidence.mjs';

/** Read only manifested cold evidence for a Run, retaining bounded exact detail. */
export async function readToolEvidence(references, {
  directory, runId, limit = 20, type, signal
}) {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 2000) throw new RangeError('Tool evidence limit must be between 1 and 2000');
  if (!references.length) throw new Error('Exact Tool evidence is unavailable for this Run');
  if (references.length > 256) throw new RangeError('Tool evidence exceeds the bounded shard lookup budget');
  const rows = [];
  const seen = new Set();
  let retainedBytes = 0;
  let totalEvents = 0;
  for (const reference of references) {
    signal?.throwIfAborted();
    const digest = reference.payloadHash;
    if (reference.runId !== runId || typeof digest !== 'string' || !/^[a-f0-9]{64}$/.test(digest)
        || reference.payloadRef !== `${TOOL_EVIDENCE_DIRECTORY}/${digest}.jsonl.gz`) {
      throw new TypeError('Tool evidence locator is not a manifested Run-owned shard');
    }
    const compressed = await readFile(path.join(directory, reference.payloadRef), { signal });
    if (compressed.length > 2 * 1024 * 1024
        || createHash('sha256').update(compressed).digest('hex') !== digest) {
      throw new Error('Tool evidence shard checksum or byte budget is invalid');
    }
    const lines = gunzipSync(compressed, { maxOutputLength: 1024 * 1024 + 1024 }).toString('utf8').trimEnd().split('\n');
    const header = JSON.parse(lines.shift());
    if (header.kind !== 'tool-evidence' || header.schemaVersion !== CANONICAL_SCHEMA_VERSION
        || !Number.isSafeInteger(header.events) || header.events !== lines.length) {
      throw new TypeError('Unsupported or incomplete Tool evidence shard');
    }
    let ownedEvents = 0;
    for (const line of lines) {
      const envelope = JSON.parse(line);
      if (envelope.kind !== 'tool-event' || !envelope.record || typeof envelope.record.id !== 'string') {
        throw new TypeError('Tool evidence shard contains an invalid event');
      }
      const event = envelope.record;
      if (event.runId !== runId) continue;
      ownedEvents++;
      if (seen.has(event.id)) throw new Error('Tool evidence contains duplicate event identities');
      seen.add(event.id);
      if (seen.size > 200000) throw new RangeError('Tool evidence exceeds the event scan budget');
      if (type !== undefined && event.type !== type) continue;
      totalEvents++;
      rows.push(event);
      retainedBytes += Buffer.byteLength(JSON.stringify(event));
      rows.sort((a, b) => String(b.timestamp).localeCompare(String(a.timestamp)) || String(a.id).localeCompare(String(b.id)));
      if (rows.length > limit) retainedBytes -= Buffer.byteLength(JSON.stringify(rows.pop()));
      if (retainedBytes > 8 * 1024 * 1024) throw new RangeError('Tool evidence exceeds the bounded output byte budget');
    }
    if (ownedEvents !== reference.eventCount) throw new Error('Tool evidence does not match its owning Run event count');
  }
  return { rows, totalEvents, returnedEvents: rows.length, omittedEvents: totalEvents - rows.length };
}
