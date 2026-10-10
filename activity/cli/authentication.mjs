import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { REPOSITORY_COORDINATE } from '../operational-value.mjs';
import { confirmExistingPatSecret, configureEnterpriseApps, FINE_GRAINED_PAT_PROFILES, fineGrainedPatSetupResult, GITHUB_AUTH_MODE_VARIABLE, githubServerUrl, openBrowser, ownerScopedPatSecret, repositorySecretNames, writeFineGrainedPatInstructions } from '../authentication.mjs';
import { DEFAULT_POLICY_PATH, validateGlobalPolicy } from './policy.mjs';
import { UsageError, parseOptions, option, rejectUnknownOptions } from './options.mjs';
import { commandFailureMessage } from './files.mjs';

export function fineGrainedTokenSetups({
  repo,
  policyPath = DEFAULT_POLICY_PATH,
  expiresIn = '30',
  writeRepositories = [],
  environment = process.env,
} = {}) {
  if (!REPOSITORY_COORDINATE.test(repo || '')) {
    throw new UsageError('--repo must be an exact OWNER/REPOSITORY');
  }
  if (!/^(?:[1-9]|[1-9][0-9]|[12][0-9]{2}|3[0-5][0-9]|36[0-6])$/.test(expiresIn)) {
    throw new UsageError('--expires-in must be an integer from 1 through 366');
  }
  let policy;
  try {
    policy = validateGlobalPolicy(JSON.parse(readFileSync(path.resolve(policyPath), 'utf8')), policyPath);
  } catch (error) {
    if (error?.code === 'ENOENT') throw new Error(`${policyPath} is required for guided token setup`);
    if (error instanceof SyntaxError) throw new Error(`${policyPath} contains invalid JSON: ${error.message}`);
    throw error;
  }
  const configuredRepositories = policy['control-plane']?.scope?.['allowed-repositories'] ?? [];
  if (!Array.isArray(configuredRepositories)
    || configuredRepositories.some((repository) => typeof repository !== 'string' || !REPOSITORY_COORDINATE.test(repository))) {
    throw new Error(`${policyPath} control-plane.scope.allowed-repositories must contain exact OWNER/REPOSITORY values`);
  }
  if (!Array.isArray(writeRepositories)
    || writeRepositories.some((repository) => typeof repository !== 'string' || !REPOSITORY_COORDINATE.test(repository))) {
    throw new UsageError('--write-repository must be an exact OWNER/REPOSITORY');
  }
  const readRepositories = [...new Set([repo, ...configuredRepositories])];
  const selectedWriteRepositories = [...new Set(writeRepositories.length > 0 ? writeRepositories : [repo])];
  const [controlOwner, controlRepository] = repo.split('/');
  const byOwner = (repositories) => {
    const groups = new Map();
    for (const repository of repositories) {
      const [owner] = repository.split('/');
      const key = owner.toLowerCase();
      if (!groups.has(key)) groups.set(key, { owner, repositories: [] });
      groups.get(key).repositories.push(repository);
    }
    return [...groups.values()]
      .map((group) => ({ ...group, repositories: group.repositories.sort() }))
      .sort((left, right) => (
        Number(right.owner.toLowerCase() === controlOwner.toLowerCase())
        - Number(left.owner.toLowerCase() === controlOwner.toLowerCase())
        || left.owner.localeCompare(right.owner)
      ));
  };
  const repositoriesByRole = {
    read: readRepositories,
    write: selectedWriteRepositories,
  };
  return FINE_GRAINED_PAT_PROFILES.flatMap((profile) => byOwner(repositoriesByRole[profile.role]).map((group) => {
    const patNameBase = `CAO-${group.owner}-${controlRepository.replace(/-token$/i, '')}-PAT`.toUpperCase();
    const parameters = new URLSearchParams({
      name: `${patNameBase}-${profile.role.toUpperCase()}`.slice(0, 40),
      description: `Central Agentic Ops ${profile.role} access for ${repo}`,
      target_name: group.owner,
      expires_in: expiresIn,
      ...profile.permissions,
    });
    return {
      ...profile,
      secret: ownerScopedPatSecret(profile, group.owner),
      url: `${githubServerUrl(environment)}/settings/personal-access-tokens/new?${parameters}`,
      owner: group.owner,
      repositories: group.repositories,
      expiresIn: Number(expiresIn),
    };
  }));
}

