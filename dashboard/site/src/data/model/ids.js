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

/** @param {string | number} githubWorkflowId */
export function workflowId(githubWorkflowId) {
  return githubId('workflow', githubWorkflowId);
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