/** Converts a kebab-case package identifier to a display name; blank input remains blank. */
export function packageName(id) {
  return id
    .split("-")
    .filter(Boolean)
    .map((part) => `${part.charAt(0).toUpperCase()}${part.slice(1)}`)
    .join(" ");
}
