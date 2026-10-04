import { createHash } from 'node:crypto';
import { mkdir, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { gzipSync } from 'node:zlib';
import { CANONICAL_SCHEMA_VERSION } from '../dashboard/site/src/data/model/schema.js';
import { toolMeasureId } from '../dashboard/site/src/data/model/tool-usage.js';

export const TOOL_EVIDENCE_DIRECTORY = 'gh-aw-logs-tools';

/** Publish byte-bounded cold events and small Run-owned locators. */
export async function writeToolEvidence(events, directory, maxBytes) {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 128) throw new RangeError('Tool evidence requires a valid shard byte budget');
  maxBytes = Math.min(maxBytes, 1024 * 1024);
  await mkdir(directory, { recursive: true });
  const names = new Set();
  const references = [];
  let lines = [];
  let bytes = 0;
  let owned = new Map();
  const flush = async () => {
    if (!lines.length) return;
    const header = { kind: 'tool-evidence', schemaVersion: CANONICAL_SCHEMA_VERSION, events: lines.length };
    const compressed = gzipSync(`${JSON.stringify(header)}\n${lines.join('')}`);
    const digest = createHash('sha256').update(compressed).digest('hex');
    const name = `${digest}.jsonl.gz`;
    const temporary = path.join(directory, `${name}.${process.pid}.tmp`);
    await writeFile(temporary, compressed, { flag: 'wx' });
    await rename(temporary, path.join(directory, name));
    names.add(name);
    for (const [runId, { eventCount, observedAt }] of owned) {
      references.push({
        id: toolMeasureId('tool-evidence', [runId, digest]), runId, eventCount, observedAt,
        payloadRef: `${TOOL_EVIDENCE_DIRECTORY}/${name}`, payloadHash: digest
      });
    }
    lines = [];
    bytes = 0;
    owned = new Map();
  };
  for await (const record of events) {
    const line = `${JSON.stringify({ kind: 'tool-event', record })}\n`;
    const size = Buffer.byteLength(line);
    if (size > maxBytes) throw new Error('Tool evidence event exceeds the bounded shard byte budget');
    if (bytes + size > maxBytes) await flush();
    lines.push(line);
    bytes += size;
    const previous = owned.get(record.runId);
    owned.set(record.runId, {
      eventCount: (previous?.eventCount ?? 0) + 1,
      observedAt: previous && previous.observedAt > record.observedAt ? previous.observedAt : record.observedAt
    });
  }
  await flush();
  return { references, names: [...names].sort() };
}
