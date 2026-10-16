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

test('collection mines all safe unified telemetry before publishing canonical SQLite records', async (t) => {
  const f = await fixture(t);
  const content = await readFile(new URL('../../dashboard/site/test/fixtures/unified-telemetry-session.jsonl', import.meta.url), 'utf8');
  await writeFile(path.join(f.usage, 'aw_session.jsonl'), content);
  await enrichSessionEvidence(f.logs, f.prefix, 'octo/api');
  const cached = await readFile(f.shard, 'utf8');
  assert.doesNotMatch(cached, /PRIVATE_/);
  const batch = normalize(adaptCachedGhAwJsonl(cached).observations);
  assert.equal(batch.runs[0].aicTotal, 1.2);
  assert.equal(batch.tools.filter((row) => row.type === 'mcp.tool_call').length, 1);
  assert.equal(batch.domains.length, 2);
  assert.ok(batch.audits.some((row) => row.type === 'github_api.rate_limit' && row.remaining === 4999));
  assert.equal(batch.issues[0].number, 42);
  const result = JSON.parse((await execute(process.execPath, ['activity/cao.mjs', 'ingest-jsonl',
    '--input-dir', path.dirname(f.shard), '--database', path.join(f.root, 'activity.sqlite'),
    '--retention-days', 'all'])).stdout);
  assert.equal(result.counts.domains, 2);
  assert.equal(result.counts.issues, 1);
  assert.ok(result.counts.audits >= 40);
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

test('invalid optional sessions are skipped without altering the shard or logging artifact contents', async (t) => {
  const cases = {
    'malformed JSON': { session: `${session}\nSECRET_INVALID_JSON` },
    'invalid event': { session: `${session}\nnull` },
    'unsupported format': { session: session.replace('"version":1', '"version":2') },
    'empty session': { session: '' },
    'missing identity': { info: undefined },
    'malformed identity': { info: 'SECRET_INVALID_JSON' },
    'null identity': { info: 'null' },
    'mismatched run': { info: JSON.stringify({ run_id: 304, run_attempt: 1, repository: 'octo/api' }) },
    'mismatched repository': { info: JSON.stringify({ run_id: 303, run_attempt: 1, repository: 'other/repo' }) },
    'missing attempt': { info: JSON.stringify({ run_id: 303, repository: 'octo/api' }) },
    'invalid attempt': { info: JSON.stringify({ run_id: 303, run_attempt: 'SECRET_ATTEMPT', repository: 'octo/api' }) },
    'ambiguous sessions': { duplicate: true }
  };
  for (const [name, options] of Object.entries(cases)) {
    await t.test(name, async (t) => {
      const f = await fixture(t);
      const original = await readFile(f.shard, 'utf8');
      const warnings = t.mock.method(console, 'warn', () => {});
      await writeFile(path.join(f.usage, 'aw_session.jsonl'), options.session ?? session);
      if (Object.hasOwn(options, 'info')) {
        await rm(f.info);
        if (options.info !== undefined) await writeFile(f.info, options.info);
      }
      if (options.duplicate) {
        await writeFile(path.join(f.logs, 'run-303', 'aw_session.jsonl'), session);
      }
      assert.deepEqual(await enrichSessionEvidence(f.logs, f.prefix, 'octo/api'), { enriched: 0 });
      assert.equal(await readFile(f.shard, 'utf8'), original);
      assert.equal(warnings.mock.callCount(), 1);
      assert.match(warnings.mock.calls[0].arguments[0], /Skipping invalid unified session evidence for run 303/);
      assert.doesNotMatch(warnings.mock.calls[0].arguments[0], /SECRET_|other\/repo/);
    });
  }
});

test('bad optional evidence does not block valid runs and warnings are deduplicated per attempt', async (t) => {
  const f = await fixture(t);
  await writeFile(path.join(f.usage, 'aw_session.jsonl'), session);
  await rm(f.info);
  const validDirectory = path.join(f.logs, 'run-304', 'usage');
  await mkdir(validDirectory, { recursive: true });
  await writeFile(path.join(validDirectory, 'aw_session.jsonl'), session);
  await writeFile(path.join(validDirectory, 'aw_info.json'),
    JSON.stringify({ run_id: 304, run_attempt: 1, repository: 'octo/api' }));
  const valid = structuredClone(f.envelope);
  valid.run.run_id = 304;
  await writeFile(f.shard, `${JSON.stringify(f.envelope)}\n${JSON.stringify(valid)}\n`);
  const secondShard = `${f.prefix}2.jsonl`;
  await writeFile(secondShard, `${JSON.stringify(f.envelope)}\n`);
  const original = await readFile(secondShard, 'utf8');

  const result = await execute(process.execPath, [
    'activity/session-evidence.mjs', f.logs, f.prefix, 'octo/api'
  ]);
  assert.deepEqual(JSON.parse(result.stdout), { enriched: 1 });
  assert.equal(result.stderr.trim(), 'Skipping invalid unified session evidence for run 303');
  const rows = (await readFile(f.shard, 'utf8')).trim().split('\n').map((line) => JSON.parse(line));
  assert.equal(rows[0].run.cao_unified_session, undefined);
  assert.equal(rows[1].run.cao_unified_session.events.length, 3);
  assert.equal(await readFile(secondShard, 'utf8'), original);
  assert.doesNotMatch(await readFile(f.shard, 'utf8'), /SECRET_/);
});

test('unexpected filesystem failures still fail collection without altering the shard', async (t) => {
  const f = await fixture(t);
  const original = await readFile(f.shard, 'utf8');
  await writeFile(path.join(f.usage, 'aw_session.jsonl'), session);
  await rm(f.info);
  await mkdir(f.info);
  await assert.rejects(enrichSessionEvidence(f.logs, f.prefix, 'octo/api'), { code: 'EISDIR' });
  assert.equal(await readFile(f.shard, 'utf8'), original);
});

test('downloaded evals remain separate from graders through SQLite and normalized publication', async (t) => {
  const f = await fixture(t);
  await writeFile(path.join(f.usage, 'evals.jsonl'), [
    { id: 'quality', answer: 'YES', runid: '303', timestamp: '2026-10-15T10:00:30Z', prompt: 'SECRET_PROMPT' },
    { id: 'uncertain', answer: 'UNKNOWN', runid: '303', timestamp: '2026-10-15T10:00:31Z' }
  ].map((row) => JSON.stringify(row)).join('\n'));
  f.envelope.run.graders = { results: [{ id: 'quality', value: 0.75, status: 'pass', unit: 'ratio' }] };
  f.envelope.run.experiments = { assignments: { prompt: 'candidate' } };
  await writeFile(f.shard, `${JSON.stringify(f.envelope)}\n`);
  assert.deepEqual(await enrichSessionEvidence(f.logs, f.prefix, 'octo/api'), { enriched: 1 });
  const content = await readFile(f.shard, 'utf8');
  assert.doesNotMatch(content, /SECRET_/);
  const batch = normalize(adaptCachedGhAwJsonl(content).observations);
  assert.equal(batch.graders.length, 1);
  assert.equal(batch.graderObservations[0].value, 0.75);
  assert.equal(batch.evals.length, 2);
  assert.deepEqual(batch.evalObservations.map((row) => row.evalResult).sort(), ['UNKNOWN', 'YES']);
  assert.ok(batch.evalObservations.every((row) => batch.audits.some((audit) => audit.id === row.auditId)));
  assert.equal(batch.experimentAssignments.length, 1);
  assert.deepEqual(await enrichSessionEvidence(f.logs, f.prefix, 'octo/api'), { enriched: 0 });

  const args = ['activity/cao.mjs', 'ingest-jsonl', '--input-dir', path.dirname(f.shard),
    '--database', path.join(f.root, 'activity.sqlite'), '--retention-days', 'all'];
  const first = JSON.parse((await execute(process.execPath, args)).stdout);
  assert.equal(first.counts.graders, 1);
  assert.equal(first.counts.evals, 2);
  assert.equal(first.counts.evalObservations, 2);
  assert.equal(first.counts.experimentAssignments, 1);
  assert.equal(JSON.parse((await execute(process.execPath, args)).stdout).result.shards[0].skipped, true);

  const recordsDirectory = path.join(f.root, 'records');
  await execute(process.execPath, ['activity/cao.mjs', 'hash-payloads',
    '--shard-dir', path.dirname(f.shard), '--runs-dir', path.join(f.root, 'runs'),
    '--records-dir', recordsDirectory]);
  const published = (await Promise.all((await readdir(recordsDirectory))
    .filter((name) => name.endsWith('.jsonl'))
    .map((name) => readFile(path.join(recordsDirectory, name), 'utf8')))).join('\n');
  const rows = published.split('\n').filter(Boolean).map((line) => JSON.parse(line));
  assert.equal(rows.filter((row) => row.collection === 'graders').length, 1);
  assert.equal(rows.filter((row) => row.collection === 'evals').length, 2);
  assert.equal(rows.filter((row) => row.collection === 'evalObservations').length, 2);
  assert.doesNotMatch(published, /SECRET_/);
});

test('collection prefers unified experiment, grader and eval events over standalone and legacy evidence', async (t) => {
  const f = await fixture(t);
  const evaluationSession = await readFile(new URL('../../dashboard/site/test/fixtures/evaluation-session.jsonl', import.meta.url), 'utf8');
  await writeFile(path.join(f.usage, 'aw_session.jsonl'), evaluationSession);
  // A malformed fallback must not be read when session evals are available.
  await writeFile(path.join(f.usage, 'evals.jsonl'), 'PRIVATE_INVALID_FALLBACK');
  const warnings = t.mock.method(console, 'warn', () => {});
  f.envelope.run.graders = { results: [{ id: 'legacy', value: 0.1, status: 'fail' }] };
  f.envelope.run.experiments = { assignments: { legacy: 'control' } };
  f.envelope.run.evals = [{ id: 'legacy', answer: 'NO' }];
  await writeFile(f.shard, `${JSON.stringify(f.envelope)}\n`);
  assert.deepEqual(await enrichSessionEvidence(f.logs, f.prefix, 'octo/api'), { enriched: 1 });
  assert.equal(warnings.mock.callCount(), 0);
  const enriched = await readFile(f.shard, 'utf8');
  assert.doesNotMatch(enriched, /PRIVATE_/);
  const batch = normalize(adaptCachedGhAwJsonl(enriched).observations);
  assert.deepEqual(batch.experiments.map((row) => row.name), ['prompt']);
  assert.deepEqual(batch.graders.map((row) => row.name), ['quality']);
  assert.deepEqual(batch.evals.map((row) => row.name), ['quality', 'uncertain']);
  assert.equal(batch.graderObservations[0].value, 0.93);
  assert.deepEqual(await enrichSessionEvidence(f.logs, f.prefix, 'octo/api'), { enriched: 0 });
});

test('eval artifact layouts verify repository, run and attempt independently of optional sessions', async (t) => {
  for (const layout of ['usage', 'caller-usage', 'evals', '.']) {
    await t.test(layout, async (t) => {
      const f = await fixture(t);
      const directory = path.join(f.logs, 'run-303', layout);
      await mkdir(directory, { recursive: true });
      await writeFile(path.join(directory, 'evals.jsonl'), '{"id":"quality","answer":"NO","runid":"303"}\n');
      assert.deepEqual(await enrichSessionEvidence(f.logs, f.prefix, 'octo/api'), { enriched: 1 });
      const row = JSON.parse(await readFile(f.shard, 'utf8')).run.evals[0];
      assert.equal(row.answer, 'NO');
      assert.equal(row.timestamp, '2026-10-15T10:01:00.000Z');
    });
  }
  for (const [name, info, record] of [
    ['wrong run', { run_id: 304, repository: 'octo/api', run_attempt: 1 }],
    ['wrong repository', { run_id: 303, repository: 'other/repo', run_attempt: 1 }],
    ['wrong attempt', { run_id: 303, repository: 'octo/api', run_attempt: 2 }],
    ['missing attempt', { run_id: 303, repository: 'octo/api' }],
    ['mismatched record', null, { id: 'quality', answer: 'YES', runid: '304' }],
    ['conflicting aliases', null, { id: 'quality', answer: 'YES', runId: '303', runid: '304' }],
    ['invalid answer', null, { id: 'quality', answer: 'SECRET_ANSWER' }]
  ]) {
    await t.test(name, async (t) => {
      const f = await fixture(t);
      const original = await readFile(f.shard, 'utf8');
      const warnings = t.mock.method(console, 'warn', () => {});
      if (info) await writeFile(f.info, JSON.stringify(info));
      await writeFile(path.join(f.usage, 'evals.jsonl'), JSON.stringify(record ?? { id: 'quality', answer: 'YES' }));
      assert.deepEqual(await enrichSessionEvidence(f.logs, f.prefix, 'octo/api'), { enriched: 0 });
      assert.equal(await readFile(f.shard, 'utf8'), original);
      assert.doesNotMatch(JSON.stringify(warnings.mock.calls), /SECRET_|other\/repo/);
    });
  }
});

test('invalid optional sessions do not prevent valid eval enrichment and vice versa', async (t) => {
  const f = await fixture(t);
  t.mock.method(console, 'warn', () => {});
  await writeFile(path.join(f.usage, 'aw_session.jsonl'), 'SECRET_INVALID_JSON');
  await writeFile(path.join(f.usage, 'evals.jsonl'), '{"id":"quality","answer":"YES"}\n');
  assert.deepEqual(await enrichSessionEvidence(f.logs, f.prefix, 'octo/api'), { enriched: 1 });
  assert.equal(JSON.parse(await readFile(f.shard, 'utf8')).run.evals[0].answer, 'YES');
  await writeFile(path.join(f.usage, 'aw_session.jsonl'), session);
  await writeFile(path.join(f.usage, 'evals.jsonl'), 'SECRET_INVALID_JSON');
  assert.deepEqual(await enrichSessionEvidence(f.logs, f.prefix, 'octo/api'), { enriched: 1 });
  assert.equal(JSON.parse(await readFile(f.shard, 'utf8')).run.cao_unified_session.events.length, 3);
});
