import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { builtinModules } from "node:module";
import { parse } from "yaml";
import { publicGitSourceReader, verifyPublicGitBlob } from "./immutable-public-git-source.mjs";
import { censusDigest, writeCensusJson } from "./operational-value-census-io.mjs";

export const checkoutDirectory = "docs/operational-value/proof/checkout-pr-dispatch";
export const checkoutSlug = "smoke-checkout-pr-dispatch";
export const checkoutRevision = "c86377ec47b38f0b5af463277ee55d1d03d08da8";
export const checkoutCutoff = "2026-10-18T15:00:12Z";

export function authorCheckoutContract(cache) {
  const repository = "github/gh-aw", sourcePath = `.github/workflows/${checkoutSlug}.md`;
  const lockPath = sourcePath.replace(/\.md$/, ".lock.yml");
  const reader = publicGitSourceReader(cache, repository);
  const git = args => execFileSync("git", [`--git-dir=${cache}`, ...args], {
    encoding: "utf8", maxBuffer: 16 * 1024 * 1024, timeout: 60000,
    env: { ...process.env, GIT_NO_LAZY_FETCH: "1" }, stdio: ["ignore", "pipe", "pipe"],
  }).trimEnd();
  if (git(["rev-parse", "--is-shallow-repository"]) !== "false") throw new Error("Shallow adoption history");
  const additions = git(["log", "--first-parent", "--diff-filter=A", "--format=%H", checkoutRevision, "--", sourcePath]).split("\n");
  if (additions.length !== 1) throw new Error("Ambiguous checkout adoption");
  const adoptionCommit = additions[0], baseline = git(["rev-parse", `${adoptionCommit}^`]);
  if (git(["ls-tree", baseline, "--", sourcePath])) throw new Error("Workflow already exists before adoption");
  const date = commit => new Date(git(["log", "-1", "--no-patch", "--format=%cI", commit])).toISOString().replace(".000Z", "Z");
  const retained = new Map();
  const read = (commit, file) => {
    const mode = git(["ls-tree", commit, "--", file]);
    let row;
    if (mode.startsWith("100755 blob ")) {
      const id = mode.split(/\s+/)[2];
      const response = JSON.parse(execFileSync("gh", ["api", `repos/${repository}/git/blobs/${id}`], {
        encoding: "utf8", maxBuffer: 4 * 1024 * 1024, timeout: 60000,
      }));
      if (response.sha !== id || response.encoding !== "base64") throw new Error("Invalid executable source blob");
      const bytes = verifyPublicGitBlob(Buffer.from(response.content.replace(/\n/g, ""), "base64"), id);
      row = { path: file, id, mode: "100755", native: bytes.toString("base64"), bytes,
        sha256: createHash("sha256").update(bytes).digest("hex") };
    } else row = reader.read(commit, file);
    if (!row) throw new Error(`Missing source: ${commit}:${file}`);
    retained.set(row.id, { ...row, bytes: undefined });
    return row;
  };
  const source = read(checkoutRevision, sourcePath);
  if (source.id !== "d03a4f83ff8fa6cb0a582b8cf4151e0268924ec4") throw new Error("Assigned source changed");
  const builtins = new Set(builtinModules.flatMap(name => [name, `node:${name.replace(/^node:/, "")}`]));
  const closure = (commit, file, seen = new Set()) => {
    if (seen.has(file)) return [];
    seen.add(file);
    const row = read(commit, file), entries = [{ path: file, gitBlob: row.id, sha256: row.sha256 }];
    for (const [, dependency] of row.bytes.toString().matchAll(/require\(["']([^"']+)["']\)/g)) {
      if (builtins.has(dependency) || dependency.startsWith("@actions/")) continue;
      if (!dependency.startsWith("./")) throw new Error(`Unreviewed checker dependency ${dependency}`);
      entries.push(...closure(commit, path.posix.join(path.posix.dirname(file), dependency), seen));
    }
    return entries;
  };
  const history = git(["log", "--first-parent", "--format=%H", `${baseline}..${checkoutRevision}`, "--",
    sourcePath, lockPath, "actions/setup/js/checkout_pr_branch.cjs"]).split("\n").filter(Boolean);
  const profiles = [];
  for (const commit of history) {
    const lock = read(commit, lockPath), document = parse(lock.bytes.toString());
    const checker = read(commit, "actions/setup/js/checkout_pr_branch.cjs");
    const workflow = read(commit, sourcePath);
    const jobs = Object.entries(document.jobs).flatMap(([jobId, job]) =>
      (job.steps ?? []).filter(step => step.id === "checkout-pr" || step.name === "Checkout PR branch").map(step => ({
        jobId, jobName: job.name ?? jobId, jobCondition: job.if ?? null, jobPermissions: job.permissions ?? null,
        step, precedingSteps: job.steps.slice(0, job.steps.indexOf(step)),
      })));
    profiles.push({ commit, at: date(commit), workflowGitBlob: workflow.id, lockGitBlob: lock.id,
      checkerGitBlob: checker.id, checkoutStepSha256: censusDigest(jobs),
      strictPrNumber: checker.bytes.toString().includes("function parsePullRequestNumber("),
      triggers: document.on, checkoutSteps: jobs });
  }
  const dependencies = {};
  for (const commit of [adoptionCommit, checkoutRevision]) {
    const workflow = read(commit, sourcePath).bytes.toString();
    const frontmatter = parse(workflow.split("---")[1]);
    const imports = (frontmatter.imports ?? []).map(file => {
      const row = read(commit, `.github/workflows/${file}`);
      return { path: `.github/workflows/${file}`, gitBlob: row.id, sha256: row.sha256 };
    });
    dependencies[commit] = { imports,
      checkerClosure: closure(commit, "actions/setup/js/checkout_pr_branch.cjs"),
      setup: ["actions/setup/action.yml", "actions/setup/index.js", "actions/setup/setup.sh",
        "actions/setup/js/setup_globals.cjs", "actions/setup/js/generate_aw_info.cjs"].map(file => {
        const row = read(commit, file);
        return { path: file, gitBlob: row.id, sha256: row.sha256 };
      }) };
  }
  read(baseline, "actions/setup/js/checkout_pr_branch.cjs");
  const nativeHistory = git(["log", "--first-parent", "--format=%H", `${baseline}..${checkoutRevision}`, "--",
    "actions/setup/js/checkout_pr_branch.cjs"]).split("\n").map(commit => ({
    commit, at: date(commit), gitBlob: read(commit, "actions/setup/js/checkout_pr_branch.cjs").id,
    diff: git(["diff", "--unified=2", `${commit}^`, commit, "--", "actions/setup/js/checkout_pr_branch.cjs"]),
  }));
  const contract = {
    schemaVersion: 1, version: "1.0.0", repository, repositoryId: 1036865607, workflowId: checkoutSlug,
    sourceRevision: checkoutRevision, sourceGitBlob: source.id, until: checkoutCutoff,
    adoption: { commit: adoptionCommit, adoptedAt: date(adoptionCommit), baselineCommit: baseline, baselineAt: date(baseline) },
    goal: "For every admitted PR-context invocation, check out the intended PR head in a clean initialized Git workspace with origin and visible history.",
    acceptance: "Join the original GitHub event and source policy to a contemporaneous expected PR head/ref and protected pre-agent Git readback; require matching head/ref, clean status, origin, visible commit and a non-main branch.",
    formula: "Count distinct initial invocation opportunities with independently established complete checkout conjunction; unknown outcomes are not zero.",
    antecedent: { result: "pre-existing-but-not-reconstructable",
      reason: "PR checkout and this same Git-state conjunction predate workflow adoption; immutable source cannot reconstruct a historical runner workspace or dispatch payload.",
      baselineProbe: { commit: baseline, eventAndWorkspaceReceipts: "not present in immutable Git",
        requiredSources: ["original event payload", "PR head at protected fetch", "protected Git state before agent execution"] } },
    triggerClasses: ["dispatch-pr", "centralized-slash-pr-dispatch", "direct-pr", "direct-pr-comment",
      "schedule-control", "dispatch-no-pr-control", "issue-slash-control"],
    evidencePlan: {
      source: "Immutable workflow, imports, compiled trigger/job policy and native checkout implementation, reviewed before Actions outcomes.",
      execution: "Exhaust initial-attempt Actions inventory from adoption to cutoff, every event/branch; retain full source profile identities.",
      originalEvent: "Original webhook/GITHUB_EVENT_PATH payload or independently preserved canonical event record bound to run and attempt; never today's editable PR or comment.",
      expectedHead: "Original direct-PR head SHA/ref or independently dated fetch-time PR-ref resolution; payload/fetch races require an explicit bound resolution receipt.",
      actualState: "Protected pre-agent checkout-step readback of HEAD^{commit}, symbolic branch, porcelain status, origin and visible commit count.",
      retention: "Actions jobs/logs/artifacts can expire; missing dispatch inputs or historical PR state stay unknown.",
      canonical: "Specification lines 64-71, 151-161: retained run summaries and seven-day run-linked details do not supply an authoritative checkout conjunction. No canonical snapshot supplied.",
    },
    rejectedProxies: ["overall run/job/agent success", "checkout_pr_success (also true for skipped and closed-PR paths)",
      "non-main branch alone", "checkout configuration", "agent-authored PASS comment", "current PR head backdated"],
    measures: [
      { id: "verified-checkouts", role: "primary", quantity: "Complete independently observed checkout conjunctions." },
      { id: "verified-heads", role: "diagnostic", quantity: "Independent intended head/ref matches, even if cleanliness or other safeguards are unknown." },
    ],
    sourceReview: {
      profiles: profiles.length, checkerVersions: nativeHistory.length,
      eras: [
        "Adoption: dispatch PR extraction; Number coercion; nonfork guard; implicit bot/app trust; direct PR branch or refs/pull/N/head checkout.",
        "Aug 4: preserve full Git history; Aug 17: explicit error codes.",
        "Aug 27: protected actual HEAD baseline exported; adds head-repository identity. Does not assert clean workspace.",
        "Sep 25: strict positive-decimal PR parser, dispatch-only fail-closed fork guard and centralized router actor validation.",
        "Oct 1/8: same-repository bot PR trust and explicit repository null guards.",
        "Oct 9/12/16: allow-listed same-repository comment/review bot trust and ready/reopened PR actions.",
      ],
      compatibility: "Retain each actual source profile. Trust/parser/fork-policy changes are distinct eras, not comparable pooled trends. No unreviewed runtime is promoted from a successful job.",
      closedPR: "Source tolerates closed/deleted PR checkout failures. Require contemporaneous closed-state evidence; do not infer either attainment or ineligibility from job success.",
      schedules: "Schedule without PR context is a negative/no-op control, not a PR checkout opportunity.",
      sourceLimits: "The source asks the agent to perform status/branch/remote/log checks; it contains no protected complete-conjunction verifier.",
    },
    sourceProfiles: profiles.map(({ lockGitBlob, checkerGitBlob, strictPrNumber, checkoutStepSha256 }) =>
      ({ lockGitBlob, checkerGitBlob, strictPrNumber, checkoutStepSha256 })),
    dependencies,
    limitations: ["The function is valid prospectively; measurement remains blocked without independent event/head/workspace receipts.",
      "No successful step or exported baseline alone proves a clean initialized workspace.",
      "Protected post-agent logs and agent reports cannot establish the required pre-agent state.",
      "No costs, sole causation, adoption-relative improvement or keep/retire bar is measured."],
    interpreterSha256: createHash("sha256").update(readFileSync("scripts/native-checkout-pr-value.mjs")).digest("hex"),
  };
  mkdirSync(checkoutDirectory, { recursive: true });
  const parts = [], blobs = [...retained.values()].map(row => JSON.parse(JSON.stringify(row)));
  for (let offset = 0; offset < blobs.length; offset += 12) {
    const rows = blobs.slice(offset, offset + 12), file = `sources-${String(parts.length + 1).padStart(3, "0")}.json.gz`;
    writeCensusJson(`${checkoutDirectory}/${file}`, rows);
    parts.push({ file, count: rows.length, sha256: censusDigest(rows) });
  }
  const sources = { schemaVersion: 1, repository, revision: checkoutRevision,
    sourceCount: retained.size, parts, profiles, nativeHistory };
  writeCensusJson(`${checkoutDirectory}/sources.json.gz`, sources);
  contract.sourcesSha256 = censusDigest(sources);
  writeCensusJson(`${checkoutDirectory}/contract.json`, contract);
  console.log(JSON.stringify({ sourceBlobs: retained.size, profiles: profiles.length, checkerVersions: nativeHistory.length,
    contractSha256: censusDigest(contract), sourceGitBlob: source.id }));
  return contract;
}

if (process.argv[1] === import.meta.filename) {
  if (process.argv.length !== 3) throw new Error("usage: author-checkout-pr-value.mjs BARE_CACHE");
  authorCheckoutContract(process.argv[2]);
}
