import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createSqliteIndexedDB } from "../../dashboard/site/src/data/storage/sqlite-indexeddb.js";
import { upsertCanonicalBatch } from "../../dashboard/site/src/data/storage/indexeddb.js";
import { normalize } from "../../dashboard/site/src/data/normalize/index.js";

// Artifact fixtures use canonical records, not the removed logical-source HTTP transport.
export async function writeCanvasSnapshot(destination, records = {}) {
  await mkdir(destination, { recursive: true });
  const snapshot = join(destination, "gh-aw-logs.sqlite");
  await upsertCanonicalBatch(createSqliteIndexedDB(snapshot), {
    ...normalize([]), ...records,
  });
  const hash = createHash("sha256").update(await readFile(snapshot)).digest("hex");
  await writeFile(join(destination, "payload-hashes.json"), JSON.stringify({ "gh-aw-logs.sqlite": hash }));
  return snapshot;
}
