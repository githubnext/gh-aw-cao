import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, cp, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { promisify } from 'node:util';
import {
  normalizedPhaseBatch,
  relationshipSafeEvidenceBatch
} from '../../activity/normalized-phase.mjs';
import { NORMALIZED_COLLECTIONS } from '../../activity/cli-usage.mjs';

const execFileAsync = promisify(execFile);

test('normalized phase partition emits every relational experiment collection exactly once', () => {
  const batch = Object.fromEntries(NORMALIZED_COLLECTIONS.map((collection) =>
    [collection, [{ id: collection, status: 'observed' }]]));
  const runs = normalizedPhaseBatch(batch, 'runs');
  const records = normalizedPhaseBatch(batch, 'records');
  for (const collection of NORMALIZED_COLLECTIONS) {
    assert.equal(runs[collection].length + records[collection].length, 1, collection);
  }
  for (const collection of ['experiments', 'experimentAssignments']) {
    assert.equal(runs[collection].length, 1, collection);
  }
  for (const collection of ['graders', 'graderObservations', 'evals', 'evalObservations']) {
    assert.equal(records[collection].length, 1, collection);
  }
});

test('relationship-safe evidence drops observations tied to another workflow', () => {
  const batch = Object.fromEntries(NORMALIZED_COLLECTIONS.map((collection) => [collection, []]));
  batch.runs = [{ id: 'run:1', workflowId: 'workflow:campaign' }];
  batch.graders = [
    { id: 'grader:campaign', workflowId: 'workflow:campaign' },
    { id: 'grader:package', workflowId: 'workflow:package' }
  ];
  batch.graderObservations = [
    { id: 'observation:valid', runId: 'run:1', graderId: 'grader:campaign' },
    { id: 'observation:mismatched', runId: 'run:1', graderId: 'grader:package' }
  ];

  const safe = relationshipSafeEvidenceBatch(batch);

  assert.deepEqual(safe.graderObservations, [batch.graderObservations[0]]);
  assert.deepEqual(safe.graders, batch.graders);
});

async function readNormalizedJsonl(filePath) {
  const lines = (await readFile(filePath, 'utf8')).trim().split('\n').map((line) => JSON.parse(line));
  const [metadata, ...records] = lines;
  const batch = Object.fromEntries(
    ['campaigns', 'repositories', 'workflows', 'runs', 'domains', 'tools', 'skills', 'friction', 'audits', 'issues', 'operationalValues',
      'experiments', 'experimentAssignments', 'graders', 'graderObservations', 'evals', 'evalObservations']
      .map((collection) => [collection, []])
  );
  for (const envelope of records) batch[envelope.collection].push(envelope.record);
  return { ...metadata, batch };
}

// Published phase directories hold consolidated shards alongside the
// `.payloads` incremental normalization cache, which is never published.
async function readShardNames(directory) {
  return (await readdir(directory)).filter((name) => name.endsWith('.jsonl')).sort();
}

// Consolidation spreads one phase across day-bucketed shards, so assertions
// about phase content read the union rather than a single file.
async function readPhasePayload(directory) {
  const names = await readShardNames(directory);
  const payloads = await Promise.all(names.map((name) => readNormalizedJsonl(path.join(directory, name))));
  const batch = Object.fromEntries(
    ['campaigns', 'repositories', 'workflows', 'runs', 'domains', 'tools', 'skills', 'friction', 'audits', 'issues', 'operationalValues',
      'experiments', 'experimentAssignments', 'graders', 'graderObservations', 'evals', 'evalObservations']
      .map((collection) => [collection, []])
  );
  for (const payload of payloads) {
    for (const [collection, records] of Object.entries(payload.batch)) batch[collection].push(...records);
  }
  return { names, payloads, batch, phase: payloads[0]?.phase };
}

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
  return JSON.parse(stdout).filter((transaction) => (
    transaction.kind !== 'audit-curation' && transaction.kind !== 'projection-clock'
  ));
}

