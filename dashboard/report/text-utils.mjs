export function firstText(...values) {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) return value.trim();
    if (value !== undefined && value !== null && String(value).trim()) return String(value).trim();
  }
  return "";
}
