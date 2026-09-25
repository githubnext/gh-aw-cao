import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import test from 'node:test';

const execFileAsync = promisify(execFile);
const cao = path.resolve('activity/cao.mjs');

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'cao-issue-status-'));
  const shardDirectory = path.join(root, 'shards');
  const databasePath = path.join(root, 'activity.sqlite');
  const bin = path.join(root, 'bin');
  const callsPath = path.join(root, 'graphql-calls.jsonl');
  await mkdir(shardDirectory);
  await mkdir(bin);
  const envelopes = [
    {
      schema_version: 2,
      kind: 'run',
      run: {
        run_id: 303,
        run_attempt: 1,
        organization: 'githubnext',
        repository: 'githubnext/gh-aw-cao',
        workflow_name: 'Dashboard',
        workflow_path: '.github/workflows/dashboard.lock.yml',
        status: 'completed',
        conclusion: 'success',
        created_at: '2026-09-09T03:59:00Z',
        started_at: '2026-09-09T04:00:00Z',
        updated_at: '2026-09-09T04:01:00Z'
      }
    },
    {
      schema_version: 2,
      kind: 'safe_output_item',
      safe_output: {
        run_id: 303,
        timestamp: '2026-09-09T04:00:30Z',
        type: 'create_issue',
        provider: 'github',
        url: 'https://github.com/githubnext/gh-aw-cao/issues/42'
      }
    },
    {
      schema_version: 2,
      kind: 'safe_output_item',
      safe_output: {
        run_id: 303,
        timestamp: '2026-09-09T04:00:31Z',
        type: 'create_issue',
        provider: 'github',
        url: 'https://github.com/githubnext/gh-aw-cao/issues/43'
      }
    }
  ];
  const shardPath = path.join(shardDirectory, 'logs-fixture.jsonl');
  await writeFile(shardPath, `${envelopes.map((record) => JSON.stringify(record)).join('\n')}\n`);
  await execFileAsync(process.execPath, [
    cao,
    'ingest-jsonl',
    '--database',
    databasePath,
    '--input-dir',
    shardDirectory
  ]);
  const ghPath = path.join(bin, 'gh');
  await writeFile(ghPath, `#!/usr/bin/env node
const fs = require('node:fs');
const args = process.argv.slice(2);
const queryArgument = args.find((argument) => argument.startsWith('query=')) || '';
fs.appendFileSync(process.env.GRAPHQL_CALLS_PATH, JSON.stringify(args) + '\\n');
if (queryArgument.includes('repository(')) {
  const number = queryArgument.includes('issue(number: 43)') ? 43 : 42;
  process.stdout.write(JSON.stringify({ data: {
    repository: { i0: {
      number,
      state: 'CLOSED',
      stateReason: 'COMPLETED',
      closedAt: '2026-09-20T12:00:00Z',
      url: 'https://github.com/githubnext/gh-aw-cao/issues/' + number
    } },
    rateLimit: { cost: 1, remaining: 998, resetAt: '2026-09-20T13:00:00Z' }
  } }));
} else {
  process.stdout.write(JSON.stringify({ data: {
    rateLimit: { cost: 1, remaining: 999, resetAt: '2026-09-20T13:00:00Z' }
  } }));
}
`);
  await chmod(ghPath, 0o755);
  return { root, shardDirectory, shardPath, databasePath, bin, callsPath };
}

