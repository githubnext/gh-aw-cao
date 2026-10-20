import assert from 'node:assert/strict';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { runOperationalValue } from '../../activity/operational-value.mjs';

const root = path.resolve(import.meta.dirname, '..', '..');
const cao = path.join(root, 'activity', 'cao.mjs');

test('standard adapter batches local history once and preserves accepted partial snapshots', async () => {
  mkdirSync(path.join(root, '.tmp'), { recursive: true });
  const temporary = mkdtempSync(path.join(root, '.tmp', 'value-history-batch-'));
  const campaign = path.join(temporary, 'example');
  const modulePath = path.join(campaign, 'operational-value', 'example-worker.mjs');
  const calls = path.join(temporary, 'calls.jsonl');
  const output = path.join(temporary, 'values.jsonl');
  const script = path.join(campaign, 'operational-value.mjs');
  mkdirSync(path.dirname(modulePath), { recursive: true });
  writeFileSync(script, readFileSync(path.join(root,
    '.github/skills/add-operational-value/templates/campaign-operational-value.mjs')));
  writeFileSync(modulePath, `
import { appendFileSync } from "node:fs";
export const historyBatch = true;
export const definition = {
  slug: "example-worker", adoption: { adoptedAt: "2026-09-15T00:00:00Z" },
  evaluation: { mode: "baseline-comparable" },
  evidence: { measurementKind: "interval", repositories: ["octo/api"], window: { durationDays: 7, maturationDays: 0, cadenceDays: 1 } },
  metrics: ["first", "second"].map(id => ({id, role:"primary", name:id, unit:"items", direction:"decrease"}))
};
export function collectBatch(windows, context) {
  appendFileSync(${JSON.stringify(calls)}, JSON.stringify({windows, context}) + "\\n");
  return windows.map(() => ({evidence:{value:3}}));
}
export function scoreMetric(id, evidence) { return evidence.value; }
`);
  writeFileSync(output, JSON.stringify({
    schema_version: 2, kind: 'operational_value',
    operational_value: {
      campaign: 'example', repository: 'octo/api', value_id: 'example-worker.first',
      timestamp: '2026-09-11T12:00:00.000Z', value: 99
    }
  }) + '\n');
  const config = {
    root: temporary, outputPath: output, databasePath: path.join(temporary, 'unused.sqlite'),
    timestamp: '2026-09-18T00:00:00Z', repositories: ['octo/api'],
    historyCampaign: 'example', retentionWindow: 365 * 86_400_000
  };
  try {
    const result = await runOperationalValue(config);
    assert.deepEqual(result.warnings, []);
    assert.equal(result.historyValues, 11);
    const batches = readFileSync(calls, 'utf8').trim().split('\n').map(JSON.parse);
    assert.equal(batches.length, 2);
    assert.equal(batches[0].windows.length, 1);
    assert.equal(batches[1].windows.length, 6);
    assert.equal(batches[1].context.history, true);
    const records = readFileSync(output, 'utf8').trim().split('\n').map(JSON.parse);
    assert.equal(records.find(({operational_value: value}) => (
      value.timestamp === '2026-09-11T12:00:00.000Z' && value.value_id === 'example-worker.first'
    )).operational_value.value, 99);
    const repeat = await runOperationalValue(config);
    assert.deepEqual(repeat.warnings, []);
    assert.equal(repeat.historyValues, 0);
    assert.equal(readFileSync(calls, 'utf8').trim().split('\n').length, 3);
    for (const historyTimestamps of [
      [], Array(367).fill('2026-09-12T00:00:00Z'),
      ['invalid'], ['2026-09-12T00:00:00Z', '2026-09-12T00:00:00Z'],
      ['2026-09-13T00:00:00Z', '2026-09-12T00:00:00Z'],
      ['2026-09-19T00:00:00Z']
    ]) {
      const invalid = spawnSync(process.execPath, [script], {
        input: JSON.stringify({schemaVersion: 1, timestamp: config.timestamp,
          repositories: config.repositories, historyTimestamps}),
        env: {...process.env, CAO_OPERATIONAL_VALUE_MODULE: 'example-worker'},
        encoding: 'utf8'
      });
      assert.notEqual(invalid.status, 0);
      assert.match(invalid.stderr, /Invalid operational value history batch/);
    }
    for (const timestamp of [
      '2026-09-18', '2026-09-18T00:00:00Z', '2026-09-18T01:00:00.000+01:00'
    ]) {
      const invalid = spawnSync(process.execPath, [script], {
        input: JSON.stringify({schemaVersion: 1, timestamp,
          repositories: config.repositories, historyTimestamps: [timestamp]}),
        env: {...process.env, CAO_OPERATIONAL_VALUE_MODULE: 'example-worker'},
        encoding: 'utf8'
      });
      assert.notEqual(invalid.status, 0);
      assert.match(invalid.stderr, /Invalid operational value history batch/);
    }
  } finally {
    rmSync(temporary, {recursive: true, force: true});
  }
});

