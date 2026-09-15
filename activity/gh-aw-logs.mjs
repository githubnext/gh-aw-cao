import { createReadStream } from "node:fs";
import { readdir } from "node:fs/promises";
import path from "node:path";
import { createInterface } from "node:readline";

export function parseGhAwLogsJsonl(contents) {
  return contents
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => JSON.parse(line))
    .flatMap((record) => record.schema_version === 2 && record.kind === "run" && record.run
      ? [record.run]
      : []);
}

export async function readGhAwLogShards(directory) {
  const names = (await readdir(directory))
    .filter((name) => name.endsWith(".jsonl"))
    .sort();
  const runs = [];
  for await (const run of iterateGhAwLogShards(directory, names)) runs.push(run);
  return runs;
}

export async function* iterateGhAwLogShards(directory, shardNames) {
  const names = shardNames ?? (await readdir(directory))
    .filter((name) => name.endsWith(".jsonl"))
    .sort();
  for (const name of names) {
    const lines = createInterface({
      input: createReadStream(path.join(directory, name)),
      crlfDelay: Infinity,
    });
    for await (const line of lines) {
      if (!line) continue;
      const record = JSON.parse(line);
      if (record.schema_version === 2 && record.kind === "run" && record.run) yield record.run;
    }
  }
}

export function serializeGhAwLogsJsonl(runs) {
  return runs
    .map((run) => JSON.stringify({ schema_version: 2, kind: "run", run }))
    .join("\n") + (runs.length ? "\n" : "");
}
