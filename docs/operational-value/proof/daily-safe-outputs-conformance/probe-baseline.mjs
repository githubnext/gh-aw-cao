import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { writeJsonArchive } from "../../../../.github/skills/add-operational-value/scripts/json-archive.mjs";
import { hash } from "./native-checker.mjs";

const cache = process.argv[2];
if (!cache) throw new Error("Usage: node probe-baseline.mjs READ-ONLY-GIT-CACHE");
const git = args => execFileSync("git", [`--git-dir=${cache}`, ...args], {
  env: { ...process.env, GIT_NO_LAZY_FETCH: "1", GIT_TERMINAL_PROMPT: "0" },
  timeout: 30000, maxBuffer: 8 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"],
});
if (git(["remote", "get-url", "origin"]).toString().trim() !== "https://github.com/github/gh-aw.git") {
  throw new Error("Unexpected baseline repository authority");
}
const parent = "5b953fa1ef92edd37b5b8202e827e9fbe159462f";
const start = "2026-02-07T18:17:28Z", end = "2026-02-14T18:17:28Z";
const snapshots = [start, end].map(at => {
  const commit = git(["rev-list", "--first-parent", "-1", `--before=${at}`, parent]).toString().trim();
  if (!/^[a-f0-9]{40}$/.test(commit)) throw new Error("Baseline immutable cutoff not found");
  const tree = git(["ls-tree", "-r", commit]);
  const entries = tree.toString("utf8").trimEnd().split("\n").map(line => {
    const match = line.match(/^(\d+) blob ([a-f0-9]{40})\t(.+)$/);
    return match ? { mode: match[1], id: match[2], file: match[3] } : null;
  }).filter(Boolean).filter(row => /^actions\/setup\/js\/[^/]+\.cjs$/.test(row.file)
    || /safe_outputs|safe-outputs-specification|check-safe-outputs-conformance|cache_integrity/.test(row.file));
  const ids = [...new Set(entries.map(row => row.id))];
  const checked = execFileSync("git", [`--git-dir=${cache}`, "cat-file", "--batch-check=%(objectname) %(objecttype) %(objectsize)"], {
    input: `${ids.join("\n")}\n`, encoding: "utf8", timeout: 30000, maxBuffer: 1024 * 1024,
    env: { ...process.env, GIT_NO_LAZY_FETCH: "1" },
  }).trimEnd().split("\n");
  const status = new Map(checked.map((line, i) => {
    const match = line.match(/^([a-f0-9]{40}) (missing|blob)(?: (\d+))?$/);
    if (!match || match[1] !== ids[i]) throw new Error("Unexpected baseline object-check response");
    return [match[1], { available: match[2] === "blob", bytes: match[3] ? Number(match[3]) : null }];
  }));
  return {
    at, commit, completeTreeSha256: hash(tree), completeTreeBase64: tree.toString("base64"),
    selectedEntries: entries.map(row => ({ ...row, ...status.get(row.id) })),
  };
});
const missing = [...new Set(snapshots.flatMap(snapshot => snapshot.selectedEntries.filter(row => !row.available).map(row => row.id)))]
  .map(id => ({ id, endpoint: `repos/github/gh-aw/git/blobs/${id}`, reason: "not-retained-in-authorized-local-cache" }));
const result = {
  schemaVersion: 1, repository: "github/gh-aw", repositoryId: 1036865607, adoptionParent: parent,
  windowStart: start, windowEnd: end, snapshots, missing,
  scope: "Bounded pre-adoption immutable availability probe only; no source code executed, no acquired objects, and no accepted baseline or value asserted.",
  interpretation: "A meaningful phenomenon predates adoption. Missing local objects and changing obligation/predicate profiles leave baseline reconstruction unresolved; not historical impossibility. Canonical historical facts/snapshots were not supplied, and new acquisition remains held.",
};
writeJsonArchive(path.join(path.dirname(fileURLToPath(import.meta.url)), "baseline-availability.json.gz"), result);
console.log(JSON.stringify({
  snapshots: snapshots.map(snapshot => ({ at: snapshot.at, commit: snapshot.commit,
    selected: snapshot.selectedEntries.length, available: snapshot.selectedEntries.filter(row => row.available).length })),
  missingObjects: missing.length, acceptedBaseline: false,
}, null, 2));
