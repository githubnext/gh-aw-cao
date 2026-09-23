import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, cp, readFile, readdir, rename, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'activity-ingest-jsonl-shards-'));
  const shardDirectory = path.join(root, 'gh-aw-logs-shards');
  await mkdir(shardDirectory, { recursive: true });
  const sourceShard = path.resolve('dashboard/site/test/fixtures/gh-aw-logs/cached-v2.jsonl');
  await cp(sourceShard, path.join(shardDirectory, 'gh-aw-logs-1000000000-aaaa.jsonl'));
  return { root, shardDirectory, databasePath: path.join(root, 'gh-aw-logs.sqlite') };
}

async function ingest(shardDirectory, databasePath) {
  const { stdout } = await execFileAsync(process.execPath, [
    path.resolve('activity/cao.mjs'),
    'ingest-jsonl',
    '--database',
    databasePath,
    '--input-dir',
    shardDirectory,
  ]);
  return JSON.parse(stdout);
}

async function ingestFile(inputPath, databasePath) {
  const { stdout } = await execFileAsync(process.execPath, [
    path.resolve('activity/cao.mjs'),
    'ingest-jsonl',
    '--database',
    databasePath,
    '--input',
    inputPath,
  ]);
  return JSON.parse(stdout);
}

async function queryTransactions(databasePath) {
  const { stdout } = await execFileAsync(process.execPath, [
    path.resolve('activity/cao.mjs'),
    'query',
    '--database',
    databasePath,
    '--collection',
    'transactions',
  ]);
  return JSON.parse(stdout);
}

test('ingest-jsonl --input-dir skips already-ingested shards on repeat runs without reparsing them', async () => {
  const { shardDirectory, databasePath } = await fixture();

  const first = await ingest(shardDirectory, databasePath);
  assert.equal(first.result.updated, true);
  assert.equal(first.result.shards.length, 1);
  assert.equal(first.result.shards[0].skipped, false);
  assert.ok(first.result.shards[0].committedRecords > 0);

  // Every ingested shard MUST be recorded as its own content-addressed entry
  // so a later run can independently look up and skip that specific shard.
  const transactionsAfterFirst = await queryTransactions(databasePath);
  assert.equal(transactionsAfterFirst.length, 1);
  assert.equal(transactionsAfterFirst[0].kind, 'ingest-jsonl');
  assert.match(transactionsAfterFirst[0].id, /^ingest-jsonl:sha256:[a-f0-9]{64}:v\d+$/);
  assert.equal(transactionsAfterFirst[0].payloadScope, 'gh-aw-jsonl:gh-aw-logs-1000000000-aaaa.jsonl');

  const second = await ingest(shardDirectory, databasePath);
  assert.equal(second.result.updated, false);
  assert.equal(second.result.shards.length, 1);
  assert.equal(second.result.shards[0].skipped, true);
  assert.equal(second.result.shards[0].committedRecords, 0);

  // Adding a brand-new shard alongside the already-ingested one should only
  // ingest the new shard, leaving the previously recorded one skipped.
  const sourceShard = path.resolve('dashboard/site/test/fixtures/gh-aw-logs/cached-v2.jsonl');
  const newShardContent = await readFile(sourceShard, 'utf8');
  await writeFile(
    path.join(shardDirectory, 'gh-aw-logs-2000000000-bbbb.jsonl'),
    newShardContent.replace('303', '404')
  );

  const third = await ingest(shardDirectory, databasePath);
  assert.equal(third.result.updated, true);
  assert.equal(third.result.shards.length, 2);
  const byShard = Object.fromEntries(third.result.shards.map((entry) => [entry.shard, entry]));
  assert.equal(byShard['gh-aw-logs-1000000000-aaaa.jsonl'].skipped, true);
  assert.equal(byShard['gh-aw-logs-2000000000-bbbb.jsonl'].skipped, false);

  // Both shards must now each carry their own independent transaction entry.
  const transactionsAfterThird = await queryTransactions(databasePath);
  assert.equal(transactionsAfterThird.length, 2);
  const scopesAfterThird = transactionsAfterThird.map((entry) => entry.payloadScope).sort();
  assert.deepEqual(scopesAfterThird, [
    'gh-aw-jsonl:gh-aw-logs-1000000000-aaaa.jsonl',
    'gh-aw-jsonl:gh-aw-logs-2000000000-bbbb.jsonl',
  ]);

  // A later cao-activity run may publish the same shard under a different
  // filename. Its SHA-256 receipt must still prevent reparsing.
  await rename(
    path.join(shardDirectory, 'gh-aw-logs-1000000000-aaaa.jsonl'),
    path.join(shardDirectory, 'gh-aw-logs-3000000000-cccc.jsonl'),
  );
  const fourth = await ingest(shardDirectory, databasePath);
  assert.equal(fourth.result.updated, false);
  assert.equal(fourth.result.shards.length, 2);
  assert.deepEqual(fourth.result.shards.map(({ skipped }) => skipped), [true, true]);
  assert.equal((await queryTransactions(databasePath)).length, 2);
});

