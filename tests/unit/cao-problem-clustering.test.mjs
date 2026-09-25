import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { runProblemClustering } from '../../activity/problem-clustering.mjs';

test('package clustering scripts replace only their validated problem rows', async () => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), 'cao-problem-clustering-'));
  const databasePath = path.join(temporary, 'activity.sqlite');
  const packageRoot = path.join(temporary, 'packages');
  const alpha = path.join(packageRoot, 'alpha');
  const failing = path.join(packageRoot, 'failing');
  const timestamp = '2026-09-24T23:05:09.441Z';
  try {
    await mkdir(alpha, { recursive: true });
    await mkdir(failing, { recursive: true });
    new DatabaseSync(databasePath).close();
    await writeFile(path.join(alpha, 'problem-clustering.mjs'), `
      import { readFileSync } from 'node:fs';
      const request = JSON.parse(readFileSync(0, 'utf8'));
      if (request.database !== process.env.CAO_DATABASE) process.exit(2);
      console.log(JSON.stringify({
        id: 'stale-workflow',
        title: 'Workflow has stale evidence',
        severity: 'high',
        repository: 'githubnext/gh-aw-cao',
        workflow: 'example',
        fixPrompt: 'Update the workflow evidence and verify the next run is current.',
        evidence: { source: 'test' }
      }));
      console.log(JSON.stringify({
        id: 'missing-owner',
        title: 'Workflow has no owner',
        severity: 'medium',
        fixPrompt: 'Assign an owner to the workflow and document the ownership boundary.'
      }));
    `);
    await writeFile(path.join(failing, 'problem-clustering.mjs'), 'process.exit(1);\n');

    const first = await runProblemClustering({
      databasePath,
      root: packageRoot,
      timestamp
    });
    assert.deepEqual(first.scripts, ['alpha', 'failing']);
    assert.deepEqual(first.problems.map((problem) => problem.id), [
      'stale-workflow',
      'missing-owner'
    ]);
    assert.deepEqual(first.warnings.map((warning) => warning.package), ['failing']);

    let database = new DatabaseSync(databasePath);
    try {
      const rows = database.prepare('SELECT * FROM cao_problems ORDER BY rowid').all();
      assert.equal(rows.length, 2);
      const row = rows[0];
      assert.equal(row.producer, 'alpha');
      assert.equal(row.problem_id, 'stale-workflow');
      assert.equal(row.observed_at, timestamp);
      assert.equal(row.severity, 'high');
      assert.equal(row.fix_prompt, 'Update the workflow evidence and verify the next run is current.');
      assert.deepEqual(JSON.parse(row.evidence), { source: 'test' });
      assert.equal(rows[1].problem_id, 'missing-owner');
      assert.equal(rows[1].severity, 'medium');
      database.prepare(`
        INSERT INTO cao_problems (
          producer, problem_id, observed_at, severity, title, summary,
          campaign, repository, workflow, target_repository, evidence
        ) VALUES ('failing', 'retained', ?, 'low', 'Retained', '', 'failing', '', '', '', '{}')
      `).run(timestamp);
      database.prepare(`
        INSERT INTO cao_problems (
          producer, problem_id, observed_at, severity, title, summary,
          campaign, repository, workflow, target_repository, evidence
        ) VALUES ('removed-package', 'stale', ?, 'low', 'Stale', '', 'removed-package', '', '', '', '{}')
      `).run(timestamp);
    } finally {
      database.close();
    }

    await writeFile(path.join(alpha, 'problem-clustering.mjs'), '');
    await runProblemClustering({ databasePath, root: packageRoot, timestamp });
    database = new DatabaseSync(databasePath);
    try {
      assert.deepEqual(
        database.prepare('SELECT producer, problem_id FROM cao_problems ORDER BY producer').all()
          .map((row) => ({ ...row })),
        [{ producer: 'failing', problem_id: 'retained' }]
      );
    } finally {
      database.close();
    }
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});

