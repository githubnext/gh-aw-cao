import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseGitChanges } from "../.github/skills/add-operational-value/scripts/git-evidence.mjs";
import { readOutputHistory } from "../.github/skills/add-operational-value/scripts/collect-output-history.mjs";
import { writeJsonArchive } from "../.github/skills/add-operational-value/scripts/json-archive.mjs";

export const frozen = {
  repository: "github/gh-aw",
  repositoryId: 1036865607,
  revision: "c86377ec47b38f0b5af463277ee55d1d03d08da8",
  cutoff: "2026-10-18T15:00:12Z",
  sourceBlob: "17e5d2e7270b0e3e185e670ce552bf8075c764b8",
  sourcePath: ".github/workflows/step-name-alignment.md",
  sourceEra: "cff4a5c09d5a4ecfc6f3a5bee18190aa6c7be273",
  eraAt: "2026-09-29T18:10:06Z",
  adoptionCommit: "8705ccfc3f1113fde75ac041aa73e177c5b57603",
  adoptedAt: "2026-01-13T14:26:57Z",
  baselineCommit: "8b9ecffc4e5fa3e8a16072c359f37e74a969afcd",
};
const glossary = "docs/src/content/docs/reference/glossary.md";
const imports = [
  ".github/workflows/shared/reporting.md",
  ".github/workflows/shared/otlp.md",
  ".github/workflows/shared/ai-coding-dictionary.md",
];
const sha256 = value => createHash("sha256").update(value).digest("hex");
const gitBlob = bytes => createHash("sha1").update(`blob ${bytes.length}\0`).update(bytes).digest("hex");