test('ingest-jsonl --input ingests a single JSONL file', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'activity-ingest-jsonl-input-'));
  const inputPath = path.join(root, 'gh-aw-logs.jsonl');
  const databasePath = path.join(root, 'gh-aw-logs.sqlite');
  const sourceShard = path.resolve('dashboard/site/test/fixtures/gh-aw-logs/cached-v2.jsonl');
  await cp(sourceShard, inputPath);

  const result = await ingestFile(inputPath, databasePath);
  assert.equal(result.result.updated, true);
  assert.ok(result.result.committedRecords > 0);

  const transactions = await queryTransactions(databasePath);
  assert.equal(transactions.length, 1);
  assert.equal(transactions[0].kind, 'ingest-jsonl');
  assert.equal(transactions[0].payloadScope, 'gh-aw-jsonl');
});

test('compact-jsonl consolidates exact-prefix shards without reordering observations', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'activity-compact-jsonl-'));
  const prefix = 'githubnext-gh-aw-cao-logs-';
  const firstPath = path.join(root, `${prefix}1000-aaaa.jsonl`);
  const secondPath = path.join(root, `${prefix}2000-bbbb.jsonl`);
  const unrelatedPath = path.join(root, 'github-gh-aw-logs-1000-cccc.jsonl');
  const overlappingPrefix = `${prefix}123-logs-`;
  const overlappingPrefixPath = path.join(root, `${overlappingPrefix}1000-dddd.jsonl`);
  const first = '{"schema_version":2,"kind":"run","run":{"run_id":1,"repository":"githubnext/gh-aw-cao"}}';
  const second = '{"schema_version":2,"kind":"run","run":{"run_id":2,"repository":"githubnext/gh-aw-cao"}}';
  const third = '{"schema_version":2,"kind":"run","run":{"run_id":3,"repository":"githubnext/gh-aw-cao-logs-123"}}';
  const unrelated = '{"schema_version":2,"kind":"run","run":{"run_id":4,"repository":"github/gh-aw"}}';
  await writeFile(firstPath, `${first}\n${second}\n`);
  await writeFile(secondPath, `${first}\n${third}\n`);
  await writeFile(unrelatedPath, `${unrelated}\n`);
  await writeFile(overlappingPrefixPath, `${third}\n`);

  const { stdout } = await execFileAsync(process.execPath, [
    path.resolve('activity/cao.mjs'),
    'compact-jsonl',
    '--input-dir',
    root,
    '--group',
    `githubnext/gh-aw-cao=${prefix}`,
    '--group',
    `githubnext/gh-aw-cao-logs-123=${overlappingPrefix}`,
  ]);
  const result = JSON.parse(stdout);
  const compacted = result.groups.find((group) => group.prefix === prefix);
  assert.equal(compacted.sourceFiles, 2);
  assert.equal(compacted.sourceRecords, 4);
  assert.equal(compacted.retainedRecords, 4);
  assert.equal(
    result.groups.find((group) => group.prefix === overlappingPrefix).sourceFiles,
    1,
  );

  const compactedName = path.basename(compacted.output);
  assert.deepEqual(
    (await readFile(path.join(root, compactedName), 'utf8')).trim().split('\n'),
    [first, second, first, third],
  );
  assert.equal(await readFile(unrelatedPath, 'utf8'), `${unrelated}\n`);
  assert.equal(await readFile(overlappingPrefixPath, 'utf8'), `${third}\n`);
});

