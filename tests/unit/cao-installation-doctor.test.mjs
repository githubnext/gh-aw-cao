import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { doctorCaoInstallation } from '../../activity/installation-doctor.mjs';

const requiredFiles = [
  '.github/aw/activity/cao.mjs',
  '.github/aw/default-AGENTS.md',
  '.github/workflows/cao-activity.yml',
  '.github/workflows/cao-dashboard.yml',
  '.github/workflows/shared/control.mjs',
  '.github/workflows/shared/policy.mjs',
  '.github/workflows/shared/setup-github-apps.mjs'
];

async function installationFixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'cao-installation-doctor-'));
  const files = [];
  for (const destination of requiredFiles) {
    const content = `installed ${destination}\n`;
    await mkdir(path.dirname(path.join(root, destination)), { recursive: true });
    await writeFile(path.join(root, destination), content);
    files.push({
      source: destination,
      destination,
      sha256: createHash('sha256').update(content).digest('hex')
    });
  }
  const recordPath = path.join(root, '.github', 'aw', 'packages', 'cao.json');
  await mkdir(path.dirname(recordPath), { recursive: true });
  await writeFile(recordPath, `${JSON.stringify({
    schemaVersion: 1,
    package: 'githubnext/gh-aw-cao',
    source: 'githubnext/gh-aw-cao@0123456789abcdef',
    resolvedCommit: '0123456789abcdef',
    installer: 'gh-aw test',
    files
  }, null, 2)}\n`);
  return { root, recordPath };
}

test('installation doctor verifies the CAO package inventory and hashes', async () => {
  const { root } = await installationFixture();
  try {
    const result = await doctorCaoInstallation(root);
    assert.equal(result.healthy, true);
    assert.equal(result.kind, 'installation');
    assert.deepEqual(result.files, { checked: requiredFiles.length, required: requiredFiles.length });
    assert.deepEqual(result.issues, []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('installation doctor reports modified and missing package files', async () => {
  const { root } = await installationFixture();
  try {
    await writeFile(path.join(root, requiredFiles[0]), 'modified\n');
    await rm(path.join(root, requiredFiles[1]));
    const result = await doctorCaoInstallation(root);
    assert.equal(result.healthy, false);
    assert.deepEqual(
      result.issues.map(({ code }) => code).sort(),
      ['package-file-hash-mismatch', 'package-file-missing']
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('installation doctor verifies every package record in the repository', async () => {
  const { root, recordPath } = await installationFixture();
  try {
    const destination = '.github/aw/other.txt';
    await writeFile(path.join(root, destination), 'modified\n');
    await writeFile(path.join(path.dirname(recordPath), 'other.json'), JSON.stringify({
      schemaVersion: 1,
      package: 'example/other',
      source: 'example/other@v1',
      installer: 'gh-aw test',
      files: [{
        source: 'other.txt',
        destination,
        sha256: createHash('sha256').update('original\n').digest('hex')
      }]
    }));

    const result = await doctorCaoInstallation(root);
    assert.equal(result.healthy, false);
    assert.equal(result.records.length, 2);
    assert.ok(result.issues.some(({ code, path: issuePath }) =>
      code === 'package-file-hash-mismatch' && issuePath === destination));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('installation doctor rejects malformed records and unsafe entries', async () => {
  const { root, recordPath } = await installationFixture();
  try {
    const record = JSON.parse(await readFile(recordPath, 'utf8'));
    record.files.push({
      source: 'escape',
      destination: '../escape',
      sha256: '0'.repeat(64)
    });
    await writeFile(recordPath, JSON.stringify(record));
    await writeFile(path.join(path.dirname(recordPath), 'broken.json'), '{');

    const result = await doctorCaoInstallation(root);
    assert.equal(result.healthy, false);
    assert.deepEqual(
      result.issues.map(({ code }) => code).sort(),
      ['invalid-file-record', 'invalid-package-record']
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('installation doctor requires a CAO ownership record and required inventory', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'cao-installation-doctor-empty-'));
  try {
    await mkdir(path.join(root, '.github', 'aw', 'packages'), { recursive: true });
    const result = await doctorCaoInstallation(root);
    assert.equal(result.healthy, false);
    assert.ok(result.issues.some(({ code }) => code === 'cao-package-record-missing'));
    assert.equal(result.issues.filter(({ code }) => code === 'required-file-untracked').length, requiredFiles.length);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
