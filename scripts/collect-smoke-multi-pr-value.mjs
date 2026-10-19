import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";
import { readOutputHistory } from "../.github/skills/add-operational-value/scripts/collect-output-history.mjs";
import { censusDigest, writeCensusJson } from "./operational-value-census-io.mjs";

export const multiPrScope = {
  repository: "github/gh-aw", repositoryId: 1036865607, workflowId: "smoke-multi-pr",
  sourceRevision: "c86377ec47b38f0b5af463277ee55d1d03d08da8",
  sourceGitBlob: "edc4cd49f2c9fb6ce86eaebcb9c74108b4da325a", until: "2026-10-18T15:00:12Z",
  directory: "docs/operational-value/proof/smoke-multi-pr-native",
};
const hash = bytes => createHash("sha256").update(bytes).digest("hex");
const sha = value => typeof value === "string" && /^[a-f0-9]{40}$/.test(value);

export function multiPrAcquisition(cache) {
  mkdirSync(cache, { recursive: true });
  let requests = 0;
  const request = (endpoint, binary = false) => {
    if (endpoint !== "repos/github/gh-aw" && !endpoint.startsWith("repos/github/gh-aw/")) throw new Error("Outside assigned public repository");
    const file = path.join(cache, `${hash(endpoint)}.${binary ? "zip" : "json"}`);
    if (existsSync(file)) return binary ? readFileSync(file) : JSON.parse(readFileSync(file, "utf8"));
    if (++requests > 7000) throw new Error("Acquisition budget exhausted; inventory remains incomplete");
    const bytes = execFileSync("gh", ["api", endpoint], { timeout: 60000, maxBuffer: 48 * 1024 * 1024 });
    writeFileSync(file, bytes);
    return binary ? bytes : JSON.parse(bytes);
  };
  const git = (args, binary = false) => execFileSync("git", [`--git-dir=${cache}/upstream.git`, ...args], {
    encoding: binary ? "buffer" : "utf8", timeout: 120000, maxBuffer: 48 * 1024 * 1024,
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
  });
  const metadata = args => git(args).trim();
  const source = (revision, file) => {
    const blob = metadata(["rev-parse", `${revision}:${file}`]);
    const bytes = git(["cat-file", "blob", blob], true);
    if (!sha(blob) || createHash("sha1").update(`blob ${bytes.length}\0`).update(bytes).digest("hex") !== blob) {
      throw new Error("Immutable source identity mismatch");
    }
    return { path: file, gitBlob: blob, sha256: hash(bytes), content: bytes.toString("base64") };
  };
  return { request, git, metadata, source };
}

