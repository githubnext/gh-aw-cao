import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { parse } from "yaml";
import { readOutputHistory } from "../.github/skills/add-operational-value/scripts/collect-output-history.mjs";
import { censusDigest, writeCensusJson } from "./operational-value-census-io.mjs";
import { verifyPublicGitBlob } from "./immutable-public-git-source.mjs";

export const crossRepoAuthority = {
  repository: "github/gh-aw", repositoryId: 1036865607,
  workflowId: "smoke-create-cross-repo-pr",
  sourceRevision: "c86377ec47b38f0b5af463277ee55d1d03d08da8",
  sourceGitBlob: "4d112feef189a2c36c76927a25bf96fee2efdb41",
  until: "2026-10-18T15:00:12Z",
};
const directory = "docs/operational-value/proof/cross-repo-creation";
const sourcePath = ".github/workflows/smoke-create-cross-repo-pr.md";
const executionPath = sourcePath.replace(/\.md$/, ".lock.yml");

export function normalizeCrossRepoRun(run) {
  if (!Number.isSafeInteger(run.id) || run.id <= 0 || !Number.isSafeInteger(run.run_attempt)
    || run.run_attempt < 1 || !/^[a-f0-9]{40}$/.test(run.head_sha)
    || run.path?.split("@")[0] !== executionPath || !Number.isFinite(Date.parse(run.created_at))) {
    throw new Error("Invalid cross-repository opportunity identity");
  }
  return { id: run.id, attempt: run.run_attempt, head: run.head_sha, event: run.event,
    at: run.created_at, repositoryId: run.head_repository?.id ?? null };
}

