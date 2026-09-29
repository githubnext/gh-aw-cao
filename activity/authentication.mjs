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
