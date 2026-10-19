import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { gzipSync } from "node:zlib";
import { readOutputHistory } from "../.github/skills/add-operational-value/scripts/collect-output-history.mjs";
import { writeJsonArchive } from "../.github/skills/add-operational-value/scripts/json-archive.mjs";

const [cache, output, historyRoot] = process.argv.slice(2);
if (!cache || !output) throw new Error("usage: collect-avenger-offline.mjs READ_ONLY_GIT OUTPUT");
const revision = "c86377ec47b38f0b5af463277ee55d1d03d08da8";
const git = args => execFileSync("git", [`--git-dir=${cache}`, ...args], {
  env: { ...process.env, GIT_NO_LAZY_FETCH: "1", GIT_TERMINAL_PROMPT: "0" },
  maxBuffer: 8 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"],
});
const paths = [
  ".github/workflows/avenger.md", ".github/workflows/avenger.lock.yml",
  ".github/workflows/shared/otlp.md", ".github/workflows/shared/graders.md",
  ".github/workflows/ci.yml", "Makefile", ".golangci.yml", "go.mod",
  "actions/setup/js/package.json", "actions/setup/js/package-lock.json",
  ".prettierignore", ".prettierrc.json", ".prettierrc",
  "scripts/check-stale-lock-files.sh", "scripts/check-skill-file-paths.sh",
  "scripts/validate-cjs-syntax.sh", "scripts/validate-model-alias-chains.js",
  "scripts/check-action-sh-no-python.sh", "scripts/check-stale-schema-binary.sh",
  "scripts/resolve-base-commit.sh", "scripts/check-workflow-drift.sh",
  "scripts/test-wasm-golden.mjs", "pkg/workflow/wasm_golden_test.go",
  "eslint-factory/package.json", "eslint-factory/eslint.config.mjs",
];
const sources = [], missing = [];
for (let i = 0; i < paths.length; i += 1) {
  const path = paths[i];
  const entry = git(["ls-tree", revision, "--", path]).toString().trim();
  if (!entry) { missing.push({ path, reason: "absent from frozen tree" }); continue; }
  const match = entry.match(/^(100644|100755) blob ([a-f0-9]{40})\t/);
  if (!match) throw new Error(`Unsupported source entry: ${path}`);
  let bytes;
  try { bytes = git(["cat-file", "blob", match[2]]); }
  catch (error) {
    if (error.status !== 128) throw error;
    missing.push({ path, gitBlob: match[2], reason: "blob absent from offline cache",
      endpoint: `repos/github/gh-aw/git/blobs/${match[2]}` });
    continue;
  }
  if (createHash("sha1").update(`blob ${bytes.length}\0`).update(bytes).digest("hex") !== match[2]) {
    throw new Error(`Source Git identity mismatch: ${path}`);
  }
  sources.push({ path, mode: match[1], gitBlob: match[2], sha256: createHash("sha256").update(bytes).digest("hex"),
    bytes: bytes.length, content: bytes.toString("base64") });
  if (path.endsWith(".md")) {
    const imports = bytes.toString().match(/^imports:\n((?:[ \t]+.*\n)*)/m)?.[1] ?? "";
    for (const imported of imports.matchAll(/^\s+-\s+([A-Za-z0-9_./-]+\.md)\s*$/gm)) {
      const resolved = `.github/workflows/${imported[1]}`;
      if (!paths.includes(resolved)) paths.push(resolved);
    }
  }
}
const commit = git(["show", "-s", "--format=%H%n%P%n%cI", revision]).toString().trim();
const history = git(["log", revision, "--format=%H %P %cI", "--diff-filter=A", "--",
  ".github/workflows/avenger.md"]).toString().trim();