export function setupCaoAuthentication(method, arguments_ = [], {
  execute = spawnSync,
  launchBrowser = (url) => openBrowser(url, execute),
  writeInstruction = (message) => console.error(message),
  confirmExistingSecret = (secret) => confirmExistingPatSecret(secret, { UsageError }),
} = {}) {
  if (method === 'github-app') {
    const script = path.join('.github', 'workflows', 'shared', 'setup-github-apps.mjs');
    const result = execute(process.execPath, [script, ...arguments_], { stdio: 'inherit' });
    if (result.error || result.status !== 0) {
      throw new Error(`GitHub App setup failed: ${commandFailureMessage(result, `exit ${result.status}`)}`);
    }
    return { command: 'setup-auth', profile: 'github-app' };
  }
  if (method === 'enterprise-app') {
    const options = parseOptions(arguments_);
    rejectUnknownOptions(options, [
      'repo',
      'read-client-id',
      'write-client-id',
      'write-repository',
      'policy',
      'dry-run',
    ]);
    const repo = option(options, 'repo');
    const policyPath = option(options, 'policy', false);
    const writeRepositories = options['write-repository'] === undefined
      ? [repo]
      : Array.isArray(options['write-repository'])
        ? options['write-repository']
        : [options['write-repository']];
    if (writeRepositories.some((repository) => !REPOSITORY_COORDINATE.test(repository))) {
      throw new UsageError('--write-repository must be an exact OWNER/REPOSITORY');
    }
    let readRepositories = [];
    if (policyPath) {
      let policy;
      try {
        policy = validateGlobalPolicy(JSON.parse(readFileSync(path.resolve(policyPath), 'utf8')), policyPath);
      } catch (error) {
        if (error?.code === 'ENOENT') throw new Error(`${policyPath} is required for enterprise App setup`);
        if (error instanceof SyntaxError) throw new Error(`${policyPath} contains invalid JSON: ${error.message}`);
        throw error;
      }
      readRepositories = policy['control-plane']?.scope?.['allowed-repositories'] ?? [];
    }
    if (!Array.isArray(readRepositories)
      || readRepositories.some((repository) => !REPOSITORY_COORDINATE.test(repository))) {
      throw new Error(`${policyPath} control-plane.scope.allowed-repositories must contain exact OWNER/REPOSITORY values`);
    }
    return configureEnterpriseApps({
      repo,
      readClientId: option(options, 'read-client-id'),
      writeClientId: option(options, 'write-client-id'),
      readRepositories,
      writeRepositories,
      dryRun: options['dry-run'],
      execute,
      failureMessage: commandFailureMessage,
    });
  }
  if (method === 'token') {
    const options = parseOptions(arguments_);
    rejectUnknownOptions(options, [
      'repo',
      'write-repository',
      'policy',
      'expires-in',
      'no-open',
      'dry-run',
      'keep-existing',
      'replace-existing',
    ]);
    if (options['keep-existing'] && options['replace-existing']) {
      throw new UsageError('--keep-existing and --replace-existing cannot be used together');
    }
    const repo = option(options, 'repo');
    const writeRepositories = options['write-repository'] === undefined
      ? []
      : Array.isArray(options['write-repository'])
        ? options['write-repository']
        : [options['write-repository']];
    const setups = fineGrainedTokenSetups({
      repo,
      policyPath: option(options, 'policy', false) || DEFAULT_POLICY_PATH,
      expiresIn: option(options, 'expires-in', false) || '30',
      writeRepositories,
    });
    const setupResult = fineGrainedPatSetupResult(repo, setups);
    const repositoryMaps = setupResult.repositories;
    if (options['dry-run']) return setupResult;
    const auth = execute('gh', ['auth', 'status'], { encoding: 'utf8' });
    if (auth.error || auth.status !== 0) {
      throw new Error(`GitHub CLI authentication check failed: ${commandFailureMessage(auth, 'gh auth status failed')}`);
    }
    let existingSecrets = new Set();
    if (!options['replace-existing']) {
      existingSecrets = repositorySecretNames(repo, {
        execute,
        failureMessage: commandFailureMessage,
      });
    }
    for (const setup of setups) {
      if (existingSecrets.has(setup.secret)
        && (options['keep-existing'] || confirmExistingSecret(setup.secret))) {
        writeInstruction(`Skipping existing repository secret ${setup.secret}.`);
        continue;
      }
      writeFineGrainedPatInstructions(setup, {
        launchBrowser,
        noOpen: options['no-open'],
        writeInstruction,
      });
      const result = execute('gh', [
        'secret', 'set', setup.secret, '--repo', repo,
      ], { stdio: 'inherit' });
      if (result.error || result.status !== 0) {
        throw new Error(`${setup.role} fine-grained token setup failed: ${commandFailureMessage(result, `exit ${result.status}`)}`);
      }
    }
    for (const profile of FINE_GRAINED_PAT_PROFILES) {
      const result = execute('gh', [
        'variable',
        'set',
        profile.repositoryMapVariable,
        '--repo',
        repo,
        '--body',
        JSON.stringify(repositoryMaps[profile.role]),
      ], { encoding: 'utf8' });
      if (result.error || result.status !== 0) {
        throw new Error(`${profile.role} token map setup failed: ${commandFailureMessage(result, `exit ${result.status}`)}`);
      }
    }
    const modeResult = execute('gh', [
      'variable', 'set', GITHUB_AUTH_MODE_VARIABLE, '--repo', repo, '--body', 'pat',
    ], { encoding: 'utf8' });
    if (modeResult.error || modeResult.status !== 0) {
      throw new Error(`authentication mode setup failed: ${commandFailureMessage(modeResult, `exit ${modeResult.status}`)}`);
    }
    return setupResult;
  }
  throw new UsageError('cao setup-auth requires github-app, enterprise-app, or token');
}