test('schema-v4 shards ingest and publish normalized payloads without CLI help output', async () => {
  const { root, shardDirectory, databasePath } = await fixture();
  try {
    const input = path.join(shardDirectory, 'gh-aw-logs-1000000000-aaaa.jsonl');
    const original = await readFile(input, 'utf8');
    const content = original.trim().split('\n').map((line) => {
      const envelope = JSON.parse(line);
      envelope.schema_version = 4;
      return JSON.stringify(envelope);
    }).join('\n') + '\n';
    await writeFile(input, content);
    const result = await ingest(shardDirectory, databasePath);
    assert.equal(result.result.updated, true);
    assert.ok(result.result.shards[0].committedRecords > 0);

    const runsDirectory = path.join(root, 'gh-aw-logs-runs');
    const recordsDirectory = path.join(root, 'gh-aw-logs-records');
    const { stdout, stderr } = await execFileAsync(process.execPath, [
      path.resolve('activity/cao.mjs'), 'hash-payloads',
      '--shard-dir', shardDirectory,
      '--runs-dir', runsDirectory,
      '--records-dir', recordsDirectory,
    ]);
    const hashes = JSON.parse(stdout);
    const published = await readPhasePayload(runsDirectory);
    assert.ok(published.batch.runs.some((run) => run.githubRunId === '303'));
    assert.ok(Object.keys(hashes).some((name) => name.startsWith('gh-aw-logs-runs/')));
    assert.doesNotMatch(stderr, /Usage:/);

    await writeFile(input, '{"schema_version":5,"kind":"run","run":{}}\n');
    await assert.rejects(
      execFileAsync(process.execPath, [
        path.resolve('activity/cao.mjs'), 'ingest-jsonl',
        '--database', databasePath, '--input', input,
      ]),
      (error) => {
        assert.equal(error.code, 1);
        assert.equal(error.stdout, '');
        assert.match(error.stderr, /Unsupported gh-aw JSONL schema version at line 1: 5/);
        assert.doesNotMatch(error.stderr, /Usage:/);
        return true;
      },
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

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

test('compact-jsonl deduplicates exact run records without reordering distinct observations', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'activity-compact-jsonl-'));
  const prefix = 'githubnext-gh-aw-cao-logs-';
  const firstPath = path.join(root, `${prefix}1000-aaaa.jsonl`);
  const secondPath = path.join(root, `${prefix}2000-bbbb.jsonl`);
  const unrelatedPath = path.join(root, 'github-gh-aw-logs-1000-cccc.jsonl');
  const overlappingPrefix = `${prefix}123-logs-`;
  const overlappingPrefixPath = path.join(root, `${overlappingPrefix}1000-dddd.jsonl`);
  const first = '{"schema_version":2,"kind":"run","run":{"run_id":1,"repository":"githubnext/gh-aw-cao","workflow_path":".github/workflows/first.lock.yml"}}';
  const second = '{"schema_version":2,"kind":"run","run":{"run_id":2,"repository":"githubnext/gh-aw-cao","workflow_path":".github/workflows/second.lock.yml"}}';
  const firstUpdated = '{"schema_version":2,"kind":"run","run":{"run_id":1,"repository":"githubnext/gh-aw-cao","workflow_path":".github/workflows/first.lock.yml","status":"completed"}}';
  const third = '{"schema_version":2,"kind":"run","run":{"run_id":3,"repository":"githubnext/gh-aw-cao-logs-123","workflow_path":".github/workflows/third.lock.yml"}}';
  const unrelated = '{"schema_version":2,"kind":"run","run":{"run_id":4,"repository":"github/gh-aw","workflow_path":".github/workflows/fourth.lock.yml"}}';
  await writeFile(firstPath, `${first}\n${second}\n`);
  await writeFile(secondPath, `${first}\n${firstUpdated}\n${third}\n`);
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
  assert.equal(compacted.sourceRecords, 5);
  assert.equal(compacted.retainedRecords, 4);
  assert.equal(compacted.deduplicatedRunRecords, 1);
  assert.equal(
    result.groups.find((group) => group.prefix === overlappingPrefix).sourceFiles,
    1,
  );

  const compactedName = path.basename(compacted.output);
  assert.deepEqual(
    (await readFile(path.join(root, compactedName), 'utf8')).trim().split('\n'),
    [first, second, firstUpdated, third],
  );
  assert.equal(await readFile(unrelatedPath, 'utf8'), `${unrelated}\n`);
  assert.equal(await readFile(overlappingPrefixPath, 'utf8'), `${third}\n`);
});

test('compact-jsonl bounds retained shards without reordering observations', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'activity-compact-jsonl-bounded-'));
  const prefix = 'githubnext-gh-aw-cao-logs-';
  const records = Array.from({ length: 6 }, (_, index) =>
    JSON.stringify({
      schema_version: 2,
      kind: 'run',
      run: {
        run_id: index + 1,
        repository: 'githubnext/gh-aw-cao',
        workflow_path: `.github/workflows/workflow-${index + 1}.lock.yml`,
      },
    })
  );
  await writeFile(path.join(root, `${prefix}1000-aaaa.jsonl`), `${records.slice(0, 3).join('\n')}\n`);
  await writeFile(path.join(root, `${prefix}2000-bbbb.jsonl`), `${records.slice(3).join('\n')}\n`);
  const maxBytes = Buffer.byteLength(`${records[0]}\n${records[1]}\n`);

  const { stdout } = await execFileAsync(process.execPath, [
    path.resolve('activity/cao.mjs'),
    'compact-jsonl',
    '--input-dir',
    root,
    '--group',
    `githubnext/gh-aw-cao=${prefix}`,
    '--max-bytes',
    String(maxBytes),
  ]);
  const [group] = JSON.parse(stdout).groups;
  const outputs = group.outputs.map((output) => path.basename(output));

  assert.equal(outputs.length, 3);
  assert.deepEqual(
    (await Promise.all(outputs.map((name) => readFile(path.join(root, name), 'utf8'))))
      .flatMap((content) => content.trim().split('\n')),
    records,
  );
  for (const name of outputs) {
    assert.ok((await stat(path.join(root, name))).size <= maxBytes);
  }
});

