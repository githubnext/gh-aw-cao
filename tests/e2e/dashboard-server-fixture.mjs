import { createHash } from "node:crypto";
import { cpSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const fixture = fileURLToPath(new URL("../../server/testdata/deployed-subset/", import.meta.url));
const timestamp = /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z/g;
const shards = ["gh-aw-logs-runs/subset.jsonl", "gh-aw-logs-records/subset.jsonl"];

export function prepareDashboardServerFixture(destination, now = Date.now()) {
  const runs = readFileSync(resolve(fixture, shards[0]), "utf8");
  const latest = Math.max(...[...runs.matchAll(timestamp)].map(([value]) => Date.parse(value)));
  if (!Number.isFinite(latest) || !Number.isFinite(now)) {
    throw new Error("Dashboard fixture requires valid evidence and evaluation timestamps.");
  }
  const offset = now - 86_400_000 - latest;
  cpSync(fixture, destination, { recursive: true });
  const manifest = JSON.parse(readFileSync(resolve(destination, "payload-hashes.json"), "utf8"));
  for (const name of [...shards, "inventory-sources.json"]) {
    const path = resolve(destination, name);
    const content = readFileSync(path, "utf8").replace(timestamp, (value) =>
      new Date(Date.parse(value) + offset).toISOString()
    );
    writeFileSync(path, content);
    if (Object.hasOwn(manifest, name)) {
      manifest[name] = createHash("sha256").update(content).digest("hex");
    }
  }
  writeFileSync(resolve(destination, "payload-hashes.json"), JSON.stringify(manifest));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (!process.argv[2]) throw new Error("A destination for the dashboard fixture is required.");
  prepareDashboardServerFixture(resolve(process.argv[2]));
}
