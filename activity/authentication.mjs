import { spawnSync } from 'node:child_process';
import { readSync } from 'node:fs';

export const FINE_GRAINED_PAT_PROFILES = [
  {
    role: 'read',
    secret: 'GH_AW_GITHUB_READ_PAT',
    repositoryMapVariable: 'GH_AW_GITHUB_READ_PAT_REPOSITORIES',
    permissions: {
      actions: 'read',
      contents: 'read',
      issues: 'read',
      pull_requests: 'read',
      secret_scanning_alerts: 'read',
      security_events: 'read',
      statuses: 'read',
      vulnerability_alerts: 'read',
    },
  },
  {
    role: 'write',
    secret: 'GH_AW_GITHUB_WRITE_PAT',
    repositoryMapVariable: 'GH_AW_GITHUB_WRITE_PAT_REPOSITORIES',
    permissions: {
      actions: 'write',
      administration: 'read',
      contents: 'write',
      issues: 'write',
      pull_requests: 'write',
    },
  },
];

export const GITHUB_AUTH_MODE_VARIABLE = 'GH_AW_GITHUB_AUTH_MODE';

export function fineGrainedPatSetupResult(repo, setups) {
  const repositories = Object.fromEntries(FINE_GRAINED_PAT_PROFILES.map((profile) => [
    profile.role,
    Object.fromEntries(setups
      .filter((setup) => setup.role === profile.role)
      .flatMap((setup) => setup.repositories.map((repository) => [repository, setup.secret]))),
  ]));
  return {
    command: 'setup-auth',
    profile: 'fine-grained-token',
    secrets: setups.map(({ owner, role, secret }) => ({ owner, role, secret })),
    repo,
    repositories,
  };
}

export function confirmExistingPatSecret(secret, {
  UsageError,
  input = process.stdin,
  output = process.stderr,
  readTerminal = readSync,
  waitForTerminal = (milliseconds) => {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);
  },
} = {}) {
  if (!input.isTTY || !output.isTTY) {
    throw new UsageError(
      `${secret} already exists; rerun with --keep-existing or --replace-existing in a non-interactive environment`,
    );
  }
  output.write(`Repository secret ${secret} already exists. Keep it? [Y/n]: `);
  const chunks = [];
  while (true) {
    const buffer = Buffer.alloc(1024);
    let bytesRead;
    try {
      bytesRead = readTerminal(input.fd, buffer, 0, buffer.length, null);
    } catch (error) {
      if (error?.code === 'EAGAIN' || error?.code === 'EWOULDBLOCK' || error?.code === 'EINTR') {
        waitForTerminal(25);
        continue;
      }
      throw error;
    }
    if (bytesRead === 0) break;
    const chunk = buffer.subarray(0, bytesRead);
    chunks.push(chunk);
    if (chunk.includes(10) || chunk.includes(13)) break;
  }
  const answer = Buffer.concat(chunks).toString('utf8').trim().toLowerCase();
  return answer === '' || answer === 'y' || answer === 'yes';
}

export function formatSetupAuthenticationSummary(result) {
  if (result?.command !== 'setup-auth' || result?.profile !== 'fine-grained-token') {
    return JSON.stringify(result, null, 2);
  }
  const readRepositories = Object.keys(result.repositories?.read ?? {});
  const writeRepositories = Object.keys(result.repositories?.write ?? {});
  const readOwners = [...new Set(result.secrets
    .filter(({ role }) => role === 'read')
    .map(({ owner }) => owner))];
  return [
    `✓ Fine-grained PAT authentication configured for ${result.repo}.`,
    `  Read scope: ${readRepositories.length} ${readRepositories.length === 1 ? 'repository' : 'repositories'} across ${readOwners.join(', ')}`,
    `  Write scope: ${writeRepositories.join(', ') || 'none'}`,
    '  Authentication mode: pat',
    '',
    'Existing GitHub App credentials, if present, are inactive while PAT mode is selected.',
    'Next: run ./cao.sh validate, then validate a bounded review workflow before removing App credentials.',
  ].join('\n');
}

