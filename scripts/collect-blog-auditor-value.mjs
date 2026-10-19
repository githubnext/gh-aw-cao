import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readOutputHistory } from "../.github/skills/add-operational-value/scripts/collect-output-history.mjs";
import { writeJsonArchive } from "../.github/skills/add-operational-value/scripts/json-archive.mjs";

export const scope = {
  repository: "github/gh-aw",
  repositoryId: 1036865607,
  revision: "c86377ec47b38f0b5af463277ee55d1d03d08da8",
  cutoff: "2026-10-18T15:00:12Z",
  sourcePath: ".github/workflows/blog-auditor.md",
  sourceBlob: "b641655a917ed1502a3cea3f7cddc511588e84c0",
};

export const digest = value => createHash("sha256").update(JSON.stringify(value)).digest("hex");

export function retainBlogSource(cache, outputDirectory) {
  const git = args => execFileSync("git", [`--git-dir=${cache}`, ...args], {
    env: { ...process.env, GIT_NO_LAZY_FETCH: "1", GIT_TERMINAL_PROMPT: "0" },
    timeout: 30000, maxBuffer: 2 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"],
  });
  if (git(["remote", "get-url", "origin"]).toString().trim() !== "https://github.com/github/gh-aw.git") {
    throw new Error("Unexpected immutable source cache repository");
  }
  const files = [
    scope.sourcePath, ".github/workflows/blog-auditor.lock.yml",
    ...["daily-audit-base", "daily-audit-discussion", "reporting", "otlp", "graders",
      "graders/state-revisit-probability-rep", "graders/recurrence-determinism",
      "graders/recurrence-laminarity"].map(name => `.github/workflows/shared/${name}.md`),
  ];
  const sources = files.map(file => {
    const tree = git(["ls-tree", scope.revision, "--", file]).toString().trim();
    const match = tree.match(/^100644 blob ([a-f0-9]{40})\t(.+)$/);
    if (!match || match[2] !== file) throw new Error(`Invalid immutable tree entry: ${file}`);
    const bytes = git(["cat-file", "blob", match[1]]);
    const blob = createHash("sha1").update(`blob ${bytes.length}\0`).update(bytes).digest("hex");
    if (blob !== match[1] || (file === scope.sourcePath && blob !== scope.sourceBlob)) {
      throw new Error("Immutable blob identity mismatch");
    }
    return { path: file, gitBlob: blob, sha256: createHash("sha256").update(bytes).digest("hex"),
      bytes: bytes.length, encoding: "base64", content: bytes.toString("base64") };
  });
  const adoptionCommit = "31dbf0d7997d44bd86983726e83b7ba3813eafac";
  const parentCommit = "7a9f18a670557265211c70d5f92b100fa00344e4";
  const adoption = {
    commit: adoptionCommit, parent: parentCommit,
    commitMetadata: git(["show", "-s", "--format=%H %P %cI", adoptionCommit, parentCommit]).toString(),
    addedTree: git(["ls-tree", "-r", adoptionCommit, "--", scope.sourcePath,
      ".github/workflows/blog-auditor.lock.yml"]).toString(),
    parentTree: git(["ls-tree", "-r", parentCommit, "--", scope.sourcePath,
      ".github/workflows/blog-auditor.lock.yml"]).toString(),
    originalSourceBlob: "008edcc373481dbda14f4a33bc912388ee880817",
    originalSourceStatus: "missing-local-blob-acquisition-pending",
  };
  if (adoption.parentTree !== "" || !adoption.addedTree.includes(adoption.originalSourceBlob)
    || !adoption.commitMetadata.startsWith(`${adoptionCommit} ${parentCommit} `)) {
    throw new Error("Workflow introduction does not match actual parent");
  }
  const result = { schemaVersion: 1, scope, sources, adoption, executedFetchedCode: false };
  mkdirSync(outputDirectory, { recursive: true });
  writeJsonArchive(path.join(outputDirectory, "source.json.gz"), result);
  return result;
}

export function discoverBlogCandidates(history) {
  const { index, entities } = history;
  if (index.repository !== scope.repository || index.repositoryId !== scope.repositoryId
    || index.sourceRevision !== scope.revision || index.until !== scope.cutoff
    || !index.workflows.some(row => row.id === "blog-auditor"
      && row.path === scope.sourcePath && row.gitBlob === scope.sourceBlob)) {
    throw new Error("Output history does not match frozen blog scope");
  }
  const seeds = entities.filter(row => row.workflowReference?.workflowId === "blog-auditor"
    || row.unverifiedWorkflowId === "blog-auditor");
  const selected = new Set(seeds.map(row => row.number));
  let changed;
  do {
    changed = false;
    for (const row of entities) {
      const related = row.relatedCandidates ?? [];
      if (selected.has(row.number)) {
        for (const number of related) {
          if (!Number.isSafeInteger(number) || number <= 0) throw new Error("Invalid discovery reference");
          if (!selected.has(number)) { selected.add(number); changed = true; }
        }
      } else if (related.some(number => selected.has(number))) {
        selected.add(row.number);
        changed = true;
      }
    }
  } while (changed);
  const candidates = entities.filter(row => selected.has(row.number));
  const retained = new Set(candidates.map(row => row.number));
  return {
    schemaVersion: 1,
    scope,
    historyIndex: index,
    historyIndexDigest: digest(index),
    seedNumbers: seeds.map(row => row.number),
    candidates,
    unresolvedReferences: [...selected].filter(number => !retained.has(number)).sort((a, b) => a - b),
    nativeEvidence: [],
    coverage: {
      survivingIssuePrInventory: index.complete ? "complete" : "partial",
      historicalPageState: "missing",
      snippetCompilation: "missing",
      authoritativeCreationReceipts: "missing",
    },
    limitations: [
      "Editable workflow markers and body references discover candidates, not native technical acceptance or authoritative attribution.",
      "An inventory observed after cutoff cannot establish historical issue state, page content or snippet compilation.",
      "Deleted/transferred objects, edited-away markers, comments and Discussions are outside the shared inventory.",
      "No network acquisition was attempted; historical page captures and independently protected compiler reports are required.",
    ],
  };
}

export function retainDiscovery(historyDirectory, outputDirectory) {
  const result = discoverBlogCandidates(readOutputHistory(historyDirectory));
  mkdirSync(outputDirectory, { recursive: true });
  writeJsonArchive(path.join(outputDirectory, "discovery.json.gz"), result);
  return result;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [historyDirectory, outputDirectory, sourceCache] = process.argv.slice(2);
  if (!historyDirectory || !outputDirectory) throw new Error("Expected HISTORY_DIRECTORY OUTPUT_DIRECTORY");
  const result = retainDiscovery(historyDirectory, outputDirectory);
  if (sourceCache) retainBlogSource(sourceCache, outputDirectory);
  console.log(JSON.stringify({
    seedCount: result.seedNumbers.length,
    candidates: result.candidates.length,
    unresolvedReferences: result.unresolvedReferences.length,
    nativeEvidence: result.nativeEvidence.length,
  }));
}
