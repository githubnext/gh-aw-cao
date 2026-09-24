import assert from 'node:assert/strict';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';
import { runOperationalValue } from '../../activity/operational-value.mjs';

const root = path.resolve(import.meta.dirname, '..', '..');
const cao = path.join(root, 'activity', 'cao.mjs');

test('operational-value worker execution is cancellable', async () => {
  const temporary = mkdtempSync(path.join(os.tmpdir(), 'cao-operational-value-abort-'));
  const packageDirectory = path.join(temporary, 'example');
  const orphanMarker = path.join(temporary, 'orphan');
  mkdirSync(packageDirectory);
  writeFileSync(path.join(packageDirectory, 'operational-value.mjs'), `
import { spawn } from 'node:child_process';
spawn(process.execPath, ['-e', ${JSON.stringify(
  `setTimeout(() => require('node:fs').writeFileSync(${JSON.stringify(orphanMarker)}, 'alive'), 150); setInterval(() => {}, 1_000);`
)}]);
setInterval(() => {}, 1_000);\n`);
  const controller = new AbortController();
  const reason = new Error('operational value cancelled');
  const cancellation = setTimeout(() => controller.abort(reason), 50);

  try {
    await assert.rejects(runOperationalValue({
      indexedDB: null,
      databasePath: path.join(temporary, 'dashboard.sqlite'),
      root: temporary,
      repositories: ['githubnext/gh-aw-cao'],
      signal: controller.signal
    }), reason);
    await new Promise((resolve) => setTimeout(resolve, 250));
    assert.equal(existsSync(orphanMarker), false);
  } finally {
    clearTimeout(cancellation);
    rmSync(temporary, { recursive: true, force: true });
  }
});

