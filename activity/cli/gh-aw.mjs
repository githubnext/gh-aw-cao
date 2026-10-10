import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { upgradeGhAwVersion } from '../upgrade-gh-aw.mjs';
import { DEFAULT_POLICY_PATH, readCaoPolicy } from './policy.mjs';
import { UsageError } from './options.mjs';
import { commandFailureMessage, writeJsonAtomically } from './files.mjs';

const GH_AW_INSTALLER_COMMAND = 'curl --fail --silent --show-error --location https://raw.githubusercontent.com/github/gh-aw/main/install-gh-aw.sh | bash -s -- "$1"';

export function parseGhAwVersion(result) {
  if (result.error || result.status !== 0) {
    throw new Error(`Unable to determine gh-aw version: ${(result.stderr || '').trim() || result.error?.message || 'gh aw version failed'}`);
  }
  // gh-aw prints its version on stderr; accept either stream.
  const version = `${result.stdout || ''}\n${result.stderr || ''}`.match(/\bv[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?\b/)?.[0];
  if (!version) throw new Error('Unable to determine gh-aw version from "gh aw version" output');
  return version;
}

export function ghAwVersionParts(version) {
  const match = String(version).match(/^v([0-9]+)\.([0-9]+)\.([0-9]+)(?:-([0-9A-Za-z.-]+))?$/);
  if (!match) throw new Error(`Invalid gh-aw version: ${version}`);
  return {
    numbers: match.slice(1, 4).map(Number),
    prerelease: match[4] ?? ''
  };
}

export function compareGhAwVersions(left, right) {
  const leftParts = ghAwVersionParts(left);
  const rightParts = ghAwVersionParts(right);
  for (let index = 0; index < leftParts.numbers.length; index += 1) {
    if (leftParts.numbers[index] !== rightParts.numbers[index]) {
      return leftParts.numbers[index] - rightParts.numbers[index];
    }
  }
  if (leftParts.prerelease === rightParts.prerelease) return 0;
  if (!leftParts.prerelease) return 1;
  if (!rightParts.prerelease) return -1;
  return leftParts.prerelease.localeCompare(rightParts.prerelease, 'en', { numeric: true });
}

function ghAwMinimumVersion(policy, source) {
  const version = policy['gh-aw-version'];
  if (typeof version !== 'string' || !/^v[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?$/.test(version)) {
    throw new Error(`${source} gh-aw-version must be a v-prefixed semantic version`);
  }
  return version;
}

export async function ensureGhAwMinimumVersion({
  policyPath = DEFAULT_POLICY_PATH,
  execute = spawnSync
} = {}) {
  const policy = await readCaoPolicy(policyPath);
  const required = ghAwMinimumVersion(policy, policyPath);
  let current = null;
  try {
    current = parseGhAwVersion(execute('gh', ['aw', 'version'], { encoding: 'utf8' }));
  } catch {
    current = null;
  }
  const installRequired = !current || compareGhAwVersions(current, required) < 0;
  if (installRequired) {
    const install = execute('bash', ['-c', GH_AW_INSTALLER_COMMAND, 'cao-gh-aw-install', required], {
      encoding: 'utf8',
      maxBuffer: 16 * 1024 * 1024
    });
    if (install.error || install.status !== 0) {
      throw new Error(`Unable to install gh-aw ${required}: ${commandFailureMessage(install, 'installer failed')}`);
    }
    const verified = parseGhAwVersion(execute('gh', ['aw', 'version'], { encoding: 'utf8' }));
    if (compareGhAwVersions(verified, required) < 0) {
      throw new Error(`Installed gh-aw ${verified} is older than required ${required}`);
    }
    return { required, previous: current, current: verified, updated: true };
  }
  return { required, previous: current, current, updated: false };
}

export async function upgradeGhAw(version, {
  policyPath = DEFAULT_POLICY_PATH,
  execute = spawnSync
} = {}) {
  return upgradeGhAwVersion(version, {
    policyPath, execute, UsageError, ghAwVersionParts, readCaoPolicy,
    ghAwMinimumVersion, compareGhAwVersions, parseGhAwVersion,
    commandFailureMessage, installerCommand: GH_AW_INSTALLER_COMMAND,
    writeJsonAtomically, resolvePath: path.resolve,
  });
}
