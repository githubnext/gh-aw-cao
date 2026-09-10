export function parseGhAwLogsJsonl(contents) {
  return contents
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

export function serializeGhAwLogsJsonl(runs) {
  return runs.map((run) => JSON.stringify(run)).join("\n") + (runs.length ? "\n" : "");
}
