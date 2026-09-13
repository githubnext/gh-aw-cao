const DEBUG_PARAMETER = 'debug';
const DEBUG_PREFIX = 'cao';

/**
 * @param {string} pattern
 */
function patternExpression(pattern) {
  const escaped = pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`^${escaped.replaceAll('\\*', '.*')}$`, 'i');
}

/**
 * @param {string} category
 * @param {string} search
 */
export function isDebugEnabled(category, search = globalThis.location?.search ?? '') {
  const value = new URLSearchParams(search).get(DEBUG_PARAMETER);
  if (!value) return false;

  const patterns = value.split(/[\s,]+/).filter(Boolean);
  const excluded = patterns
    .filter((pattern) => pattern.startsWith('-'))
    .map((pattern) => patternExpression(pattern.slice(1)));
  if (excluded.some((pattern) => pattern.test(category))) return false;

  return patterns
    .filter((pattern) => !pattern.startsWith('-'))
    .some((pattern) => pattern === '1'
      || pattern.toLowerCase() === 'true'
      || patternExpression(pattern).test(category));
}

/**
 * Creates a category-scoped dashboard debug logger. Logging is disabled unless
 * the current URL has a matching `debug` query parameter.
 * @param {string} category
 * @param {{ search?: () => string, output?: Pick<Console, 'debug'> }} [options]
 */
export function createDebug(category, options = {}) {
  const search = options.search ?? (() => globalThis.location?.search ?? '');
  const output = options.output ?? globalThis.console;

  return (
    /** @param {unknown[]} values */
    (...values) => {
    if (!isDebugEnabled(category, search())) return;
    output.debug(`[${DEBUG_PREFIX}:${category}]`, ...values);
    }
  );
}
