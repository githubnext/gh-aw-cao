import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import test from 'node:test';
import { enrichSessionEvidence } from '../../activity/session-evidence.mjs';
import { adaptCachedGhAwJsonl } from '../../dashboard/site/src/data/adapters/gh-aw-logs.js';
import { normalize } from '../../dashboard/site/src/data/normalize/index.js';

const execute = promisify(execFile);
const session = [
  { type: 'session.format', data: { version: 1 } },
  { type: 'tool.execution_start', timestamp: '2026-10-15T10:00:00Z',
    data: { toolName: 'bash', toolCallId: 'call-1', input: 'SECRET_INPUT' } },
  { type: 'tool.execution_complete', timestamp: '2026-10-15T10:00:01Z',
    data: { toolName: 'bash', toolCallId: 'call-1', success: true, output: 'SECRET_OUTPUT' } },
  { type: 'firewall.http_access', timestamp: '2026-10-15T10:00:02Z',
    data: { host: 'api.github.com', status: 200 } }
].map((event) => JSON.stringify(event)).join('\n');

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'cao-session-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const logs = path.join(root, 'logs');
  const usage = path.join(logs, 'run-303', 'usage');
  const shards = path.join(root, 'shards');
  await mkdir(usage, { recursive: true });
  await mkdir(shards);
  const info = path.join(logs, 'run-303', 'aw_info.json');
  await writeFile(info, JSON.stringify({ run_id: 303, run_attempt: '1', repository: 'octo/api' }));
  const shard = path.join(shards, 'octo-api-logs-1.jsonl');
  const envelope = {
    schema_version: 5, kind: 'run',
    run: {
      run_id: 303, run_attempt: '1', organization: 'octo', repository: 'octo/api',
      workflow_name: 'Worker', workflow_path: '.github/workflows/worker.lock.yml',
      created_at: '2026-10-15T10:00:00Z', updated_at: '2026-10-15T10:01:00Z',
      status: 'completed', conclusion: 'success',
      mcp_tool_usage: { tool_calls: [{ tool_name: 'legacy-tool', status: 'success' }] },
      firewall_analysis: { requests_by_domain: { 'legacy.test': { allowed: 20 } } }
    }
  };
  await writeFile(shard, `${JSON.stringify(envelope)}\n`);
  return { root, logs, usage, info, shard, envelope, prefix: path.join(shards, 'octo-api-logs-') };
}

test('collection persists only safe unified evidence through compaction and canonical CLI ingestion', async (t) => {
  const f = await fixture(t);
  await writeFile(path.join(f.usage, 'aw_session.jsonl'), session);
  assert.deepEqual(await enrichSessionEvidence(f.logs, f.prefix, 'octo/api'), { enriched: 1 });
  const content = await readFile(f.shard, 'utf8');
  assert.doesNotMatch(content, /SECRET_/);
  const batch = normalize(adaptCachedGhAwJsonl(content).observations);
  assert.equal(batch.tools.length, 2);
  assert.deepEqual(batch.domains.map((row) => row.domain), ['api.github.com']);
  assert.ok(batch.tools.every((row) => row.correlationId === 'call-1'));
  assert.deepEqual(await enrichSessionEvidence(f.logs, f.prefix, 'octo/api'), { enriched: 0 });
  assert.equal(await readFile(f.shard, 'utf8'), content);

  await execute(process.execPath, ['activity/cao.mjs', 'compact-jsonl',
    '--input-dir', path.dirname(f.shard), '--group', 'octo/api=octo-api-logs-']);
  const args = ['activity/cao.mjs', 'ingest-jsonl', '--input-dir', path.dirname(f.shard),
    '--database', path.join(f.root, 'activity.sqlite'), '--retention-days', 'all'];
  const first = JSON.parse((await execute(process.execPath, args)).stdout);
  assert.equal(first.counts.tools, 2);
  assert.equal(first.counts.domains, 1);
  const second = JSON.parse((await execute(process.execPath, args)).stdout);
  assert.equal(second.result.shards[0].skipped, true);

  const recordsDirectory = path.join(f.root, 'records');
  await execute(process.execPath, ['activity/cao.mjs', 'hash-payloads',
    '--shard-dir', path.dirname(f.shard), '--runs-dir', path.join(f.root, 'runs'),
    '--records-dir', recordsDirectory]);
  const published = (await Promise.all((await readdir(recordsDirectory))
    .filter((name) => name.endsWith('.jsonl'))
    .map((name) => readFile(path.join(recordsDirectory, name), 'utf8')))).join('\n');
  const rows = published.split('\n').filter(Boolean).map((line) => JSON.parse(line));
  assert.equal(rows.filter((row) => row.collection === 'tools').length, 2);
  assert.equal(rows.filter((row) => row.collection === 'domains').length, 1);
  assert.doesNotMatch(published, /SECRET_|legacy-tool|legacy\.test/);
});

