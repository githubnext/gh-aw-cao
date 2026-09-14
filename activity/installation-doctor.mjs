import { createHash } from 'node:crypto';
import { readFile, readdir, lstat } from 'node:fs/promises';
import path from 'node:path';

const CAO_PACKAGE = 'githubnext/gh-aw-cao';
const REQUIRED_CAO_FILES = [
  '.github/aw/activity/cao.mjs',
  '.github/aw/default-AGENTS.md',
  '.github/workflows/cao-activity.yml',
  '.github/workflows/cao-dashboard.yml',
  '.github/workflows/shared/control.mjs',
  '.github/workflows/shared/policy.mjs',
  '.github/workflows/shared/setup-github-apps.mjs'
];

function issue(code, message, details = {}) {
  return { code, message, ...details };
}

function safeDestination(root, destination) {
  if (typeof destination !== 'string' || !destination || path.isAbsolute(destination)) return null;
  const resolved = path.resolve(root, destination);
  return resolved === root || resolved.startsWith(`${root}${path.sep}`) ? resolved : null;
}

export async function doctorCaoInstallation(directory) {
  const root = path.resolve(directory);
  const recordsDirectory = path.join(root, '.github', 'aw', 'packages');
  const issues = [];
  let recordNames;
  try {
    recordNames = (await readdir(recordsDirectory, { withFileTypes: true }))
      .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith('.json'))
      .map((entry) => entry.name)
      .sort();
  } catch (error) {
    issues.push(issue(
      'package-records-unavailable',
      `CAO package records are unavailable: ${error instanceof Error ? error.message : String(error)}`,
      { path: path.relative(root, recordsDirectory) }
    ));
    return { command: 'doctor', kind: 'installation', root, healthy: false, records: [], issues };
  }

  const records = [];
  let caoRecordCount = 0;
  for (const name of recordNames) {
    const recordPath = path.join(recordsDirectory, name);
    let record;
    try {
      record = JSON.parse(await readFile(recordPath, 'utf8'));
    } catch (error) {
      issues.push(issue(
        'invalid-package-record',
        `Package record ${name} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
        { path: path.relative(root, recordPath) }
      ));
      continue;
    }
    records.push({ name, record });
    if (record?.package === CAO_PACKAGE) caoRecordCount += 1;
  }

  if (caoRecordCount === 0) {
    issues.push(issue(
      'cao-package-record-missing',
      `No package ownership record was found for ${CAO_PACKAGE}`
    ));
  } else if (caoRecordCount > 1) {
    issues.push(issue(
      'duplicate-cao-package-record',
      `Multiple package ownership records were found for ${CAO_PACKAGE}`
    ));
  }

  const destinations = new Set();
  const caoDestinations = new Set();
  for (const { name, record } of records) {
    const recordPath = path.join('.github', 'aw', 'packages', name);
    if (record.schemaVersion !== 1 || typeof record.source !== 'string'
      || typeof record.installer !== 'string' || !Array.isArray(record.files) || record.files.length === 0) {
      issues.push(issue(
        'invalid-package-record',
        `Package record ${name} has an invalid or unsupported structure`,
        { path: recordPath }
      ));
      continue;
    }
    for (const file of record.files) {
      const destination = file?.destination;
      const absolutePath = safeDestination(root, destination);
      if (!absolutePath || typeof file?.source !== 'string'
        || typeof file?.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(file.sha256)) {
        issues.push(issue(
          'invalid-file-record',
          `Package record ${name} contains an invalid file entry`,
          { path: recordPath, destination: typeof destination === 'string' ? destination : null }
        ));
        continue;
      }
      const normalized = path.relative(root, absolutePath).split(path.sep).join('/');
      const comparisonKey = normalized.toLowerCase();
      if (destinations.has(comparisonKey)) {
        issues.push(issue(
          'duplicate-file-record',
          `Package file ${normalized} is listed more than once`,
          { path: normalized }
        ));
        continue;
      }
      destinations.add(comparisonKey);
      if (record.package === CAO_PACKAGE) caoDestinations.add(comparisonKey);
      try {
        const metadata = await lstat(absolutePath);
        if (!metadata.isFile() || metadata.isSymbolicLink()) {
          issues.push(issue(
            'invalid-package-file',
            `Package file ${normalized} is not a regular file`,
            { path: normalized }
          ));
          continue;
        }
        const actualHash = createHash('sha256').update(await readFile(absolutePath)).digest('hex');
        if (actualHash !== file.sha256) {
          issues.push(issue(
            'package-file-hash-mismatch',
            `Package file ${normalized} does not match its recorded SHA-256 hash`,
            { path: normalized, expected: file.sha256, actual: actualHash }
          ));
        }
      } catch (error) {
        issues.push(issue(
          'package-file-missing',
          `Package file ${normalized} is missing or unreadable: ${error instanceof Error ? error.message : String(error)}`,
          { path: normalized }
        ));
      }
    }
  }

  for (const required of REQUIRED_CAO_FILES) {
    if (!caoDestinations.has(required.toLowerCase())) {
      issues.push(issue(
        'required-file-untracked',
        `Required CAO file ${required} is not tracked by the package ownership record`,
        { path: required }
      ));
    }
  }

  return {
    command: 'doctor',
    kind: 'installation',
    root,
    healthy: issues.length === 0,
    records: records.map(({ name, record }) => ({
      path: path.join('.github', 'aw', 'packages', name),
      source: record.source,
      resolvedCommit: record.resolvedCommit ?? null,
      files: Array.isArray(record.files) ? record.files.length : 0
    })),
    files: { checked: destinations.size, required: REQUIRED_CAO_FILES.length },
    issues
  };
}
