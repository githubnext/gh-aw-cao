import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readJsonArchive, writeJsonArchive } from "../.github/skills/add-operational-value/scripts/json-archive.mjs";

export const updateScope = Object.freeze({
  repository: "github/gh-aw", repositoryId: 1036865607,
  revision: "c86377ec47b38f0b5af463277ee55d1d03d08da8",
  sourceBlob: "219be9c4d425130eeed0e2891de7c821b85ce7cf",
  slug: "smoke-update-cross-repo-pr", until: "2026-10-18T15:00:12Z",
  adoptedAt: "2026-03-02T01:25:35Z",
});
export const updateHash = bytes => createHash("sha256").update(bytes).digest("hex");
export const updateJsonHash = object => updateHash(JSON.stringify(object));
const sourcePath = `.github/workflows/${updateScope.slug}.md`;
const outputRoot = "docs/operational-value/proof/cross-repo-update";
const safeError = error => ({ status: error.status ?? null,
  reason: String(error.stderr ?? error.message).replace(/https:\/\/[^ ]+/g, "[URL]").slice(0, 500) });

export function verifyUpdateBlob(row) {
  const bytes = Buffer.from(row.content, "base64");
  if (row.encoding !== "base64" || bytes.length !== row.size
    || createHash("sha1").update(`blob ${bytes.length}\0`).update(bytes).digest("hex") !== row.sha) {
    throw new Error("Cross-repo update source blob identity mismatch");
  }
  return bytes;
}

