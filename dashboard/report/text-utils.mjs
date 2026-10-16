export function parseRolloutMode(value) {
  const text = String(value ?? "").trim().toLowerCase();
  if (text === "review" || text === "live") return text;
  return text.match(/(?:^|[^a-z0-9])(review|live)\s*$/)?.[1] || "unknown";
}

export function firstText(...values) {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) return value.trim();
    if (value !== undefined && value !== null && String(value).trim()) return String(value).trim();
  }
  return "";
}