test('missing sessions preserve legacy ingestion and unrelated repository shards', async (t) => {
  const f = await fixture(t);
  const original = await readFile(f.shard, 'utf8');
  assert.deepEqual(await enrichSessionEvidence(f.logs, f.prefix, 'octo/api'), { enriched: 0 });
  assert.equal(await readFile(f.shard, 'utf8'), original);
  assert.equal(normalize(adaptCachedGhAwJsonl(original).observations).tools.length, 2);
  await writeFile(path.join(f.usage, 'aw_session.jsonl'), session);
  assert.deepEqual(await enrichSessionEvidence(f.logs, f.prefix, 'different/repo'), { enriched: 0 });
  assert.equal(await readFile(f.shard, 'utf8'), original);
});

test('sessions from another attempt are not associated with the cached attempt', async (t) => {
  const f = await fixture(t);
  await writeFile(path.join(f.usage, 'aw_session.jsonl'), session);
  await writeFile(f.info, JSON.stringify({ run_id: 303, run_attempt: '2', repository: 'octo/api' }));
  assert.deepEqual(await enrichSessionEvidence(f.logs, f.prefix, 'octo/api'), { enriched: 0 });
  assert.equal(JSON.parse(await readFile(f.shard, 'utf8')).run.cao_unified_session, undefined);
});

test('a newer raw attempt never inherits a prior attempt unified timeline', async (t) => {
  const f = await fixture(t);
  await writeFile(path.join(f.usage, 'aw_session.jsonl'), session);
  await enrichSessionEvidence(f.logs, f.prefix, 'octo/api');
  const listing = {
    schema_version: 5, kind: 'workflow_runs',
    request: { repository: 'octo/api', host: 'github.com', args: ['run', 'list'] },
    payload: [{
      databaseId: 303, attempt: 2, workflowName: 'Worker',
      createdAt: '2026-10-15T11:00:00Z', updatedAt: '2026-10-15T11:01:00Z',
      status: 'completed', conclusion: 'success'
    }]
  };
  const content = `${await readFile(f.shard, 'utf8')}${JSON.stringify(listing)}\n`;
  const batch = normalize(adaptCachedGhAwJsonl(content).observations);
  assert.equal(batch.runs[0].attempt, 2);
  assert.equal(batch.tools.length, 0);
  assert.equal(batch.domains.length, 0);
});

test('compact usage metadata, called-workflow usage and flattened sessions are supported', async (t) => {
  for (const layout of ['usage', 'caller-usage', '.']) {
    await t.test(layout, async (t) => {
      const f = await fixture(t);
      const directory = path.join(f.logs, 'run-303', layout);
      await mkdir(directory, { recursive: true });
      await writeFile(path.join(directory, 'aw_session.jsonl'), session);
      const identity = await readFile(f.info, 'utf8');
      await rm(f.info);
      await writeFile(path.join(directory, 'aw_info.json'), identity);
      f.envelope.run.repository = 'api';
      await writeFile(f.shard, `${JSON.stringify(f.envelope)}\n`);
      assert.deepEqual(await enrichSessionEvidence(f.logs, f.prefix, 'octo/api'), { enriched: 1 });
      assert.equal(normalize(adaptCachedGhAwJsonl(await readFile(f.shard, 'utf8')).observations).tools.length, 2);
    });
  }
});

test('bad session format or missing identity fails collection without altering the shard', async (t) => {
  const f = await fixture(t);
  const original = await readFile(f.shard, 'utf8');
  await writeFile(path.join(f.usage, 'aw_session.jsonl'), '{invalid');
  await assert.rejects(enrichSessionEvidence(f.logs, f.prefix, 'octo/api'), /valid JSON/);
  assert.equal(await readFile(f.shard, 'utf8'), original);
  await writeFile(path.join(f.usage, 'aw_session.jsonl'), session);
  await rm(f.info);
  await assert.rejects(enrichSessionEvidence(f.logs, f.prefix, 'octo/api'), /identity unavailable/);
  assert.equal(await readFile(f.shard, 'utf8'), original);
});