test('compact-jsonl retains only agentic workflow runs and their associated records', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'activity-compact-jsonl-agentic-'));
  const prefix = 'githubnext-gh-aw-cao-logs-';
  const records = [
    {
      schema_version: 2,
      kind: 'workflow_runs',
      request: { repository: 'githubnext/gh-aw-cao' },
      payload: [
        { databaseId: 1, workflowName: 'Agentic' },
        { databaseId: 2, workflowName: 'CI' },
      ],
    },
    {
      schema_version: 2,
      kind: 'run',
      run: {
        run_id: 1,
        repository: 'githubnext/gh-aw-cao',
        workflow_path: '.github/workflows/agentic.lock.yml',
      },
    },
    {
      schema_version: 2,
      kind: 'safe_output_item',
      safe_output: { run_id: 1, type: 'create_issue' },
    },
    {
      schema_version: 2,
      kind: 'run',
      run: {
        run_id: 2,
        repository: 'githubnext/gh-aw-cao',
        workflow_path: '.github/workflows/ci.yml',
      },
    },
    {
      schema_version: 2,
      kind: 'safe_output_item',
      safe_output: { run_id: 2, type: 'create_issue' },
    },
  ];
  await writeFile(
    path.join(root, `${prefix}1000-aaaa.jsonl`),
    `${records.map((record) => JSON.stringify(record)).join('\n')}\n`,
  );

  const { stdout } = await execFileAsync(process.execPath, [
    path.resolve('activity/cao.mjs'),
    'compact-jsonl',
    '--input-dir',
    root,
    '--group',
    `githubnext/gh-aw-cao=${prefix}`,
  ]);
  const [group] = JSON.parse(stdout).groups;
  const retained = (await readFile(group.output, 'utf8')).trim().split('\n').map(JSON.parse);

  assert.equal(group.sourceRecords, 5);
  assert.equal(group.retainedRecords, 3);
  assert.deepEqual(retained.map((record) => record.kind), [
    'workflow_runs',
    'run',
    'safe_output_item',
  ]);
  assert.deepEqual(retained[0].payload.map((run) => run.databaseId), [1]);
  assert.equal(retained[1].run.workflow_path, '.github/workflows/agentic.lock.yml');
  assert.equal(retained[2].safe_output.run_id, 1);
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

  assert.deepEqual(
    [...new Set(result.shards.map((shard) => shard.phase))],
    ['runs', 'records'],
  );
  const transactions = await queryTransactions(databasePath);
  const runShards = await readShardNames(runsDirectory);
  const recordShards = await readShardNames(recordsDirectory);
  assert.deepEqual(
    transactions.map((transaction) => transaction.payloadScope).sort(),
    [
      ...recordShards.map((name) => `gh-aw-records:${name}`),
      ...runShards.map((name) => `gh-aw-runs:${name}`),
    ].sort(),
  );

  // Skip receipts key on payload content, so renaming a shard must not re-ingest it.
  for (const name of runShards) {
    await rename(path.join(runsDirectory, name), path.join(runsDirectory, `renamed-${name}`));
  }
  for (const name of recordShards) {
    await rename(path.join(recordsDirectory, name), path.join(recordsDirectory, `renamed-${name}`));
  }
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
  const shardCount = runShards.length + recordShards.length;
  assert.equal(repeated.updated, false);
  assert.deepEqual(repeated.shards.map(({ skipped }) => skipped), new Array(shardCount).fill(true));
  assert.equal((await queryTransactions(databasePath)).length, shardCount);
});

