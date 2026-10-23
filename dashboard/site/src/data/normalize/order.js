/** @param {string} left @param {string} right */
export function compareCanonicalStrings(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

/**
 * JSON object insertion order is not observation authority. Array order remains
 * significant; absent fields retain ordinary JSON serialization semantics.
 * @param {unknown} value
 */
export function canonicalJson(value) {
  const serialized = JSON.stringify(value, (_key, item) => {
    if (item === null || typeof item !== 'object' || Array.isArray(item)) return item;
    return Object.fromEntries(Object.keys(item).sort(compareCanonicalStrings)
      .map((key) => [key, item[key]]));
  });
  if (serialized === undefined) throw new TypeError('Canonical ordering requires a JSON value');
  return serialized;
}