export function repositorySecretNames(repo, { execute, failureMessage }) {
  const result = execute('gh', [
    'secret', 'list', '--repo', repo, '--json', 'name',
  ], { encoding: 'utf8' });
  if (result.error || result.status !== 0) {
    throw new Error(`existing token lookup failed: ${failureMessage(result, `exit ${result.status}`)}`);
  }
  try {
    return new Set(JSON.parse(result.stdout || '[]').map(({ name }) => name));
  } catch (error) {
    throw new Error(`existing token lookup returned invalid JSON: ${error.message}`);
  }
}

export function writeFineGrainedPatInstructions(setup, {
  launchBrowser,
  noOpen,
  writeInstruction,
}) {
  writeInstruction(`Create the ${setup.role} fine-grained PAT for ${setup.owner}:`);
  writeInstruction(`- expiration: ${setup.expiresIn} days`);
  writeInstruction('- repository access: Only select repositories');
  for (const repository of setup.repositories) writeInstruction(`  - ${repository}`);
  writeInstruction('- repository permissions:');
  for (const [permission, level] of Object.entries(setup.permissions)) {
    writeInstruction(`  - ${permission}: ${level}`);
  }
  if (noOpen || !launchBrowser(setup.url)) writeInstruction(`Open this URL to continue: ${setup.url}`);
  writeInstruction(`Generate the token, then paste it only into the secure prompt for ${setup.secret}.`);
}

export function githubServerUrl(environment = process.env) {
  const configured = environment.GH_HOST?.trim()
    || environment.GITHUB_SERVER_URL?.trim()
    || 'github.com';
  const url = configured.includes('://') ? configured : `https://${configured}`;
  return new URL(url).origin;
}

export function openBrowser(url, execute = spawnSync) {
  const command = process.platform === 'darwin' ? ['open', [url]]
    : process.platform === 'win32' ? ['cmd', ['/c', 'start', '', url]]
      : ['xdg-open', [url]];
  const result = execute(command[0], command[1], { stdio: 'ignore' });
  return !result.error && result.status === 0;
}

export function ownerScopedPatSecret(profile, owner) {
  const suffix = owner.toUpperCase().replaceAll('-', '_');
  return `${profile.secret}_${suffix}`;
}

function repositoryCoordinate(value) {
  return /^[A-Za-z0-9][A-Za-z0-9-]*\/[A-Za-z0-9._-]+$/.test(String(value || ""));
}

function parseRepositoryMap(value) {
  if (!value) return {};
  let parsed;
  try {
    parsed = JSON.parse(value);
  } catch (error) {
    throw new Error(`GH_AW_GITHUB_READ_PAT_REPOSITORIES contains invalid JSON: ${error.message}`);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("GH_AW_GITHUB_READ_PAT_REPOSITORIES must be a repository-to-secret-name object");
  }
  return parsed;
}

