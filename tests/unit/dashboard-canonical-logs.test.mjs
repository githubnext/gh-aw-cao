import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

test('Node CLI ingests a gh-aw artifact directory through IndexedDB queries', async () => {
  const fixture = path.resolve('dashboard/site/test/fixtures/gh-aw-logs');
  const directory = await mkdtemp(path.join(tmpdir(), 'cao-cli-logs-'));
  const database = path.join(directory, 'logs.sqlite');
  const cao = path.resolve('activity/cao.mjs');
  try {
    const { stdout } = await execFileAsync(process.execPath, [
      cao, 'ingest', '--database', database,
      '--context', path.join(fixture, 'context.json'),
      '--logs', path.join(fixture, 'run-303'),
      '--retention-days', 'all', '--run-retention-days', 'all',
    ]);
    const output = JSON.parse(stdout);
    assert.equal(output.result.updated, true);
    const query = async (collection) => JSON.parse((await execFileAsync(process.execPath, [
      cao, 'query', '--database', database, '--collection', collection
    ])).stdout);
    const runs = await query('runs');
    assert.equal(runs[0].id, 'github:run:githubnext/gh-aw-cao:303');
    const records = (await Promise.all(['domains', 'tools', 'audits'].map(query))).flat();
    assert.equal(records.every((record) => record.runId === runs[0].id), true);
    assert.deepEqual(records.map((record) => record.type).sort(), [
      'net_allowed', 'tool_call', 'agent_tool_start', 'agent_tool_done',
      'agent_turn', 'assistant_message'
    ].sort());
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});