import assert from 'node:assert/strict';
import test from 'node:test';
import { compactToolEventBuffers } from '../../activity/tool-compaction.mjs';

test('Tool buffers preserve deduplicated counters without files or cold events', async () => {
  const event = {
    id: 'call:1', runId: 'run:1', runAttempt: 1, source: 'mcp',
    name: 'read', type: 'tool.call', status: 'started', requestBytes: 42,
    timestamp: '2026-10-03T14:00:00.000Z', observedAt: '2026-10-03T14:01:00.000Z'
  };
  const buffer = Buffer.from(JSON.stringify([
    event, event, { ...event, id: 'stale-call', runAttempt: 2 }
  ]));
  const attempts = new Map([['run:1', 1]]);
  const compact = () => compactToolEventBuffers([buffer], attempts);
  const first = await compact();
  assert.equal(first.batch.tools.length, 1);
  assert.equal(first.batch.tools[0].eventCount, 1);
  assert.equal(first.batch.tools[0].callCount, 1);
  assert.equal(first.batch.tools[0].requestBytes, 42);
  assert.equal(first.batch.toolCounters[0].eventCount, 1);
  assert.deepEqual(Object.keys(first.batch).sort(), ['toolCounters', 'toolIdentities', 'tools']);
  assert.equal(first.batch.tools[0].evidenceRevision, first.revisions.get('run:1'));
  assert.deepEqual(await compact(), first);
  await assert.rejects(compactToolEventBuffers([Buffer.from('{}')], attempts), /event array/);
  await assert.rejects(compactToolEventBuffers(['not a buffer'], attempts), /must be buffers/);
  assert.deepEqual(await compact(), first);
});

test('asynchronous Tool buffers deduplicate across batches before counting', async () => {
  const event = {
    id: 'call:1', runId: 'run:1', runAttempt: 1, source: 'mcp',
    name: 'read', type: 'tool.call', status: 'started', requestBytes: 42,
    timestamp: '2026-10-03T14:00:00.000Z', observedAt: '2026-10-03T14:01:00.000Z'
  };
  const buffers = async function* () {
    yield Buffer.from(JSON.stringify([event]));
    yield Buffer.from(JSON.stringify([event, { ...event, id: 'call:2' }]));
  };
  const result = await compactToolEventBuffers(buffers(), new Map([['run:1', 1]]));
  assert.equal(result.batch.tools[0].callCount, 2);
  assert.equal(result.batch.tools[0].requestBytes, 84);
  assert.equal(result.batch.toolCounters[0].eventCount, 2);
});
