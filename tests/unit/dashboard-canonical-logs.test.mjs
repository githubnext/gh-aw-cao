import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import path from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

test('Node CLI ingests a gh-aw artifact directory through IndexedDB queries', async () => {
  const fixture = path.resolve('dashboard/site/test/fixtures/gh-aw-logs');
  const { stdout } = await execFileAsync(process.execPath, [
    path.resolve('dashboard/site/scripts/ingest-gh-aw-logs.mjs'),
    path.join(fixture, 'context.json'),
    path.join(fixture, 'run-303'),
  ]);
  const output = JSON.parse(stdout);

  assert.deepEqual(output.result, {
    generation: 'gh-aw-logs-2026-09-09-05',
    activated: true,
  });
  assert.equal(output.runs[0].id, 'github:run:303:attempt:1');
  assert.equal(output.sessions[0].kind, 'unified-operational-log');
  assert.deepEqual(output.events.map((event) => event.type), [
    'agent_turn',
    'tool_call',
    'agent_tool_start',
    'agent_tool_done',
    'net_allowed',
    'assistant_message',
  ]);
});