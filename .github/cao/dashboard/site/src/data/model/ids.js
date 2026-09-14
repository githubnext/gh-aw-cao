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

/**
 * @param {string | number} githubRunId
 * @param {string | number} attempt
 */
export function runId(githubRunId, attempt) {
  const normalizedAttempt = Number(attempt);
  if (!Number.isInteger(normalizedAttempt) || normalizedAttempt < 1) {
    throw new TypeError('Run attempt must be a positive integer');
  }
  return `${githubId('run', githubRunId)}:attempt:${normalizedAttempt}`;
}

/** @param {string | number} githubJobId */
export function jobId(githubJobId) {
  return githubId('job', githubJobId);
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