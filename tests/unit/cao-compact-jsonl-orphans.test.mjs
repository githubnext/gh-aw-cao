import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readdir, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { compactJsonlShards } from '../../activity/cao.mjs';

async function shardDirectoryFixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'cao-compact-jsonl-orphans-'));
  const shardDirectory = path.join(root, 'gh-aw-logs-shards');
  await mkdir(shardDirectory, { recursive: true });
  return shardDirectory;
}

function runLine(repository) {
  return `${JSON.stringify({
    schema_version: 2,
    kind: 'run',
    run: { run_id: 1, organization: repository.split('/')[0], repository, workflow_name: 'w', workflow_path: '.github/workflows/w.md' }
  })}\n`;
}

test('compact-jsonl garbage collects shards for repositories that are not in any requested group', async () => {
  const shardDirectory = await shardDirectoryFixture();
  // A shard belonging to a repository that is still enrolled (part of a
  // requested --group) is compacted normally and must be retained.
  await writeFile(path.join(shardDirectory, 'logs-1000000000-aaaa.jsonl'), runLine('githubnext/gh-aw-cao'));
  // A shard belonging to a repository that was removed from the control
  // plane's allowed repositories (so no --group is requested for it anymore)
  // is orphaned: nothing will ever compact or ingest it again, so it must be
  // garbage collected instead of growing the shard directory forever.
  await writeFile(path.join(shardDirectory, 'unenrolled-repo-logs-1000000000-bbbb.jsonl'), runLine('githubnext/unenrolled-repo'));

  const result = await compactJsonlShards(shardDirectory, ['githubnext/gh-aw-cao=logs-']);

  assert.deepEqual(result.orphanedShards, ['unenrolled-repo-logs-1000000000-bbbb.jsonl']);
  const remaining = (await readdir(shardDirectory)).filter((name) => name.endsWith('.jsonl'));
  assert.deepEqual(remaining, ['logs-1000000000-aaaa.jsonl']);
});

test('compact-jsonl garbage collects shards whose repository cannot be identified', async () => {
  const shardDirectory = await shardDirectoryFixture();
  await writeFile(path.join(shardDirectory, 'logs-1000000000-aaaa.jsonl'), runLine('githubnext/gh-aw-cao'));
  await writeFile(path.join(shardDirectory, 'logs-1000000001-cccc.jsonl'), `${JSON.stringify({ schema_version: 2, kind: 'rate_limit' })}\n`);

  const result = await compactJsonlShards(shardDirectory, ['githubnext/gh-aw-cao=logs-']);

  assert.deepEqual(result.orphanedShards, ['logs-1000000001-cccc.jsonl']);
  const remaining = (await readdir(shardDirectory)).filter((name) => name.endsWith('.jsonl'));
  assert.deepEqual(remaining, ['logs-1000000000-aaaa.jsonl']);
});

test('compact-jsonl leaves the shard directory untouched when every shard is claimed', async () => {
  const shardDirectory = await shardDirectoryFixture();
  await writeFile(path.join(shardDirectory, 'logs-1000000000-aaaa.jsonl'), runLine('githubnext/gh-aw-cao'));

  const result = await compactJsonlShards(shardDirectory, ['githubnext/gh-aw-cao=logs-']);

  assert.deepEqual(result.orphanedShards, []);
  const remaining = (await readdir(shardDirectory)).filter((name) => name.endsWith('.jsonl'));
  assert.deepEqual(remaining, ['logs-1000000000-aaaa.jsonl']);
});