export function collect({ gitDirectory, historyDirectory, outputDirectory }) {
  const env = { ...process.env, GIT_NO_LAZY_FETCH: "1", GIT_OPTIONAL_LOCKS: "0",
    GIT_TERMINAL_PROMPT: "0", GIT_PAGER: "cat" };
  const git = (...args) => execFileSync("git", [`--git-dir=${gitDirectory}`, ...args], {
    env, encoding: "utf8", maxBuffer: 128 * 1024 * 1024,
  });
  const tree = (revision, ...paths) => git("ls-tree", "-r", revision, "--", ...paths).trim()
    .split("\n").filter(Boolean).map(line => {
      const match = line.match(/^(\d{6}) blob ([a-f0-9]{40})\t(.+)$/);
      if (!match) throw new Error("Unsupported native Git tree entry");
      return { mode: match[1], blob: match[2], path: match[3] };
    });
  const { index, entities } = readOutputHistory(historyDirectory);
  if (index.repository !== frozen.repository || index.repositoryId !== frozen.repositoryId
    || index.until !== frozen.cutoff || index.sourceRevision !== frozen.revision
    || index.totalEntities !== 58048 || index.partitions.length !== 346 || !index.complete
    || index.workflows.find(row => row.id === "step-name-alignment")?.gitBlob !== frozen.sourceBlob) {
    throw new Error("Frozen shared history identity mismatch");
  }
  const selected = new Set(entities.filter(row => row.workflowReference?.workflowId === "step-name-alignment"
    || row.unverifiedWorkflowId === "step-name-alignment").map(row => row.number));
  let changed = true;
  while (changed) {
    changed = false;
    for (const row of entities) {
      if (selected.has(row.number) || row.relatedCandidates.some(number => selected.has(number))) {
        for (const number of [row.number, ...row.relatedCandidates]) {
          if (!selected.has(number)) { selected.add(number); changed = true; }
        }
      }
    }
  }
  const lineage = entities.filter(row => selected.has(row.number));
  const descriptors = new Map();
  const record = entry => {
    if (entry?.blob) descriptors.set(entry.blob, { blob: entry.blob });
    return entry;
  };
  const currentFiles = tree(frozen.revision, ".github/workflows")
    .filter(row => /^\.github\/workflows\/.*\.lock\.yml$/.test(row.path)).map(record);
  const sources = tree(frozen.revision, frozen.sourcePath, glossary, ...imports).map(record);
  if (sources.find(row => row.path === frozen.sourcePath)?.blob !== frozen.sourceBlob) {
    throw new Error("Frozen workflow source mismatch");
  }
  const adoption = tree(frozen.adoptionCommit, frozen.sourcePath,
    ".github/workflows/step-name-alignment.lock.yml").map(record);
  if (adoption.length !== 2 || tree(frozen.baselineCommit, frozen.sourcePath,
    ".github/workflows/step-name-alignment.lock.yml").length !== 0) {
    throw new Error("Actual adoption does not add both source and compiled workflow");
  }
  const baselineAt = new Date(git("show", "-s", "--format=%cI", frozen.baselineCommit).trim())
    .toISOString().replace(".000Z", "Z");
  git("merge-base", "--is-ancestor", frozen.sourceEra, frozen.revision);
  const changes = parseGitChanges(Buffer.from(git("log", "--first-parent", "--full-history",
    "--raw", "--no-abbrev", "--no-renames", "--diff-merges=first-parent",
    "--format=%x00VALUE-COMMIT%x00%H%x00%P%x00%cI%x00", "-z",
    frozen.revision, `^${frozen.sourceEra}`, "--", ".github/workflows/*.lock.yml"))).reverse();
  if (changes.some(row => Date.parse(row.at) >= Date.parse(frozen.cutoff))) {
    throw new Error("Native history escaped exclusive frozen cutoff");
  }
  const profiles = new Map();
  for (const revision of new Set([frozen.revision, frozen.sourceEra,
    ...changes.flatMap(row => [row.commit, row.parents[0]])])) {
    if (!revision) throw new Error("Native change lacks first parent");
    profiles.set(revision, tree(revision, frozen.sourcePath, glossary, ...imports).map(record));
  }
  for (const row of changes) {
    row.changes = row.changes.filter(change => /^\.github\/workflows\/.*\.lock\.yml$/.test(change.path));
    for (const change of row.changes) {
      record(change.beforeBlob ? { blob: change.beforeBlob } : null);
      record(change.afterBlob ? { blob: change.afterBlob } : null);
    }
  }
  const ids = [...descriptors.keys()];
  const checks = spawnSync("git", [`--git-dir=${gitDirectory}`, "cat-file",
    "--batch-check=%(objectname) %(objecttype) %(objectsize)"], {
    env, encoding: "utf8", input: `${ids.join("\n")}\n`, maxBuffer: 16 * 1024 * 1024,
  });
  if (checks.status !== 0) throw new Error(checks.stderr || "Git object availability failed");
  const lines = checks.stdout.trim().split("\n");
  if (lines.length !== ids.length) throw new Error("Git availability response cardinality mismatch");
  console.error(JSON.stringify({ expectedBlobs: ids.length,
    readableBytes: lines.reduce((sum, line) => sum + (Number(line.split(" ")[2]) || 0), 0) }));
  const readable = [];
  for (let i = 0; i < lines.length; i++) {
    const [id, type, size] = lines[i].split(" ");
    if (id !== ids[i]) throw new Error("Git availability identity mismatch");
    if (type === "missing") descriptors.set(id, { blob: id, status: "missing",
      reason: "Immutable object absent with GIT_NO_LAZY_FETCH=1; metadata is not readable content." });
    else {
      if (type !== "blob" || !Number.isSafeInteger(Number(size)) || Number(size) < 0) {
        throw new Error("Invalid Git blob metadata");
      }
      readable.push(id);
    }
  }
  let decodedBytes = 0;
  for (let offset = 0; offset < readable.length; offset += 64) {
    const batch = readable.slice(offset, offset + 64);
    const response = execFileSync("git", [`--git-dir=${gitDirectory}`, "cat-file", "--batch"], {
      env, input: `${batch.join("\n")}\n`, maxBuffer: 128 * 1024 * 1024,
    });
    let cursor = 0;
    for (const id of batch) {
      const end = response.indexOf(10, cursor);
      const [actual, type, size] = response.subarray(cursor, end).toString("ascii").split(" ");
      if (end < 0 || actual !== id || type !== "blob" || !/^\d+$/.test(size)) {
        throw new Error("Malformed native Git blob response");
      }
      cursor = end + 1;
      const bytes = response.subarray(cursor, cursor + Number(size));
      if (bytes.length !== Number(size) || response[cursor + bytes.length] !== 10 || gitBlob(bytes) !== id) {
        throw new Error("Native Git content identity mismatch");
      }
      decodedBytes += bytes.length;
      if (decodedBytes > 160 * 1024 * 1024) throw new Error("Explicit source archive budget exceeded; acquisition incomplete");
      const content = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
      descriptors.set(id, { blob: id, status: "readable", sha256: sha256(bytes), content });
      cursor += bytes.length + 1;
    }
    if (cursor !== response.length) throw new Error("Trailing native Git response bytes");
  }
  const archive = {
    schemaVersion: 1, kind: "step-name-alignment-native-inputs", frozen,
    acquiredAt: new Date().toISOString(), baselineAt,
    sourcePlan: {
      historicalScope: "Current source era only; earlier acceptance policies are not backdated.",
      eraStartExclusive: frozen.sourceEra,
      commands: ["git ls-tree -r", "git log --first-parent --raw --no-renames --diff-merges=first-parent",
        "git cat-file --batch-check", "git cat-file --batch"],
      environment: { GIT_NO_LAZY_FETCH: "1", GIT_OPTIONAL_LOCKS: "0" },
      nativeExecution: "Git object reads only; fetched workflow, scripts and actions are never executed.",
    },
    sources, adoption, currentFiles, profiles: Object.fromEntries(profiles), changes,
    blobs: Object.fromEntries(descriptors),
    history: { index, selectedEntities: lineage,
      unresolvedReferences: [...selected].filter(number => !lineage.some(row => row.number === number)),
      selection: "Exact workflow marker plus transitive forward/reverse body-reference candidates; not accepted graph edges or outcomes.",
      acquisitionObservationIsHistoricalOutcome: false },
    requests: [
      "Supply missing immutable blobs listed in blobs by exact Git SHA; no new repository scope is required.",
      "For earlier periods, supply complete source/import/glossary and first-parent lock transitions under their historical goal profiles.",
      "For full semantic acceptance, supply independent name-to-actual-step-intent adjudication and regression evidence bound to unchanged execution identities.",
      "For contribution, supply protected original producer receipts and independently verified downstream graph edges; editable markers are candidates only.",
      "The secondary external AI Coding Dictionary contents are not retained; do not infer their historical wording from its URL.",
    ],
  };
  mkdirSync(outputDirectory, { recursive: true });
  const target = path.join(outputDirectory, "native-inputs.json.gz");
  const files = writeJsonArchive(target, archive, { spacing: 0, gzipLevel: 9,
    maxDecodedBytes: 256 * 1024 * 1024, maxParts: 1536 });
  return { archive: target, files: files.length, nativeChanges: changes.length,
    nativeObjects: ids.length, readableObjects: readable.length, decodedBytes,
    currentLocks: currentFiles.length, currentReadableLocks: currentFiles.filter(row =>
      descriptors.get(row.blob).status === "readable").length, lineage: lineage.length };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.length !== 5) throw new Error(
    "usage: node scripts/collect-step-name-alignment.mjs READONLY_GIT_DIR HISTORY_DIR OUTPUT_DIR");
  console.log(JSON.stringify(collect({ gitDirectory: process.argv[2],
    historyDirectory: process.argv[3], outputDirectory: process.argv[4] })));
}