const addition = "928cdd6ba4a388dfed2d4ddd1d7b229551f7f6bc";
const parent = "f2738c94a86819bc4d95f17ec0081713da78e463";
const adoption = { addition, parent,
  commitObject: git(["cat-file", "commit", addition]).toString(),
  parentCommitObject: git(["cat-file", "commit", parent]).toString(),
  sourceEntry: git(["ls-tree", addition, "--", ".github/workflows/avenger.md"]).toString().trim(),
  parentSourceEntry: git(["ls-tree", parent, "--", ".github/workflows/avenger.md"]).toString().trim(),
  compiledEntry: git(["ls-tree", addition, "--", ".github/workflows/avenger.lock.yml"]).toString().trim(),
  parentCompiledEntry: git(["ls-tree", parent, "--", ".github/workflows/avenger.lock.yml"]).toString().trim(),
};
mkdirSync(output, { recursive: true });
const adoptedSources = [], adoptionMissing = [];
for (const [path, entry] of [[".github/workflows/avenger.md", adoption.sourceEntry],
  [".github/workflows/avenger.lock.yml", adoption.compiledEntry]]) {
  const blob = entry.match(/ blob ([a-f0-9]{40})\t/)?.[1];
  let bytes;
  try { bytes = git(["cat-file", "blob", blob]); }
  catch (error) {
    if (error.status !== 128) throw error;
    adoptionMissing.push({ path, gitBlob: blob, reason: "blob content absent from offline cache",
      endpoint: `repos/github/gh-aw/git/blobs/${blob}` });
    continue;
  }
  if (createHash("sha1").update(`blob ${bytes.length}\0`).update(bytes).digest("hex") !== blob) {
    throw new Error("Adoption blob integrity mismatch");
  }
  adoptedSources.push({ path, gitBlob: blob, bytes: bytes.length,
    sha256: createHash("sha256").update(bytes).digest("hex"), content: bytes.toString("base64") });
}
writeJsonArchive(`${output}/adoption-sources.json.gz`, {
  revision: addition, parent, adoption, sources: adoptedSources, missing: adoptionMissing,
  reviewScope: "Original source and compiled bytes retained as actual-addition provenance, not a historical acceptance profile. No historical checker closure or baseline native observations asserted.",
}, { spacing: 0, gzipLevel: 9 });
const sourceBytes = gzipSync(JSON.stringify({
  repository: "github/gh-aw", repositoryId: 1036865607, revision, commit,
  cutoff: "2026-10-18T15:00:12Z", history, adoption, sources, missing,
}), { level: 9 });
if (sourceBytes.length > 256 * 1024) throw new Error("Source bundle exceeds bounded member size");
writeFileSync(`${output}/sources.json.gz`, sourceBytes);
if (historyRoot) {
  const { index, entities } = readOutputHistory(historyRoot);
  if (index.repositoryId !== 1036865607 || index.sourceRevision !== revision
    || index.until !== "2026-10-18T15:00:12Z") throw new Error("Shared discovery scope mismatch");
  const selected = entities.filter(row => row.workflowReference?.workflowId === "avenger"
    || row.unverifiedWorkflowId === "avenger");
  const relatedNumbers = new Set(selected.flatMap(row => row.relatedCandidates ?? []));
  const related = entities.filter(row => relatedNumbers.has(row.number) && !selected.some(chosen => chosen.id === row.id));
  writeJsonArchive(`${output}/discovery-index.json.gz`, index, { spacing: 0, gzipLevel: 9 });
  writeJsonArchive(`${output}/discovery.json.gz`, {
    schemaVersion: 1, repository: index.repository, repositoryId: index.repositoryId,
    sourceRevision: index.sourceRevision, cutoff: index.until,
    verification: { partitions: index.partitions.length, entities: entities.length, complete: index.complete },
    interpretation: "Lineage discovery only; mutable states and editable markers are observed at acquisition, never native repair or historical contribution proofs.",
    selected, related,
  }, { spacing: 0, gzipLevel: 9 });
  const runIds = [...new Set(selected.map(row => row.workflowReference?.runId).filter(Boolean))].sort();
  const producerEndpoints = runIds.flatMap(runId => [
    `repos/github/gh-aw/actions/runs/${runId}`,
    `repos/github/gh-aw/actions/runs/${runId}/jobs?per_page=100&page=1`,
    `repos/github/gh-aw/actions/runs/${runId}/artifacts?per_page=100&page=1`,
  ]);
  const pullRequestEndpoints = selected.filter(row => row.kind === "PullRequest").map(row =>
    `repos/github/gh-aw/pulls/${row.number}`);
  writeJsonArchive(`${output}/missing-endpoints.json.gz`, {
    schemaVersion: 1, repositoryId: 1036865607, repository: "github/gh-aw", revision,
    networkReleased: false, acquisitionPerformed: false, automaticResume: false,
    source: [...missing, ...adoptionMissing].filter(row => row.endpoint),
    absentAlternateConfigurations: missing.filter(row => !row.endpoint),
    producerEndpoints, pullRequestEndpoints,
    boundedFirstPageOnly: "At most one retained response per listed endpoint. No log/artifact downloads, cursor/page follow, target check, commit or API endpoint is authorized by this manifest. Review retained producer metadata first.",
    producerLimitations: "Original run references are editable discovery, not protected execution receipts. Artifact metadata alone is not payload/readback evidence. Missing/deleted runs and expired artifacts remain missing.",
    currentRequirementEndpoints: [
      "repos/github/gh-aw/branches/main/protection/required_status_checks",
      "repos/github/gh-aw/rules/branches/main",
    ],
    currentRequirementLimitation: "Current policy cannot establish historical enforcement at an earlier head; original required-check snapshots or protected receipts remain necessary.",
    unresolvedNativeEndpoints: [
      { kind: "original-ci-failure", reason: "No independently identified original required CI run/job/head retained; do not invent a run ID from an Avenger output run." },
      { kind: "landed-check", reason: "No accepted landing commit/check run ID or raw native report payload retained; resolve an actual parent/landing graph before proposing exact endpoints." },
      { kind: "native-producer", reason: "No protected native-command producer receipt or adjudicated condition-equivalence catalogue retained. This module does not fabricate or execute one." },
      { kind: "full-lint", reason: "Source-specific stale-lock, skill-path, Node syntax, ESLint, model-alias, shellcheck, no-python and stale-schema decoders are not implemented by the five retained receipt decoders. Keep these checks unavailable." },
    ],
    historicalScope: "Adoption source is retained; adoption compiled content is unavailable despite tree identity being known. Historical import/checker closure and pre-adoption native baseline are not reconstructed, not exhausted, and are not replaced with today's predicates.",
    exactEndpointCount: [...missing, ...adoptionMissing].filter(row => row.endpoint).length
      + producerEndpoints.length + pullRequestEndpoints.length + 2,
  }, { spacing: 0, gzipLevel: 9 });
  console.log(JSON.stringify({ verifiedPartitions: index.partitions.length,
    verifiedEntities: entities.length, selected: selected.length, related: related.length }));
}
console.log(JSON.stringify({ sources: sources.map(({ content, ...source }) => source), missing, history }, null, 2));