test('operational-value worker execution times out and continues', async () => {
  const temporary = mkdtempSync(path.join(os.tmpdir(), 'cao-operational-value-timeout-'));
  const failedDirectory = path.join(temporary, 'failed');
  const successfulDirectory = path.join(temporary, 'successful');
  mkdirSync(failedDirectory);
  mkdirSync(successfulDirectory);
  writeFileSync(path.join(failedDirectory, 'operational-value.mjs'), 'setInterval(() => {}, 1_000);\n');
  writeFileSync(path.join(successfulDirectory, 'operational-value.mjs'), `
const chunks = [];
for await (const chunk of process.stdin) chunks.push(chunk);
const request = JSON.parse(Buffer.concat(chunks).toString());
console.log(JSON.stringify({timestamp:request.timestamp,repository:request.repositories[0],valueId:"successful",value:1}));\n`);

  try {
    const result = await runOperationalValue({
      indexedDB: null,
      databasePath: path.join(temporary, 'dashboard.sqlite'),
      root: temporary,
      repositories: ['githubnext/gh-aw-cao'],
      workerTimeoutMs: 500
    });

    assert.equal(result.warnings.length, 1);
    assert.match(result.warnings[0].message, /timed out after 500 ms/);
    assert.deepEqual(result.values.map(({ campaign, valueId }) => ({ campaign, valueId })), [
      { campaign: 'successful', valueId: 'successful' }
    ]);
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
});

test('operational-value cleans up descendants after worker failure', async () => {
  const temporary = mkdtempSync(path.join(os.tmpdir(), 'cao-operational-value-failure-tree-'));
  const packageDirectory = path.join(temporary, 'failed');
  const orphanMarker = path.join(temporary, 'orphan');
  mkdirSync(packageDirectory);
  writeFileSync(path.join(packageDirectory, 'operational-value.mjs'), `
import { spawn } from 'node:child_process';
spawn(process.execPath, ['-e', ${JSON.stringify(
  `setTimeout(() => require('node:fs').writeFileSync(${JSON.stringify(orphanMarker)}, 'alive'), 150); setInterval(() => {}, 1_000);`
)}]);
process.exit(1);\n`);

  try {
    const result = await runOperationalValue({
      indexedDB: null,
      databasePath: path.join(temporary, 'dashboard.sqlite'),
      root: temporary,
      repositories: ['githubnext/gh-aw-cao']
    });
    await new Promise((resolve) => setTimeout(resolve, 250));

    assert.equal(result.warnings.length, 1);
    assert.equal(existsSync(orphanMarker), false);
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
});

test('cao operational-value terminates worker process trees on SIGTERM', async () => {
  const temporary = mkdtempSync(path.join(os.tmpdir(), 'cao-operational-value-sigterm-'));
  const packageDirectory = path.join(temporary, 'example');
  const orphanMarker = path.join(temporary, 'orphan');
  const readyMarker = path.join(temporary, 'ready');
  mkdirSync(packageDirectory);
  writeFileSync(path.join(packageDirectory, 'operational-value.mjs'), `
import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
spawn(process.execPath, ['-e', ${JSON.stringify(
  `setTimeout(() => require('node:fs').writeFileSync(${JSON.stringify(orphanMarker)}, 'alive'), 300); setInterval(() => {}, 1_000);`
)}]);
writeFileSync(${JSON.stringify(readyMarker)}, 'ready');
setInterval(() => {}, 1_000);\n`);

  try {
    const execution = spawn(process.execPath, [
      cao,
      'operational-value',
      '--database', path.join(temporary, 'dashboard.sqlite'),
      '--root', temporary,
      '--repository', 'githubnext/gh-aw-cao'
    ], { stdio: 'ignore' });
    for (let attempt = 0; attempt < 40 && !existsSync(readyMarker); attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    assert.equal(existsSync(readyMarker), true);
    execution.kill('SIGTERM');
    const [status, signal] = await new Promise((resolve) => {
      execution.once('close', (code, closedBySignal) => resolve([code, closedBySignal]));
    });
    await new Promise((resolve) => setTimeout(resolve, 350));

    assert.equal(status, 143);
    assert.equal(signal, null);
    assert.equal(existsSync(orphanMarker), false);
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
});

test('cao operational-value runs package scripts and ingests emitted JSONL', () => {
  const temporary = mkdtempSync(path.join(os.tmpdir(), 'cao-operational-value-'));
  const packageDirectory = path.join(temporary, 'example');
  const output = path.join(temporary, 'values.jsonl');
  const database = path.join(temporary, 'dashboard.sqlite');
  mkdirSync(packageDirectory);
  const script = path.join(packageDirectory, 'operational-value.mjs');
  writeFileSync(script, `import { readFileSync } from 'node:fs';
const request = JSON.parse(readFileSync(0, 'utf8'));
for (const repository of request.repositories) {
  const isolated = process.env.GH_TOKEN === "read-only-token" && process.env.UNRELATED_SECRET === undefined;
  console.log(JSON.stringify({timestamp:request.timestamp,repository,valueId:"example-count",value:isolated ? 2 : 0,metricRole:"diagnostic",metricName:"Example count",metricDirection:"decrease",maturityStatus:"interim"}));
}\n`);
  chmodSync(script, 0o755);

  const result = JSON.parse(execFileSync(process.execPath, [
    cao,
    'operational-value',
    '--database', database,
    '--root', temporary,
    '--output', output,
    '--timestamp', '2026-09-24T10:00:00Z',
    '--repository', 'githubnext/gh-aw-cao',
    '--repository', 'github/gh-aw',
  ], { encoding: 'utf8', env: {
    ...process.env,
    CAO_OPERATIONAL_VALUE_GH_TOKEN: 'read-only-token',
    UNRELATED_SECRET: 'must-not-reach-worker'
  } }));

  assert.deepEqual(result.scripts, ['example']);
  assert.equal(result.values.length, 2);
  const envelopes = readFileSync(output, 'utf8').trim().split('\n').map(JSON.parse);
  assert.deepEqual(envelopes.map((entry) => entry.kind), ['operational_value', 'operational_value']);

  execFileSync(process.execPath, [cao, 'ingest-jsonl', '--database', database, '--input', output]);
  const stored = JSON.parse(execFileSync(process.execPath, [
    cao, 'query', '--database', database, '--collection', 'operationalValues'
  ], { encoding: 'utf8' }));
  assert.deepEqual(stored.map(({ repository, valueId, value }) => ({ repository, valueId, value })), [
    { repository: 'github/gh-aw', valueId: 'example-count', value: 2 },
    { repository: 'githubnext/gh-aw-cao', valueId: 'example-count', value: 2 },
  ]);
  assert.deepEqual(
    stored.map((record) => ({
      role: record['operational-value-role'],
      name: record['operational-value-name'],
      direction: record['operational-value-direction'],
      maturity: record['maturity-status'],
    })),
    [
      { role: 'diagnostic', name: 'Example count', direction: 'decrease', maturity: 'interim' },
      { role: 'diagnostic', name: 'Example count', direction: 'decrease', maturity: 'interim' },
    ],
  );
});

test('cao operational-value warns on worker failure and preserves successful values', () => {
  const temporary = mkdtempSync(path.join(os.tmpdir(), 'cao-operational-resilience-'));
  const failedDirectory = path.join(temporary, 'failed');
  const successfulDirectory = path.join(temporary, 'successful');
  const output = path.join(temporary, 'values.jsonl');
  mkdirSync(failedDirectory);
  mkdirSync(successfulDirectory);
  writeFileSync(path.join(failedDirectory, 'operational-value.mjs'), `
console.error("permission denied for " + process.env.GH_TOKEN);
process.exitCode = 1;\n`);
  writeFileSync(path.join(successfulDirectory, 'operational-value.mjs'), `
const chunks = [];
for await (const chunk of process.stdin) chunks.push(chunk);
const request = JSON.parse(Buffer.concat(chunks).toString());
console.log(JSON.stringify({timestamp:request.timestamp,repository:request.repositories[0],valueId:"successful",value:1}));\n`);

  const result = spawnSync(process.execPath, [
    cao, 'operational-value',
    '--database', path.join(temporary, 'dashboard.sqlite'),
    '--root', temporary,
    '--output', output,
    '--timestamp', '2026-09-24T10:00:00Z',
    '--repository', 'githubnext/gh-aw-cao'
  ], {
    encoding: 'utf8',
    env: { ...process.env, CAO_OPERATIONAL_VALUE_GH_TOKEN: 'read-only-token' }
  });

  assert.equal(result.status, 0);
  assert.match(result.stderr, /Warning: .*failed.*permission denied/);
  assert.doesNotMatch(result.stderr, /read-only-token/);
  const summary = JSON.parse(result.stdout);
  assert.equal(summary.warnings.length, 1);
  assert.deepEqual(summary.values.map(({ campaign, valueId }) => ({ campaign, valueId })), [
    { campaign: 'successful', valueId: 'successful' }
  ]);
  const envelopes = readFileSync(output, 'utf8').trim().split('\n').map(JSON.parse);
  assert.deepEqual(envelopes.map((entry) => entry.operational_value.campaign), ['successful']);
});

test('Dependabot operational value measures mature plan consumption signals', () => {
  const temporary = mkdtempSync(path.join(os.tmpdir(), 'cao-dependabot-value-'));
  const fakeGh = path.join(temporary, 'gh');
  const calls = path.join(temporary, 'calls.log');
  writeFileSync(fakeGh, `#!/usr/bin/env bash
set -euo pipefail
printf '%s\\n' "$*" >> ${JSON.stringify(calls)}
if [[ " $* " == *" repos/githubnext/gh-aw-cao/issues "* ]]; then
  printf '%s\\n' '[[{"number":41,"title":"[dependabot:update-planner] Dependency update plan for octo/example","body":"<!-- dependabot-update-plan:repository=octo/example -->","created_at":"2026-09-10T00:00:00Z","state":"open","user":{"login":"cao-test[bot]"}}]]'
elif [[ " $* " == *"/issues/41/sub_issues"* ]]; then
  printf '%s\\n' '[[{"number":42,"state":"closed","state_reason":"completed","user":{"login":"cao-test[bot]"}}]]'
elif [[ " $* " == *"/issues/41/comments"* ]]; then
  printf '%s\\n' '[[{"created_at":"2026-09-11T00:00:00Z","user":{"login":"maintainer"}}]]'
elif [[ " $* " == *"/issues/41/timeline"* ]]; then
  printf '%s\\n' '[[{"event":"assigned","created_at":"2026-09-11T00:00:00Z"},{"event":"cross-referenced","created_at":"2026-09-12T00:00:00Z","source":{"issue":{"pull_request":{"url":"https://api.github.test/pulls/7"}}}},{"event":"closed","created_at":"2026-09-13T00:00:00Z"}]]'
elif [[ " $* " == *"/issues/42/comments"* ]]; then
  printf '%s\\n' '[[]]'
elif [[ " $* " == *"/issues/42/timeline"* ]]; then
  printf '%s\\n' '[[{"event":"closed","state_reason":"completed","created_at":"2026-09-14T00:00:00Z"}]]'
else
  echo "unexpected gh api arguments: $*" >&2
  exit 1
fi\n`);
  chmodSync(fakeGh, 0o755);
  const request = JSON.stringify({
    schemaVersion: 1,
    timestamp: '2026-10-01T10:00:00.000Z',
    repositories: ['githubnext/gh-aw-cao']
  });

  const result = execFileSync(
    process.execPath,
    [path.join(root, 'dependabot', 'operational-value.mjs')],
    { encoding: 'utf8', input: request, env: {
      ...process.env,
      PATH: `${temporary}:${process.env.PATH}`
    } }
  ).trim().split('\n').map(JSON.parse);

  assert.deepEqual(result.map(({ valueId, value }) => ({ valueId, value })), [
    { valueId: 'dependabot-update-planner.consumed-plan-share', value: 1 },
    { valueId: 'dependabot-update-planner.assigned-plan-share', value: 1 },
    { valueId: 'dependabot-update-planner.participated-plan-share', value: 1 },
    { valueId: 'dependabot-update-planner.progressed-plan-share', value: 1 },
    { valueId: 'dependabot-update-planner.linked-plan-share', value: 1 },
    { valueId: 'dependabot-update-planner.closed-plan-share', value: 1 }
  ]);
  const ghCalls = readFileSync(calls, 'utf8');
  assert.match(ghCalls, /--paginate --slurp repos\/githubnext\/gh-aw-cao\/issues/);
  assert.equal(ghCalls.match(/\/issues\/41\/timeline/g)?.length, 1);
});

test('Dependabot operational value fails closed on unbounded child evidence', () => {
  const temporary = mkdtempSync(path.join(os.tmpdir(), 'cao-dependabot-value-pages-'));
  const fakeGh = path.join(temporary, 'gh');
  writeFileSync(fakeGh, `#!/usr/bin/env bash
set -euo pipefail
if [[ " $* " == *" repos/githubnext/gh-aw-cao/issues "* ]]; then
  printf '%s\\n' '[[{"number":41,"title":"Dependency update plan for octo/example","body":"","created_at":"2026-09-10T00:00:00Z","state":"open","user":{"login":"cao-test[bot]"}}]]'
elif [[ " $* " == *"/issues/41/sub_issues"* ]]; then
  printf '%s\\n' '[[],[]]'
else
  printf '%s\\n' '[[]]'
fi\n`);
  chmodSync(fakeGh, 0o755);
  const request = JSON.stringify({
    schemaVersion: 1,
    timestamp: '2026-10-01T10:00:00.000Z',
    repositories: ['githubnext/gh-aw-cao']
  });

  assert.throws(() => execFileSync(
    process.execPath,
    [path.join(root, 'dependabot', 'operational-value.mjs')],
    { encoding: 'utf8', input: request, env: {
      ...process.env,
      PATH: `${temporary}:${process.env.PATH}`
    }, stdio: 'pipe' }
  ), /evidence exceeded its bounded page/);
});

test('Daily File Diet shares one value module between CAO collection and historical evaluation', async () => {
  const temporary = mkdtempSync(path.join(os.tmpdir(), 'cao-daily-file-diet-value-'));
  const packageDirectory = path.join(temporary, 'daily-file-diet');
  const sourceDirectory = path.join(temporary, 'source');
  const archive = path.join(temporary, 'repository.tar.gz');
  const fakeGh = path.join(temporary, 'gh');
  const output = path.join(temporary, 'values.jsonl');
  const commit = '0123456789abcdef0123456789abcdef01234567';
  mkdirSync(path.join(sourceDirectory, 'pkg'), { recursive: true });
  writeFileSync(path.join(sourceDirectory, 'pkg', 'large.go'), 'line\n'.repeat(1200));
  writeFileSync(path.join(sourceDirectory, 'pkg', 'healthy.go'), 'line\n'.repeat(800));
  execFileSync('tar', ['-czf', archive, '-C', sourceDirectory, '.']);
  cpSync(path.join(root, 'daily-file-diet'), packageDirectory, { recursive: true });
  writeFileSync(path.join(packageDirectory, 'operational-value', 'other-workflow.mjs'), `
export const definition = {
  slug: "other-workflow",
  evidence: {
    repositories: ["github/gh-aw"],
    window: {durationDays: 1, maturationDays: 0}
  },
  metrics: [{id: "largest-file-health"}]
};
export async function collectBatch(windows) {
  return windows.map(() => ({evidence: {value: 0.25}}));
}
export function scoreMetric(id, evidence) {
  if (id !== "largest-file-health") throw new Error("unknown metric");
  return evidence.value;
}
`);
  writeFileSync(fakeGh, `#!/usr/bin/env bash
set -euo pipefail
if [[ " $* " == *"tarball/"* ]]; then
  cat ${JSON.stringify(archive)}
elif [[ " $* " == *" --paginate --slurp "* ]]; then
  printf '[[{"sha":"${commit}","commit":{"committer":{"date":"2026-09-24T18:00:00Z"}}}]]\\n'
else
  printf '[{"sha":"${commit}","commit":{"committer":{"date":"2026-09-24T18:00:00Z"}}}]\\n'
fi
`);
  chmodSync(fakeGh, 0o755);

  const result = JSON.parse(execFileSync(process.execPath, [
    cao,
    'operational-value',
    '--database', path.join(temporary, 'dashboard.sqlite'),
    '--root', temporary,
    '--output', output,
    '--timestamp', '2026-09-24T19:30:24Z',
    '--repository', 'github/gh-aw',
  ], {
    encoding: 'utf8',
    env: { ...process.env, PATH: `${temporary}:${process.env.PATH}` },
  }));

  assert.deepEqual(result.scripts, ['daily-file-diet']);
  assert.deepEqual(
    result.values.map(({ campaign, repository, valueId, value }) => ({
      campaign, repository, valueId, value,
    })),
    [
      {
        campaign: 'daily-file-diet',
        repository: 'github/gh-aw',
        valueId: 'daily-file-diet.largest-file-health',
        value: 0.8325,
      },
      {
        campaign: 'daily-file-diet',
        repository: 'github/gh-aw',
        valueId: 'daily-file-diet.compliant-line-mass-share',
        value: 0.4,
      },
      {
        campaign: 'daily-file-diet',
        repository: 'github/gh-aw',
        valueId: 'other-workflow.largest-file-health',
        value: 0.25,
      },
    ],
  );
  const valueModule = await import(pathToFileURL(
    path.join(root, 'daily-file-diet', 'operational-value', 'daily-file-diet.mjs')
  ));
  const evidence = {
    eligibleFileCount: 2,
    totalLines: 2000,
    largestFileLines: 1200,
    compliantLines: 800,
  };
  assert.deepEqual(
    result.values
      .filter(({ valueId }) => valueId.startsWith('daily-file-diet.'))
      .map(({ valueId, value }) => ({ valueId, value })),
    valueModule.definition.metrics.map(({ id }) => ({
      valueId: `daily-file-diet.${id}`,
      value: valueModule.scoreMetric(id, evidence),
    })),
  );
  const envelopes = readFileSync(output, 'utf8').trim().split('\n').map(JSON.parse);
  assert.deepEqual(envelopes.map(({ operational_value: value }) => ({
    campaign: value.campaign,
    repository: value.repository,
    valueId: value.value_id,
    value: value.value,
  })), result.values.map(({ campaign, repository, valueId, value }) => ({
    campaign, repository, valueId, value,
  })));

  const unrelated = JSON.parse(execFileSync(process.execPath, [
    cao,
    'operational-value',
    '--database', path.join(temporary, 'dashboard.sqlite'),
    '--root', temporary,
    '--timestamp', '2026-09-24T19:30:24Z',
    '--repository', 'githubnext/gh-aw-cao',
  ], {
    encoding: 'utf8',
    env: { ...process.env, PATH: `${temporary}:${process.env.PATH}` },
  }));
  assert.deepEqual(unrelated.values, []);
});

test('cao operational-value warns on non-numeric metrics and bounds retained output', () => {
  const temporary = mkdtempSync(path.join(os.tmpdir(), 'cao-operational-retention-'));
  const packageDirectory = path.join(temporary, 'example');
  const output = path.join(temporary, 'values.jsonl');
  mkdirSync(packageDirectory);
  const script = path.join(packageDirectory, 'operational-value.mjs');
  writeFileSync(script, `process.stdin.resume();
process.stdin.on('end', () => console.log(JSON.stringify({timestamp:"2026-09-24T10:00:00.000Z",repository:"githubnext/gh-aw-cao",valueId:"example",value:1})));\n`);
  chmodSync(script, 0o755);
  writeFileSync(output, [
    JSON.stringify({ schema_version: 2, kind: 'operational_value', operational_value: {
      timestamp: '2026-08-01T10:00:00.000Z', repository: 'githubnext/gh-aw-cao', value_id: 'old', value: 1
    } }),
    JSON.stringify({ schema_version: 2, kind: 'operational_value', operational_value: {
      timestamp: '2026-09-20T10:00:00.000Z', repository: 'githubnext/gh-aw-cao', value_id: 'retained', value: 1
    } })
  ].join('\n'));

  execFileSync(process.execPath, [
    cao, 'operational-value', '--database', path.join(temporary, 'dashboard.sqlite'),
    '--root', temporary, '--output', output, '--timestamp', '2026-09-24T10:00:00Z',
    '--repository', 'githubnext/gh-aw-cao', '--retention-days', '30'
  ]);
  const envelopes = readFileSync(output, 'utf8').trim().split('\n').map(JSON.parse);
  assert.deepEqual(envelopes.map((entry) => entry.operational_value.value_id), ['retained', 'example']);

  writeFileSync(script, `process.stdin.resume();
process.stdin.on('end', () => console.log(JSON.stringify({timestamp:"2026-09-24T10:00:00Z",repository:"githubnext/gh-aw-cao",valueId:"invalid",value:null})));\n`);
  const invalid = spawnSync(process.execPath, [
    cao, 'operational-value', '--database', path.join(temporary, 'dashboard.sqlite'),
    '--root', temporary, '--repository', 'githubnext/gh-aw-cao'
  ], { encoding: 'utf8' });
  assert.equal(invalid.status, 0);
  assert.match(invalid.stderr, /Warning: .*must be a finite number/);
});