test('ingest-jsonl injects every run shard before record shards', async () => {
  const { root, shardDirectory, databasePath } = await fixture();
  const runsDirectory = path.join(root, 'gh-aw-logs-runs');
  const recordsDirectory = path.join(root, 'gh-aw-logs-records');
  await execFileAsync(process.execPath, [
    path.resolve('activity/cao.mjs'),
    'hash-payloads',
    '--shard-dir',
    shardDirectory,
    '--runs-dir',
    runsDirectory,
    '--records-dir',
    recordsDirectory,
  ]);

  const { stdout } = await execFileAsync(process.execPath, [
    path.resolve('activity/cao.mjs'),
    'ingest-jsonl',
    '--database',
    databasePath,
    '--runs-dir',
    runsDirectory,
    '--records-dir',
    recordsDirectory,
  ]);
  const result = JSON.parse(stdout).result;

  assert.deepEqual(result.shards.map((shard) => shard.phase), ['runs', 'records']);
  const transactions = await queryTransactions(databasePath);
  const runShard = (await readdir(runsDirectory))[0];
  const recordShard = (await readdir(recordsDirectory))[0];
  assert.deepEqual(
    transactions.map((transaction) => transaction.payloadScope).sort(),
    [
      `gh-aw-records:${recordShard}`,
      `gh-aw-runs:${runShard}`,
    ].sort(),
  );

  const renamedRunShard = `renamed-${runShard}`;
  const renamedRecordShard = `renamed-${recordShard}`;
  await rename(path.join(runsDirectory, runShard), path.join(runsDirectory, renamedRunShard));
  await rename(path.join(recordsDirectory, recordShard), path.join(recordsDirectory, renamedRecordShard));
  const repeated = JSON.parse((await execFileAsync(process.execPath, [
    path.resolve('activity/cao.mjs'),
    'ingest-jsonl',
    '--database',
    databasePath,
    '--runs-dir',
    runsDirectory,
    '--records-dir',
    recordsDirectory,
  ])).stdout).result;
  assert.equal(repeated.updated, false);
  assert.deepEqual(repeated.shards.map(({ skipped }) => skipped), [true, true]);
  assert.equal((await queryTransactions(databasePath)).length, 2);
});

test('hash-payloads keeps phased shard hashes stable when source shard names change', async () => {
  const { root, shardDirectory } = await fixture();
  const sourceName = (await readdir(shardDirectory))[0];
  const sourcePath = path.join(shardDirectory, sourceName);
  const duplicateName = 'gh-aw-logs-2000000000-bbbb.jsonl';
  await cp(sourcePath, path.join(shardDirectory, duplicateName));
  const runsDirectory = path.join(root, 'gh-aw-logs-runs');
  const recordsDirectory = path.join(root, 'gh-aw-logs-records');

  const hashes = JSON.parse((await execFileAsync(process.execPath, [
    path.resolve('activity/cao.mjs'),
    'hash-payloads',
    '--shard-dir',
    shardDirectory,
    '--runs-dir',
    runsDirectory,
    '--records-dir',
    recordsDirectory,
  ])).stdout);
  const runHashes = Object.entries(hashes)
    .filter(([name]) => name.startsWith('gh-aw-logs-runs/'))
    .map(([, hash]) => hash);
  const recordHashes = Object.entries(hashes)
    .filter(([name]) => name.startsWith('gh-aw-logs-records/'))
    .map(([, hash]) => hash);

  assert.equal(runHashes.length, 2);
  assert.equal(new Set(runHashes).size, 1);
  assert.equal(recordHashes.length, 2);
  assert.equal(new Set(recordHashes).size, 1);
});

test('phased shard names preserve source order for non-empty phase pairs', async () => {
  const { root, shardDirectory } = await fixture();
  const sourcePath = path.join(shardDirectory, 'gh-aw-logs-1000000000-aaaa.jsonl');
  const source = await readFile(sourcePath, 'utf8');
  await writeFile(sourcePath, source.replace('"status":"completed"', '"status":"queued"'));
  await writeFile(
    path.join(shardDirectory, 'gh-aw-logs-2000000000-bbbb.jsonl'),
    source
  );
  const runsDirectory = path.join(root, 'gh-aw-logs-runs');
  const recordsDirectory = path.join(root, 'gh-aw-logs-records');
  const { stdout } = await execFileAsync(process.execPath, [
    path.resolve('activity/cao.mjs'),
    'hash-payloads',
    '--shard-dir',
    shardDirectory,
    '--runs-dir',
    runsDirectory,
    '--records-dir',
    recordsDirectory,
  ]);

  const runs = (await readdir(runsDirectory)).sort();
  const records = (await readdir(recordsDirectory)).sort();
  const hashes = JSON.parse(stdout);
  assert.equal(runs.length, 2);
  assert.deepEqual(runs, records);
  assert.match(runs[0], /^gh-aw-logs-1000000000-aaaa-/);
  assert.match(runs[1], /^gh-aw-logs-2000000000-bbbb-/);
  assert.ok(hashes[`gh-aw-logs-runs/${runs[0]}`]);
  assert.ok(hashes[`gh-aw-logs-records/${records[1]}`]);
});

