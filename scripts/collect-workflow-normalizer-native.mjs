import { execFileSync } from "node:child_process";
import { readFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readOutputHistory } from "../.github/skills/add-operational-value/scripts/collect-output-history.mjs";
import { writeJsonArchive } from "../.github/skills/add-operational-value/scripts/json-archive.mjs";
import { gitBlob, sha256 } from "../docs/operational-value/proof/workflow-normalizer/native.mjs";

export const revision = "c86377ec47b38f0b5af463277ee55d1d03d08da8";
export const cutoff = "2026-10-18T15:00:12Z";
const sourcePaths = [
  ".github/workflows/workflow-normalizer.md",
  ".github/workflows/shared/aw-logs-24h-fetch.md",
  ".github/workflows/shared/reporting.md",
  ".github/workflows/shared/otlp.md",
  ".github/skills/reporting/SKILL.md",
  "docs/src/content/docs/reference/markdown.md",
];

export function collectNativeScope(gitDirectory, historyDirectory, outputDirectory, activatedAt) {
  if (!/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/.test(activatedAt)
    || !Number.isFinite(Date.parse(activatedAt)) || Date.parse(activatedAt) <= Date.parse(cutoff)) {
    throw new Error("Current-source contract activation must not be backdated to the historical cutoff");
  }
  const git = args => execFileSync("git", [`--git-dir=${path.resolve(gitDirectory)}`, ...args], {
    env: { ...process.env, GIT_NO_LAZY_FETCH: "1", GIT_TERMINAL_PROMPT: "0" },
    maxBuffer: 8 * 1024 * 1024, timeout: 30000, stdio: ["ignore", "pipe", "pipe"],
  });
  if (git(["remote", "get-url", "origin"]).toString().trim() !== "https://github.com/github/gh-aw.git") {
    throw new Error("Wrong read-only native Git repository");
  }
  const { index, entities } = readOutputHistory(historyDirectory);
  if (index.repository !== "github/gh-aw" || index.repositoryId !== 1036865607
    || index.sourceRevision !== revision || index.until !== cutoff) throw new Error("History scope mismatch");
  const workflow = index.workflows.find(row => row.id === "workflow-normalizer");
  if (workflow?.gitBlob !== "abfac1d367ff164b08c7184ef9b24174373fb91e") throw new Error("Workflow source mismatch");
  const sources = sourcePaths.map(file => {
    const entry = git(["ls-tree", revision, "--", file]).toString().trim();
    const match = entry.match(/^100644 blob ([a-f0-9]{40})\t(.+)$/);
    if (!match || match[2] !== file) throw new Error(`Unsupported source: ${file}`);
    const bytes = git(["cat-file", "blob", match[1]]);
    if (gitBlob(bytes) !== match[1]) throw new Error("Native source byte identity mismatch");
    return { path: file, gitBlob: match[1], bytes: bytes.length, sha256: sha256(bytes),
      encoding: "base64", content: bytes.toString("base64") };
  });
  const selected = entities.filter(row => row.workflowReference?.workflowId === "workflow-normalizer"
    || row.unverifiedWorkflowId === "workflow-normalizer");
  const historyIndexBytes = readFileSync(path.join(historyDirectory, "history.json.gz"));
  const corpus = {
    schemaVersion: 1, kind: "workflow-normalizer-native-scope", repository: "github/gh-aw",
    repositoryId: 1036865607, revision, cutoff, activatedAt,
    sources,
    discovery: {
      reader: ".github/skills/add-operational-value/scripts/collect-output-history.mjs#readOutputHistory",
      indexSha256: sha256(historyIndexBytes), completeTraversal: index.complete,
      partitions: index.partitions.length, totalEntities: index.totalEntities,
      selected,
      limitation: "Verified inventory and editable references are discovery only. Acquisition-time state is not backdated.",
    },
    production: {
      coverageStatus: "unknown", records: [],
      missingReason: "unacquired-native-report-history-and-independent-active-report-producer",
      requiredInputs: [
        "Complete active reporting-workflow cohort for each 24h interval, including skipped/malformed logs and pagination/storage continuation.",
        "Full original and changed report bytes tied to stable GitHub subjects and independent authoritative body-edit timestamps.",
        "Original report/run/head/safe-output identity from a protected producer; editable attribution and successful jobs are not receipts.",
        "Pinned native producer code, configuration and receipt/source closure that independently binds those bytes and cohort.",
        "Separate explicit downstream graph for workflow-normalizer contribution; selected lineage alone is not a verified graph edge.",
      ],
    },
  };
  mkdirSync(outputDirectory, { recursive: true });
  const file = path.join(outputDirectory, "native-scope.json.gz");
  const files = writeJsonArchive(file, corpus, { spacing: 0, maxDecodedBytes: 16 * 1024 * 1024 });
  return { file, sha256: sha256(readFileSync(file)), files,
    sourceCount: sources.length, selectedCandidates: selected.length };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  if (args.length !== 4) throw new Error("usage: collect-workflow-normalizer-native.mjs GIT-DIRECTORY HISTORY-DIRECTORY OUTPUT-DIRECTORY ACTIVATED-AT");
  console.log(JSON.stringify(collectNativeScope(...args)));
}
