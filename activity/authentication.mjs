// Actions-only credential profiles and bounded Activity collection planning.
// Operator provisioning and credential prompts belong to native gh cao setup auth.
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
export const GITHUB_AUTH_MODES = Object.freeze({
  APP: 'app',
  PAT: 'pat',
  WORKFLOW_TOKEN: 'workflow-token',
});

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
  const mode = authMode || GITHUB_AUTH_MODES.WORKFLOW_TOKEN;
  if (!Object.values(GITHUB_AUTH_MODES).includes(mode)) {
    throw new Error(
      "GH_AW_GITHUB_AUTH_MODE must select app, pat, or workflow-token for CAO Activity; "
      + `run gh cao setup auth github-app --repo ${controlRepository} or `
      + `gh cao setup auth token --repo ${controlRepository}`,
    );
  }

  const configuredActivityRepositories = controlSettings?.activity_repositories;
  const hasExplicitActivityScope = Array.isArray(configuredActivityRepositories);
  const configuredRepositories = hasExplicitActivityScope
    ? configuredActivityRepositories
    : controlSettings?.allowed_repositories ?? [];
  const configuredOwners = hasExplicitActivityScope ? [] : controlSettings?.allowed_owners ?? [];
  const repositories = [...new Map(
    [controlRepository, ...configuredRepositories].map((repository) => [
      String(repository).toLowerCase(),
      String(repository),
    ]),
  ).values()];
  if (repositories.some((repository) => !repositoryCoordinate(repository))) {
    throw new Error("Activity repository scope must contain exact OWNER/REPOSITORY values");
  }

  if (controlSettings?.activity_public_only === true) {
    if (mode !== GITHUB_AUTH_MODES.WORKFLOW_TOKEN || !hasExplicitActivityScope || configuredRepositories.length === 0) {
      throw new Error("Public-only Activity requires workflow-token authentication and an explicit activity.repositories scope");
    }
    const byOwner = new Map();
    for (const repository of repositories) {
      const [owner] = repository.split("/");
      const key = owner.toLowerCase();
      if (!byOwner.has(key)) byOwner.set(key, {
        owner, repositories: [], credentialRepository: controlRepository, artifact: key, publicOnly: true,
      });
      byOwner.get(key).repositories.push(repository);
    }
    return [...byOwner.values()];
  }

  if (mode === GITHUB_AUTH_MODES.WORKFLOW_TOKEN) {
    if (repositories.some((repository) => repository.toLowerCase() !== controlRepository.toLowerCase())
      || (configuredRepositories.length === 0 && configuredOwners.length > 0)) {
      throw new Error(
        "GITHUB_TOKEN can collect CAO Activity only for the control repository; "
        + `set allowed-repositories to ["${controlRepository}"] or configure `
        + "GH_AW_GITHUB_AUTH_MODE=app or pat for cross-repository or owner-wide collection",
      );
    }
    const [owner] = controlRepository.split("/");
    return [{
      owner,
      repositories: [controlRepository],
      credentialRepository: controlRepository,
      artifact: owner.toLowerCase(),
    }];
  }

  if (mode === GITHUB_AUTH_MODES.PAT) {
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