test('issue-status enriches issues through one-item GraphQL batches within a small budget', async () => {
  const item = await fixture();
  try {
    const env = {
      ...process.env,
      PATH: `${item.bin}:${process.env.PATH}`,
      GRAPHQL_CALLS_PATH: item.callsPath
    };
    const { stdout } = await execFileAsync(process.execPath, [
      cao,
      'issue-status',
      '--database',
      item.databasePath,
      '--input-dir',
      item.shardDirectory,
      '--batch-size',
      '1',
      '--graphql-cost-budget',
      '3',
      '--graphql-min-remaining',
      '500'
    ], { env });
    const result = JSON.parse(stdout);
    assert.equal(result.issues, 2);
    assert.equal(result.queried, 2);
    assert.equal(result.statuses, 2);
    assert.equal(result.updatedRecords, 2);
    assert.equal(result.rateLimit.cost, 3);

    const records = (await readFile(item.shardPath, 'utf8')).trim().split('\n').map(JSON.parse);
    for (const record of records.slice(1)) {
      assert.deepEqual(record.safe_output.github_issue_status, {
        state: 'CLOSED',
        closed: true,
        state_reason: 'COMPLETED',
        closed_at: '2026-09-20T12:00:00Z',
        observed_at: record.safe_output.github_issue_status.observed_at
      });
      assert.ok(Number.isFinite(Date.parse(record.safe_output.github_issue_status.observed_at)));
    }

    await execFileAsync(process.execPath, [
      cao,
      'ingest-jsonl',
      '--database',
      item.databasePath,
      '--input-dir',
      item.shardDirectory
    ]);
    const query = await execFileAsync(process.execPath, [
      cao,
      'query',
      '--database',
      item.databasePath,
      '--collection',
      'issues'
    ]);
    assert.deepEqual(JSON.parse(query.stdout).map((issue) => ({
      closed: issue.closed,
      state: issue.state,
      stateReason: issue.stateReason,
      closedAt: issue.closedAt
    })), [42, 43].map(() => ({
      closed: true,
      state: 'CLOSED',
      stateReason: 'COMPLETED',
      closedAt: '2026-09-20T12:00:00Z'
    })));

    const calls = (await readFile(item.callsPath, 'utf8')).trim().split('\n').map(JSON.parse);
    assert.equal(calls.length, 3);
    assert.ok(calls.every((arguments_) => arguments_.slice(0, 2).join(' ') === 'api graphql'));
    assert.match(calls[1].find((argument) => argument.startsWith('query=')), /issue\(number: 42\)/);
    assert.match(calls[2].find((argument) => argument.startsWith('query=')), /issue\(number: 43\)/);
  } finally {
    await rm(item.root, { recursive: true, force: true });
  }
});

test('issue-status does not query issues beyond its GraphQL point budget', async () => {
  const item = await fixture();
  try {
    const env = {
      ...process.env,
      PATH: `${item.bin}:${process.env.PATH}`,
      GRAPHQL_CALLS_PATH: item.callsPath
    };
    const { stdout } = await execFileAsync(process.execPath, [
      cao,
      'issue-status',
      '--database',
      item.databasePath,
      '--input-dir',
      item.shardDirectory,
      '--graphql-cost-budget',
      '1'
    ], { env });
    const result = JSON.parse(stdout);
    assert.equal(result.queried, 0);
    assert.equal(result.updatedRecords, 0);
    assert.equal(result.stopped, 'cost-budget');
    const calls = (await readFile(item.callsPath, 'utf8')).trim().split('\n').map(JSON.parse);
    assert.equal(calls.length, 1);
  } finally {
    await rm(item.root, { recursive: true, force: true });
  }
});

