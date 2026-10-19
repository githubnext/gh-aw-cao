import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";
import { readJsonArchive, writeJsonArchive } from "../.github/skills/add-operational-value/scripts/json-archive.mjs";

const base = fileURLToPath(new URL("../docs/operational-value/proof/constraint-potd/", import.meta.url));
const hash = value => createHash("sha256").update(value).digest("hex");
const repository = "github/gh-aw", revision = "c86377ec47b38f0b5af463277ee55d1d03d08da8";
const selected = [
  { number: 58462, kind: "n-queens", runId: 33868062846 },
  { number: 64465, kind: "sudoku", runId: 36708905984 },
  { number: 54778, kind: "latin-square", runId: 32570488547 },
  { number: 57139, kind: "graph-coloring", runId: 33308908522 },
];

export function collect() {
  mkdirSync(path.join(base, "originals"), { recursive: true });
  const receipts = {};
  const request = (label, endpoint, query) => {
    const file = `originals/${label}.json.gz`, target = path.join(base, file);
    let packet;
    if (existsSync(target)) packet = readJsonArchive(target);
    else {
      const args = ["api", endpoint, ...(query ? ["-f", `query=${query}`] : [])];
      const body = execFileSync("gh", args, { encoding: "utf8", maxBuffer: 16 * 1024 * 1024, timeout: 60000 });
      packet = { endpoint, ...(query ? { query } : {}), observedAt: new Date().toISOString(),
        body, sha256: hash(body) };
      writeJsonArchive(target, packet);
    }
    if (packet.endpoint !== endpoint || packet.query !== query || hash(packet.body) !== packet.sha256) {
      throw new Error(`Changed original response: ${label}`);
    }
    receipts[label] = { file, archiveSha256: hash(readFileSync(target)), bodySha256: packet.sha256 };
    return JSON.parse(packet.body);
  };
  const metadata = request("repository", `repos/${repository}`);
  if (metadata.id !== 1036865607 || metadata.full_name !== repository || metadata.private !== false
    || metadata.visibility !== "public") throw new Error("Public repository authority mismatch");
  const adoption = request("adoption", `repos/${repository}/commits/dc1d7031d3db32579ac3467eaf40fc0f35e828a5`);
  if (!adoption.files.some(file => file.filename === ".github/workflows/constraint-solving-potd.md" && file.status === "added")) {
    throw new Error("Actual workflow addition is not established");
  }
  for (const suffix of ["md", "lock.yml"]) {
    request(`frozen-${suffix.replace(".", "-")}`,
      `repos/${repository}/contents/.github/workflows/constraint-solving-potd.${suffix}?ref=${revision}`);
  }
  const records = selected.map(row => {
    const query = `query { repository(owner:"github",name:"gh-aw") { databaseId discussion(number:${row.number}) { id number url title body createdAt updatedAt } } }`;
    const discussion = request(`discussion-${row.number}`, "graphql", query);
    if (discussion.errors?.length || discussion.data?.repository?.databaseId !== 1036865607
      || discussion.data.repository.discussion?.number !== row.number) throw new Error("Invalid original lesson identity");
    const run = request(`run-${row.runId}`, `repos/${repository}/actions/runs/${row.runId}`);
    if (run.id !== row.runId || run.repository?.id !== 1036865607
      || run.path !== ".github/workflows/constraint-solving-potd.lock.yml"
      || !/^[a-f0-9]{40}$/.test(run.head_sha)) throw new Error("Unverified candidate run/source identity");
    for (const suffix of ["md", "lock.yml"]) {
      request(`source-${row.number}-${suffix.replace(".", "-")}`,
        `repos/${repository}/contents/.github/workflows/constraint-solving-potd.${suffix}?ref=${run.head_sha}`);
    }
    return { ...row, head: run.head_sha };
  });
  const index = { schemaVersion: 1, repository, repositoryId: 1036865607, revision,
    cutoff: "2026-10-18T15:00:12Z", records, receipts,
    selection: "Four selected surviving lessons: latest retained title-matched candidate in each initially supported mathematical class. Discovery is not a complete outcome census.",
    contribution: "Editable run markers corroborate candidate lineage only; original creation receipts remain unavailable.",
    bodyVersion: "Original GraphQL bytes acquired after cutoff. Native correctness concerns the surviving body, not original publication-time bytes.",
  };
  writeJsonArchive(path.join(base, "index.json"), index);
  return index;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  console.log(JSON.stringify({ originals: Object.keys(collect().receipts).length, selected: selected.length }));
}
