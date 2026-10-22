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
    assert.deepEqual(Object.keys(output).sort(), ['counts', 'result']);
    assert.equal(output.result.updated, true);
    assert.equal(output.counts.runs, 1);
    assert.equal(output.counts.tools, 3);
    const query = async (collection) => JSON.parse((await execFileAsync(process.execPath, [
      cao, 'query', '--database', database, '--collection', collection
    ])).stdout);
    const runs = await query('runs');
    assert.equal(runs[0].id, 'github:run:githubnext/gh-cao:303');
    const records = (await Promise.all(['domains', 'tools', 'audits'].map(query))).flat();
    assert.equal(records.every((record) => record.runId === runs[0].id), true);
    assert.deepEqual(records.map((record) => record.type).sort(), [
      'firewall.http_access', 'mcp.tool_call', 'tool.execution_start', 'tool.execution_complete',
      'user.message', 'assistant.message'
    ].sort());
    const repeated = JSON.parse((await execFileAsync(process.execPath, [
      cao, 'ingest', '--database', database,
      '--context', path.join(fixture, 'context.json'),
      '--logs', path.join(fixture, 'run-303'),
      '--retention-days', 'all', '--run-retention-days', 'all',
    ])).stdout);
    assert.deepEqual(repeated.counts, output.counts);
    assert.deepEqual(await query('runs'), runs);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('explicit raw-log ingestion preserves default and configured retention policies', async (t) => {
  const fixture = path.resolve('dashboard/site/test/fixtures/gh-aw-logs');
  const directory = await mkdtemp(path.join(tmpdir(), 'cao-cli-log-retention-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  for (const [name, now, options, expected] of [
    ['defaults', '2026-09-20', [], { runs: 1, domains: 0, tools: 0, audits: 0 }],
    ['all', '2026-10-22', ['--retention-days', 'all', '--run-retention-days', 'all'], { runs: 1, domains: 1, tools: 3, audits: 2 }],
    ['expired-defaults', '2026-10-22', [], { runs: 0, domains: 0, tools: 0, audits: 0 }],
    ['all-runs', '2026-10-22', ['--retention-days', '7', '--run-retention-days', 'all'], { runs: 1, domains: 0, tools: 0, audits: 0 }],
  ]) {
    const clock = `data:text/javascript,Date.now=()=>Date.parse("${now}T00:00:00Z")`;
    const { stdout } = await execFileAsync(process.execPath, [
      '--import', clock, path.resolve('activity/cao.mjs'), 'ingest',
      '--database', path.join(directory, `${name}.sqlite`),
      '--context', path.join(fixture, 'context.json'),
      '--logs', path.join(fixture, 'run-303'), ...options,
    ]);
    const output = JSON.parse(stdout);
    assert.deepEqual(Object.keys(output).sort(), ['counts', 'result']);
    for (const [collection, count] of Object.entries(expected)) {
      assert.equal(output.counts[collection], count, `${name}: ${collection}`);
    }
  }
});