import { createDebug } from '../../debug.js';

/**
 * Build SQLite statements with bound values. Identifiers must be explicitly
 * marked; values are never interpolated into SQL text. This prevents SQL
 * injection, not HTML injection: render returned strings as text or sanitize
 * them separately at the DOM boundary.
 */
const IDENTIFIER = Symbol('sql identifier');

const debugSql = createDebug('sql');

/** @param {string} name */
export function identifier(name) {
  if (typeof name !== 'string' || !name || name.includes('\0')) {
    debugSql({ event: 'identifier-rejected', reason: typeof name !== 'string' ? 'not-a-string' : !name ? 'empty' : 'contains-nul' });
    throw new TypeError('SQL identifier must be a nonempty string without NUL');
  }
  return Object.freeze({ [IDENTIFIER]: name });
}

/**
 * @param {TemplateStringsArray} strings
 * @param {...unknown} substitutions
 */
export function sql(strings, ...substitutions) {
  if (!Array.isArray(strings) || !Array.isArray(strings.raw)
      || strings.length !== substitutions.length + 1) {
    debugSql({ event: 'sql-call-rejected', reason: 'not-a-tagged-template' });
    throw new TypeError('SQL must be a tagged template');
  }
  const values = [];
  let text = strings[0];
  for (const [index, value] of substitutions.entries()) {
    if (value && typeof value === 'object' && Object.hasOwn(value, IDENTIFIER)) {
      text += `"${String(/** @type {{ [IDENTIFIER]: string }} */ (value)[IDENTIFIER]).replaceAll('"', '""')}"`;
    } else if (value === null || typeof value === 'string'
        || typeof value === 'bigint' || value instanceof Uint8Array
        || (typeof value === 'number' && Number.isFinite(value))) {
      text += '?';
      values.push(value);
    } else {
      debugSql({ event: 'parameter-rejected', index, valueType: typeof value });
      throw new TypeError('Unsupported SQL parameter');
    }
    text += strings[index + 1];
  }
  return { text, values };
}
