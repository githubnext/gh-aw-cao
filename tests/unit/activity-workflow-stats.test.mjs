import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import { activityWorkflowStats } from '../../activity/cao.mjs';

const FIXTURE_JSONL = path.resolve('dashboard/site/test/fixtures/gh-aw-logs/cached-v2.jsonl');

function fakeGh(runs) {
  return function execute(command, arguments_) {
    assert.equal(command, 'gh');
    if (arguments_[0] === 'run' && arguments_[1] === 'list') {
      return { status: 0, stdout: JSON.stringify(runs), stderr: '' };
    }
    if (arguments_[0] === 'run' && arguments_[1] === 'download') {
      const runId = arguments_[2];
      const directoryIndex = arguments_.indexOf('--dir');
      const directory = arguments_[directoryIndex + 1];
      const run = runs.find((entry) => String(entry.databaseId) === runId);
      if (run?.missingArtifact) return { status: 1, stdout: '', stderr: 'artifact not found' };
      mkdirSync(path.join(directory, 'gh-aw-logs-shards'), { recursive: true });
      const jsonl = readFileSync(FIXTURE_JSONL, 'utf8');
      writeFileSync(path.join(directory, 'gh-aw-logs.jsonl'), jsonl);
      writeFileSync(path.join(directory, 'gh-aw-logs.sqlite'), 'fake sqlite bytes');
      writeFileSync(path.join(directory, 'gh-aw-logs-shards', 'logs-1-a.jsonl'), jsonl);
      writeFileSync(path.join(directory, 'payload-hashes.json'), JSON.stringify({
        'gh-aw-logs.jsonl': 'abc',
        'gh-aw-logs.sqlite': 'def'
      }));
      return { status: 0, stdout: '', stderr: '' };
    }
    throw new Error(`Unexpected gh invocation: ${arguments_.join(' ')}`);
  };
}

test('activity-stats reports download duration, payload sizes, and hash files for each run', async () => {
  const runs = [
    { databaseId: 111, status: 'completed', conclusion: 'success', createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:05:00Z', url: 'https://example.test/111' }
  ];
  const stats = await activityWorkflowStats({ repo: 'githubnext/gh-aw-cao', limit: 1 }, fakeGh(runs));

  assert.equal(stats.command, 'activity-stats');
  assert.equal(stats.summary.repository, 'githubnext/gh-aw-cao');
  assert.equal(stats.summary.workflow, 'cao-activity.yml');
  assert.equal(stats.summary.runsInspected, 1);
  assert.equal(stats.summary.runsWithArtifact, 1);
  assert.equal(stats.summary.runsMissingArtifact, 0);

  const [run] = stats.runs;
  assert.equal(run.runId, '111');
  assert.equal(typeof run.downloadDurationMs, 'number');
  assert.ok(run.downloadDurationMs >= 0);
  assert.equal(run.jsonl.exists, true);
  assert.ok(run.jsonl.sizeBytes > 0);
  assert.equal(run.sqlite.exists, true);
  assert.ok(run.sqlite.sizeBytes > 0);
  assert.deepEqual(run.shards, [{ name: 'logs-1-a.jsonl', sizeBytes: run.jsonl.sizeBytes }]);
  assert.deepEqual(run.hashFiles, ['gh-aw-logs.jsonl', 'gh-aw-logs.sqlite']);
  assert.equal(typeof run.uniqueRuns, 'number');
  assert.equal(typeof run.duplicateRunObservations, 'number');
  assert.equal(run.directory, undefined);

  assert.equal(stats.summary.totalJsonlBytes, run.jsonl.sizeBytes);
  assert.equal(stats.summary.totalSqliteBytes, run.sqlite.sizeBytes);
  assert.equal(stats.summary.totalShardFiles, 1);
  assert.equal(stats.summary.totalHashFiles, 2);
  assert.equal(stats.summary.totalUniqueRuns, run.uniqueRuns);
  assert.equal(stats.summary.totalDuplicateRunObservations, run.duplicateRunObservations);
});

test('activity-stats records a per-run error when the artifact download fails', async () => {
  const runs = [
    { databaseId: 222, status: 'completed', conclusion: 'success', missingArtifact: true }
  ];
  const stats = await activityWorkflowStats({ repo: 'githubnext/gh-aw-cao', limit: 1 }, fakeGh(runs));

  assert.equal(stats.summary.runsWithArtifact, 0);
  assert.equal(stats.summary.runsMissingArtifact, 1);
  assert.equal(stats.runs[0].error, 'artifact not found');
  assert.equal(stats.runs[0].jsonl, undefined);
});

test('activity-stats requires a repository', async () => {
  const previous = process.env.GITHUB_REPOSITORY;
  delete process.env.GITHUB_REPOSITORY;
  try {
    await assert.rejects(
      () => activityWorkflowStats({ limit: 1 }, fakeGh([])),
      /Missing required option --repo/
    );
  } finally {
    if (previous === undefined) delete process.env.GITHUB_REPOSITORY;
    else process.env.GITHUB_REPOSITORY = previous;
  }
});

test('activity-stats rejects a non-positive limit', async () => {
  await assert.rejects(
    () => activityWorkflowStats({ repo: 'githubnext/gh-aw-cao', limit: 0 }, fakeGh([])),
    /--limit must be a positive integer/
  );
});
