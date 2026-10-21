import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';

const execute = promisify(execFile);
const fixtures = new URL('../fixtures/activity-session-evidence/', import.meta.url);

async function fixture(t, mode) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'cao-session-integration-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const bin = path.join(root, 'bin');
  const seeds = path.join(root, 'seeds');
  const shards = path.join(root, 'shards');
  const database = path.join(root, 'activity.sqlite');
  const input = path.join(root, 'input.json');
  await mkdir(bin);
  await mkdir(seeds);
  const nested = JSON.parse(await readFile(new URL('nested-run.json', fixtures), 'utf8'));
  const flat = JSON.parse(await readFile(new URL('flat-run.json', fixtures), 'utf8'));
  // Rebase freshness only so the real-record regression survives normal retention.
  nested.run.updated_at = flat.run.updated_at = new Date().toISOString();
  await writeFile(path.join(seeds, 'github-gh-aw-actions-logs-seed.jsonl'), JSON.stringify(flat) + '\n');
  await writeFile(input, JSON.stringify({
    nested, mode, session: await readFile(new URL('routed-session.jsonl', fixtures), 'utf8')
  }));
  const gh = path.join(bin, 'gh');
  await writeFile(gh, `#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const args = process.argv.slice(2);
if (args[0] === 'api') {
  console.log(JSON.stringify(args[1] === 'rate_limit'
    ? { resources: { core: { limit: 5000, remaining: 5000, reset: 9999999999 } } }
    : [{ workflows: [{ path: '.github/workflows/smoke-copilot-sdk-routed.lock.yml' }] }]));
  process.exit(0);
}
assert.deepEqual(args.slice(0, 2), ['aw', 'logs']);
const option = (name) => args[args.indexOf(name) + 1];
assert.equal(option('--artifacts'), 'usage,experiment,graders');
if (option('--repo') === 'github/gh-aw-actions') process.exit(0);
assert.equal(option('--repo'), 'github/gh-aw');
const input = JSON.parse(fs.readFileSync(process.env.SESSION_INPUT, 'utf8'));
const run = input.nested.run;
const output = option('--output');
const directory = path.join(output, 'repo-github-gh-aw', 'workflow-Smoke-Copilot-SDK-Routed', 'run-' + run.run_id);
const usage = path.join(directory, 'usage');
fs.mkdirSync(usage, { recursive: true });
fs.writeFileSync(path.join(usage, 'aw_info.json'), JSON.stringify({
  run_id: run.run_id, run_attempt: run.run_attempt, repository: run.repository
}));
if (input.mode !== 'missing') {
  fs.writeFileSync(path.join(usage, 'aw_session.jsonl'), input.mode === 'malformed'
    ? 'SECRET_INVALID_JSON' : input.session + JSON.stringify({
    type: 'tool.execution_complete', timestamp: run.updated_at,
    data: { toolName: 'bash', success: true, output: 'SECRET_OUTPUT' }
  }) + '\\n');
}
fs.mkdirSync(path.join(usage, 'experiment'), { recursive: true });
fs.writeFileSync(path.join(usage, 'experiment', 'assignments.json'), '{"prompt":"candidate"}');
fs.mkdirSync(path.join(usage, 'graders'), { recursive: true });
fs.writeFileSync(path.join(usage, 'graders', 'grader_results.json'), JSON.stringify({
  version: 2, run: { id: String(run.run_id), attempt: 1 },
  results: [{ id: 'quality', value: 0.9, status: 'pass', source: 'inline' }]
}));
fs.writeFileSync(path.join(usage, 'evals.jsonl'), JSON.stringify({
  id: 'quality', answer: 'YES', runid: String(run.run_id), prompt: 'SECRET_PROMPT'
}) + '\\n');
run.logs_path = directory;
if (['outside', 'traversal', 'symlink'].includes(input.mode)) {
  // The valid flat copy must not authorize fallback from an invalid supplied path.
  fs.cpSync(directory, path.join(output, 'run-' + run.run_id), { recursive: true });
  run.logs_path = path.join(process.env.SESSION_ROOT, 'outside');
  fs.mkdirSync(path.join(run.logs_path, 'usage', 'aw_session.jsonl'), { recursive: true });
  if (input.mode === 'traversal') run.logs_path = path.relative(output, run.logs_path);
  if (input.mode === 'symlink') {
    const link = path.join(output, 'escape');
    fs.symlinkSync(run.logs_path, link);
    run.logs_path = link;
  }
}
const prefix = option('--cached-jsonl').replace(/\\*$/, '');
fs.mkdirSync(path.dirname(prefix), { recursive: true });
for (const suffix of ['download-1', 'download-2']) {
  fs.writeFileSync(prefix + suffix + '.jsonl', JSON.stringify(input.nested) + '\\n');
}
`);
  await chmod(gh, 0o755);
  const env = {
    ...process.env, PATH: `${bin}:${process.env.PATH}`,
    GH_TOKEN: '', GITHUB_TOKEN: '', SESSION_INPUT: input, SESSION_ROOT: root,
    GITHUB_REPOSITORY: 'githubnext/gh-cao',
    REPORT_TARGET_REPOSITORIES_JSON: '["github/gh-aw","github/gh-aw-actions"]',
    REPORT_INCLUDE_CONTROL_REPOSITORY: '0',
    REPORT_GH_AW_LOGS_SEED_SHARDS: seeds,
    REPORT_GH_AW_LOGS_SHARDS: shards,
    REPORT_AIC_CACHE: path.join(root, 'downloads'),
    REPORT_GH_AW_LOGS_EXIT_CODE: path.join(root, 'exit-code'),
    REPORT_ACTIVITY_DATABASE: database,
    REPORT_CONTROL_SETTINGS: '', REPORT_INVENTORY_SOURCES: '', REPORT_DRAIN3_WEIGHTS: '',
    GITHUB_OUTPUT: path.join(root, 'github-output'), GITHUB_STEP_SUMMARY: path.join(root, 'summary'),
    REPORT_DEFER_ISSUE_STATUS: '1',
    REPORT_PUBLIC_ONLY: 'false',
    REPORT_RUN_WINDOW_DAYS: '30', REPORT_DETAIL_WINDOW_DAYS: '7'
  };
  const collect = () => execute('bash', ['activity/collect-logs.sh'], { env });
  const query = async (collection) => JSON.parse((await execute(process.execPath, [
    'activity/cao.mjs', 'query', '--database', database, '--collection', collection
  ])).stdout);
  const envelopes = async () => (await Promise.all((await readdir(shards))
    .filter((name) => name.endsWith('.jsonl'))
    .map((name) => readFile(path.join(shards, name), 'utf8'))))
    .flatMap((content) => content.trim().split('\n').filter(Boolean).map((line) => JSON.parse(line)));
  return { root, shards, database, flat, nested, collect, query, envelopes };
}