test('period-aware collection retains adjacent cutoffs even when assessments share a legacy cadence bucket', async (t) => {
  mkdirSync(path.join(root, '.tmp'), { recursive: true });
  const temporary = mkdtempSync(path.join(root, '.tmp', 'value-period-retention-'));
  t.after(() => rmSync(temporary, { recursive: true, force: true }));
  const campaign = path.join(temporary, 'example');
  mkdirSync(path.join(campaign, 'operational-value'), { recursive: true });
  writeFileSync(path.join(campaign, 'operational-value.mjs'), readFileSync(path.join(root,
    '.github/skills/add-operational-value/templates/campaign-operational-value.mjs')));
  writeFileSync(path.join(campaign, 'operational-value', 'example-worker.mjs'), `
export const historyBatch = true;
export const definition = {
  slug: "example-worker", adoption: { adoptedAt: "2026-09-15T00:00:00Z" },
  evaluation: { mode: "attainment-only" },
  evidence: { measurementKind: "interval", repositories: ["octo/api"], window: { durationDays: 7, maturationDays: 0, cadenceDays: 1 } },
  metrics: [{id:"current", role:"primary", name:"Current", unit:"items", direction:"decrease"}]
};
export function collectBatch(windows) {
  return windows.map(window => ({evidence:{value:3, coverageStatus:"complete"}}));
}
export function scoreMetric(id, evidence) { return evidence.value; }
`);
  const outputPath = path.join(temporary, 'values.jsonl');
  const config = {
    root: temporary, outputPath, databasePath: path.join(temporary, 'unused.sqlite'),
    repositories: ['octo/api'], retentionWindow: 30 * 86_400_000
  };
  for (const timestamp of ['2026-09-23T12:00:00Z', '2026-09-24T00:00:00Z']) {
    assert.deepEqual((await runOperationalValue({ ...config, timestamp })).warnings, []);
  }
  const records = readFileSync(outputPath, 'utf8').trim().split('\n').map(JSON.parse);
  assert.deepEqual(records.map(row => row.operational_value.window_end), [
    '2026-09-23T00:00:00.000Z', '2026-09-24T00:00:00.000Z'
  ]);
  const history = await runOperationalValue({
    ...config, timestamp: '2026-09-24T12:00:00Z', historyCampaign: 'example'
  });
  assert.deepEqual(history.warnings, []);
  const retained = readFileSync(outputPath, 'utf8').trim().split('\n').map(JSON.parse);
  assert.ok(retained.every(row => Date.parse(row.operational_value.window_end) > Date.parse(row.operational_value.window_start)));
  assert.ok(retained.some(row => row.operational_value.timestamp === '2026-09-23T12:00:00.000Z'));
});

