import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { writeToolEvidence } from '../../activity/tool-evidence.mjs';
import { readToolEvidence } from '../../activity/read-tool-evidence.mjs';

test('cold Tool evidence is checksum-addressed, bounded and exact without hot events', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'cao-tool-evidence-'));
  try {
    const events = Array.from({ length: 40 }, (_, index) => ({
      id: `event:${String(index).padStart(2, '0')}`, runId: index % 2 ? 'run:other' : 'run:1',
      source: 'mcp', type: index % 4 ? 'tool.call' : 'tool.error', status: 'incomplete',
      timestamp: `2026-10-03T14:00:${String(index).padStart(2, '0')}.000Z`, observedAt: '2026-10-03T14:01:00.000Z'
    }));
    const published = await writeToolEvidence(events, path.join(directory, 'gh-aw-logs-tools'), 1500);
    assert.ok(published.names.length > 1);
    const references = published.references.filter(reference => reference.runId === 'run:1');
    const result = await readToolEvidence(references, { directory, runId: 'run:1', limit: 3, type: 'tool.error' });
    assert.equal(result.totalEvents, 10);
    assert.equal(result.returnedEvents, 3);
    assert.equal(result.omittedEvents, 7);
    assert.deepEqual(result.rows.map(row => row.id), ['event:36', 'event:32', 'event:28']);
    await assert.rejects(readToolEvidence([], { directory, runId: 'run:missing' }), /unavailable/);
    await assert.rejects(readToolEvidence([{ ...references[0], payloadRef: '../secret' }], { directory, runId: 'run:1' }), /locator/);
    const file = path.join(directory, references[0].payloadRef);
    const content = await readFile(file);
    await writeFile(file, Buffer.concat([content, Buffer.from('corrupted')]));
    await assert.rejects(readToolEvidence(references, { directory, runId: 'run:1' }), /checksum/);
  } finally {
    await rm(directory, { recursive: true });
  }
});