test('hash-payloads excludes info-level audits from record shards', async () => {
  const { root, shardDirectory } = await fixture();
  const sourcePath = path.join(shardDirectory, 'gh-aw-logs-1000000000-aaaa.jsonl');
  const source = (await readFile(sourcePath, 'utf8')).trim().split('\n');
  const run = JSON.parse(source[1]);
  run.run.audit = {
    key_findings: [
      { title: 'Informational finding', severity: 'info' },
      { title: 'Actionable finding', severity: 'high' },
    ],
  };
  await writeFile(sourcePath, `${source[0]}\n${JSON.stringify(run)}\n${source[2]}\n`);
  const recordsDirectory = path.join(root, 'gh-aw-logs-records');

  await execFileAsync(process.execPath, [
    path.resolve('activity/cao.mjs'),
    'hash-payloads',
    '--shard-dir',
    shardDirectory,
    '--records-dir',
    recordsDirectory,
  ]);

  const [recordShard] = await readdir(recordsDirectory);
  const payload = JSON.parse(await readFile(path.join(recordsDirectory, recordShard), 'utf8'));
  const findings = payload.batch.audits.filter((audit) => audit.type === 'audit.finding');
  assert.deepEqual(findings.map((audit) => audit.summary), ['Actionable finding']);
});

test('hash-payloads drops empty phased shards from files and hashes', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'activity-empty-phased-shards-'));
  const shardDirectory = path.join(root, 'gh-aw-logs-shards');
  const runsDirectory = path.join(root, 'gh-aw-logs-runs');
  const recordsDirectory = path.join(root, 'gh-aw-logs-records');
  await mkdir(shardDirectory, { recursive: true });
  await writeFile(
    path.join(shardDirectory, 'gh-aw-logs-1000000000-aaaa.jsonl'),
    `${JSON.stringify({ schema_version: 2, kind: 'unknown' })}\n`,
  );
  const emptySourcePath = path.join(shardDirectory, 'empty.jsonl');
  await writeFile(emptySourcePath, '');

  const { stdout } = await execFileAsync(process.execPath, [
    path.resolve('activity/cao.mjs'),
    'hash-payloads',
    '--shard-dir',
    shardDirectory,
    '--runs-dir',
    runsDirectory,
    '--records-dir',
    recordsDirectory,
  ]);

  const hashes = JSON.parse(stdout);
  assert.deepEqual(await readdir(runsDirectory), []);
  assert.deepEqual(await readdir(recordsDirectory), []);
  assert.equal(Object.keys(hashes).filter((name) => name.startsWith('gh-aw-logs-runs/')).length, 0);
  assert.equal(Object.keys(hashes).filter((name) => name.startsWith('gh-aw-logs-records/')).length, 0);
  assert.equal(Object.hasOwn(hashes, 'gh-aw-logs-shards/empty.jsonl'), false);
  await assert.rejects(readFile(emptySourcePath), { code: 'ENOENT' });
});

test('hash-payloads upgrades the legacy cached layout to phased shards', async () => {
  const { root, shardDirectory } = await fixture();
  const legacyNormalizedDirectory = path.join(root, 'gh-aw-logs-normalized');
  await mkdir(legacyNormalizedDirectory);
  await writeFile(path.join(legacyNormalizedDirectory, 'legacy.json'), '{}');
  const runsDirectory = path.join(root, 'gh-aw-logs-runs');
  const recordsDirectory = path.join(root, 'gh-aw-logs-records');

  await execFileAsync(process.execPath, [
    path.resolve('activity/cao.mjs'),
    'hash-payloads',
    '--shard-dir',
    shardDirectory,
    '--normalized-dir',
    legacyNormalizedDirectory,
    '--runs-dir',
    runsDirectory,
    '--records-dir',
    recordsDirectory,
  ]);

  const runs = await readdir(runsDirectory);
  const records = await readdir(recordsDirectory);
  const normalized = await readdir(legacyNormalizedDirectory);
  assert.equal(runs.length, 1);
  assert.deepEqual(runs, records);
  assert.equal(normalized.length, 1);
  const runPayload = JSON.parse(await readFile(path.join(runsDirectory, runs[0]), 'utf8'));
  const recordPayload = JSON.parse(await readFile(path.join(recordsDirectory, records[0]), 'utf8'));
  const normalizedPayload = JSON.parse(await readFile(path.join(legacyNormalizedDirectory, normalized[0]), 'utf8'));
  assert.equal(runPayload.phase, 'runs');
  assert.equal(recordPayload.phase, 'records');
  assert.ok(runPayload.batch.runs.length > 0);
  assert.ok(['domains', 'tools', 'audits', 'issues'].some((name) => recordPayload.batch[name].length > 0));
  for (const payload of [normalizedPayload, runPayload, recordPayload]) {
    assert.equal(Object.hasOwn(payload.batch, 'jobs'), false);
    assert.equal(Object.hasOwn(payload.batch, 'sessions'), false);
  }
});