test('standard adapters reuse versioned observations only within cadence and retain real timestamps', () => {
  mkdirSync(path.join(root, '.tmp'), { recursive: true });
  const temporary = mkdtempSync(path.join(root, '.tmp', 'value-cadence-test-'));
  const campaign = path.join(temporary, 'example');
  const modulePath = path.join(campaign, 'operational-value', 'example-worker.mjs');
  const database = path.join(temporary, 'values.sqlite');
  const output = path.join(temporary, 'values.jsonl');
  const calls = path.join(temporary, 'calls.jsonl');
  mkdirSync(path.dirname(modulePath), { recursive: true });
  const template = readFileSync(path.join(root,
    '.github/skills/add-operational-value/templates/campaign-operational-value.mjs'), 'utf8');
  writeFileSync(path.join(campaign, 'operational-value.mjs'), template);
  const moduleSource = `
import { appendFileSync } from "node:fs";
export const definition = {
  slug: "example-worker", name: "Example",
  adoption: { adoptedAt: "2026-09-01T00:00:00Z" },
  evaluation: { mode: "attainment-only" },
  evidence: { measurementKind: "interval", repositories: ["octo/api"], window: { durationDays: 7, maturationDays: 0, cadenceDays: 1 } },
  metrics: [{ id: "remaining", name: "Remaining", role: "primary", unit: "alerts", direction: "decrease" }]
};
export function collectBatch(windows) {
  appendFileSync(${JSON.stringify(calls)}, JSON.stringify(windows) + "\\n");
  return windows.map(window => ({
    evidence: { value: 0, maturityStatus: "matured", coverageStatus: "complete", eligibleCount: 2,
      populationDigest: "a".repeat(64) },
    provenance: [{ source: "fixture", cutoff: window.windowEnd }]
  }));
}
export function scoreMetric(id, evidence) { return evidence.value; }
`;
  writeFileSync(modulePath, moduleSource);
  const run = (timestamp) => JSON.parse(execFileSync(process.execPath, [
    cao, 'operational-value', '--database', database, '--root', temporary,
    '--output', output, '--timestamp', timestamp, '--repository', 'octo/api',
    '--retention-days', '30'
  ], { encoding: 'utf8' }));
  const ingest = () => execFileSync(process.execPath, [
    cao, 'ingest-jsonl', '--database', database, '--input', output
  ]);
  const callCount = () => readFileSync(calls, 'utf8').trim().split('\n').length;
  try {
    for (const name of ['dependabot', 'optimization']) {
      assert.equal(readFileSync(path.join(root, name, 'operational-value.mjs'), 'utf8'), template);
    }
    const first = run('2026-09-24T10:00:00Z');
    assert.deepEqual(first.warnings, []);
    assert.equal(first.values[0].value, 0);
    assert.equal(first.values[0].cadenceDays, 1);
    assert.equal(first.values[0].windowStart, '2026-09-17T00:00:00.000Z');
    assert.equal(first.values[0].windowEnd, '2026-09-24T00:00:00.000Z');
    assert.equal(first.values[0].measurementKind, 'interval');
    assert.equal(first.values[0].coverageStatus, 'complete');
    assert.equal(first.values[0].eligibleCount, 2);
    assert.match(first.values[0].evidenceDigest, /^[0-9a-f]{64}$/);
    assert.match(first.values[0].evaluatorDigest, /^[0-9a-f]{64}$/);
    ingest();
    const stored = JSON.parse(execFileSync(process.execPath, [
      cao, 'query', '--database', database, '--collection', 'operationalValues'
    ], { encoding: 'utf8' }));
    assert.equal(stored[0]?.['evaluator-digest'], first.values[0].evaluatorDigest, JSON.stringify(stored));
    assert.equal(stored[0]?.['cadence-days'], 1);
    const reused = run('2026-09-24T11:00:00Z');
    assert.deepEqual(reused.warnings, []);
    assert.equal(callCount(), 1);
    assert.equal(reused.values[0].timestamp, first.values[0].timestamp);
    assert.equal(reused.values[0].metricUnit, 'alerts');
    assert.equal(reused.values[0].cadenceDays, 1);
    assert.equal(reused.values[0].evaluatorDigest, first.values[0].evaluatorDigest);
    assert.equal(reused.values[0].evidenceDigest, first.values[0].evidenceDigest);
    assert.equal(reused.values[0].populationDigest, first.values[0].populationDigest);
    assert.equal(readFileSync(output, 'utf8').trim().split('\n').length, 1);

    const accepted = JSON.parse(readFileSync(output, 'utf8').trim());
    const unavailable = { ...accepted, operational_value: {
      ...accepted.operational_value, timestamp: '2026-09-24T11:30:00.000Z',
      value: null, maturity_status: 'unavailable', coverage_status: 'missing', missing_reason: 'source-inaccessible'
    } };
    writeFileSync(output, [accepted, unavailable].map(record => JSON.stringify(record)).join('\n') + '\n');
    ingest();
    const reassessed = run('2026-09-24T12:00:00Z');
    assert.equal(callCount(), 2);
    assert.equal(reassessed.values[0].timestamp, '2026-09-24T12:00:00.000Z');
    assert.equal(reassessed.values[0].value, 0);
    ingest();

    const expired = run('2026-09-25T00:00:00Z');
    assert.equal(callCount(), 3);
    assert.equal(expired.values[0].timestamp, '2026-09-25T00:00:00.000Z');
    assert.equal(expired.values[0].windowEnd, '2026-09-25T00:00:00.000Z');
    ingest();
    writeFileSync(modulePath, `${moduleSource}\n`);
    const changed = run('2026-09-25T01:00:00Z');
    assert.equal(callCount(), 4);
    assert.notEqual(changed.values[0].evaluatorDigest, first.values[0].evaluatorDigest);
    ingest();
    writeFileSync(path.join(campaign, 'operational-value.mjs'), `${template}\n`);
    const adapterChanged = run('2026-09-25T02:00:00Z');
    assert.equal(callCount(), 5);
    assert.notEqual(adapterChanged.values[0].evaluatorDigest, changed.values[0].evaluatorDigest);
    assert.ok(readFileSync(output, 'utf8').trim().split('\n').length >= 2);
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
});

function writeProcessTreeWorker(packageDirectory, config) {
  writeFileSync(path.join(packageDirectory, 'config.json'), JSON.stringify(config));
  writeFileSync(path.join(packageDirectory, 'descendant.mjs'), `
import { writeFileSync } from 'node:fs';
const [, , marker, delay] = process.argv;
setTimeout(() => writeFileSync(marker, 'alive'), Number(delay));
setInterval(() => {}, 1_000);
`);
  writeFileSync(path.join(packageDirectory, 'operational-value.mjs'), `
import { spawn } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
const config = JSON.parse(readFileSync(new URL('./config.json', import.meta.url)));
spawn(process.execPath, [
  fileURLToPath(new URL('./descendant.mjs', import.meta.url)),
  config.orphanMarker,
  String(config.delay)
]);
if (config.readyMarker) writeFileSync(config.readyMarker, 'ready');
if (config.fail) process.exit(1);
setInterval(() => {}, 1_000);
`);
}

test('operational-value worker execution is cancellable', async () => {
  const temporary = mkdtempSync(path.join(os.tmpdir(), 'cao-operational-value-abort-'));
  const packageDirectory = path.join(temporary, 'example');
  const orphanMarker = path.join(temporary, 'orphan');
  mkdirSync(packageDirectory);
  writeProcessTreeWorker(packageDirectory, { orphanMarker, delay: 150 });
  const controller = new AbortController();
  const reason = new Error('operational value cancelled');
  const cancellation = setTimeout(() => controller.abort(reason), 50);

  try {
    await assert.rejects(runOperationalValue({
      indexedDB: null,
      databasePath: path.join(temporary, 'dashboard.sqlite'),
      root: temporary,
      repositories: ['githubnext/gh-cao'],
      signal: controller.signal
    }), reason);
    await new Promise((resolve) => setTimeout(resolve, 250));
    assert.equal(existsSync(orphanMarker), false);
  } finally {
    clearTimeout(cancellation);
    rmSync(temporary, { recursive: true, force: true });
  }
});

test('operational-value history requires a retention window', async () => {
  await assert.rejects(
    runOperationalValue({
      indexedDB: null,
      databasePath: ':memory:',
      root,
      repositories: [],
      historyCampaign: 'optimization'
    }),
    /history requires a retention window/
  );
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
      repositories: ['githubnext/gh-cao'],
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
  writeProcessTreeWorker(packageDirectory, { orphanMarker, delay: 150, fail: true });

  try {
    const result = await runOperationalValue({
      indexedDB: null,
      databasePath: path.join(temporary, 'dashboard.sqlite'),
      root: temporary,
      repositories: ['githubnext/gh-cao']
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
  writeProcessTreeWorker(packageDirectory, { orphanMarker, readyMarker, delay: 300 });

  try {
    const execution = spawn(process.execPath, [
      cao,
      'operational-value',
      '--database', path.join(temporary, 'dashboard.sqlite'),
      '--root', temporary,
      '--repository', 'githubnext/gh-cao'
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
  console.log(JSON.stringify({timestamp:request.timestamp,repository,valueId:"example-count",value:isolated ? 2 : 0,metricRole:"diagnostic",metricName:"Example count",metricUnit:"percent",metricDirection:"decrease",maturityStatus:"interim",adoptionAt:"2026-09-15T23:30:36Z",evaluationMode:"attainment-only",workflowSlug:"example-worker",workflowName:"Example Worker",rollupNumerator:100,rollupDenominator:2}));
}\n`);
  chmodSync(script, 0o755);

  const result = JSON.parse(execFileSync(process.execPath, [
    cao,
    'operational-value',
    '--database', database,
    '--root', temporary,
    '--output', output,
    '--timestamp', '2026-09-24T10:00:00Z',
    '--repository', 'githubnext/gh-cao',
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
    { repository: 'githubnext/gh-cao', valueId: 'example-count', value: 2 },
  ]);
  assert.deepEqual(
    stored.map((record) => ({
      role: record['operational-value-role'],
      name: record['operational-value-name'],
      unit: record['operational-value-unit'],
      direction: record['operational-value-direction'],
      maturity: record['maturity-status'],
      adoptionAt: record['adoption-at'],
      evaluationMode: record['evaluation-mode'],
      workflowSlug: record['workflow-slug'],
      workflowName: record['workflow-name'],
      rollupNumerator: record['rollup-numerator'],
      rollupDenominator: record['rollup-denominator'],
    })),
    [
      { role: 'diagnostic', name: 'Example count', unit: 'percent', direction: 'decrease', maturity: 'interim', adoptionAt: '2026-09-15T23:30:36.000Z', evaluationMode: 'attainment-only', workflowSlug: 'example-worker', workflowName: 'Example Worker', rollupNumerator: 100, rollupDenominator: 2 },
      { role: 'diagnostic', name: 'Example count', unit: 'percent', direction: 'decrease', maturity: 'interim', adoptionAt: '2026-09-15T23:30:36.000Z', evaluationMode: 'attainment-only', workflowSlug: 'example-worker', workflowName: 'Example Worker', rollupNumerator: 100, rollupDenominator: 2 },
    ],
  );
});

test('cao operational-value rejects malformed optional cadence metadata', async () => {
  const temporary = mkdtempSync(path.join(os.tmpdir(), 'cao-operational-cadence-'));
  const packageDirectory = path.join(temporary, 'example');
  mkdirSync(packageDirectory);
  try {
    for (const cadenceDays of [0, -1, null, '7']) {
      writeFileSync(path.join(packageDirectory, 'operational-value.mjs'), `
console.log(JSON.stringify({timestamp:"2026-09-24T10:00:00Z",repository:"octo/api",valueId:"primary",value:4,cadenceDays:${JSON.stringify(cadenceDays)}}));`);
      const result = await runOperationalValue({
        indexedDB: null,
        root: temporary,
        databasePath: path.join(temporary, 'values.sqlite'),
        outputPath: path.join(temporary, 'values.jsonl'),
        timestamp: '2026-09-24T10:00:00Z',
        repositories: ['octo/api']
      });
      assert.deepEqual(result.values, []);
      assert.match(result.warnings[0]?.message, /cadenceDays must be a positive finite number/);
    }
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
});

test('cao operational-value accepts only string SHA-256 evaluator fingerprints or omitted legacy metadata', async () => {
  const temporary = mkdtempSync(path.join(os.tmpdir(), 'cao-operational-digest-'));
  const packageDirectory = path.join(temporary, 'example');
  mkdirSync(packageDirectory);
  try {
    for (const evaluatorDigest of [
      null, 64, {}, ['a'.repeat(64)], '', 'a'.repeat(63), 'A'.repeat(64),
      'g'.repeat(64), 'a'.repeat(64), undefined
    ]) {
      const record = {
        timestamp: '2026-09-24T10:00:00Z', repository: 'octo/api',
        valueId: 'primary', value: 4, evaluatorDigest
      };
      writeFileSync(path.join(packageDirectory, 'operational-value.mjs'),
        `console.log(${JSON.stringify(JSON.stringify(record))});`);
      const result = await runOperationalValue({
        indexedDB: null,
        root: temporary,
        databasePath: path.join(temporary, 'values.sqlite'),
        outputPath: path.join(temporary, 'values.jsonl'),
        timestamp: record.timestamp,
        repositories: [record.repository]
      });
      if (evaluatorDigest === undefined || evaluatorDigest === 'a'.repeat(64)) {
        assert.deepEqual(result.warnings, []);
        assert.equal(result.values.length, 1);
        assert.equal(result.values[0].evaluatorDigest, evaluatorDigest);
      } else {
        assert.deepEqual(result.values, []);
        assert.match(result.warnings[0]?.message, /evaluatorDigest must be a SHA-256 fingerprint/);
      }
    }
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
});

test('cao operational-value keeps shared metric IDs isolated per campaign', async () => {
  const temporary = mkdtempSync(path.join(os.tmpdir(), 'cao-operational-campaign-key-'));
  const output = path.join(temporary, 'values.jsonl');
  const database = path.join(temporary, 'dashboard.sqlite');
  for (const [campaign, metricName, metricUnit, value] of [
    ['dependabot', 'Dependabot alert risk', 'alerts', 3],
    ['optimization', 'Optimization opportunity share', 'percent', 0.5]
  ]) {
    const packageDirectory = path.join(temporary, campaign);
    mkdirSync(packageDirectory);
    writeFileSync(path.join(packageDirectory, 'operational-value.mjs'), `
const chunks = [];
for await (const chunk of process.stdin) chunks.push(chunk);
const request = JSON.parse(Buffer.concat(chunks).toString());
console.log(JSON.stringify({timestamp:request.timestamp,repository:request.repositories[0],valueId:"primary",value:${value},metricName:${JSON.stringify(metricName)},metricUnit:${JSON.stringify(metricUnit)}}));\n`);
  }

  try {
    await runOperationalValue({
      indexedDB: null,
      databasePath: database,
      root: temporary,
      outputPath: output,
      timestamp: '2026-09-24T10:00:00Z',
      repositories: ['githubnext/gh-cao']
    });

    const values = readFileSync(output, 'utf8').trim().split('\n')
      .map((line) => JSON.parse(line).operational_value)
      .toSorted((left, right) => left.campaign.localeCompare(right.campaign));
    assert.deepEqual(
      values.map((value) => ({
        campaign: value.campaign,
        valueId: value.value_id,
        name: value.metric_name,
        unit: value.metric_unit,
        measured: value.value
      })),
      [
        {
          campaign: 'dependabot',
          valueId: 'primary',
          name: 'Dependabot alert risk',
          unit: 'alerts',
          measured: 3
        },
        {
          campaign: 'optimization',
          valueId: 'primary',
          name: 'Optimization opportunity share',
          unit: 'percent',
          measured: 0.5
        }
      ]
    );
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
});

test('cao operational-value materializes queried history, compacts cadence buckets, and retires obsolete metric IDs', () => {
  const temporary = mkdtempSync(path.join(os.tmpdir(), 'cao-operational-definitions-'));
  const packageDirectory = path.join(temporary, 'example');
  const output = path.join(temporary, 'values.jsonl');
  mkdirSync(packageDirectory);
  writeFileSync(path.join(packageDirectory, 'operational-value.mjs'), `
const chunks = [];
for await (const chunk of process.stdin) chunks.push(chunk);
const request = JSON.parse(Buffer.concat(chunks).toString());
console.log(JSON.stringify({kind:"operational_value_definition",workflowSlug:"example-worker",adoptedAt:"2026-09-15T23:30:36Z",evaluationMode:"baseline-comparable",cadenceDays:1,repositories:["githubnext/gh-cao"],valueIds:["example-worker.current"]}));
console.log(JSON.stringify({timestamp:request.timestamp,repository:request.repositories[0],valueId:"example-worker.current",value:3}));\n`);
  writeFileSync(output, [
    {
      schema_version: 2,
      kind: 'operational_value',
      operational_value: {
        campaign: 'example',
        repository: 'githubnext/gh-cao',
        value_id: 'example-worker.retired',
        value: 1,
        timestamp: '2026-09-21T10:00:00.000Z'
      }
    },
    {
      schema_version: 2,
      kind: 'operational_value',
      operational_value: {
        campaign: 'unrelated',
        repository: 'githubnext/gh-cao',
        value_id: 'preserved',
        value: 4,
        timestamp: '2026-09-21T10:00:00.000Z'
      }
    }
  ].map(JSON.stringify).join('\n') + '\n');

  const arguments_ = [
    cao,
    'operational-value',
    '--database', path.join(temporary, 'dashboard.sqlite'),
    '--root', temporary,
    '--output', output,
    '--timestamp', '2026-09-24T10:00:00Z',
    '--retention-days', '30',
    '--history-campaign', 'example',
    '--repository', 'githubnext/gh-cao'
  ];
  const result = JSON.parse(execFileSync(process.execPath, arguments_, { encoding: 'utf8' }));

  const envelopes = readFileSync(output, 'utf8').trim().split('\n').map(JSON.parse);
  assert.equal(result.historyValues, 12);
  assert.equal(result.values.length, 13);
  assert.equal(envelopes.length, 14);
  assert.equal(
    envelopes.some((entry) => entry.operational_value.value_id === 'example-worker.retired'),
    false
  );
  assert.deepEqual(
    envelopes
      .filter((entry) => entry.operational_value.campaign === 'example')
      .map((entry) => entry.operational_value.timestamp)
      .toSorted(),
    [
      '2026-09-12T23:30:36.000Z',
      '2026-09-13T23:30:36.000Z',
      '2026-09-14T23:30:36.000Z',
      '2026-09-15T23:30:36.000Z',
      '2026-09-16T23:30:36.000Z',
      '2026-09-17T23:30:36.000Z',
      '2026-09-18T23:30:36.000Z',
      '2026-09-19T23:30:36.000Z',
      '2026-09-20T23:30:36.000Z',
      '2026-09-21T23:30:36.000Z',
      '2026-09-22T23:30:36.000Z',
      '2026-09-23T23:30:36.000Z',
      '2026-09-24T10:00:00.000Z'
    ]
  );
  const repeated = JSON.parse(execFileSync(process.execPath, arguments_, { encoding: 'utf8' }));
  assert.equal(repeated.historyValues, 0);

  const laterArguments = [...arguments_];
  laterArguments[laterArguments.indexOf('--timestamp') + 1] = '2026-09-24T10:15:00Z';
  const later = JSON.parse(execFileSync(process.execPath, laterArguments, { encoding: 'utf8' }));
  assert.equal(later.historyValues, 0);
  assert.deepEqual(
    readFileSync(output, 'utf8').trim().split('\n')
      .map(JSON.parse)
      .filter((entry) => entry.operational_value.campaign === 'example')
      .map((entry) => entry.operational_value.timestamp)
      .toSorted(),
    [
      '2026-09-12T23:30:36.000Z',
      '2026-09-13T23:30:36.000Z',
      '2026-09-14T23:30:36.000Z',
      '2026-09-15T23:30:36.000Z',
      '2026-09-16T23:30:36.000Z',
      '2026-09-17T23:30:36.000Z',
      '2026-09-18T23:30:36.000Z',
      '2026-09-19T23:30:36.000Z',
      '2026-09-20T23:30:36.000Z',
      '2026-09-21T23:30:36.000Z',
      '2026-09-22T23:30:36.000Z',
      '2026-09-23T23:30:36.000Z',
      '2026-09-24T10:15:00.000Z'
    ]
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
    '--repository', 'githubnext/gh-cao'
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

test('Dependabot operational value measures open security-risk repository state', () => {
  const temporary = mkdtempSync(path.join(os.tmpdir(), 'cao-dependabot-value-'));
  const fakeGh = path.join(temporary, 'gh');
  const calls = path.join(temporary, 'calls.log');
  writeFileSync(fakeGh, `#!/usr/bin/env bash
set -euo pipefail
printf '%s\\n' "$*" >> ${JSON.stringify(calls)}
if [[ " $* " == *"repos/github/gh-aw/dependabot/alerts"* ]]; then
  printf '%s\\n' '[[{"created_at":"2026-09-10T00:00:00Z","security_advisory":{"severity":"high"}},{"created_at":"2026-09-12T00:00:00Z","security_advisory":{"severity":"low"}},{"created_at":"2026-09-01T00:00:00Z","fixed_at":"2026-09-15T00:00:00Z","security_advisory":{"severity":"medium"}}]]'
elif [[ " $* " == *"graphql"* ]]; then
  printf '%s\\n' '[{"data":{"search":{"issueCount":1,"nodes":[{"createdAt":"2026-09-05T00:00:00Z","closedAt":null}],"pageInfo":{"hasNextPage":false,"endCursor":null}}}}]'
else
  echo "unexpected gh api arguments: $*" >&2
  exit 1
fi\n`);
  chmodSync(fakeGh, 0o755);
  const request = JSON.stringify({
    schemaVersion: 1,
    timestamp: '2026-10-01T10:00:00.000Z',
    repositories: ['github/gh-aw']
  });

  const result = execFileSync(
    process.execPath,
    [path.join(root, 'dependabot', 'operational-value.mjs')],
    { encoding: 'utf8', input: request, env: {
      ...process.env,
      PATH: `${temporary}:${process.env.PATH}`
    } }
  ).trim().split('\n').map(JSON.parse)
    .filter(({ kind }) => kind !== 'operational_value_definition');

  assert.deepEqual(result.map(({ valueId, value }) => ({ valueId, value })), [
    { valueId: 'dependabot-update-planner.open-security-alert-count', value: 2 },
    { valueId: 'dependabot-update-planner.open-high-critical-alert-count', value: 1 },
    { valueId: 'dependabot-update-planner.open-dependabot-pr-count', value: 1 }
  ]);
  const ghCalls = readFileSync(calls, 'utf8');
  assert.match(ghCalls, /--paginate --slurp repos\/github\/gh-aw\/dependabot\/alerts/);
  assert.equal(ghCalls.match(/graphql/g)?.length, 1);
});

test('Dependabot operational value fails closed on incomplete pull request evidence', () => {
  const temporary = mkdtempSync(path.join(os.tmpdir(), 'cao-dependabot-value-pages-'));
  const fakeGh = path.join(temporary, 'gh');
  writeFileSync(fakeGh, `#!/usr/bin/env bash
set -euo pipefail
if [[ " $* " == *"repos/github/gh-aw/dependabot/alerts"* ]]; then
  printf '%s\\n' '[[]]'
elif [[ " $* " == *"graphql"* ]]; then
  printf '%s\\n' '[{"data":{"search":{"issueCount":5,"nodes":null,"pageInfo":{"hasNextPage":false,"endCursor":null}}}}]'
else
  echo "unexpected gh api arguments: $*" >&2
  exit 1
fi\n`);
  chmodSync(fakeGh, 0o755);
  const request = JSON.stringify({
    schemaVersion: 1,
    timestamp: '2026-10-01T10:00:00.000Z',
    repositories: ['github/gh-aw']
  });

  assert.throws(() => execFileSync(
    process.execPath,
    [path.join(root, 'dependabot', 'operational-value.mjs')],
    { encoding: 'utf8', input: request, env: {
      ...process.env,
      PATH: `${temporary}:${process.env.PATH}`
    }, stdio: 'pipe' }
  ), /incomplete Dependabot pull request evidence/);
});

test('cao operational-value warns on non-numeric metrics and bounds retained output', () => {
  const temporary = mkdtempSync(path.join(os.tmpdir(), 'cao-operational-retention-'));
  const packageDirectory = path.join(temporary, 'example');
  const output = path.join(temporary, 'values.jsonl');
  mkdirSync(packageDirectory);
  const script = path.join(packageDirectory, 'operational-value.mjs');
  writeFileSync(script, `process.stdin.resume();
process.stdin.on('end', () => console.log(JSON.stringify({timestamp:"2026-09-24T10:00:00.000Z",repository:"githubnext/gh-cao",valueId:"example",value:1})));\n`);
  chmodSync(script, 0o755);
  const retained = [
    JSON.stringify({ schema_version: 2, kind: 'operational_value', operational_value: {
      timestamp: '2025-09-23T10:00:00.000Z', campaign: 'example', repository: 'githubnext/gh-cao', value_id: 'expired', value: 1
    } }),
    JSON.stringify({ schema_version: 2, kind: 'operational_value', operational_value: {
      timestamp: '2025-09-24T10:00:00.000Z', campaign: 'example', repository: 'githubnext/gh-cao', value_id: 'boundary', value: 1
    } }),
    JSON.stringify({ schema_version: 2, kind: 'operational_value', operational_value: {
      timestamp: '2026-08-01T10:00:00.000Z', campaign: 'example', repository: 'githubnext/gh-cao', value_id: 'old', value: 1
    } }),
    JSON.stringify({ schema_version: 2, kind: 'operational_value', operational_value: {
      timestamp: '2026-09-19T10:00:00.000Z', repository: 'githubnext/gh-cao', value_id: 'legacy', value: 1
    } }),
    JSON.stringify({ schema_version: 2, kind: 'operational_value', operational_value: {
      timestamp: '2026-09-20T10:00:00.000Z', campaign: 'example', repository: 'githubnext/gh-cao', value_id: 'retained', value: 1
    } })
  ].join('\n');
  writeFileSync(output, retained);

  execFileSync(process.execPath, [
    cao, 'operational-value', '--database', path.join(temporary, 'dashboard.sqlite'),
    '--root', temporary, '--output', output, '--timestamp', '2026-09-24T10:00:00Z',
    '--repository', 'githubnext/gh-cao', '--retention-days', '30'
  ]);
  const envelopes = readFileSync(output, 'utf8').trim().split('\n').map(JSON.parse);
  assert.deepEqual(envelopes.map((entry) => entry.operational_value.value_id), ['retained', 'example']);

  writeFileSync(output, retained);
  execFileSync(process.execPath, [
    cao, 'operational-value', '--database', path.join(temporary, 'dashboard.sqlite'),
    '--root', temporary, '--output', output, '--timestamp', '2026-09-24T10:00:00Z',
    '--repository', 'githubnext/gh-cao'
  ]);
  assert.deepEqual(readFileSync(output, 'utf8').trim().split('\n')
    .map((line) => JSON.parse(line).operational_value.value_id), ['boundary', 'old', 'retained', 'example']);

  writeFileSync(script, `process.stdin.resume();
process.stdin.on('end', () => console.log(JSON.stringify({timestamp:"2026-09-24T10:00:00Z",repository:"githubnext/gh-cao",valueId:"invalid",value:null})));\n`);
  const invalid = spawnSync(process.execPath, [
    cao, 'operational-value', '--database', path.join(temporary, 'dashboard.sqlite'),
    '--root', temporary, '--repository', 'githubnext/gh-cao'
  ], { encoding: 'utf8' });
  assert.equal(invalid.status, 0);
  assert.match(invalid.stderr, /Warning: .*must be a finite number/);
});
