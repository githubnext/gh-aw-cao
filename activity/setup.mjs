import { spawnSync } from 'node:child_process';
import { readFile, mkdir, mkdtemp, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

const DEFAULT_POLICY_PATH = '.github/workflows/cao.json';
const REPOSITORY_COORDINATE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const REPOSITORY_PATTERN = /^([A-Za-z0-9_.*-]+)\/([A-Za-z0-9_.*-]+)$/;
const REPOSITORY_LIST_LIMIT = 1000;
const ORGANIZATION_PAGE_SIZE = 100;

function commandFailureMessage(result, fallback) {
  return (result.stderr || '').trim() || result.error?.message || fallback;
}

function isMapping(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

async function writeJsonAtomically(filePath, document) {
  const absolutePath = path.resolve(filePath);
  await mkdir(path.dirname(absolutePath), { recursive: true });
  const temporaryPath = `${absolutePath}.${process.pid}.${Date.now()}.tmp`;
  try {
    await writeFile(temporaryPath, `${JSON.stringify(document, null, 2)}\n`, { flag: 'wx' });
    await rename(temporaryPath, absolutePath);
  } catch (error) {
    await rm(temporaryPath, { force: true });
    throw error;
  }
}

function resolveControlRepository(execute) {
  const result = execute('gh', ['repo', 'view', '--json', 'nameWithOwner', '--jq', '.nameWithOwner'], { encoding: 'utf8' });
  const repository = String(result.stdout || '').trim();
  if (result.error || result.status !== 0 || !REPOSITORY_COORDINATE.test(repository)) {
    throw new Error(
      `Unable to determine control repository: ${commandFailureMessage(result, 'gh repo view failed')}. `
      + 'Run cao setup from a GitHub repository checkout with a configured remote.',
    );
  }
  return repository;
}

function parseRepositoryList(value, fallback, UsageError) {
  const repositories = String(value || '')
    .split(',')
    .map((repository) => repository.trim())
    .filter(Boolean);
  const selected = (repositories.length > 0 ? repositories : fallback)
    .map((repository) => repository === '*' ? '*/*' : repository);
  for (const repository of selected) {
    if (!REPOSITORY_PATTERN.test(repository)) {
      throw new UsageError(`Repository must use owner/repository format with optional * wildcards: ${repository}`);
    }

  }
  return [...new Set(selected)];
}

function repositoryInputError(value) {
  const invalid = String(value || '').split(',').map((entry) => entry.trim())
    .find((entry) => entry && entry !== '*' && !REPOSITORY_PATTERN.test(entry));
  if (invalid) return `Use owner/repository names or * wildcards: ${invalid}`;
}

function listOrganizations(execute) {
  const organizations = [];
  for (let page = 1; page <= REPOSITORY_LIST_LIMIT / ORGANIZATION_PAGE_SIZE; page += 1) {
    const result = execute('gh', [
      'api',
      `/user/orgs?per_page=${ORGANIZATION_PAGE_SIZE}&page=${page}`,
    ], { encoding: 'utf8' });
    if (result.error || result.status !== 0) {
      throw new Error(`Unable to list organizations: ${commandFailureMessage(result, 'gh api failed')}`);
    }
    let entries;
    try {
      entries = JSON.parse(result.stdout);
    } catch {
      throw new Error('Unable to list organizations: GitHub returned invalid JSON');
    }
    if (!Array.isArray(entries)) {
      throw new Error('Unable to list organizations: GitHub returned invalid organization data');
    }
    if (entries.some((entry) => !/^[A-Za-z0-9_.-]+$/.test(entry?.login))) {
      throw new Error('Unable to list organizations: GitHub returned incomplete organization data');
    }
    organizations.push(...entries.map(({ login }) => login));
    if (organizations.length >= REPOSITORY_LIST_LIMIT) {
      throw new Error(
        `Unable to expand organization wildcard: the organization list reached ${REPOSITORY_LIST_LIMIT}; use a narrower pattern`,
      );
    }
    if (entries.length < ORGANIZATION_PAGE_SIZE) return organizations;
  }
  throw new Error(
    `Unable to expand organization wildcard: the organization list reached ${REPOSITORY_LIST_LIMIT}; use a narrower pattern`,
  );
}

function listOwnerRepositories(owner, execute) {
  const result = execute('gh', [
    'repo',
    'list',
    owner,
    '--json',
    'nameWithOwner,visibility',
    '--limit',
    String(REPOSITORY_LIST_LIMIT),
  ], { encoding: 'utf8' });
  if (result.error || result.status !== 0) {
    throw new Error(`Unable to list repositories for ${owner}: ${commandFailureMessage(result, 'gh repo list failed')}`);
  }
  let repositories;
  try {
    repositories = JSON.parse(result.stdout);
  } catch {
    throw new Error(`Unable to list repositories for ${owner}: gh repo list returned invalid JSON`);
  }
  if (!Array.isArray(repositories)) {
    throw new Error(`Unable to list repositories for ${owner}: gh repo list returned invalid repository data`);
  }
  if (repositories.length >= REPOSITORY_LIST_LIMIT) {
    throw new Error(
      `Unable to expand wildcard for ${owner}: the repository list reached ${REPOSITORY_LIST_LIMIT}; enter exact repository names instead`,
    );
  }
  return repositories.map((repository) => {
    if (
      !REPOSITORY_COORDINATE.test(repository?.nameWithOwner)
      || typeof repository.visibility !== 'string'
      || repository.nameWithOwner.split('/')[0].toLowerCase() !== owner.toLowerCase()
    ) {
      throw new Error(`Unable to list repositories for ${owner}: gh repo list returned incomplete repository data`);
    }
    return {
      repository: repository.nameWithOwner,
      owner: repository.nameWithOwner.split('/')[0],
      visibility: repository.visibility.toLowerCase(),
    };
  });
}

function repositoryPatternMatches(pattern, repository) {
  const escapeRegExp = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const matches = (componentPattern, value) => (
    new RegExp(`^${componentPattern.split('*').map(escapeRegExp).join('.*')}$`, 'i').test(value)
  );
  const [ownerPattern, namePattern] = pattern.split('/');
  const [owner, name] = repository.split('/');
  return matches(ownerPattern, owner) && matches(namePattern, name);
}

function inspectRepository(repository, execute) {
  const result = execute('gh', [
    'repo',
    'view',
    repository,
    '--json',
    'nameWithOwner,visibility',
  ], { encoding: 'utf8' });
  if (result.error || result.status !== 0) {
    throw new Error(`Unable to inspect ${repository}: ${commandFailureMessage(result, 'gh repo view failed')}`);
  }
  let document;
  try {
    document = JSON.parse(result.stdout);
  } catch {
    throw new Error(`Unable to inspect ${repository}: gh repo view returned invalid JSON`);
  }
  if (!REPOSITORY_COORDINATE.test(document.nameWithOwner) || typeof document.visibility !== 'string') {
    throw new Error(`Unable to inspect ${repository}: gh repo view returned incomplete repository data`);
  }
  return {
    repository: document.nameWithOwner,
    owner: document.nameWithOwner.split('/')[0],
    visibility: document.visibility.toLowerCase(),
  };
}

export function configureDashboardPages({ repository, execute = spawnSync }) {
  const endpoint = `repos/${repository}/pages`;
  const request = (arguments_) => execute('gh', ['api', ...arguments_, endpoint], { encoding: 'utf8' });
  const read = () => {
    const result = request([]);
    if (result.error || result.status !== 0) return { result };
    try {
      return { site: JSON.parse(result.stdout) };
    } catch {
      throw new Error('Unable to inspect dashboard Pages site: GitHub returned invalid JSON');
    }
  };

  let { site, result } = read();
  const created = !site;
  if (!site) {
    if (result.error || !/\bHTTP 404\b/.test(result.stderr || '')) {
      throw new Error(`Unable to inspect dashboard Pages site: ${commandFailureMessage(result, 'gh api failed')}`);
    }
    result = request(['-X', 'POST', '-f', 'build_type=workflow']);
    if (result.error || result.status !== 0) {
      throw new Error(`Unable to create dashboard Pages site: ${commandFailureMessage(result, 'gh api failed')}`);
    }
  }

  if (site && site.build_type !== 'workflow') {
    result = request(['-X', 'PUT', '-f', 'build_type=workflow']);
    if (result.error || result.status !== 0) {
      throw new Error(`Unable to select GitHub Actions as the Pages source: ${commandFailureMessage(result, 'gh api failed')}`);
    }
  }

  ({ site } = read());
  if (!site || site.build_type !== 'workflow') {
    throw new Error('Dashboard Pages configuration could not be verified; do not deploy the dashboard');
  }
  return {
    created,
    public: site.public !== false,
    url: typeof site.html_url === 'string' ? site.html_url : undefined,
  };
}

export function removeDashboardPages({ repository, execute = spawnSync }) {
  const result = execute('gh', ['api', '-X', 'DELETE', `repos/${repository}/pages`], { encoding: 'utf8' });
  return !result.error && result.status === 0;
}

async function setupNonInteractivePublicControl({
  output,
  execute,
  policyPath,
  UsageError,
}) {
  output.write('Applying non-interactive setup defaults for the current public control repository.\n');
  const auth = execute('gh', ['auth', 'status'], { encoding: 'utf8' });
  if (auth.error || auth.status !== 0) {
    throw new UsageError(`GitHub CLI authentication check failed: ${commandFailureMessage(auth, 'gh auth status failed')}. Run gh auth login, then gh cao setup again.`);
  }

  const controlRepository = resolveControlRepository(execute);
  const control = inspectRepository(controlRepository, execute);
  if (control.visibility !== 'public') {
    throw new UsageError(
      `Non-interactive setup requires a public control repository; ${control.repository} is ${control.visibility}. `
      + 'Run gh cao setup from an interactive terminal for a private or internal repository.',
    );
  }

  let policy;
  try {
    policy = JSON.parse(await readFile(path.resolve(policyPath), 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') throw new UsageError('CAO policy is missing. Run gh cao init, then gh cao setup.');
    if (error instanceof SyntaxError) throw new UsageError('CAO policy contains invalid JSON. Fix the policy file, then rerun gh cao setup.');
    throw error;
  }
  const controlPlane = policy?.['control-plane'];
  const campaigns = controlPlane?.campaigns;
  if (!isMapping(campaigns) || Object.keys(campaigns).length > 0) {
    throw new UsageError('Non-interactive setup requires a bare control plane with no declared campaigns');
  }
  const owner = control.repository.split('/')[0];
  const scope = controlPlane.scope;
  if (scope !== undefined) {
    const owners = scope?.['allowed-owners'];
    const repositories = scope?.['allowed-repositories'];
    const exactScope = isMapping(scope)
      && Object.keys(scope).every((key) => ['allowed-owners', 'allowed-repositories'].includes(key))
      && Array.isArray(owners)
      && owners.length === 1
      && typeof owners[0] === 'string'
      && owners[0].toLowerCase() === owner.toLowerCase()
      && Array.isArray(repositories)
      && repositories.length === 1
      && typeof repositories[0] === 'string'
      && repositories[0].toLowerCase() === control.repository.toLowerCase();
    if (!exactScope) {
      throw new UsageError(
        'Non-interactive setup refuses to replace existing repository scope; '
        + 'run gh cao setup from an interactive terminal to review it',
      );
    }
  }
  const activity = controlPlane.activity;
  if (activity !== undefined) {
    const repositories = activity?.repositories;
    const exactActivity = isMapping(activity)
      && Array.isArray(repositories)
      && repositories.length === 1
      && typeof repositories[0] === 'string'
      && repositories[0].toLowerCase() === control.repository.toLowerCase();
    if (!exactActivity) {
      throw new UsageError(
        'Non-interactive setup refuses to replace existing Activity scope; '
        + 'run gh cao setup from an interactive terminal to review it',
      );
    }
  }

  const intendedPolicy = structuredClone(policy);
  intendedPolicy['control-plane'].scope = {
    'allowed-owners': [owner],
    'allowed-repositories': [control.repository],
  };
  intendedPolicy['control-plane'].activity = {
    ...(isMapping(activity) ? activity : {}),
    repositories: [control.repository],
  };

  let applyStage = 'dashboard Pages';
  try {
    const pages = configureDashboardPages({ repository: control.repository, execute });
    if (!pages.public) {
      throw new Error('Non-interactive setup requires public GitHub Pages for the public control repository');
    }

    applyStage = 'workflow-token authentication';
    const authentication = execute('gh', [
      'variable', 'set', 'GH_AW_GITHUB_AUTH_MODE',
      '--repo', control.repository,
      '--body', 'workflow-token',
    ], { encoding: 'utf8' });
    if (authentication.error || authentication.status !== 0) {
      throw new Error(`Unable to select repository workflow-token authentication: ${commandFailureMessage(authentication, 'gh variable set failed')}`);
    }

    applyStage = 'policy';
    await writeJsonAtomically(path.resolve(policyPath), intendedPolicy);
    output.write([
      `Non-interactive setup applied to ${control.repository}.`,
      `Read and Activity scope: ${control.repository}`,
      'Authentication: repository GITHUB_TOKEN (workflow-token)',
      `Dashboard Pages: public${pages.url ? ` (${pages.url})` : ''}`,
      'Campaigns: none',
      '',
    ].join('\n'));
    return {
      command: 'setup',
      controlRepository: control.repository,
      visibility: control.visibility,
      repositories: [control.repository],
      profile: 'workflow-token',
      authentication: {
        mode: 'workflow-token',
        repository: control.repository,
      },
      dashboardPages: 'public',
      campaigns: [],
      nonInteractive: true,
    };
  } catch (error) {
    throw new UsageError(
      `${error.message}\nNon-interactive setup stopped during ${applyStage}; `
      + 'the local policy was not changed, but Pages settings or the authentication-mode variable may already have changed.',
      { cause: error },
    );
  }
}

export async function setupCaoControlPlane({
  input = process.stdin,
  output = process.stderr,
  environment = process.env,
  prompt,
  execute = spawnSync,
  policyPath = DEFAULT_POLICY_PATH,
  setupAuthentication,
  UsageError = Error,
} = {}) {
  if (prompt === undefined && (!input.isTTY || !output.isTTY || environment.CI)) {
    return setupNonInteractivePublicControl({
      output,
      execute,
      policyPath,
      UsageError,
    });
  }
  if (typeof setupAuthentication !== 'function') {
    throw new Error('CAO setup authentication handler is unavailable');
  }
  const { createTerminalPrompt, SetupCancelled } = await import('./setup-prompt.mjs');
  const interactive = prompt || createTerminalPrompt({ input, output, UsageError });
  const ownsPrompt = prompt === undefined;
  let temporaryDirectory;
  let applyStage;
  let policySaved = false;
  let pages;
  let control;
  const declinePublicPages = () => {
    const removed = pages.created && removeDashboardPages({ repository: control.repository, execute });
    interactive.note(pages.created
      ? (removed
          ? 'Removed the Pages site created by setup.'
          : 'Could not remove the Pages site created by setup; unpublish it in Settings > Pages.')
      : 'Left the existing Pages site in place; restrict or unpublish it in Settings > Pages before running the dashboard workflow.');
    interactive.cancel?.('Setup cancelled. Policy and credentials are unchanged.');
    return { command: 'setup', cancelled: true, reason: 'public-pages-declined' };
  };
  try {
    interactive.start?.();
    interactive.step?.('Checking GitHub sign-in and this checkout');
    const auth = execute('gh', ['auth', 'status'], { encoding: 'utf8' });
    if (auth.error || auth.status !== 0) {
      throw new UsageError(`GitHub CLI authentication check failed: ${commandFailureMessage(auth, 'gh auth status failed')}. Run gh auth login, then gh cao setup again.`);
    }

    const controlRepository = resolveControlRepository(execute);
    control = inspectRepository(controlRepository, execute);
    let policy;
    try {
      policy = JSON.parse(await readFile(path.resolve(policyPath), 'utf8'));
    } catch (error) {
      if (error.code === 'ENOENT') throw new UsageError('CAO policy is missing. Run gh cao init, then gh cao setup.');
      if (error instanceof SyntaxError) throw new UsageError('CAO policy contains invalid JSON. Fix the policy file, then rerun gh cao setup.');
      throw error;
    }
    const campaigns = policy?.['control-plane']?.campaigns;
    if (!isMapping(campaigns) || Object.keys(campaigns).length > 0) {
      throw new Error('cao setup only configures a bare control plane with no declared campaigns');
    }

    interactive.note(`Control repository: ${control.repository} (${control.visibility})\nNo campaign will be installed, enabled, or run.\nWildcard patterns are expanded now; only exact names are saved.`, '1 / 3  Repositories');
    const targetAnswer = await interactive.text(
      'Repositories CAO should read (comma-separated names or * wildcards)',
      control.repository,
      repositoryInputError,
    );
    const requestedRepositories = parseRepositoryList(targetAnswer, [control.repository], UsageError);
    const inspected = [control];
    const ownerRepositories = new Map();
    let organizations;
    for (const requestedRepository of requestedRepositories) {
      const [ownerPattern] = requestedRepository.split('/');
      if (!requestedRepository.includes('*')) {
        if (requestedRepository.toLowerCase() !== control.repository.toLowerCase()) {
          inspected.push(inspectRepository(requestedRepository, execute));
        }
        continue;
      }
      let owners;
      if (ownerPattern.includes('*')) {
        organizations ??= listOrganizations(execute);
        owners = organizations.filter((owner) => repositoryPatternMatches(
          `${ownerPattern}/*`,
          `${owner}/*`,
        ));
        if (owners.length === 0) {
          throw new Error(`Organization pattern ${ownerPattern} matched no accessible organizations`);
        }
      } else {
        owners = [ownerPattern];
      }
      const matches = owners.flatMap((owner) => {
        const key = owner.toLowerCase();
        if (!ownerRepositories.has(key)) {
          ownerRepositories.set(key, listOwnerRepositories(owner, execute));
        }
        return ownerRepositories.get(key);
      })
        .filter(({ repository }) => repositoryPatternMatches(requestedRepository, repository))
        .sort((left, right) => left.repository.localeCompare(right.repository, 'en'));
      if (matches.length === 0) {
        throw new Error(`Repository pattern ${requestedRepository} matched no accessible repositories`);
      }
      inspected.push(...matches);
    }
    const seenRepositories = new Set();
    const uniqueInspected = inspected.filter(({ repository }) => {
      const key = repository.toLowerCase();
      if (seenRepositories.has(key)) return false;
      seenRepositories.add(key);
      return true;
    });
    const repositories = uniqueInspected.map(({ repository }) => repository);
    const owners = [...new Set(uniqueInspected.map(({ owner }) => owner))];
    const hasNonPublicTarget = uniqueInspected.some(({ repository, visibility }) => (
      repository.toLowerCase() !== control.repository.toLowerCase() && visibility !== 'public'
    ));
    if (control.visibility === 'public' && hasNonPublicTarget) {
      throw new Error('A public control repository cannot be configured for non-public repository evidence; use a private control repository');
    }

    interactive.note(`${repositories.length} repositories across ${owners.length} resource owners.\nRead and review-output credentials stay separate.`, '2 / 3  Connections');
    const choices = [owners.length === 1
      ? {
          value: 'github-app',
          label: 'Organization GitHub Apps',
          hint: 'Recommended for one organization',
        }
      : {
          value: 'enterprise-app',
          label: 'Enterprise GitHub Apps',
          hint: 'Organizations in one enterprise',
        },
      {
        value: 'approved-app',
        label: 'Reuse approved private GitHub Apps',
        hint: 'Existing read/write Apps; no new App registration',
      },
      {
        value: 'token',
        label: 'Fine-grained personal access tokens',
        hint: 'User-bound; separate credentials per owner',
      }];

    const profile = await interactive.select('How should CAO authenticate?', choices);
    if (!choices.some((choice) => choice.value === profile)) {
      throw new UsageError(`Authentication profile is not available for this repository scope: ${profile}`);
    }
    const intendedPolicy = structuredClone(policy);
    intendedPolicy['control-plane'].scope = {
      'allowed-owners': owners,
      'allowed-repositories': repositories,
    };
    temporaryDirectory = await mkdtemp(path.join(tmpdir(), 'cao-setup-'));
    const intendedPolicyPath = path.join(temporaryDirectory, 'cao.json');
    await writeJsonAtomically(intendedPolicyPath, intendedPolicy);

    const authenticationArguments = ['--repo', control.repository];
    if (profile === 'github-app' || profile === 'approved-app' || profile === 'token') {
      authenticationArguments.push('--policy', intendedPolicyPath);
    }
    if (profile === 'github-app' || profile === 'approved-app' || profile === 'enterprise-app' || profile === 'token') {
      authenticationArguments.push('--write-repository', control.repository);
    }
    if (profile === 'enterprise-app' || profile === 'approved-app') {
      if (profile === 'enterprise-app') authenticationArguments.push('--policy', intendedPolicyPath);
      const requiredClientId = (value) => value ? undefined : 'Enter the App client ID.';
      const readClientId = await interactive.text('Read App client ID', '', requiredClientId);
      const writeClientId = await interactive.text('Write App client ID', '', requiredClientId);
      if (!readClientId || !writeClientId) {
        throw new UsageError('Existing App setup requires both client IDs');
      }
      authenticationArguments.push(
        '--read-client-id', readClientId,
        '--write-client-id', writeClientId,
      );
    }
    if (profile === 'token') {
      authenticationArguments.push('--expires-in', '30');
    }

    interactive.note([
      `Control repository: ${control.repository} (${control.visibility})`,
      `Read scope: ${repositories.join(', ')}`,
      `Review output write scope: ${control.repository}`,
      `Authentication: ${profile}`,
      'Campaigns: none',
      'Dashboard Pages: GitHub Actions source; public visibility requires consent',
      'Pages settings and credentials may be changed; no commit or push is made.',
    ].join('\n'), '3 / 3  Review and apply');
    if (!await interactive.confirm('Apply this setup?')) {
      interactive.cancel?.('Setup cancelled. Policy, credentials, and Pages settings are unchanged.');
      return { command: 'setup', cancelled: true };
    }

    applyStage = 'dashboard Pages';
    interactive.step?.('Configuring and verifying the dashboard Pages source');
    pages = configureDashboardPages({ repository: control.repository, execute });
    if (pages.public) {
      applyStage = 'public dashboard consent';
      interactive.note([
        `Warning: the dashboard Pages site for ${control.repository} is public${pages.url ? ` (${pages.url})` : ''}.`,
        'Anyone on the internet will be able to read published dashboard data, including activity from',
        `${control.visibility === 'public' ? 'the selected repositories' : 'this private control repository and the selected repositories'}.`,
        'To keep it private, restrict access in Settings > Pages (requires an organization on GitHub Enterprise Cloud).',
      ].join('\n'), 'Dashboard visibility');
      if (!await interactive.confirm('Is a public dashboard OK?')) {
        return declinePublicPages();
      }
    }
    applyStage = 'credentials';
    interactive.step?.('Connecting read and review-output credentials');
    const authentication = await setupAuthentication(
      profile === 'approved-app' ? 'github-app' : profile,
      authenticationArguments,
      { execute },
    );
    if (authentication?.cancelled) throw new SetupCancelled();
    applyStage = 'policy';
    interactive.step?.('Saving the exact repository scope');
    await writeJsonAtomically(path.resolve(policyPath), intendedPolicy);
    policySaved = true;
    interactive.finish?.();
    return {
      command: 'setup',
      controlRepository: control.repository,
      visibility: control.visibility,
      repositories,
      profile,
      authentication,
      dashboardPages: pages.public ? 'public' : 'private',
      campaigns: [],
    };
  } catch (error) {
    if (error instanceof SetupCancelled) {
      if (applyStage === 'public dashboard consent') return declinePublicPages();
      interactive.cancel?.(policySaved
        ? 'Configuration was saved before cancellation. Run gh cao validate, then review the installed files.'
        : applyStage
        ? 'Setup cancelled. The local policy is unchanged; Pages settings or credentials may have changed. Rerun gh cao setup to finish.'
        : 'Setup cancelled. Policy, credentials, and Pages settings are unchanged.');
      return { command: 'setup', cancelled: true };
    }
    interactive.failure?.();
    if (applyStage) {
      const recovery = policySaved
        ? 'Configuration was saved, but completion could not be displayed. Run gh cao validate, then review the installed files.'
        : `Setup stopped during ${applyStage}; the local policy was not changed. Pages settings or credentials may already have changed. Fix the reported problem and rerun gh cao setup; existing settings will be inspected again.`;
      throw new UsageError(`${error.message}\n${recovery}`, { cause: error });
    }
    if (ownsPrompt && !(error instanceof UsageError)) throw new UsageError(error.message, { cause: error });
    throw error;
  } finally {
    if (temporaryDirectory) await rm(temporaryDirectory, { recursive: true, force: true });
    if (ownsPrompt) interactive.close();
  }
}