test('hash-payloads deduplicates records observed by more than one source shard', async () => {
  const { root, shardDirectory } = await fixture();
  const sourceName = (await readdir(shardDirectory))[0];
  const sourcePath = path.join(shardDirectory, sourceName);
  const runsDirectory = path.join(root, 'gh-aw-logs-runs');
  const recordsDirectory = path.join(root, 'gh-aw-logs-records');
  const hashPayloads = async () => JSON.parse((await execFileAsync(process.execPath, [
    path.resolve('activity/cao.mjs'),
    'hash-payloads',
    '--shard-dir',
    shardDirectory,
    '--runs-dir',
    runsDirectory,
    '--records-dir',
    recordsDirectory,
  ])).stdout);
  const phaseHashes = (hashes) => Object.fromEntries(Object.entries(hashes)
    .filter(([name]) => name.startsWith('gh-aw-logs-runs/') || name.startsWith('gh-aw-logs-records/')));

  const before = phaseHashes(await hashPayloads());
  // A second source shard repeating the same runs must not publish a second copy,
  // and must leave every published shard byte-identical so the browser skips it.
  await cp(sourcePath, path.join(shardDirectory, 'gh-aw-logs-2000000000-bbbb.jsonl'));
  const after = phaseHashes(await hashPayloads());

  assert.deepEqual(after, before);
  assert.ok(Object.keys(before).length > 0);
});

test('hash-payloads publishes consolidated shards in deterministic ingestion order', async () => {
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

  const hashes = JSON.parse(stdout);
  const runs = await readPhasePayload(runsDirectory);
  const records = await readPhasePayload(recordsDirectory);
  // Structural records are owned by discovery and must sort ahead of day buckets.
  assert.match(runs.names[0], /^0000-00-00-/);
  assert.deepEqual(runs.names, [...runs.names].sort());
  assert.deepEqual(records.names, [...records.names].sort());
  for (const name of runs.names) assert.ok(hashes[`gh-aw-logs-runs/${name}`]);
  for (const name of records.names) assert.ok(hashes[`gh-aw-logs-records/${name}`]);
  assert.deepEqual(
    Object.keys(hashes).filter((name) => name.startsWith('gh-aw-logs-shards/')),
    [],
  );
  assert.ok((await readdir(shardDirectory)).some((name) => name.endsWith('.jsonl')));
  // The later source shard observed the run last, so its status wins.
  assert.deepEqual([...new Set(runs.batch.runs.map((run) => run.status))], ['completed']);
  assert.equal(runs.batch.runs.length, new Set(runs.batch.runs.map((run) => run.id)).size);
});

