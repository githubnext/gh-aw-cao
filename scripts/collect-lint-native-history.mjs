import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { gitEvidence } from "../.github/skills/add-operational-value/scripts/git-evidence.mjs";
import { censusDigest, writeCensusJson } from "./operational-value-census-io.mjs";
import { jsFacts, yamlFacts, lintEffect, parserVersion } from "./lint-native-oracles.mjs";

export const lintScopes = {
  "eslint-monster": {
    directory: "eslint-monster", baseline: "5b7ef28a594bd0a936367cd130726c4980bc2637",
    since: "2026-06-26T00:00:00Z", paths: ["actions/setup/js/*.cjs"],
  },
  "daily-yamllint-fixer": {
    directory: "yamllint-fixer", baseline: "c38906bb3fd04ab5bb9d8e0c41ea3f18470d8157",
    since: "2026-06-25T00:00:00Z", paths: [".github/workflows/*.lock.yml"],
  },
};
export const revision = "c86377ec47b38f0b5af463277ee55d1d03d08da8";
export const cutoff = "2026-10-18T15:00:12Z";
export const hashFile = file => createHash("sha256").update(readFileSync(file)).digest("hex");

export function collectLintHistory(workflow, cache, prepareOnly = false) {
  const scope = lintScopes[workflow];
  if (!scope) throw new Error("Unknown lint workflow");
  const directory = `docs/operational-value/proof/${scope.directory}`;
  if (existsSync(path.join(directory, "native-index.json"))) throw new Error("Refusing to overwrite preserved native history");
  mkdirSync(directory, { recursive: true });
  const git = gitEvidence("github/gh-aw", cache);
  const history = git.history(revision, scope.baseline, scope.since, 100000, scope.paths);
  const eligible = file => workflow !== "eslint-monster" || !/\.test\.cjs$/.test(file.path);
  const commits = history.map(row => ({ ...row, changes: row.changes.filter(eligible) })).filter(row => row.changes.length);
  const blobs = commits.flatMap(row => row.changes.flatMap(file => [file.beforeBlob, file.afterBlob].filter(Boolean)));
  console.log(JSON.stringify({ workflow, commits: commits.length, blobs: new Set(blobs).size }));
  if (prepareOnly) return;
  const sourcePath = `.github/workflows/${workflow}.md`;
  const adoption = JSON.parse(readFileSync(path.join(directory, "adoption.json"), "utf8"));
  const parent = adoption.parents[0];
  const actualParents = git.git(["show", "-s", "--format=%P", adoption.sha]).trim().split(" ");
  if (!actualParents.includes(parent) || git.git(["cat-file", "-t", parent]).trim() !== "commit") {
    throw new Error("Adoption real parent is unavailable");
  }
  const addition = git.git(["diff-tree", "--no-commit-id", "--name-status", "-r", parent, adoption.sha, "--", sourcePath]).trim();
  if (addition !== `A\t${sourcePath}`) throw new Error("Not an actual workflow addition");
  const sourceGitBlob = git.git(["rev-parse", `${revision}:${sourcePath}`]).trim();
  const adoptionGitBlob = git.git(["rev-parse", `${adoption.sha}:${sourcePath}`]).trim();
  const sourceBlobs = git.features([sourceGitBlob, adoptionGitBlob], rows => rows.map(row => row));
  writeCensusJson(path.join(directory, "sources.json.gz"), [...sourceBlobs.features.values()]);
  const analyze = workflow === "eslint-monster" ? jsFacts : yamlFacts;
  const acquired = git.features(blobs, rows => rows.map(row => ({ id: row.id, ...analyze(row.content) })),
    { maxBlobs: 200000, maxBytes: 4 * 1024 * 1024 * 1024 });
  const facts = acquired.features;
  const partitions = [];
  let buffer = [];
  const flush = () => {
    if (!buffer.length) return;
    const file = `native-${String(partitions.length + 1).padStart(3, "0")}.json.gz`;
    writeCensusJson(path.join(directory, file), buffer);
    partitions.push({ file, sha256: censusDigest(buffer), rows: buffer.length });
    buffer = [];
  };
  for (const commit of commits) {
    for (const file of commit.changes) {
      const before = facts.get(file.beforeBlob) ?? null, after = facts.get(file.afterBlob) ?? null;
      const modesValid = [file.beforeMode, file.afterMode].every(mode => ["000000", "100644", "100755"].includes(mode));
      buffer.push({ commit: commit.commit, parents: commit.parents, at: commit.at, ...file, before, after,
        value: modesValid ? lintEffect(before, after) : null });
      if (buffer.length >= 200) flush();
    }
  }
  flush();
  const index = { schemaVersion: 1, repository: "github/gh-aw", workflow, revision, cutoff,
    sourceGitBlob, adoptionGitBlob, baseline: scope.baseline, adoptionVerified: true,
    adoptionParent: parent, sourceParentAbsent: true, commits: commits.length, blobs: acquired.uniqueBlobs,
    bytes: acquired.totalBytes, paths: scope.paths, parserVersion,
    oracleSha256: hashFile(new URL("./lint-native-oracles.mjs", import.meta.url)),
    collectorSha256: hashFile(import.meta.filename), partitions };
  writeCensusJson(path.join(directory, "native-index.json"), index);
  console.log(JSON.stringify(index));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [workflow, cache, flag] = process.argv.slice(2);
  collectLintHistory(workflow, cache, flag === "--prepare");
}