test('invalid package output leaves existing rows intact', async () => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), 'cao-problem-clustering-invalid-'));
  const databasePath = path.join(temporary, 'activity.sqlite');
  const packageRoot = path.join(temporary, 'packages');
  const packageDirectory = path.join(packageRoot, 'alpha');
  try {
    await mkdir(packageDirectory, { recursive: true });
    const database = new DatabaseSync(databasePath);
    database.exec(`
      CREATE TABLE cao_problems (
        producer TEXT NOT NULL,
        problem_id TEXT NOT NULL,
        observed_at TEXT NOT NULL,
        severity TEXT NOT NULL,
        title TEXT NOT NULL,
        summary TEXT NOT NULL,
        campaign TEXT NOT NULL,
        repository TEXT NOT NULL,
        workflow TEXT NOT NULL,
        target_repository TEXT NOT NULL,
        evidence TEXT NOT NULL,
        PRIMARY KEY (producer, problem_id)
      ) STRICT;
      INSERT INTO cao_problems VALUES (
        'alpha', 'existing', '2026-09-24T23:05:09.441Z', 'low',
        'Existing', '', 'alpha', '', '', '', '{}'
      );
    `);
    database.close();
    await writeFile(path.join(packageDirectory, 'problem-clustering.mjs'), `
      console.log(JSON.stringify({ id: 'missing-fix', title: 'Missing fix prompt' }));
    `);

    const result = await runProblemClustering({
      databasePath,
      root: packageRoot,
      timestamp: '2026-09-24T23:05:09.441Z'
    });
    assert.equal(result.warnings.length, 1);
    assert.match(result.warnings[0].message, /\.fixPrompt is required/);
    const verify = new DatabaseSync(databasePath);
    try {
      assert.deepEqual(
        verify.prepare('SELECT producer, problem_id, fix_prompt FROM cao_problems').all()
          .map((row) => ({ ...row })),
        [{ producer: 'alpha', problem_id: 'existing', fix_prompt: '' }]
      );
    } finally {
      verify.close();
    }
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});

test('timed-out workers retain their rows and do not block other packages', async () => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), 'cao-problem-clustering-timeout-'));
  const databasePath = path.join(temporary, 'activity.sqlite');
  const packageRoot = path.join(temporary, 'packages');
  try {
    await mkdir(path.join(packageRoot, 'hanging'), { recursive: true });
    await mkdir(path.join(packageRoot, 'healthy'), { recursive: true });
    const database = new DatabaseSync(databasePath);
    database.exec(`
      CREATE TABLE cao_problems (
        producer TEXT NOT NULL, problem_id TEXT NOT NULL, observed_at TEXT NOT NULL,
        severity TEXT NOT NULL, title TEXT NOT NULL, summary TEXT NOT NULL,
        campaign TEXT NOT NULL, repository TEXT NOT NULL, workflow TEXT NOT NULL,
        target_repository TEXT NOT NULL, evidence TEXT NOT NULL,
        PRIMARY KEY (producer, problem_id)
      ) STRICT;
      INSERT INTO cao_problems VALUES (
        'hanging', 'retained', '2026-09-24T23:05:09.441Z', 'low',
        'Retained', '', 'hanging', '', '', '', '{}'
      );
    `);
    database.close();
    await writeFile(
      path.join(packageRoot, 'hanging', 'problem-clustering.mjs'),
      'setInterval(() => {}, 1_000);\n'
    );
    await writeFile(path.join(packageRoot, 'healthy', 'problem-clustering.mjs'), `
      console.log(JSON.stringify({
        id: 'fresh',
        title: 'Fresh problem',
        fixPrompt: 'Refresh the problem evidence.'
      }));
    `);

    const result = await runProblemClustering({
      databasePath,
      root: packageRoot,
      timestamp: '2026-09-24T23:05:09.441Z',
      workerTimeoutMs: 50
    });
    assert.match(result.warnings[0].message, /timed out after 50 ms/);
    const verify = new DatabaseSync(databasePath);
    try {
      assert.deepEqual(
        verify.prepare('SELECT producer, problem_id FROM cao_problems ORDER BY producer').all()
          .map((row) => ({ ...row })),
        [
          { producer: 'hanging', problem_id: 'retained' },
          { producer: 'healthy', problem_id: 'fresh' }
        ]
      );
    } finally {
      verify.close();
    }
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});

