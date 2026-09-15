import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, cp, readFile, writeFile } from 'node:fs/promises';
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

async function ingest(shardDirectory, databasePath, options = {}) {
  const { stdout, stderr } = await execFileAsync(process.execPath, [
    path.resolve('activity/cao.mjs'),
    'ingest-jsonl',
    '--database',
    databasePath,
    '--input-dir',
    shardDirectory,
  ], { env: { ...process.env, ...options.env } });
  const output = JSON.parse(stdout);
  return options.includeStderr ? { output, stderr } : output;
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

  // Every ingested shard MUST be recorded as its own entry in the
  // transactions table, keyed by its own payload scope, so a later run can
  // independently look up and skip that specific shard.
  const transactionsAfterFirst = await queryTransactions(databasePath);
  assert.equal(transactionsAfterFirst.length, 1);
  assert.equal(transactionsAfterFirst[0].kind, 'ingest-jsonl');
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
});

test('ingest-jsonl --input-dir logs shard decisions without record payloads', async () => {
  const { shardDirectory, databasePath } = await fixture();
  const sourceShard = path.resolve('dashboard/site/test/fixtures/gh-aw-logs/cached-v2.jsonl');
  const secondShardContent = (await readFile(sourceShard, 'utf8'))
    .replace('"schema_version":2,', '"schema_version":2,"debug_test_secret":"record-payload-secret",')
    .replace('303', '404');
  await writeFile(path.join(shardDirectory, 'gh-aw-logs-2000000000-bbbb.jsonl'), secondShardContent);

  const first = await ingest(shardDirectory, databasePath, {
    includeStderr: true,
    env: { NODE_DEBUG: 'cao:ingest' },
  });
  assert.equal(first.output.result.shards.length, 2);
  assert.match(first.stderr, /scanning shard directory .*2 shard\(s\) found/);
  assert.match(first.stderr, /ingesting shard gh-aw-logs-1000000000-aaaa\.jsonl/);
  assert.match(first.stderr, /ingested shard gh-aw-logs-1000000000-aaaa\.jsonl: committedRecords=\d+/);
  assert.match(first.stderr, /ingesting shard gh-aw-logs-2000000000-bbbb\.jsonl/);
  assert.match(first.stderr, /ingested shard gh-aw-logs-2000000000-bbbb\.jsonl: committedRecords=\d+/);
  assert.doesNotMatch(first.stderr, /record-payload-secret|workflow_runs|token_usage_summary|githubnext\/gh-aw-cao/);

  const second = await ingest(shardDirectory, databasePath, {
    includeStderr: true,
    env: { NODE_DEBUG: 'cao:ingest' },
  });
  assert.equal(second.output.result.updated, false);
  assert.match(second.stderr, /skipping shard gh-aw-logs-1000000000-aaaa\.jsonl: content hash already recorded in transactions table/);
  assert.match(second.stderr, /skipping shard gh-aw-logs-2000000000-bbbb\.jsonl: content hash already recorded in transactions table/);
  assert.doesNotMatch(second.stderr, /record-payload-secret|workflow_runs|token_usage_summary|githubnext\/gh-aw-cao/);
});
