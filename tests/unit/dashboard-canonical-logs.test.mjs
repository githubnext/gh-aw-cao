import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import path from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

test('Node CLI ingests a gh-aw artifact directory through IndexedDB queries', async () => {
  const fixture = path.resolve('dashboard/site/test/fixtures/gh-aw-logs');
  const { stdout } = await execFileAsync(process.execPath, [
    path.resolve('activity/cao.mjs'),
    path.join(fixture, 'context.json'),
    path.join(fixture, 'run-303'),
  ]);
  const output = JSON.parse(stdout);

  assert.equal(output.result.updated, true);
  assert.equal(output.runs[0].id, 'github:run:githubnext/gh-aw-cao:303');
  assert.equal(output.records.every((record) => record.runId === output.runs[0].id), true);
  assert.deepEqual(output.records.map((record) => record.type), [
    'net_allowed',
    'tool_call',
    'agent_tool_start',
    'agent_tool_done',
    'agent_turn',
    'assistant_message',
  ]);
});