test('cancellation terminates the active worker and stops package processing', async () => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), 'cao-problem-clustering-cancel-'));
  const databasePath = path.join(temporary, 'activity.sqlite');
  const packageRoot = path.join(temporary, 'packages');
  const controller = new AbortController();
  try {
    await mkdir(path.join(packageRoot, 'a-healthy'), { recursive: true });
    await mkdir(path.join(packageRoot, 'b-hanging'), { recursive: true });
    await mkdir(path.join(packageRoot, 'z-unreached'), { recursive: true });
    new DatabaseSync(databasePath).close();
    await writeFile(path.join(packageRoot, 'a-healthy', 'problem-clustering.mjs'), `
      console.log(JSON.stringify({
        id: 'completed',
        title: 'Completed problem',
        fixPrompt: 'Complete the required remediation.'
      }));
    `);
    await writeFile(
      path.join(packageRoot, 'b-hanging', 'problem-clustering.mjs'),
      'setInterval(() => {}, 1_000);\n'
    );
    await writeFile(path.join(packageRoot, 'z-unreached', 'problem-clustering.mjs'), `
      console.log(JSON.stringify({
        id: 'unexpected',
        title: 'Unexpected problem',
        fixPrompt: 'Resolve the unexpected problem.'
      }));
    `);
    setTimeout(() => controller.abort(new Error('clustering cancelled')), 500).unref();

    await assert.rejects(
      runProblemClustering({
        databasePath,
        root: packageRoot,
        timestamp: '2026-09-24T23:05:09.441Z',
        signal: controller.signal
      }),
      /clustering cancelled/
    );
    const verify = new DatabaseSync(databasePath);
    try {
      assert.deepEqual(
        verify.prepare('SELECT producer, problem_id FROM cao_problems').all()
          .map((row) => ({ ...row })),
        [{ producer: 'a-healthy', problem_id: 'completed' }]
      );
    } finally {
      verify.close();
    }
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});

test('debug logging reports lifecycle metadata without problem evidence', async () => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), 'cao-problem-clustering-debug-'));
  const databasePath = path.join(temporary, 'activity.sqlite');
  const packageRoot = path.join(temporary, 'packages');
  const packageDirectory = path.join(packageRoot, 'alpha');
  const sensitiveEvidence = 'must-not-appear-in-debug-output';
  try {
    await mkdir(packageDirectory, { recursive: true });
    new DatabaseSync(databasePath).close();
    await writeFile(path.join(packageDirectory, 'problem-clustering.mjs'), `
      console.log(JSON.stringify({
        id: 'debug-problem',
        title: 'Debug problem',
        fixPrompt: 'Resolve the debug problem without exposing evidence.',
        evidence: { detail: '${sensitiveEvidence}' }
      }));
    `);
    const moduleUrl = new URL('../../activity/problem-clustering.mjs', import.meta.url).href;
    const execution = spawnSync(process.execPath, [
      '--input-type=module',
      '--eval',
      `import { runProblemClustering } from ${JSON.stringify(moduleUrl)};
       await runProblemClustering(${JSON.stringify({
         databasePath,
         root: packageRoot,
         timestamp: '2026-09-24T23:05:09.441Z'
       })});`
    ], {
      encoding: 'utf8',
      env: { ...process.env, NODE_DEBUG: 'cao:problem-clustering' }
    });

    assert.equal(execution.status, 0, execution.stderr);
    assert.match(execution.stderr, /clustering started/);
    assert.match(execution.stderr, /worker starting package=alpha/);
    assert.match(execution.stderr, /worker completed package=alpha/);
    assert.match(execution.stderr, /problems replaced package=alpha count=1/);
    assert.match(execution.stderr, /clustering completed scripts=1 problems=1 warnings=0/);
    assert.doesNotMatch(execution.stderr, new RegExp(sensitiveEvidence));
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});
