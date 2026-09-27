export async function upgradeGhAwVersion(version, {
  policyPath,
  execute,
  UsageError,
  ghAwVersionParts,
  readCaoPolicy,
  ghAwMinimumVersion,
  compareGhAwVersions,
  parseGhAwVersion,
  commandFailureMessage,
  installerCommand,
  writeJsonAtomically,
  resolvePath,
}) {
  ghAwVersionParts(version);
  const policy = await readCaoPolicy(policyPath);
  const previousRequired = ghAwMinimumVersion(policy, policyPath);
  if (compareGhAwVersions(version, previousRequired) < 0) {
    throw new UsageError(`cao upgrade-gh-aw cannot downgrade gh-aw from ${previousRequired} to ${version}`);
  }

  let previousInstalled = null;
  try {
    previousInstalled = parseGhAwVersion(execute('gh', ['aw', 'version'], { encoding: 'utf8' }));
  } catch {
    previousInstalled = null;
  }
  if (previousInstalled !== version) {
    const install = execute('bash', ['-c', installerCommand, 'cao-gh-aw-install', version], {
      encoding: 'utf8',
      maxBuffer: 16 * 1024 * 1024
    });
    if (install.error || install.status !== 0) {
      throw new Error(`Unable to install gh-aw ${version}: ${commandFailureMessage(install, 'installer failed')}`);
    }
  }

  const installed = parseGhAwVersion(execute('gh', ['aw', 'version'], { encoding: 'utf8' }));
  if (installed !== version) {
    throw new Error(`Installed gh-aw version is ${installed}, expected ${version}`);
  }
  const upgrade = execute('gh', ['aw', 'upgrade'], {
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024
  });
  if (upgrade.error || upgrade.status !== 0) {
    throw new Error(`gh aw upgrade failed: ${commandFailureMessage(upgrade, 'unknown error')}`);
  }

  policy['gh-aw-version'] = version;
  await writeJsonAtomically(resolvePath(policyPath), policy);
  return {
    command: 'upgrade-gh-aw',
    policy: policyPath,
    previous: previousRequired,
    current: version
  };
}
