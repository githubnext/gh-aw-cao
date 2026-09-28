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