export function collectMultiPrInventory(cache) {
  const { request, metadata, source } = multiPrAcquisition(cache);
  const scope = multiPrScope, directory = scope.directory;
  mkdirSync(directory, { recursive: true });
  const workflowPath = `.github/workflows/${scope.workflowId}.md`;
  if (source(scope.sourceRevision, workflowPath).gitBlob !== scope.sourceGitBlob) throw new Error("Unexpected source revision");
  const additions = metadata(["log", "--first-parent", "--diff-filter=A", "--format=%H", scope.sourceRevision, "--", workflowPath]).split("\n");
  if (additions.length !== 1 || !sha(additions[0])) throw new Error("Ambiguous adoption");
  const commit = additions[0], parent = metadata(["rev-parse", `${commit}^`]);
  if (metadata(["ls-tree", parent, "--", workflowPath])) throw new Error("False shallow adoption");
  const time = revision => new Date(metadata(["show", "-s", "--format=%cI", revision])).toISOString().replace(".000Z", "Z");
  const adoption = { commit, adoptedAt: time(commit), baselineCommit: parent, baselineAt: time(parent) };
  const versions = metadata(["log", "--first-parent", "--format=%H", scope.sourceRevision, "--", workflowPath]).split("\n");
  const originals = new Map(), profiles = [];
  for (const revision of versions) {
    const workflow = source(revision, workflowPath), text = Buffer.from(workflow.content, "base64").toString("utf8");
    originals.set(workflow.gitBlob, workflow);
    const front = parse(text.split("---")[1]);
    const imports = (front.imports ?? []).map(item => typeof item === "string" ? item : item.uses);
    for (const item of imports) {
      if (!/^shared\/[a-z0-9-]+\.md$/.test(item)) throw new Error("Unreviewed import topology");
      const imported = source(revision, `.github/workflows/${item}`);
      originals.set(imported.gitBlob, imported);
    }
    const task = text.slice(text.indexOf("# Smoke Test:"));
    profiles.push({ revision, at: time(revision), workflowGitBlob: workflow.gitBlob, taskSha256: hash(task),
      era: task.includes("CRLF Line Endings") ? "crlf" : "configuration",
      imports, frontmatter: front });
  }
  const runtimePaths = ["create_pull_request.cjs", "create_pull_request_helpers.cjs", "generate_git_patch.cjs",
    "git_patch_utils.cjs", "process_safe_outputs.cjs", "work_queue_native_creation_delivery.cjs",
    "configure_git_credentials.sh", "safe_output_transport.cjs"];
  for (const name of runtimePaths) {
    const file = `actions/setup/${name.endsWith(".sh") ? "sh" : "js"}/${name}`;
    if (!metadata(["ls-tree", scope.sourceRevision, "--", file])) continue;
    const item = source(scope.sourceRevision, file);
    originals.set(item.gitBlob, item);
  }
  const lock = source(scope.sourceRevision, `.github/workflows/${scope.workflowId}.lock.yml`);
  originals.set(lock.gitBlob, lock);
  const frozen = {
    ...scope, adoption,
    nativeContract: {
      primary: "verified-payload-deliveries", unit: "branch payloads", cadenceDays: 7,
      population: "Every retained initial workflow execution before the cutoff; reruns are separately inventoried and never double-credit an initial execution.",
      acceptedEvidence: "A source-bound protected create-pull-request operation receipt binds the original branch/base/head identities to immutable target-tree pre/post bytes. The base lacks the expected file; the head changes exactly that file with the run-specific required content, unchanged supplied bytes and no sibling payload. CRLF cases retain every carriage return. Each case is credited once, at the native delivery receipt.",
      partialProgress: "Each independently verified branch payload counts even when its sibling or the summary-comment acceptance is unknown. Two PRs or a merge do not prove payload delivery.",
      contentPolicy: "Documentation and original configuration cases have the source's four required LF lines. CRLF cases have the first four required CRLF lines and the final CRLF annotation, accepting the literal annotation or the six-line expansion produced by the source's actual Bash printf; preserve the exact representation and report it separately. A nonempty printable timestamp must parse as a date.",
      missing: "Missing/expired operations, original head/base receipts, supplied payload bytes, source identity or immutable target trees remain null; no successes are inferred from run/job status or editable PR bodies.",
      historicalEras: "Original config case and later CRLF case are different predicates; keep profile-specific quantities and do not infer a comparable trend across the switch.",
      fullAcceptance: "Exactly two correct separate branches from main in one initial execution, matching intended bytes, plus protected proof of the required summary comment. Contribution is receipt-bound, not sole attribution; costs unmeasured.",
      antecedent: "The multi-PR test opportunities are introduced with this workflow. Generic PR creation existed earlier but is not the same test; no invented pre-adoption baseline.",
      canonicalSources: "Canonical run/tool/issue summaries do not contain original Git trees, binary payloads or protected patch/application receipts. Immutable Git plus retained Actions artifacts/logs are required; no dashboard query is substituted.",
    },
    profiles,
  };
  const contractFile = path.join(directory, "contract.json");
  if (existsSync(contractFile) && censusDigest(JSON.parse(readFileSync(contractFile, "utf8"))) !== censusDigest(frozen)) {
    throw new Error("Refusing to alter frozen multi-PR contract");
  }
  writeCensusJson(contractFile, frozen);
  writeCensusJson(path.join(directory, "sources.json.gz"), [...originals.values()]);
  const repo = request("repos/github/gh-aw");
  if (repo.id !== scope.repositoryId || repo.full_name !== scope.repository || repo.private) throw new Error("Wrong public repository");
  const slices = [], runs = new Map();
  const inventory = (start, end) => {
    const query = `repos/github/gh-aw/actions/workflows/smoke-multi-pr.lock.yml/runs?created=${encodeURIComponent(`${start}..${end}`)}&per_page=100`;
    const first = request(`${query}&page=1`);
    if (!Number.isSafeInteger(first.total_count) || !Array.isArray(first.workflow_runs)) throw new Error("Invalid run inventory");
    if (first.total_count > 1000) {
      const middle = new Date(Math.floor((Date.parse(start) + Date.parse(end)) / 2000) * 1000).toISOString().replace(".000Z", "Z");
      if (middle === start || middle === end) throw new Error("Unsplittable run inventory; not complete");
      inventory(start, middle);
      inventory(new Date(Date.parse(middle) + 1000).toISOString().replace(".000Z", "Z"), end);
      return;
    }
    const selected = [...first.workflow_runs];
    for (let page = 2; selected.length < first.total_count; page++) {
      const response = request(`${query}&page=${page}`);
      if (response.total_count !== first.total_count || !response.workflow_runs.length) throw new Error("Run inventory changed during traversal");
      selected.push(...response.workflow_runs);
    }
    if (selected.length !== first.total_count || new Set(selected.map(row => row.id)).size !== selected.length) throw new Error("Incomplete run slice");
    slices.push({ start, end, count: selected.length, responseSha256: censusDigest(selected) });
    for (const run of selected) {
      if (!Number.isSafeInteger(run.id) || !sha(run.head_sha) || runs.has(run.id)
        || run.path.split("@")[0] !== `.github/workflows/${scope.workflowId}.lock.yml`
        || run.created_at < adoption.adoptedAt || run.created_at > scope.until) throw new Error("Run outside frozen inventory");
      if (run.created_at === scope.until) continue;
      runs.set(run.id, { id: run.id, attemptCount: run.run_attempt, at: run.created_at, updatedAt: run.updated_at,
        headSha: run.head_sha, headBranch: run.head_branch, event: run.event, conclusion: run.conclusion,
        repositoryId: run.repository?.id ?? scope.repositoryId, headRepositoryId: run.head_repository?.id ?? null,
        path: run.path, url: run.html_url });
    }
  };
  inventory(adoption.adoptedAt, scope.until);
  const outputs = readOutputHistory("docs/operational-value/gh-aw-workflows/evidence");
  if (outputs.index.complete !== true || outputs.index.until !== scope.until || outputs.index.repository !== scope.repository) {
    throw new Error("Incomplete frozen discovery archive");
  }
  const candidates = outputs.entities.filter(row => row.workflowReference?.workflowId === scope.workflowId || row.unverifiedWorkflowId === scope.workflowId);
  const result = { ...scope, complete: true, observedAt: new Date().toISOString(), slices,
    runs: [...runs.values()].sort((a, b) => a.at.localeCompare(b.at) || a.id - b.id), candidates,
    sourceArchiveSha256: censusDigest([...originals.values()]), contractSha256: censusDigest(frozen),
    discoveryLimitation: "Shared markers are discovery only; deleted outputs and expired run history may be unavailable." };
  writeCensusJson(path.join(directory, "inventory.json.gz"), result);
  console.log(JSON.stringify({ runs: runs.size, candidates: candidates.length, sourceProfiles: profiles.length,
    tasks: [...new Set(profiles.map(item => item.taskSha256))], conclusions: Object.fromEntries(Object.entries(Object.groupBy([...runs.values()], row => row.conclusion)).map(([key, rows]) => [key, rows.length])) }));
  return result;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  collectMultiPrInventory(process.argv[2] ?? ".cache/smoke-multi-pr");
}
