import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';
import { parse } from 'yaml';

const executeFile = promisify(execFile);
const cao = path.resolve('activity/cao.mjs');

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'cao-api-cost-'));
  const input = path.join(root, 'activity.jsonl');
  await writeFile(input, [
    JSON.stringify({
      schema_version: 2,
      kind: 'workflow_runs',
      payload: [{ databaseId: 101 }, { databaseId: 102 }],
    }),
    JSON.stringify({
      schema_version: 2,
      kind: 'github_api_rate_limit',
      rate_limit: { host: 'github.com', start: { limit: 15000, remaining: 14999 } },
    }),
    JSON.stringify({ schema_version: 2, kind: 'run', run: { run_id: 101 } }),
    JSON.stringify({ schema_version: 2, kind: 'run', run: { run_id: 102 } }),
    '',
  ].join('\n'));
  return { root, input };
}

test('cao api-cost models collection and repository capacity as JSON', async () => {
  const { root, input } = await fixture();
  try {
    const { stdout } = await executeFile(cao, [
      'api-cost',
      '--input', input,
      '--hourly-limit', '100',
      '--reserve', '20',
      '--workflows-per-repository', '2',
      '--fresh-runs-per-workflow', '3',
      '--format', 'json',
    ]);
    const result = JSON.parse(stdout);

    assert.equal(result.totals.workflowQueries, 1);
    assert.equal(result.totals.discoveredRuns, 2);
    assert.equal(result.totals.analyzedReports, 2);
    assert.equal(result.totals.normalPrimaryUnits, 12);
    assert.equal(result.prediction.runsPerRateLimitWindow, 13);
    assert.equal(result.prediction.scenario.primaryUnitsPerRepository, 34);
    assert.equal(result.prediction.scenario.repositoriesPerRateLimitWindow, 2);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('cao api-cost renders markdown and validates numeric options', async () => {
  const { root, input } = await fixture();
  try {
    const { stdout } = await executeFile(cao, ['api-cost', '--input', input]);
    assert.match(stdout, /^\| Input \| Workflow queries \|/);
    assert.match(stdout, /Aggregate: 2 reports at 6\.00 modeled primary units\/report\./);

    await assert.rejects(
      executeFile(cao, ['api-cost', '--input', input, '--reserve', '15000']),
      /--reserve must be smaller than --hourly-limit/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('the Activity package installs the API cost command module', async () => {
  const manifest = parse(await readFile('activity/aw.yml', 'utf8'));
  assert.ok(manifest.resources.some((resource) => (
    resource.source === 'api-cost.mjs' &&
    resource.destination === '.github/aw/activity/api-cost.mjs'
  )));
});