export function acquireCrossRepoUpdate(cache, phase) {
  if (!["sources", "outcomes"].includes(phase)) throw new Error("Select sources or outcomes phase");
  mkdirSync(cache, { recursive: true });
  mkdirSync(outputRoot, { recursive: true });
  let calls = 0;
  const request = endpoint => {
    const filename = path.join(cache, `${updateHash(endpoint)}.json`);
    if (existsSync(filename)) return JSON.parse(readFileSync(filename, "utf8"));
    if (++calls > 450) throw new Error("Acquisition budget exhausted; resume with the same cache");
    try {
      const bytes = execFileSync("gh", ["api", endpoint], {
        timeout: 60000, maxBuffer: 16 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"],
      });
      const value = JSON.parse(bytes);
      writeFileSync(filename, bytes);
      return value;
    } catch (error) {
      if (error.status === 1 && /HTTP (404|410)/.test(String(error.stderr))) {
        const value = { unavailable: true, ...safeError(error) };
        writeFileSync(filename, JSON.stringify(value));
        return value;
      }
      throw error;
    }
  };
  const save = (name, value) => {
    writeJsonArchive(`${outputRoot}/${name}.json`, value);
    return value;
  };
  const paginate = endpoint => {
    const values = [];
    for (let page = 1; page <= 100; page++) {
      const rows = request(`${endpoint}${endpoint.includes("?") ? "&" : "?"}per_page=100&page=${page}`);
      if (!Array.isArray(rows)) throw new Error(`Incomplete paginated evidence: ${endpoint}`);
      values.push(...rows);
      if (rows.length < 100) return values;
    }
    throw new Error("Pagination remains open; resume rather than claiming completeness");
  };
  const repo = request("repos/github/gh-aw");
  if (repo.id !== updateScope.repositoryId || repo.private !== false || repo.visibility !== "public") {
    throw new Error("Wrong or non-public source repository identity");
  }
  if (phase === "sources") {
    const commits = paginate(`repos/github/gh-aw/commits?path=${sourcePath}&sha=${updateScope.revision}`);
    const profiles = [];
    for (const commit of commits) {
      const file = request(`repos/github/gh-aw/contents/${sourcePath}?ref=${commit.sha}`);
      const bytes = verifyUpdateBlob(file);
      profiles.push({ commit: commit.sha, parents: commit.parents.map(row => row.sha),
        at: commit.commit.committer.date, path: sourcePath, gitBlob: file.sha,
        sha256: updateHash(bytes), content: bytes.toString("base64") });
      const lock = request(`repos/github/gh-aw/contents/${sourcePath.replace(".md", ".lock.yml")}?ref=${commit.sha}`);
      if (lock.unavailable) throw new Error("Historical compiled workflow unavailable");
      const lockedBytes = verifyUpdateBlob(lock);
      profiles.at(-1).compiled = { gitBlob: lock.sha, sha256: updateHash(lockedBytes),
        content: lockedBytes.toString("base64") };
    }
    if (profiles[0]?.gitBlob !== updateScope.sourceBlob
      || profiles.at(-1)?.commit !== "55e326bff80902ff224fbb187e6af044a2e2e73c") {
      throw new Error("Unexpected workflow history endpoints");
    }
    const additions = request("repos/github/gh-aw/commits/55e326bff80902ff224fbb187e6af044a2e2e73c");
    if (!additions.files?.some(file => file.filename === sourcePath && file.status === "added")
      || additions.parents[0]?.sha !== "dcaa791c750ebcced5caede5702bcb8f40890bbc") {
      throw new Error("Adoption is not a real source addition");
    }
    const parent = request("repos/github/gh-aw/commits/dcaa791c750ebcced5caede5702bcb8f40890bbc");
    const paths = [sourcePath, sourcePath.replace(".md", ".lock.yml"),
      ".github/workflows/shared/otlp.md", ".github/workflows/shared/reporting.md",
      ".github/workflows/shared/smoke-test-brevity.md", "actions/setup/js/push_to_pull_request_branch.cjs",
      "actions/setup/js/safe_output_execution_metadata.cjs",
      "actions/setup/js/repo_helpers.cjs",
      "actions/setup/md/safe_outputs_push_to_pr_branch.md", "pkg/workflow/push_to_pull_request_branch.go",
      "pkg/workflow/push_to_pull_request_branch_validation.go"];
    const sources = paths.map(file => {
      const row = request(`repos/github/gh-aw/contents/${file}?ref=${updateScope.revision}`);
      const bytes = verifyUpdateBlob(row);
      return { path: file, gitBlob: row.sha, sha256: updateHash(bytes), content: bytes.toString("base64") };
    });
    save("sources", { schemaVersion: 1, scope: updateScope, complete: true, profiles, sources,
      adoption: { commit: additions.sha, adoptedAt: additions.commit.committer.date,
        baselineCommit: parent.sha, baselineAt: parent.commit.committer.date } });
    console.log(JSON.stringify({ phase, calls, profiles: profiles.length, sources: sources.length }));
    return;
  }
  const source = readJsonArchive(`${outputRoot}/sources.json`);
  if (!source.complete || source.scope.sourceBlob !== updateScope.sourceBlob) throw new Error("Missing frozen source review");
  const declaredTarget = request("repos/github/gh-aw-side-repo");
  const legacyRepo = request("repos/githubnext/gh-aw-side-repo");
  const visibility = row => row.unavailable ? { unavailable: true, ...row }
    : { id: row.id, fullName: row.full_name, private: row.private, visibility: row.visibility };
  // This public-only producer deliberately has no target-content acquisition path.
  const targets = { frontmatter: visibility(declaredTarget), prose: visibility(legacyRepo) };
  const runs = new Map(), partitions = [];
  let lower = updateScope.adoptedAt;
  for (let month = 3; month <= 10; month++) {
    const upper = month === 10 ? updateScope.until : `2026-${String(month + 1).padStart(2, "0")}-01T00:00:00Z`;
    const found = [], counts = [];
    for (let page = 1; page <= 10; page++) {
      const endpoint = `repos/github/gh-aw/actions/workflows/${updateScope.slug}.lock.yml/runs?created=${encodeURIComponent(`${lower}..${upper}`)}&per_page=100&page=${page}`;
      const response = request(endpoint);
      if (!Array.isArray(response.workflow_runs) || !Number.isSafeInteger(response.total_count)
        || response.total_count > 1000) throw new Error("Run partition must be split before completing inventory");
      counts.push(response.total_count);
      for (const row of response.workflow_runs) {
        if (row.path.split("@")[0] !== sourcePath.replace(".md", ".lock.yml")
          || row.head_repository?.id !== updateScope.repositoryId) throw new Error("Wrong workflow run scope");
        found.push({ id: row.id, attempt: row.run_attempt, event: row.event, status: row.status,
          conclusion: row.conclusion, createdAt: row.created_at, updatedAt: row.updated_at,
          headSha: row.head_sha, headBranch: row.head_branch, workflowId: row.workflow_id });
      }
      if (found.length === response.total_count) break;
      if (!response.workflow_runs.length || page === 10) throw new Error("Incomplete run partition");
    }
    if (new Set(counts).size !== 1 || new Set(found.map(row => row.id)).size !== found.length) {
      throw new Error("Run inventory changed or duplicated during pagination");
    }
    for (const row of found) if (row.createdAt >= updateScope.adoptedAt && row.createdAt < updateScope.until) runs.set(row.id, row);
    partitions.push({ lowerInclusive: lower, upperInclusive: upper, totalCount: found.length, pages: counts.length });
    lower = upper;
  }
  save("acquisition", { schemaVersion: 1, scope: updateScope, observedAt: new Date().toISOString(),
    sourcesSha256: updateJsonHash(source),
    completeness: { retainedRunInventory: true, partitions, targetReachableHistory: false,
      historicalBranchUpdates: false, exactSequentialLineMapping: false,
      reason: "Target content is outside public-only authority. Source does not pin an Odyssey edition or line corpus." },
    targets,
    runs: [...runs.values()].sort((a, b) => a.createdAt.localeCompare(b.createdAt)),
    missing: ["Prose target metadata declares private visibility; no target bodies or bytes are authorized for this public proof.",
      "No source-defined immutable Odyssey edition/line sequence.",
      "No independently retained pre/post push receipt binding run, target repository ID, PR ID and branch.",
      "Declared frontmatter target is unavailable; legacy prose target must not silently substitute for it.",
      "No authorized historical target ref-update ledger."] });
  console.log(JSON.stringify({ phase, calls, runs: runs.size, measured: false }));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.length !== 4) throw new Error("usage: node scripts/collect-cross-repo-update-value.mjs CACHE sources|outcomes");
  acquireCrossRepoUpdate(path.resolve(process.argv[2]), process.argv[3]);
}
