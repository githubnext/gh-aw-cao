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
