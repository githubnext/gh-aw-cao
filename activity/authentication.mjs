export const FINE_GRAINED_PAT_PROFILES = [
  {
    role: 'read',
    secret: 'GH_AW_GITHUB_READ_PAT',
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
    permissions: {
      actions: 'write',
      administration: 'read',
      contents: 'write',
      issues: 'write',
      pull_requests: 'write',
    },
  },
];