test('collector enriches real nested downloads before compaction, SQLite ingestion and phased publication', async (t) => {
  const f = await fixture(t, 'valid');
  const result = await f.collect();
  const rows = await f.envelopes();
  const nested = rows.filter((row) => row.run?.run_id === f.nested.run.run_id);
  assert.ok(nested.length);
  assert.ok(nested.every((row) => row.run.cao_unified_session?.events.some((event) => event.type === 'model.config')));
  assert.match(result.stdout, /"missingSessions":0/);
  assert.deepEqual(rows.find((row) => row.run?.run_id === f.flat.run.run_id).run.cao_unified_session,
    f.flat.run.cao_unified_session);
  assert.doesNotMatch(JSON.stringify(rows), /SECRET_/);
  const runs = await f.query('runs');
  assert.equal(runs.length, 2);
  const audits = await f.query('audits');
  for (const type of ['model.config', 'model.baseline_estimate', 'grader.result']) {
    assert.ok(audits.some((row) => row.type === type), type);
  }
  assert.equal((await f.query('graderObservations'))[0].value, 0.9);
  assert.equal((await f.query('evalObservations'))[0].evalResult, 'YES');
  assert.equal((await f.query('experimentAssignments'))[0].variant, 'candidate');

  const runsDirectory = path.join(f.root, 'runs');
  const recordsDirectory = path.join(f.root, 'records');
  const publish = () => execute(process.execPath, [
    'activity/cao.mjs', 'hash-payloads', '--database', f.database, '--shard-dir', f.shards,
    '--runs-dir', runsDirectory, '--records-dir', recordsDirectory,
    '--output', path.join(f.root, 'payload-hashes.json')
  ]);
  await publish();
  const files = (await readdir(recordsDirectory)).filter((name) => name.endsWith('.jsonl'));
  const published = (await Promise.all(files.map((name) => readFile(path.join(recordsDirectory, name), 'utf8')))).join('\n');
  assert.match(published, /model\.config/);
  assert.match(published, /model\.baseline_estimate/);
  assert.doesNotMatch(published, /SECRET_/);
  await f.collect();
  await publish();
  assert.deepEqual(await f.query('runs'), runs);
  assert.deepEqual(await f.query('audits'), audits);
});

for (const mode of ['missing', 'malformed']) {
  test(`collector reports ${mode} sessions once per attempt across duplicate shards`, async (t) => {
    const f = await fixture(t, mode);
    const result = await f.collect();
    assert.equal((result.stderr.match(/Downloaded usage has no unified session evidence/g) ?? []).length, 1);
    assert.match(result.stderr, /1 distinct run attempts.*missing evidence is not zero activity/);
    assert.match(result.stdout, /"missingSessions":1/);
    assert.doesNotMatch(result.stderr, /SECRET_/);
    const nested = (await f.envelopes()).filter((row) => row.run?.run_id === f.nested.run.run_id);
    assert.ok(nested.every((row) => !row.run.cao_unified_session));
    assert.equal((await f.query('runs')).length, 2);
    assert.equal((await f.query('graderObservations'))[0].value, 0.9);
    assert.equal((await f.query('evalObservations'))[0].evalResult, 'YES');
  });
}

for (const mode of ['outside', 'traversal', 'symlink']) {
  test(`collector rejects ${mode} directories without reading them or using a valid flat fallback`, async (t) => {
    const f = await fixture(t, mode);
    const result = await f.collect();
    const nested = (await f.envelopes()).filter((row) => row.run?.run_id === f.nested.run.run_id);
    assert.ok(nested.length);
    assert.ok(nested.every((row) => !row.run.cao_unified_session && !row.run.experiments && !row.run.graders && !row.run.evals));
    assert.equal((result.stderr.match(/Skipping invalid evidence log directory/g) ?? []).length, 2);
    assert.equal((await f.query('runs')).length, 2);
    assert.equal((await f.query('audits')).filter((row) => row.type === 'model.config').length, 0);
  });
}