export function activityCollectionPlan(controlSettings, {
  authMode,
  controlRepository,
  patRepositoryMap = "",
} = {}) {
  if (!repositoryCoordinate(controlRepository)) {
    throw new Error("GITHUB_REPOSITORY must use OWNER/REPOSITORY form");
  }
  if (!["app", "pat"].includes(authMode)) {
    throw new Error(
      "GH_AW_GITHUB_AUTH_MODE must explicitly select app or pat for CAO Activity; "
      + `run ./cao.sh setup-auth github-app --repo ${controlRepository} or `
      + `./cao.sh setup-auth token --repo ${controlRepository}`,
    );
  }

  const configuredRepositories = controlSettings?.allowed_repositories ?? [];
  const configuredOwners = controlSettings?.allowed_owners ?? [];
  const repositories = [...new Map(
    [controlRepository, ...configuredRepositories].map((repository) => [
      String(repository).toLowerCase(),
      String(repository),
    ]),
  ).values()];
  if (repositories.some((repository) => !repositoryCoordinate(repository))) {
    throw new Error("Activity repository scope must contain exact OWNER/REPOSITORY values");
  }

  if (authMode === "pat") {
    if (configuredRepositories.length === 0) {
      throw new Error("PAT-mode CAO Activity requires an exact allowed-repositories scope");
    }
    const repositoryMap = parseRepositoryMap(patRepositoryMap);
    const byOwner = new Map();
    for (const repository of repositories) {
      const [owner] = repository.split("/");
      const expectedSecret = ownerScopedPatSecret(FINE_GRAINED_PAT_PROFILES[0], owner);
      const mappedSecret = repositoryMap[repository];
      if (!mappedSecret) {
        throw new Error(`GH_AW_GITHUB_READ_PAT_REPOSITORIES has no mapping for ${repository}`);
      }
      if (mappedSecret !== expectedSecret) {
        throw new Error(`${repository} must map to owner-scoped secret ${expectedSecret}`);
      }
      const key = owner.toLowerCase();
      if (!byOwner.has(key)) byOwner.set(key, { owner, repositories: [], secret: mappedSecret });
      byOwner.get(key).repositories.push(repository);
    }
    return [...byOwner.values()].map((entry) => ({
      ...entry,
      repositories: entry.repositories.sort(),
      credentialRepository: entry.repositories[0],
      artifact: entry.owner.toLowerCase().replaceAll(/[^a-z0-9-]/g, "-"),
    }));
  }

  const owners = configuredRepositories.length > 0
    ? repositories.map((repository) => repository.split("/", 1)[0])
    : [controlRepository.split("/", 1)[0], ...configuredOwners];
  const byOwner = new Map();
  for (const owner of owners) {
    const key = String(owner).toLowerCase();
    if (!key || byOwner.has(key)) continue;
    byOwner.set(key, {
      owner,
      repositories: configuredRepositories.length > 0
        ? repositories.filter((repository) => repository.split("/", 1)[0].toLowerCase() === key)
        : [],
      credentialRepository: "",
      artifact: key.replaceAll(/[^a-z0-9-]/g, "-"),
    });
  }
  const plan = [...byOwner.values()];
  const oversized = plan.find((entry) => entry.repositories.length > 500);
  if (oversized) {
    throw new Error(`GitHub App Activity scope for ${oversized.owner} exceeds the 500-repository token limit`);
  }
  return plan;
}

export function configureEnterpriseApps({
  repo,
  readClientId,
  writeClientId,
  readRepositories,
  writeRepositories,
  dryRun,
  execute,
  failureMessage,
}) {
  const credentials = [
    {
      role: 'read',
      clientId: readClientId,
      variable: 'GH_AW_GITHUB_READ_APP_ID',
      secret: 'GH_AW_GITHUB_READ_APP_PRIVATE_KEY',
    },
    {
      role: 'write',
      clientId: writeClientId,
      variable: 'GH_AW_GITHUB_WRITE_APP_ID',
      secret: 'GH_AW_GITHUB_WRITE_APP_PRIVATE_KEY',
    },
  ];
  const repositories = {
    read: [...new Set([repo, ...readRepositories])],
    write: [...new Set(writeRepositories)],
  };
  if (dryRun) {
    return {
      command: 'setup-auth',
      profile: 'enterprise-app',
      repo,
      credentials: credentials.map(({ role, clientId, variable, secret }) => ({
        role, clientId, variable, secret,
      })),
      repositories,
    };
  }
  const auth = execute('gh', ['auth', 'status'], { encoding: 'utf8' });
  if (auth.error || auth.status !== 0) {
    throw new Error(`GitHub CLI authentication check failed: ${failureMessage(auth, 'gh auth status failed')}`);
  }
  for (const credential of credentials) {
    const variableResult = execute('gh', [
      'variable', 'set', credential.variable, '--repo', repo, '--body', credential.clientId,
    ], { encoding: 'utf8' });
    if (variableResult.error || variableResult.status !== 0) {
      throw new Error(`Enterprise App variable setup failed: ${failureMessage(variableResult, `exit ${variableResult.status}`)}`);
    }
    const secretResult = execute('gh', [
      'secret', 'set', credential.secret, '--repo', repo,
    ], { stdio: 'inherit' });
    if (secretResult.error || secretResult.status !== 0) {
      throw new Error(`Enterprise App private-key setup failed: ${failureMessage(secretResult, `exit ${secretResult.status}`)}`);
    }
  }
  const modeResult = execute('gh', [
    'variable', 'set', GITHUB_AUTH_MODE_VARIABLE, '--repo', repo, '--body', 'app',
  ], { encoding: 'utf8' });
  if (modeResult.error || modeResult.status !== 0) {
    throw new Error(`authentication mode setup failed: ${failureMessage(modeResult, `exit ${modeResult.status}`)}`);
  }
  return { command: 'setup-auth', profile: 'enterprise-app', repo, repositories };
}
