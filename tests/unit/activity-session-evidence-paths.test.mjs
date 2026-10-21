import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rename, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { enrichSessionEvidence } from '../../activity/session-evidence.mjs';
import { adaptCachedGhAwJsonl } from '../../dashboard/site/src/data/adapters/gh-aw-logs.js';
import { normalize } from '../../dashboard/site/src/data/normalize/index.js';

const fixtures = new URL('../fixtures/activity-session-evidence/', import.meta.url);
const routedSession = await readFile(new URL('routed-session.jsonl', fixtures), 'utf8');

async function fixture(t, name = 'nested-run.json') {
  const root = await mkdtemp(path.join(os.tmpdir(), 'cao-session-path-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const envelope = JSON.parse(await readFile(new URL(name, fixtures), 'utf8'));
  const logs = path.join(root, 'logs');
  const relative = envelope.run.logs_path.split(`/cao-gh-aw-logs/${envelope.run.repository.replace('/', '-')}/`)[1];
  const directory = path.join(logs, relative);
  const usage = path.join(directory, 'usage');
  const shards = path.join(root, 'shards');
  await mkdir(usage, { recursive: true });
  await mkdir(shards);
  envelope.run.logs_path = directory;
  const shard = path.join(shards, 'logs-1.jsonl');
  const prefix = path.join(shards, 'logs-');
  const info = { run_id: envelope.run.run_id, run_attempt: '1', repository: envelope.run.repository };
  await writeFile(path.join(usage, 'aw_info.json'), JSON.stringify(info));
  const save = (rows = [envelope], filename = shard) => writeFile(filename, rows.map((row) => JSON.stringify(row)).join('\n') + '\n');
  await save();
  const enrich = () => enrichSessionEvidence(logs, prefix, envelope.run.repository);
  const run = async () => JSON.parse((await readFile(shard, 'utf8')).trim().split('\n')[0]).run;
  return { root, logs, directory, usage, shard, prefix, info, envelope, save, enrich, run };
}

test('real workflow-nested run retains routing events through production normalization', async (t) => {
  for (const relative of [false, true]) {
    await t.test(relative ? 'relative recorded directory' : 'absolute recorded directory', async (t) => {
      const f = await fixture(t);
      if (relative) f.envelope.run.logs_path = path.relative(f.logs, f.directory);
      await f.save();
      await writeFile(path.join(f.usage, 'aw_session.jsonl'), routedSession);
      assert.deepEqual(await f.enrich(), { enriched: 1, missingSessions: 0 });
      const content = await readFile(f.shard, 'utf8');
      const evidence = (await f.run()).cao_unified_session;
      assert.equal(evidence.path, 'usage/aw_session.jsonl');
      assert.deepEqual(evidence.events.map((event) => event.type), [
        'session.format', 'model.config', 'model.baseline_estimate'
      ]);
      assert.equal(evidence.events[1].fields.routingConfiguredMode, 'economy');
      assert.equal(evidence.events[2].fields.aic, 6.02079);
      const batch = normalize(adaptCachedGhAwJsonl(content).observations);
      assert.ok(batch.audits.some((row) => row.type === 'model.config'));
      assert.ok(batch.audits.some((row) => row.type === 'model.baseline_estimate'));
      assert.deepEqual(await f.enrich(), { enriched: 0, missingSessions: 0 });
      assert.equal(await readFile(f.shard, 'utf8'), content);
    });
  }
});

test('real flat record retains its already-projected evidence byte for byte', async (t) => {
  const f = await fixture(t, 'flat-run.json');
  const content = await readFile(f.shard, 'utf8');
  const warnings = t.mock.method(console, 'warn', () => {});
  assert.deepEqual(await f.enrich(), { enriched: 0, missingSessions: 0 });
  assert.equal(await readFile(f.shard, 'utf8'), content);
  assert.equal(warnings.mock.callCount(), 0);
  // A retained runner-temporary path is not authority to read on another host.
  f.envelope.run.logs_path = '/home/runner/work/_temp/cao-gh-aw-logs/github-gh-aw-actions/run-39375198241';
  await f.save();
  const retained = await readFile(f.shard, 'utf8');
  assert.deepEqual(await f.enrich(), { enriched: 0, missingSessions: 0 });
  assert.equal(await readFile(f.shard, 'utf8'), retained);
  assert.equal(warnings.mock.callCount(), 1);
});

test('nested standalone artifacts share the resolved directory and identity checks', async (t) => {
  for (const mismatch of [null, 'repository', 'run_id', 'run_attempt']) {
    await t.test(mismatch ?? 'matching identity', async (t) => {
      const f = await fixture(t);
      t.mock.method(console, 'warn', () => {});
      await mkdir(path.join(f.usage, 'experiment'));
      await mkdir(path.join(f.usage, 'graders'));
      await writeFile(path.join(f.usage, 'experiment', 'assignments.json'), '{"prompt":"candidate"}');
      await writeFile(path.join(f.usage, 'evals.jsonl'), JSON.stringify({
        id: 'quality', answer: 'YES', runid: String(f.info.run_id)
      }));
      await writeFile(path.join(f.usage, 'graders', 'grader_manifest.json'), JSON.stringify({
        version: 2, graders: [{ id: 'quality', name: 'Quality', unit: 'ratio', direction: 'higher_is_better' }]
      }));
      await writeFile(path.join(f.usage, 'graders', 'grader_results.json'), JSON.stringify({
        version: 2, run: { id: String(f.info.run_id), attempt: 1 },
        results: [{ id: 'quality', value: 0.9, status: 'pass', source: 'inline' }]
      }));
      if (mismatch) {
        const info = { ...f.info, [mismatch]: mismatch === 'repository' ? 'other/repo' : 2 };
        await writeFile(path.join(f.usage, 'aw_info.json'), JSON.stringify(info));
      }
      assert.deepEqual(await f.enrich(), { enriched: mismatch ? 0 : 1, missingSessions: 1 });
      const run = await f.run();
      if (mismatch) {
        assert.equal(run.experiments, undefined);
        assert.equal(run.graders, undefined);
        assert.equal(run.evals, undefined);
      } else {
        assert.deepEqual(run.experiments.assignments, { prompt: 'candidate' });
        assert.equal(run.graders.results[0].value, 0.9);
        const batch = normalize(adaptCachedGhAwJsonl(await readFile(f.shard, 'utf8')).observations);
        assert.equal(batch.graders[0].unit, 'ratio');
        assert.equal(run.evals[0].answer, 'YES');
      }
    });
  }
});

test('nested sessions reject identity mismatches without replacing retained evidence', async (t) => {
  for (const field of ['repository', 'run_id', 'run_attempt']) {
    await t.test(field, async (t) => {
      const f = await fixture(t);
      t.mock.method(console, 'warn', () => {});
      await writeFile(path.join(f.usage, 'aw_session.jsonl'), routedSession);
      await writeFile(path.join(f.usage, 'aw_info.json'), JSON.stringify({
        ...f.info, [field]: field === 'repository' ? 'other/repo' : 2
      }));
      const original = await readFile(f.shard, 'utf8');
      assert.deepEqual(await f.enrich(), { enriched: 0, missingSessions: 1 });
      assert.equal(await readFile(f.shard, 'utf8'), original);
    });
  }
});

test('outside, traversal, missing, and malformed recorded directories never fall back to flat artifacts', async (t) => {
  for (const kind of ['outside', 'sibling-prefix', 'traversal', 'missing', 'empty', 'null', 'object', 'nul', 'symlink']) {
    await t.test(kind, async (t) => {
      const f = await fixture(t);
      const flat = path.join(f.logs, `run-${f.info.run_id}`);
      await rename(f.directory, flat);
      await writeFile(path.join(flat, 'usage', 'aw_session.jsonl'), routedSession);
      const outside = path.join(f.root, 'logs-outside');
      await mkdir(path.join(outside, 'usage', 'aw_session.jsonl'), { recursive: true });
      const supplied = {
        outside, 'sibling-prefix': outside, traversal: '../logs-outside',
        missing: path.join(f.logs, 'missing'), empty: '', null: null, object: {},
        nul: 'SECRET_PATH\0', symlink: path.join(f.logs, 'link')
      };
      if (kind === 'symlink') await symlink(outside, supplied.symlink);
      f.envelope.run.logs_path = supplied[kind];
      await f.save();
      const original = await readFile(f.shard, 'utf8');
      const warnings = t.mock.method(console, 'warn', () => {});
      assert.deepEqual(await f.enrich(), { enriched: 0, missingSessions: 0 });
      assert.equal(await readFile(f.shard, 'utf8'), original);
      assert.doesNotMatch(JSON.stringify(warnings.mock.calls), /SECRET_PATH|logs-outside/);
      if (kind !== 'missing') assert.equal(warnings.mock.callCount(), 1);
      delete f.envelope.run.logs_path;
      await f.save();
      assert.deepEqual(await f.enrich(), { enriched: 1, missingSessions: 0 });
    });
  }
});

test('symlink escapes in artifact subdirectories and identity files are never read', async (t) => {
  for (const kind of ['usage', 'session', 'identity', 'experiment', 'graders', 'eval']) {
    await t.test(kind, async (t) => {
      const f = await fixture(t);
      t.mock.method(console, 'warn', () => {});
      const outside = path.join(f.root, 'outside');
      await mkdir(outside);
      if (kind === 'usage') {
        await rm(f.usage, { recursive: true });
        await symlink(outside, f.usage);
      } else if (kind === 'identity') {
        await writeFile(path.join(f.usage, 'aw_session.jsonl'), routedSession);
        await rm(path.join(f.usage, 'aw_info.json'));
        await symlink(outside, path.join(f.usage, 'aw_info.json'));
      } else if (kind === 'experiment' || kind === 'graders') {
        await symlink(outside, path.join(f.usage, kind));
      } else {
        await symlink(outside, path.join(f.usage, kind === 'session' ? 'aw_session.jsonl' : 'evals.jsonl'));
      }
      const original = await readFile(f.shard, 'utf8');
      const result = await f.enrich();
      assert.equal(result.enriched, 0);
      assert.equal(await readFile(f.shard, 'utf8'), original);
    });
  }
});

test('a supplied null path cannot reuse a cached legacy fallback', async (t) => {
  const f = await fixture(t);
  const flat = path.join(f.logs, `run-${f.info.run_id}`);
  await rename(f.directory, flat);
  await writeFile(path.join(flat, 'usage', 'aw_session.jsonl'), routedSession);
  const legacy = structuredClone(f.envelope);
  delete legacy.run.logs_path;
  f.envelope.run.logs_path = null;
  await f.save([legacy, f.envelope]);
  const warnings = t.mock.method(console, 'warn', () => {});
  assert.deepEqual(await f.enrich(), { enriched: 1, missingSessions: 0 });
  const rows = (await readFile(f.shard, 'utf8')).trim().split('\n').map((line) => JSON.parse(line));
  assert.ok(rows[0].run.cao_unified_session);
  assert.equal(rows[1].run.cao_unified_session, undefined);
  assert.equal(warnings.mock.callCount(), 1);
});

test('downloaded usage warnings are bounded and deduplicated across shards by attempt', async (t) => {
  const f = await fixture(t);
  const rows = Array.from({ length: 15 }, (_, index) => ({
    ...f.envelope, run: { ...f.envelope.run, run_attempt: String(index + 1) }
  }));
  rows.push({ ...f.envelope, run: { ...f.envelope.run, run_attempt: 'SECRET_ATTEMPT' } });
  await f.save([...rows, ...rows]);
  await f.save(rows, `${f.prefix}2.jsonl`);
  const warnings = t.mock.method(console, 'warn', () => {});
  assert.deepEqual(await f.enrich(), { enriched: 0, missingSessions: 16 });
  assert.equal(warnings.mock.callCount(), 11);
  assert.match(warnings.mock.calls[10].arguments[0], /16 distinct run attempts/);
  assert.doesNotMatch(JSON.stringify(warnings.mock.calls), /SECRET_|aw_info|logs_path/);
});

test('duplicate locations do not hide a valid session or inflate missing coverage', async (t) => {
  const f = await fixture(t);
  await writeFile(path.join(f.usage, 'aw_session.jsonl'), routedSession);
  const stale = structuredClone(f.envelope);
  stale.run.logs_path = path.join(f.logs, 'missing');
  await f.save([stale, f.envelope, f.envelope]);
  const warnings = t.mock.method(console, 'warn', () => {});
  assert.deepEqual(await f.enrich(), { enriched: 2, missingSessions: 0 });
  assert.equal(warnings.mock.callCount(), 0);
});

test('retained evidence in another shard suppresses missing-session coverage warnings', async (t) => {
  const f = await fixture(t);
  const retained = structuredClone(f.envelope);
  retained.run.cao_unified_session = JSON.parse(await readFile(new URL('flat-run.json', fixtures), 'utf8')).run.cao_unified_session;
  await f.save([retained], `${f.prefix}2.jsonl`);
  const warnings = t.mock.method(console, 'warn', () => {});
  assert.deepEqual(await f.enrich(), { enriched: 0, missingSessions: 0 });
  assert.equal(warnings.mock.callCount(), 0);
});
