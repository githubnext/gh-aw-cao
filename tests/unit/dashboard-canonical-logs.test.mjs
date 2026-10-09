import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { cp, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

test('Node CLI ingests a gh-aw artifact directory through IndexedDB queries', async () => {
  const fixture = path.resolve('dashboard/site/test/fixtures/gh-aw-logs');
  const directory = await mkdtemp(path.join(tmpdir(), 'cao-canonical-logs-'));
  let output;
  try {
    await cp(fixture, directory, { recursive: true });
    const recentDay = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    for (const file of ['context.json', ...await readdir(path.join(directory, 'run-303'), { recursive: true })]) {
      const filename = file === 'context.json' ? path.join(directory, file) : path.join(directory, 'run-303', file);
      if (!file.endsWith('.json') && !file.endsWith('.jsonl')) continue;
      const content = await readFile(filename, 'utf8');
      await writeFile(filename, content.replaceAll('2026-09-09', recentDay)
        .replaceAll('1788926403', String(Date.parse(`${recentDay}T04:00:03Z`) / 1000)));
    }
    const { stdout } = await execFileAsync(process.execPath, [
      path.resolve('activity/cao.mjs'),
      path.join(directory, 'context.json'),
      path.join(directory, 'run-303'),
    ]);
    output = JSON.parse(stdout);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }

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