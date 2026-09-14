import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFile, readdir, lstat, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

const CAO_PACKAGE = 'githubnext/gh-aw-cao';
const executeFile = promisify(execFile);

function issue(code, message, details = {}) {
  return { code, message, ...details };
}

function safeDestination(root, destination) {
  if (typeof destination !== 'string' || !destination || path.isAbsolute(destination)) return null;
  const resolved = path.resolve(root, destination);
  return resolved === root || resolved.startsWith(`${root}${path.sep}`) ? resolved : null;
}

async function typecheckModules(root, modules) {
  if (modules.length === 0) return [];
  const directory = await mkdtemp(path.join(os.tmpdir(), 'cao-doctor-'));
  const declarations = path.join(directory, 'globals.d.ts');
  try {
    await writeFile(declarations, "declare module '*';\ndeclare const process: any;\n");
    await executeFile('tsc', [
      '--allowJs',
      '--checkJs',
      '--noEmit',
      '--noResolve',
      '--target', 'ES2023',
      '--module', 'NodeNext',
      '--moduleResolution', 'NodeNext',
      '--skipLibCheck',
      '--noImplicitAny', 'false',
      declarations,
      ...modules
    ], { cwd: root, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
    return [];
  } catch (error) {
    const output = error && typeof error === 'object' && 'stdout' in error
      ? String(error.stdout).trim()
      : '';
    return [issue(
      'typescript-typecheck-failed',
      output || `TypeScript typecheck could not run: ${error instanceof Error ? error.message : String(error)}`,
      { files: modules.map((module) => path.relative(root, module).split(path.sep).join('/')) }
    )];
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
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
  const modules = [];
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
        if (normalized.endsWith('.mjs')) modules.push(absolutePath);
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
  issues.push(...await typecheckModules(root, modules));

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
    files: { checked: destinations.size, modulesTypechecked: modules.length },
    issues
  };
}
