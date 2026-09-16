/**
 * @param {unknown} id Kebab-case package identifier.
 * @returns {string} The title-cased display name, or an empty string for blank input.
 */
export function packageName(id) {
  return String(id ?? "")
    .split("-")
    .filter(Boolean)
    .map((part) => `${part.charAt(0).toUpperCase()}${part.slice(1).toLowerCase()}`)
    .join(" ");
}