export function collectCrossRepoCreation(cache) {
  mkdirSync(cache, { recursive: true });
  mkdirSync(directory, { recursive: true });
  let requests = 0;
  const api = endpoint => {
    if (!endpoint.startsWith("repos/github/gh-aw/")) throw new Error("Public acquisition escaped source repository");
    const file = path.join(cache, `${censusDigest(endpoint)}.json`);
    if (!existsSync(file)) {
      if (++requests > 250) throw new Error("Bounded public acquisition exhausted; inventory remains incomplete");
      const bytes = execFileSync("gh", ["api", endpoint], {
        timeout: 60000, maxBuffer: 8 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"],
      });
      writeFileSync(file, bytes);
    }
    return JSON.parse(readFileSync(file, "utf8"));
  };
  const sources = new Map();
  const source = (revision, file) => {
    const response = api(`repos/github/gh-aw/contents/${file}?ref=${revision}`);
    if (response.type !== "file" || response.encoding !== "base64" || response.size > 4 * 1024 * 1024) {
      throw new Error("Unavailable bounded immutable source");
    }
    const bytes = verifyPublicGitBlob(Buffer.from(response.content, "base64"), response.sha);
    const row = { path: file, revision, gitBlob: response.sha,
      sha256: createHash("sha256").update(bytes).digest("hex"), content: bytes.toString("base64") };
    sources.set(`${revision}:${file}`, row);
    return { row, text: bytes.toString("utf8") };
  };
  const history = [];
  for (let page = 1; ; page++) {
    const rows = api(`repos/github/gh-aw/commits?path=${sourcePath}&sha=${crossRepoAuthority.sourceRevision}&per_page=100&page=${page}`);
    if (!Array.isArray(rows)) throw new Error("Malformed source-history inventory");
    history.push(...rows.map(row => ({ commit: row.sha, at: row.commit.committer.date,
      parents: row.parents.map(parent => parent.sha) })));
    if (rows.length < 100) break;
  }
  const addition = api(`repos/github/gh-aw/commits/${history.at(-1).commit}`);
  if (addition.files?.find(row => row.filename === sourcePath)?.status !== "added"
    || addition.files?.find(row => row.filename === executionPath)?.status !== "added"
    || addition.parents.length !== 1) throw new Error("Unverified workflow adoption boundary");
  const baseline = api(`repos/github/gh-aw/commits/${addition.parents[0].sha}`);
  const compiledHistory = [];
  for (let page = 1; ; page++) {
    const rows = api(`repos/github/gh-aw/commits?path=${executionPath}&sha=${crossRepoAuthority.sourceRevision}&per_page=100&page=${page}`);
    if (!Array.isArray(rows)) throw new Error("Malformed compiled-history inventory");
    compiledHistory.push(...rows.map(row => ({ commit: row.sha, at: row.commit.committer.date,
      parents: row.parents.map(parent => parent.sha) })));
    if (rows.length < 100) break;
  }
  const profiles = [];
  for (const revision of [...new Set([crossRepoAuthority.sourceRevision, ...history.map(row => row.commit)])]) {
    const markdown = source(revision, sourcePath);
    const frontmatter = parse(markdown.text.split(/^---\s*$/m)[1]);
    const imports = [];
    for (const imported of frontmatter.imports ?? []) {
      if (typeof imported !== "string" || !/^shared\/[a-z0-9-]+\.md$/.test(imported)) {
        throw new Error("Unreviewed historical source import");
      }
      const file = `.github/workflows/${imported}`;
      const content = source(revision, file);
      imports.push({ path: file, gitBlob: content.row.gitBlob, sha256: content.row.sha256 });
    }
    const compiled = source(revision, executionPath);
    const lock = parse(compiled.text);
    const handler = Object.values(lock.jobs).flatMap(job => job.steps ?? [])
      .find(step => step.env?.GH_AW_SAFE_OUTPUTS_HANDLER_CONFIG)?.env.GH_AW_SAFE_OUTPUTS_HANDLER_CONFIG;
    const config = handler ? JSON.parse(handler).create_pull_request : null;
    profiles.push({ revision, markdown: markdown.row.gitBlob, lock: compiled.row.gitBlob,
      imports, configuredTarget: frontmatter["safe-outputs"]?.["create-pull-request"]?.["target-repo"],
      checkout: frontmatter.checkout, handlerTarget: config?.["target-repo"] ?? null,
      jobs: Object.fromEntries(Object.entries(lock.jobs).map(([id, job]) => [id, {
        sha256: censusDigest(job), steps: (job.steps ?? []).map(step => step.name ?? null),
      }])) });
  }
  if (profiles[0].markdown !== crossRepoAuthority.sourceGitBlob) throw new Error("Frozen source changed");
  const runtimeFiles = ["create_pull_request", "create_pull_request_helpers", "repo_helpers",
    "push_signed_commits", "work_queue_native_creation_delivery", "create_or_update_pull_request",
    "execution_provenance", "resolve_transport_paths"];
  for (const name of runtimeFiles) source(crossRepoAuthority.sourceRevision, `actions/setup/js/${name}.cjs`);
  const review = { ...crossRepoAuthority, sourceInventoryComplete: true,
    historicalExecutionCompatibility: "not-established",
    adoption: { commit: addition.sha, adoptedAt: addition.commit.committer.date,
      baselineCommit: baseline.sha, baselineAt: baseline.commit.committer.date },
    history, compiledHistory, profiles, sources: [...sources.values()] };
  writeCensusJson(`${directory}/sources.json.gz`, review);

  const inventory = new Map(), queries = [];
  const traverse = (start, end) => {
    const query = `repos/github/gh-aw/actions/workflows/smoke-create-cross-repo-pr.lock.yml/runs?created=${encodeURIComponent(`${start}..${end}`)}&per_page=100`;
    const first = api(`${query}&page=1`);
    if (!Number.isSafeInteger(first.total_count) || first.total_count < 0) throw new Error("Invalid opportunity total");
    if (first.total_count > 1000) {
      const middle = new Date(Math.floor((Date.parse(start) + Date.parse(end)) / 2000) * 1000).toISOString().replace(".000Z", "Z");
      if (middle === start || middle === end) throw new Error("Opportunity interval cannot be exhausted");
      traverse(start, middle);
      traverse(middle, end);
      return;
    }
    const ids = new Set();
    for (let page = 1; ; page++) {
      const response = page === 1 ? first : api(`${query}&page=${page}`);
      if (response.total_count !== first.total_count || !Array.isArray(response.workflow_runs)) {
        throw new Error("Opportunity traversal changed");
      }
      for (const original of response.workflow_runs) {
        const run = normalizeCrossRepoRun(original);
        if (ids.has(run.id)) throw new Error("Duplicate opportunity within page traversal");
        ids.add(run.id);
        if (run.at >= review.adoption.adoptedAt && run.at < crossRepoAuthority.until) {
          if (inventory.has(run.id) && censusDigest(inventory.get(run.id)) !== censusDigest(run)) {
            throw new Error("Conflicting opportunity discovery");
          }
          inventory.set(run.id, run);
        }
      }
      if (ids.size === first.total_count) break;
      if (!response.workflow_runs.length || ids.size > first.total_count) throw new Error("Incomplete opportunities");
    }
    queries.push({ start, end, total: first.total_count, complete: true });
  };
  traverse(review.adoption.adoptedAt, crossRepoAuthority.until);
  const { index: shared, entities } = readOutputHistory("docs/operational-value/gh-aw-workflows/evidence");
  if (!shared.complete || shared.sourceRevision !== crossRepoAuthority.sourceRevision
    || shared.until !== crossRepoAuthority.until) throw new Error("Shared discovery authority mismatch");
  const candidates = entities.filter(row => row.workflowReference?.workflowId === crossRepoAuthority.workflowId
    || row.unverifiedWorkflowId === crossRepoAuthority.workflowId);
  const retained = [...inventory.values()].sort((a, b) => a.at.localeCompare(b.at) || a.id - b.id);
  const discovery = { queries, retained, candidates, sharedHistorySha256: censusDigest(shared),
    sharedTotalEntities: shared.totalEntities, retainedInventoryComplete: true,
    lifetimeOpportunityComplete: false,
    limitation: "Actions retains only available runs. Deleted runs and unretained initial-attempt source/target receipts cannot be reconstructed from absence." };
  writeCensusJson(`${directory}/discovery.json.gz`, discovery);
  console.log(JSON.stringify({ profiles: profiles.length, sources: sources.size,
    retainedRuns: retained.length, candidates: candidates.length, requests }));
  return { review, discovery };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  if (process.argv.length !== 3) throw new Error("usage: collect-cross-repo-creation-evidence.mjs PRIVATE-WORKSPACE-CACHE");
  collectCrossRepoCreation(process.argv[2]);
}
