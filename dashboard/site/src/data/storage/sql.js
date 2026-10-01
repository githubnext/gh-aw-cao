/**
 * Build SQLite statements with bound values. Identifiers must be explicitly
 * marked; values are never interpolated into SQL text.
 */
const IDENTIFIER = Symbol('sql identifier');

/** @param {string} name */
export function identifier(name) {
  if (typeof name !== 'string' || !name || name.includes('\0')) {
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
      throw new TypeError('Unsupported SQL parameter');
    }
    text += strings[index + 1];
  }
  return { text, values };
}
