/**
 * @param {string} kind
 * @param {string | number} value
 * @returns {string}
 */
function githubId(kind, value) {
  const normalized = String(value).trim();
  if (!normalized) throw new TypeError(`${kind} ID is required`);
  return `github:${kind}:${normalized}`;
}

/** @param {string | number} githubRepositoryId */
export function repositoryId(githubRepositoryId) {
  return githubId('repository', githubRepositoryId);
}

/** @param {string} owner @param {string} name */
export function repositoryCoordinateId(owner, name) {
  const coordinate = `${owner.trim()}/${name.trim()}`.toLowerCase();
  if (coordinate === '/') throw new TypeError('Repository owner and name are required');
  return `repository:${encodeURIComponent(coordinate)}`;
}

/** @param {string | number} githubWorkflowId */
export function workflowId(githubWorkflowId) {
  return githubId('workflow', githubWorkflowId);
}

/** @param {string} path */
export function workflowSourcePath(path) {
  const normalized = path.trim().toLowerCase();
  if (!normalized) throw new TypeError('Workflow path is required');
  return normalized.endsWith('.lock.yml')
    ? `${normalized.slice(0, -'.lock.yml'.length)}.md`
    : normalized;
}

/** @param {string} owner @param {string} repository @param {string} path */
export function workflowCoordinateId(owner, repository, path) {
  const repositoryCoordinate = `${owner.trim()}/${repository.trim()}`.toLowerCase();
  if (repositoryCoordinate === '/') throw new TypeError('Workflow repository is required');
  return `workflow:${encodeURIComponent(`${repositoryCoordinate}:${workflowSourcePath(path)}`)}`;
}

/** @param {string} owner @param {string} repository @param {string | number} githubRunId */
export function runId(owner, repository, githubRunId) {
  const normalizedOwner = owner.trim();
  const normalizedRepository = repository.trim();
  if (!normalizedOwner || !normalizedRepository) {
    throw new TypeError('Run repository owner and name are required');
  }
  const coordinate = `${normalizedOwner}/${normalizedRepository}`.toLowerCase();
  const normalizedRunId = String(githubRunId).trim();
  if (!normalizedRunId) throw new TypeError('run ID is required');
  return `github:run:${coordinate}:${normalizedRunId}`;
}

const RUN_ID_PATTERN = /^github:run:([^/:]+)\/([^:]+):(.+)$/;

/**
 * Splits a canonical run ID back into its repository owner, repository name,
 * and raw GitHub run ID.
 *
 * @param {string} value
 */
export function runCoordinatesFromId(value) {
  const match = RUN_ID_PATTERN.exec(String(value));
  if (!match) throw new TypeError(`Value is not a canonical run ID: ${value}`);
  const [, owner, repository, githubRunId] = match;
  return { owner, repository, githubRunId };
}

/**
 * Produces a deterministic, human-readable Audit ID keyed by repository
 * coordinate, run, and a per-run-unique audit code, so audits are stored as
 * `<org>/<repo>/<runid>/<audit-code>`.
 *
 * @param {string} canonicalRunId
 * @param {string | number} auditCode
 */
export function auditId(canonicalRunId, auditCode) {
  const { owner, repository, githubRunId } = runCoordinatesFromId(canonicalRunId);
  let normalizedCode = String(auditCode).trim();
  if (!normalizedCode) throw new TypeError('Audit code is required');
  const runPrefix = `${canonicalRunId}:`;
  if (normalizedCode.startsWith(runPrefix)) normalizedCode = normalizedCode.slice(runPrefix.length);
  return `${owner}/${repository}/${githubRunId}/${encodeURIComponent(normalizedCode)}`;
}

/** @param {string} owner @param {string} repository @param {string | number} issueNumber */
export function issueId(owner, repository, issueNumber) {
  const normalizedOwner = owner.trim();
  const normalizedRepository = repository.trim();
  if (!normalizedOwner || !normalizedRepository) {
    throw new TypeError('Issue repository owner and name are required');
  }
  const coordinate = `${normalizedOwner}/${normalizedRepository}`.toLowerCase();
  const normalizedNumber = Number(issueNumber);
  if (!Number.isInteger(normalizedNumber) || normalizedNumber < 1) {
    throw new TypeError('Issue number must be a positive integer');
  }
  return `github:issue:${coordinate}:${normalizedNumber}`;
}

/** @param {string} value */
export function issueCoordinates(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new TypeError(`URL must identify a GitHub issue or pull request: ${value}`);
  }
  const match = url.hostname.toLowerCase() === 'github.com'
    ? url.pathname.match(/^\/([^/]+)\/([^/]+)\/(?:issues|pull)\/(\d+)(?:\/|$)/)
    : null;
  if (!match) throw new TypeError(`URL must identify a GitHub issue or pull request: ${value}`);
  return {
    owner: match[1],
    repository: match[2],
    number: Number(match[3])
  };
}

/**
 * Produces a deterministic ID for source records without a native stable ID.
 * Coordinates must be stable identifiers, not display names or timestamps.
 *
 * @param {import('./schema.js').EntityKind} kind
 * @param {string} source
 * @param {string | number} coordinate
 */
export function sourceId(kind, source, coordinate) {
  const normalizedSource = source.trim();
  const normalizedCoordinate = String(coordinate).trim();
  if (!normalizedSource || !normalizedCoordinate) {
    throw new TypeError(`${kind} source and coordinate are required`);
  }
  return `${kind}:${encodeURIComponent(normalizedSource)}:${encodeURIComponent(normalizedCoordinate)}`;
}