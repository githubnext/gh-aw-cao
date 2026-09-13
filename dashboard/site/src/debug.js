const DEBUG_PARAMETER = 'debug';
const DEBUG_PREFIX = 'cao';
const patternCache = new Map();
const disabledDebug = () => {};

/**
 * @param {string} pattern
 */
function patternExpression(pattern) {
  const escaped = pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`^${escaped.replaceAll('\\*', '.*')}$`, 'i');
}

/**
 * @param {string} search
 * @returns {{ included: RegExp[], excluded: RegExp[] }}
 */
function debugPatterns(search) {
  const cached = patternCache.get(search);
  if (cached) return cached;

  const value = new URLSearchParams(search).get(DEBUG_PARAMETER) ?? '';
  const patterns = value.split(/[\s,]+/).filter(Boolean);
  const compiled = {
    included: patterns
      .filter((pattern) => !pattern.startsWith('-'))
      .map((pattern) => patternExpression(pattern === '1' || pattern.toLowerCase() === 'true' ? '*' : pattern)),
    excluded: patterns
      .filter((pattern) => pattern.startsWith('-'))
      .map((pattern) => patternExpression(pattern.slice(1)))
  };
  patternCache.set(search, compiled);
  return compiled;
}

/**
 * @param {string} category
 * @param {string} search
 */
export function isDebugEnabled(category, search = globalThis.location?.search ?? '') {
  const { included, excluded } = debugPatterns(search);
  if (excluded.some((pattern) => pattern.test(category))) return false;
  return included.some((pattern) => pattern.test(category));
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
  if (!isDebugEnabled(category, search())) return disabledDebug;

  return (
    /** @param {unknown[]} values */
    (...values) => output.debug(`[${DEBUG_PREFIX}:${category}]`, ...values)
  );
}
