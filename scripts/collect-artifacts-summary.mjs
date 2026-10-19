import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, mkdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { readOutputHistory } from "../.github/skills/add-operational-value/scripts/collect-output-history.mjs";
import { writeJsonArchive } from "../.github/skills/add-operational-value/scripts/json-archive.mjs";
import { readJson } from "../.github/skills/add-operational-value/scripts/common.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const proof = path.join(root, "docs/operational-value/proof/artifacts-summary");
export const hash = bytes => createHash("sha256").update(bytes).digest("hex");
const contract = JSON.parse(readFileSync(path.join(proof, "contract.json")));

export function discoveryClosure(entities) {
  const direct = entities.filter(row =>
    row.workflowReference?.workflowId === contract.workflow
    || row.workflowReference?.additionalRunReferences?.some(reference => reference.workflowId === contract.workflow)
    || row.unverifiedWorkflowId === contract.workflow);
  const selected = new Set(direct.map(row => row.number));
  let changed;
  do {
    changed = false;
    for (const row of entities) {
      if (selected.has(row.number) || (row.relatedCandidates ?? []).some(n => selected.has(n))) {
        for (const number of [row.number, ...(row.relatedCandidates ?? [])]) {
          if (!selected.has(number)) { selected.add(number); changed = true; }
        }
      }
    }
  } while (changed);
  const available = new Set(entities.map(row => row.number));
  return {
    directCandidates: direct.map(row => row.number).sort((a, b) => a - b),
    entities: entities.filter(row => selected.has(row.number)),
    absentReferences: [...selected].filter(n => !available.has(n)).sort((a, b) => a - b),
    interpretation: "Editable markers and forward/reverse body-reference closure are discovery only; no accepted delivery or creation attribution.",
  };
}

export function collect({ gitDirectory, historyDirectory, outputDirectory = proof }) {
  const git = args => spawnSync("git", [`--git-dir=${gitDirectory}`, ...args], {
    env: { ...process.env, GIT_NO_LAZY_FETCH: "1", GIT_TERMINAL_PROMPT: "0" },
    maxBuffer: 16 * 1024 * 1024,
  });
  const tree = git(["ls-tree", "-r", contract.sourceRevision]);
  if (tree.status !== 0) throw new Error(`Frozen source tree unavailable: ${tree.stderr}`);
  const entries = tree.stdout.toString().trim().split("\n").map(line => {
    const match = line.match(/^(\d+) (\w+) ([a-f0-9]{40})\t(.+)$/);
    if (!match) throw new Error("Malformed Git tree");
    return { mode: match[1], type: match[2], blob: match[3], path: match[4] };
  });
  const sourceMap = new Map(entries.map(row => [row.path, row]));
  const sources = [], missing = [], pending = [
    ".github/workflows/artifacts-summary.md", ".github/workflows/artifacts-summary.lock.yml",
  ];
  const visited = new Set();
  while (pending.length) {
    const file = pending.shift();
    if (visited.has(file)) continue;
    visited.add(file);
    const entry = sourceMap.get(file);
    if (!entry) { missing.push({ path: file, reason: "absent from frozen source tree" }); continue; }
    const response = git(["cat-file", "blob", entry.blob]);
    if (response.status !== 0) {
      missing.push({ ...entry, endpoint: `repos/github/gh-aw/git/blobs/${entry.blob}`,
        reason: "Exact blob content absent locally; no network acquisition authorized." });
      continue;
    }
    const bytes = response.stdout;
    const actual = createHash("sha1").update(`blob ${bytes.length}\0`).update(bytes).digest("hex");
    if (actual !== entry.blob) throw new Error(`Source identity mismatch: ${file}`);
    sources.push({ ...entry, base64: bytes.toString("base64"), sha256: hash(bytes), bytes: bytes.length });
    if (file.endsWith(".md")) {
      const frontmatter = bytes.toString().match(/^---\n([\s\S]*?)\n---/);
      const imports = frontmatter?.[1].match(/^imports:\n((?:[ \t]+.*\n?)*)/m)?.[1] ?? "";
      for (const match of imports.matchAll(/^\s+-\s+([A-Za-z0-9_./-]+\.md)\s*$/gm)) {
        pending.push(`.github/workflows/${match[1]}`);
      }
    }
  }
  const native = sourceMap.get(".github/workflows/artifacts-summary.md");
  if (native?.blob !== contract.sourceBlob) throw new Error("Workflow source escaped frozen identity");
  const { index, entities } = readOutputHistory(historyDirectory);
  if (index.repository !== contract.repository || index.repositoryId !== contract.repositoryId
    || index.sourceRevision !== contract.sourceRevision || index.until !== contract.frozenReportCutoff) {
    throw new Error("History archive scope differs from frozen inventory");
  }
  const destination = path.join(outputDirectory, "history");
  mkdirSync(destination, { recursive: true });
  for (const name of ["history.json.gz", ...index.partitions.map(part => part.file)]) {
    const bytes = readFileSync(path.join(historyDirectory, name));
    if (bytes.length > 256 * 1024) throw new Error(`Oversized history member: ${name}`);
    copyFileSync(path.join(historyDirectory, name), path.join(destination, name));
  }
  const closure = discoveryClosure(entities);
  const censusPath = path.join(root, "docs/operational-value/gh-aw-census/evidence.json.gz");
  const census = readJson(censusPath);
  const retainedRunMetadata = census.runInventory.filter(row =>
    row.path === ".github/workflows/artifacts-summary.md");
  const acquisition = {
    schemaVersion: 1, repository: contract.repository, repositoryId: contract.repositoryId,
    sourceRevision: contract.sourceRevision, cutoff: contract.frozenReportCutoff,
    contractSha256: hash(readFileSync(path.join(proof, "contract.json"))),
    sources, missingSources: missing,
    sourceInventory: entries.filter(row => /artifacts.summary|artifact.*(?:spec|check|grad)|shared\/graders/.test(row.path)),
    history: { partitions: index.partitions.length, entities: entities.length, complete: index.complete,
      originalIndexSha256: hash(readFileSync(path.join(historyDirectory, "history.json.gz"))) },
    discovery: closure,
    retainedRunMetadata: {
      sourceSha256: hash(readFileSync(censusPath)), rows: retainedRunMetadata,
      interpretation: "Retained acquisition metadata only; six listed artifacts on one run do not prove repository-wide inventory accuracy, report delivery, cost or historical completeness.",
    },
    nativePackets: [],
    limitations: [
      "The issue/PR acquisition explicitly excludes Discussions, the workflow's only declared report output.",
      "No independently preserved workflow/run/artifact API pages or original published report bodies were supplied.",
      "Missing blob content and absent discovery references are unknown, not exhausted history.",
      "No historical source-era reconstruction, independent delivery census, costs or economic keep bar is established.",
    ],
  };
  mkdirSync(outputDirectory, { recursive: true });
  writeJsonArchive(path.join(outputDirectory, "acquisition.json.gz"), acquisition,
    { maxDecodedBytes: 64 * 1024 * 1024, maxParts: 512 });
  return { sources: sources.length, missingSources: missing, history: acquisition.history,
    directCandidates: closure.directCandidates, closureEntities: closure.entities.length,
    absentReferences: closure.absentReferences, nativePackets: 0 };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const [gitDirectory, historyDirectory] = process.argv.slice(2);
  if (!gitDirectory || !historyDirectory) throw new Error("usage: collect-artifacts-summary.mjs GIT_DIRECTORY HISTORY_DIRECTORY");
  console.log(JSON.stringify(collect({ gitDirectory, historyDirectory }), null, 2));
}