test('bounded publication preserves ordering evidence and skips byte-identical generations', async (t) => {
  const { root, shardDirectory, databasePath } = await fixture();
  t.after(() => rm(root, { recursive: true, force: true }));
  const sourcePath = path.join(shardDirectory, 'gh-aw-logs-1000000000-aaaa.jsonl');
  const [raw, enriched] = (await readFile(sourcePath, 'utf8')).trim().split('\n').map(JSON.parse);
  const rawRuns = Array.from({ length: 32 }, (_, index) => ({
    ...raw.payload[0], databaseId: 1000 + index
  }));
  const enrichedRuns = rawRuns.map((run) => ({
    ...enriched, run: { ...enriched.run, run_id: run.databaseId }
  }));
  const publishSource = async (reverse) => {
    await writeFile(sourcePath, [
      { ...raw, payload: reverse ? [...rawRuns].reverse() : rawRuns },
      ...(reverse ? [...enrichedRuns].reverse() : enrichedRuns)
    ].map((record) => JSON.stringify(record)).join('\n') + '\n');
  };
  const runsDirectory = path.join(root, 'gh-aw-logs-runs');
  const recordsDirectory = path.join(root, 'gh-aw-logs-records');
  const publish = async () => {
    const { stdout } = await execFileAsync(process.execPath, [
      path.resolve('activity/cao.mjs'), 'hash-payloads', '--shard-dir', shardDirectory,
      '--runs-dir', runsDirectory, '--records-dir', recordsDirectory, '--max-bytes', '2048'
    ]);
    return Object.fromEntries(Object.entries(JSON.parse(stdout))
      .filter(([name]) => /^gh-aw-logs-(runs|records)\//.test(name)));
  };
  const ingestPhases = async () => JSON.parse((await execFileAsync(process.execPath, [
    path.resolve('activity/cao.mjs'), 'ingest-jsonl', '--database', databasePath,
    '--runs-dir', runsDirectory, '--records-dir', recordsDirectory,
    '--retention-days', 'all', '--run-retention-days', 'all'
  ])).stdout);

  await publishSource(false);
  const before = await publish();
  const first = await ingestPhases();
  assert.equal(first.counts.runs, 32);
  assert.ok(Object.keys(before).length > 2);
  for (const name of Object.keys(before)) {
    const payload = await readNormalizedJsonl(path.join(root, name));
    assert.ok((await stat(path.join(root, name))).size <= 2048 || payload.records === 1, name);
  }
  await publishSource(true);
  const reordered = await publish();
  assert.notDeepEqual(reordered, before, 'changed source ordering must retain its new attribution');
  const repeated = await ingestPhases();
  assert.deepEqual(repeated.counts, first.counts);
  assert.deepEqual(await publish(), reordered);
  const identical = await ingestPhases();
  assert.equal(identical.result.updated, false);
  assert.ok(identical.result.shards.every((shard) => shard.skipped));

  rawRuns[0].displayTitle = 'Updated dashboard';
  enrichedRuns[0].run.display_title = rawRuns[0].displayTitle;
  await publishSource(true);
  const changed = await publish();
  const unchanged = Object.keys(changed).filter((name) => changed[name] === reordered[name]);
  assert.equal(unchanged.length, Object.keys(reordered).length - 2);
  const refreshed = await ingestPhases();
  assert.equal(refreshed.counts.runs, 32);
  assert.equal(refreshed.result.shards.filter((shard) => !shard.skipped).length, 2);
  const published = await readPhasePayload(runsDirectory);
  assert.equal(published.batch.runs.find((run) => run.githubRunId === '1000').title, 'Updated dashboard');
});

test('hash-payloads rejects invalid shard byte limits explicitly', async () => {
  for (const value of ['0', '-1', '1.5', 'NaN', 'Infinity', '9007199254740992']) {
    await assert.rejects(
      execFileAsync(process.execPath, [path.resolve('activity/cao.mjs'), 'hash-payloads', '--max-bytes', value]),
      (error) => error.stderr.includes('--max-bytes must be a positive integer')
    );
  }
});

test('1 MiB shards reduce the canonical records rewritten for a single-run refresh', async (t) => {
  const { root, shardDirectory } = await fixture();
  t.after(() => rm(root, { recursive: true, force: true }));
  const sourcePath = path.join(shardDirectory, 'gh-aw-logs-1000000000-aaaa.jsonl');
  const [raw, enriched] = (await readFile(sourcePath, 'utf8')).trim().split('\n').map(JSON.parse);
  const rawRuns = Array.from({ length: 600 }, (_, index) => ({
    ...raw.payload[0], databaseId: 1000 + index, displayTitle: 'x'.repeat(8192)
  }));
  const enrichedRuns = rawRuns.map((run) => ({
    ...enriched, run: { ...enriched.run, run_id: run.databaseId, display_title: run.displayTitle }
  }));
  const writeSource = () => writeFile(sourcePath, [
    { ...raw, payload: rawRuns }, ...enrichedRuns
  ].map((record) => JSON.stringify(record)).join('\n') + '\n');
  const variants = [1, 4].map((mebibytes) => ({
    maxBytes: mebibytes * 1024 * 1024,
    runsDirectory: path.join(root, `runs-${mebibytes}`),
    recordsDirectory: path.join(root, `records-${mebibytes}`),
    database: path.join(root, `activity-${mebibytes}.sqlite`)
  }));
  const publishAndIngest = async (variant) => {
    await execFileAsync(process.execPath, [
      path.resolve('activity/cao.mjs'), 'hash-payloads', '--shard-dir', shardDirectory,
      '--runs-dir', variant.runsDirectory, '--records-dir', variant.recordsDirectory,
      '--max-bytes', String(variant.maxBytes)
    ]);
    return JSON.parse((await execFileAsync(process.execPath, [
      path.resolve('activity/cao.mjs'), 'ingest-jsonl', '--database', variant.database,
      '--runs-dir', variant.runsDirectory, '--records-dir', variant.recordsDirectory,
      '--retention-days', 'all', '--run-retention-days', 'all'
    ])).stdout);
  };

  await writeSource();
  for (const variant of variants) assert.equal((await publishAndIngest(variant)).counts.runs, 600);
  rawRuns[0].displayTitle = 'y'.repeat(8192);
  enrichedRuns[0].run.display_title = rawRuns[0].displayTitle;
  await writeSource();
  const [smaller, larger] = await Promise.all(variants.map(publishAndIngest));

  assert.equal(smaller.result.shards.filter((shard) => !shard.skipped).length, 2);
  assert.equal(larger.result.shards.filter((shard) => !shard.skipped).length, 2);
  assert.ok(smaller.result.committedRecords <= larger.result.committedRecords / 3,
    `${smaller.result.committedRecords} rewritten records versus ${larger.result.committedRecords}`);
  assert.deepEqual(smaller.counts, larger.counts);
});

test('publication retains usage evidence when the winning Run has null AIC', async () => {
  const { root, shardDirectory } = await fixture();
  const sourcePath = path.join(shardDirectory, 'gh-aw-logs-1000000000-aaaa.jsonl');
  const source = (await readFile(sourcePath, 'utf8')).trim().split('\n');
  await writeFile(path.join(shardDirectory, 'gh-aw-logs-2000000000-bbbb.jsonl'), `${source[0]}\n`);
  const runsDirectory = path.join(root, 'gh-aw-logs-runs');
  const recordsDirectory = path.join(root, 'gh-aw-logs-records');
  await execFileAsync(process.execPath, [
    path.resolve('activity/cao.mjs'), 'hash-payloads', '--shard-dir', shardDirectory,
    '--runs-dir', runsDirectory, '--records-dir', recordsDirectory
  ]);
  const runs = await readPhasePayload(runsDirectory);
  const records = await readPhasePayload(recordsDirectory);
  assert.equal(runs.batch.runs[0].aicTotal, null);
  assert.deepEqual(records.batch.audits.filter((audit) => audit.type === 'workflow_run_usage')
    .map((audit) => audit.summary), ['AIC 2.5']);
});

test('unchanged source shards do not perform existing-row Audit cleanup', async () => {
  const { shardDirectory, databasePath } = await fixture();
  await ingest(shardDirectory, databasePath);
  const database = new DatabaseSync(databasePath);
  const run = JSON.parse(database.prepare("SELECT value FROM __idb_records WHERE store_name='runs' LIMIT 1").get().value);
  const { database_name: databaseName } = database.prepare("SELECT database_name FROM __idb_records WHERE store_name='runs' LIMIT 1").get();
  const audit = {
    id: 'audit:legacy-marker', runId: run.id, source: 'gh-aw-logs',
    type: 'workflow_run_working_set', status: 'observed', summary: 'Working set measured',
    timestamp: run.completedAt, observedAt: run.completedAt
  };
  database.prepare('INSERT INTO __idb_records (database_name,store_name,record_key,value) VALUES (?,?,?,?)')
    .run(databaseName, 'audits', JSON.stringify(audit.id), JSON.stringify(audit));
  database.prepare("DELETE FROM __idb_records WHERE store_name='transactions' AND json_extract(value,'$.kind')='audit-curation'").run();
  database.close();
  const repeated = await ingest(shardDirectory, databasePath);
  assert.equal(repeated.result.updated, false);
  assert.equal(repeated.result.committedRecords, 0);
  assert.ok(repeated.result.shards.every((shard) => shard.skipped));
  const cleaned = new DatabaseSync(databasePath, { readOnly: true });
  assert.equal(cleaned.prepare("SELECT count(*) AS count FROM __idb_records WHERE store_name='audits' AND json_extract(value,'$.id')=?")
    .get(audit.id).count, 1);
  cleaned.close();
  assert.equal((await ingest(shardDirectory, databasePath)).result.updated, false);
});

test('hash-payloads preserves independent info-level findings in record shards', async () => {
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

  const [recordShard] = await readShardNames(recordsDirectory);
  const payload = await readNormalizedJsonl(path.join(recordsDirectory, recordShard));
  const findings = payload.batch.audits.filter((audit) => audit.type === 'audit.finding');
  assert.deepEqual(findings.map((audit) => audit.summary).sort(), ['Actionable finding', 'Informational finding']);
});

test('hash-payloads drops empty source payloads and publishes one header-only shard per empty phase', async () => {
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
  for (const [phase, directory] of [['runs', runsDirectory], ['records', recordsDirectory]]) {
    const names = await readShardNames(directory);
    assert.equal(names.length, 1);
    const lines = (await readFile(path.join(directory, names[0]), 'utf8')).trim().split('\n').map((line) => JSON.parse(line));
    assert.deepEqual(lines.map(({ kind, phase: linePhase, records }) => [kind, linePhase, records]), [['metadata', phase, 0]]);
    assert.deepEqual(Object.keys(hashes).filter((name) => name.startsWith(`gh-aw-logs-${phase}/`)), [`gh-aw-logs-${phase}/${names[0]}`]);
  }
  assert.deepEqual(await readdir(path.join(runsDirectory, '.payloads')), []);
  assert.equal(Object.hasOwn(hashes, 'gh-aw-logs-shards/empty.jsonl'), false);
  assert.equal(await readFile(emptySourcePath, 'utf8'), '');
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

  const runs = await readPhasePayload(runsDirectory);
  const records = await readPhasePayload(recordsDirectory);
  const normalized = await readShardNames(legacyNormalizedDirectory);
  assert.ok(runs.names.length > 0);
  assert.ok(records.names.length > 0);
  assert.ok(normalized.length > 0);
  assert.ok([...runs.names, ...records.names, ...normalized].every((name) => name.endsWith('.jsonl')));
  assert.ok(normalized.every((name) => !name.endsWith('.json')));
  const normalizedPayload = await readNormalizedJsonl(path.join(legacyNormalizedDirectory, normalized[0]));
  assert.ok(runs.payloads.every((payload) => payload.phase === 'runs'));
  assert.ok(records.payloads.every((payload) => payload.phase === 'records'));
  assert.ok(runs.batch.runs.length > 0);
  assert.ok(records.batch.audits.every((audit) => audit.type !== 'workflow_run_usage'
    && audit.type !== 'workflow_run_safe_outputs'));
  for (const payload of [normalizedPayload, ...runs.payloads, ...records.payloads]) {
    assert.equal(Object.hasOwn(payload.batch, 'jobs'), false);
    assert.equal(Object.hasOwn(payload.batch, 'sessions'), false);
    assert.equal(Object.hasOwn(payload.batch, 'skills'), true);
    assert.equal(Object.hasOwn(payload.batch, 'friction'), true);
  }
});