test('activity collection enriches issue status before dashboard shard ingestion', async () => {
  const item = await fixture();
  const runsDirectory = path.join(item.root, 'runs');
  const recordsDirectory = path.join(item.root, 'records');
  try {
    await rm(item.shardPath);
    await rm(item.databasePath);
    const ghPath = path.join(item.bin, 'gh');
    await writeFile(ghPath, `#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const args = process.argv.slice(2);
fs.appendFileSync(process.env.GRAPHQL_CALLS_PATH, JSON.stringify(args) + '\\n');
if (args[0] === 'aw' && args[1] === 'logs') {
  const shardPattern = args[args.indexOf('--cached-jsonl') + 1];
  const shardPath = shardPattern.replace(/\\*$/, '') + 'fixture.jsonl';
  fs.mkdirSync(path.dirname(shardPath), { recursive: true });
  fs.writeFileSync(shardPath, [
    ${JSON.stringify(JSON.stringify({
      schema_version: 2,
      kind: 'run',
      run: {
        run_id: 303,
        run_attempt: 1,
        organization: 'githubnext',
        repository: 'githubnext/gh-aw-cao',
        workflow_name: 'Dashboard',
        workflow_path: '.github/workflows/dashboard.lock.yml',
        status: 'completed',
        conclusion: 'success',
        created_at: '2026-09-09T03:59:00Z',
        started_at: '2026-09-09T04:00:00Z',
        updated_at: '2026-09-09T04:01:00Z'
      }
    }))},
    ${JSON.stringify(JSON.stringify({
      schema_version: 2,
      kind: 'safe_output_item',
      safe_output: {
        run_id: 303,
        timestamp: '2026-09-09T04:00:30Z',
        type: 'create_issue',
        provider: 'github',
        url: 'https://github.com/githubnext/gh-aw-cao/issues/42'
      }
    }))}
  ].join('\\n') + '\\n');
  process.exit(0);
}
if (args[0] === 'api' && args[1] === 'graphql') {
  const query = args.find((argument) => argument.startsWith('query=')) || '';
  if (query.includes('issue(number: 42)')) {
    process.stdout.write(JSON.stringify({ data: {
      // issue-status aliases the first batch item as i0.
      repository: { i0: {
        number: 42,
        state: 'CLOSED',
        stateReason: 'COMPLETED',
        closedAt: '2026-09-20T12:00:00Z',
        url: 'https://github.com/githubnext/gh-aw-cao/issues/42'
      } },
      rateLimit: { cost: 1, remaining: 998, resetAt: '2026-09-20T13:00:00Z' }
    } }));
  } else {
    process.stdout.write(JSON.stringify({ data: {
      rateLimit: { cost: 1, remaining: 999, resetAt: '2026-09-20T13:00:00Z' }
    } }));
  }
  process.exit(0);
}
process.exit(1);
`);
    await chmod(ghPath, 0o755);
    const env = {
      ...process.env,
      PATH: `${item.bin}:${process.env.PATH}`,
      GITHUB_REPOSITORY: 'githubnext/gh-aw-cao',
      REPORT_AIC_CACHE: path.join(item.root, 'logs'),
      REPORT_ACTIVITY_DATABASE: item.databasePath,
      REPORT_GH_AW_LOGS_EXIT_CODE: path.join(item.root, 'collection-exit-code'),
      REPORT_GH_AW_LOGS_SHARDS: item.shardDirectory,
      GRAPHQL_CALLS_PATH: item.callsPath
    };
    await execFileAsync('bash', [path.resolve('activity/collect-logs.sh')], { env });

    await execFileAsync(process.execPath, [
      cao,
      'hash-payloads',
      '--shard-dir',
      item.shardDirectory,
      '--runs-dir',
      runsDirectory,
      '--records-dir',
      recordsDirectory
    ]);
    await execFileAsync(process.execPath, [
      cao,
      'ingest-jsonl',
      '--database',
      item.databasePath,
      '--runs-dir',
      runsDirectory,
      '--records-dir',
      recordsDirectory
    ]);
    const query = await execFileAsync(process.execPath, [
      cao,
      'query',
      '--database',
      item.databasePath,
      '--collection',
      'issues'
    ]);
    assert.deepEqual(JSON.parse(query.stdout).map((issue) => ({
      state: issue.state,
      closed: issue.closed,
      stateReason: issue.stateReason,
      closedAt: issue.closedAt
    })), [{
      state: 'CLOSED',
      closed: true,
      stateReason: 'COMPLETED',
      closedAt: '2026-09-20T12:00:00Z'
    }]);
    const calls = (await readFile(item.callsPath, 'utf8')).trim().split('\n').map(JSON.parse);
    const graphqlCalls = calls.filter((arguments_) => arguments_.slice(0, 2).join(' ') === 'api graphql');
    // issue-status first checks the rate limit, then queries the one collected issue.
    assert.equal(graphqlCalls.length, 2);
    const issueQuery = graphqlCalls.find((arguments_) => arguments_.some((argument) => argument.includes('issue(number: 42)')));
    assert.ok(issueQuery);
    assert.ok(issueQuery.some((argument) => argument.includes('owner=githubnext')));
    assert.ok(issueQuery.some((argument) => argument.includes('name=gh-aw-cao')));
  } finally {
    await rm(item.root, { recursive: true, force: true });
  }
});
