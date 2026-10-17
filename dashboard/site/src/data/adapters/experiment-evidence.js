import { createDebug, diagnosticErrorName } from '../../debug.js';

const debug = createDebug('experiment-evidence');

/**
 * Read explicit current-run assignments, never infer them from cumulative counts.
 * The caller owns verification of the artifact's repository, run and attempt.
 * @param {string} content
 * @param {string} path
 * @returns {{ assignments: Record<string, string> }}
 */
export function parseExperimentAssignments(content, path) {
  let value;
  try {
    value = JSON.parse(content);
  } catch (error) {
    if (!(error instanceof SyntaxError)) throw error;
    debug({ event: 'assignments-parse', status: 'invalid-json', error: diagnosticErrorName(error) });
    throw new TypeError(`${path} must contain valid experiment assignment JSON`);
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)
      || Object.entries(value).some(([name, variant]) =>
        !name.trim() || typeof variant !== 'string' || !variant.trim())) {
    throw new TypeError(`${path} must contain explicit experiment assignments`);
  }
  const assignments = Object.fromEntries(Object.entries(value));
  debug({ event: 'assignments-parse', status: 'ok', count: Object.keys(assignments).length });
  return { assignments };
}

/**
 * @param {{ path: string, content: string }[]} files
 */
export function experimentAssignmentArtifact(files) {
  const candidates = files.filter((file) =>
    /(^|\/)(?:(?:[^/]+-)?usage\/)?(?:[^/]+-)?experiments?\/assignments\.json$/.test(file.path)
      || file.path === 'assignments.json');
  debug({ event: 'artifact-select', files: files.length, candidates: candidates.length });
  if (candidates.length > 1) throw new TypeError('Multiple experiment assignment artifacts found for one run');
  return candidates[0];
}
