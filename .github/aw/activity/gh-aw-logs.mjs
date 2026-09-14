export function parseGhAwLogsJsonl(contents) {
  return contents
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => JSON.parse(line))
    .flatMap((record) => record.schema_version === 2 && record.kind === "run" && record.run
      ? [record.run]
      : []);
}

export function serializeGhAwLogsJsonl(runs) {
  return runs
    .map((run) => JSON.stringify({ schema_version: 2, kind: "run", run }))
    .join("\n") + (runs.length ? "\n" : "");
}
