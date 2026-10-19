import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { readOutputHistory } from "../.github/skills/add-operational-value/scripts/collect-output-history.mjs";
import { writeJsonArchive } from "../.github/skills/add-operational-value/scripts/json-archive.mjs";

const revision = "c86377ec47b38f0b5af463277ee55d1d03d08da8";
const repository = "github/gh-aw";
const sourcePath = ".github/workflows/daily-credit-limit-test.md";
const destination = "docs/operational-value/proof/daily-credit-limit-test";
const sha256 = bytes => createHash("sha256").update(bytes).digest("hex");
const [cache, history] = process.argv.slice(2);
if (!cache || !history || process.argv.length !== 4) {
  throw new Error("usage: node scripts/daily-credit-limit-test-evidence.mjs READ_ONLY_GIT_CACHE VERIFIED_HISTORY");
}
const env = { ...process.env, GIT_NO_LAZY_FETCH: "1", GIT_TERMINAL_PROMPT: "0" };
const git = args => execFileSync("git", [`--git-dir=${cache}`, ...args], {
  env, maxBuffer: 8 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"],
});
if (git(["remote", "get-url", "origin"]).toString().trim() !== `https://github.com/${repository}.git`) {
  throw new Error("Wrong source repository identity");
}
const paths = [
  sourcePath, ".github/workflows/daily-credit-limit-test.lock.yml",
  ".github/workflows/shared/reporting.md",
  "actions/setup/js/check_daily_aic_workflow_guardrail.cjs",
  "actions/setup/js/check_daily_aic_workflow_guardrail.test.cjs",
  "actions/setup/js/daily_aic_workflow_helpers.cjs",
  "actions/setup/js/daily_aic_workflow_helpers.test.cjs",
  "actions/setup/js/daily_aic_scan.cjs",
  "actions/setup/js/daily_aic_cache_helpers.cjs",
  "actions/setup/js/daily_aic_component_coverage.cjs",
  "actions/setup/js/daily_aic_api_budget.cjs",
  "actions/setup/js/daily_aic_repo_memory_ledger.cjs",
  "actions/setup/js/daily_aic_spec_conformance.test.cjs",
  "actions/setup/js/handle_agent_failure.cjs",
  "actions/setup/js/handle_agent_failure_daily_aic_workflow.test.cjs",
  "actions/setup/md/daily_workflow_aic_exceeded.md",
  "actions/setup/md/daily_workflow_aic_unknown.md",
  "pkg/workflow/compiler_activation_daily_aic.go",
  "pkg/workflow/daily_aic_workflow.go",
  "pkg/workflow/daily_aic_workflow_guardrail_test.go",
  "pkg/workflow/daily_aic_workflow_guardrail_skip_integration_test.go",
  "docs/src/content/docs/specs/ai-credits-specification.md",
];
const missing = [], sources = [];
function capture(commit, file) {
  const tree = git(["ls-tree", commit, "--", file]).toString().trim();
  if (!tree) {
    sources.push({ commit, path: file, status: "absent-in-tree" });
    return;
  }
  const match = tree.match(/^100644 blob ([a-f0-9]{40})\t(.+)$/);
  if (!match || match[2] !== file) throw new Error("Unsupported source mode");
  const blob = match[1];
  const result = spawnSync("git", [`--git-dir=${cache}`, "cat-file", "blob", blob], {
    env, maxBuffer: 8 * 1024 * 1024,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    if (result.status !== 128 || !/bad file|Not a valid object|could not get object info/i.test(String(result.stderr))) {
      throw new Error(`Unexpected source read failure: ${commit}:${file}`);
    }
    const endpoint = `repos/${repository}/git/blobs/${blob}`;
    sources.push({ commit, path: file, blob, status: "missing-local-blob", endpoint });
    missing.push({ kind: "immutable-source", commit, path: file, blob, endpoint });
    return;
  }
  const bytes = result.stdout;
  if (createHash("sha1").update(`blob ${bytes.length}\0`).update(bytes).digest("hex") !== blob) {
    throw new Error("Git source identity mismatch");
  }
  sources.push({ commit, path: file, blob, status: "retained", bytes: bytes.length,
    sha256: sha256(bytes), encoding: "base64", content: bytes.toString("base64") });
}
for (const file of paths) capture(revision, file);
const addition = "0fb669049b80755074f3891de4a85c848acdd167";
const parent = "29e09fa8f846b7e86bdecb541405f39238a06e07";
const profile = "6db8ade37d00364f58495e5d83df673fa28d57fa";
for (const commit of [addition, parent, profile]) {
  capture(commit, sourcePath);
  capture(commit, ".github/workflows/daily-credit-limit-test.lock.yml");
}
const current = sources.find(row => row.commit === revision && row.path === sourcePath);
if (current.blob !== "950ad1930ee32372cb8f254b36eee121cbc94254" || current.status !== "retained") {
  throw new Error("Frozen workflow source mismatch");
}
const profileSource = sources.find(row => row.commit === profile && row.path === sourcePath);
if (profileSource.blob !== current.blob || profileSource.status !== "retained") {
  throw new Error("Current source profile activation not established");
}
const additionMetadata = git(["show", "-s", "--format=%H%n%P%n%cI%n%B", addition]).toString();
if (!additionMetadata.split("\n")[1].split(" ").includes(parent)) throw new Error("Addition parent mismatch");
const boundary = spawnSync("git", [`--git-dir=${cache}`, "rev-parse", "--git-path", "shallow"], { env, encoding: "utf8" });
if (boundary.status !== 0) throw new Error("Cannot resolve shallow boundaries");
let shallow = [];
try { shallow = readFileSync(boundary.stdout.trim(), "utf8").trim().split("\n"); } catch (error) {
  if (error.code !== "ENOENT") throw error;
}
if (shallow.includes(addition)) throw new Error("Source addition is a shallow boundary");
const verified = readOutputHistory(history);
if (verified.index.repository !== repository || verified.index.repositoryId !== 1036865607
  || verified.index.sourceRevision !== revision || verified.index.until !== "2026-10-18T15:00:12Z") {
  throw new Error("Shared history identity mismatch");
}
const selected = verified.entities.filter(row => row.workflowReference?.workflowId === "daily-credit-limit-test");
mkdirSync(destination, { recursive: true });
const write = (name, value) => writeJsonArchive(path.join(destination, name), value, {
  maxDecodedBytes: 64 * 1024 * 1024, maxParts: 512,
});
write("sources.json.gz", { schemaVersion: 1, repository, repositoryId: 1036865607, revision,
  cutoff: verified.index.until, sources, addition: { commit: addition, parent, metadata: additionMetadata,
    verifiedNotShallowBoundary: true }, currentSourceProfile: profile,
  limitation: "Complete bodies retained where present; missing compiled/checker bodies are explicit. No fetched code executed." });
write("lineage.json.gz", { schemaVersion: 1, index: verified.index, selected,
  indexSha256: sha256(readFileSync(path.join(history, "history.json.gz"))),
  verifiedPartitions: verified.index.partitions.length, verifiedEntities: verified.entities.length,
  interpretation: "Discovery only. Editable markers and closed issues prove neither activation eligibility, denial, notification nor absence of inference." });
write("acquisition-review.json", { schemaVersion: 1, repository, revision,
  release: "none; offline-only; endpoints are a review manifest, not an acquisition plan to execute",
  missingSources: missing, nativeEvidenceStatus: "not-acquired",
  requiredNativeFacts: [
    "Complete activation-attempt inventory with immutable workflow/engine/guardrail versions and trusted clock.",
    "Complete same-workflow preceding rolling-24-hour AIC ledger including all relevant attempts, unknown components and usage provenance.",
    "Authoritative guardrail-specific decision bound to repository/run/attempt and activation.",
    "Complete trusted agent/provider inference inventory through terminal opportunity disposition; missing logs are not proof of no inference.",
    "Immutable conclusion-job limit-exceeded message receipt and payload, bound to the same opportunity.",
    "Workflow producer receipts for contribution; period/version-matched costs remain separate.",
  ],
  nativeEndpointTemplates: [
    "repos/github/gh-aw/actions/workflows/daily-credit-limit-test.lock.yml/runs?created=START..END&per_page=100",
    "repos/github/gh-aw/actions/runs/{run_id}/attempts/{attempt_number}/jobs?per_page=100",
    "repos/github/gh-aw/actions/runs/{run_id}/attempts/{attempt_number}/logs",
    "repos/github/gh-aw/actions/runs/{run_id}/artifacts?per_page=100",
    "repos/github/gh-aw/issues/{issue_number}/comments?per_page=100",
  ],
  endpointLimitations: "GitHub runs/jobs/logs/artifacts alone do not establish exhaustive provider requests, independent AIC eligibility or receipt authenticity. A trusted bounded producer for these facts is still required. No producer endpoint was discovered; do not invent one.",
  candidateRunMetadataEndpoints: [...new Set(selected.map(row =>
    `repos/github/gh-aw/actions/runs/${row.workflowReference.runId}`))],
  candidateEndpointStatus: "Unverified editable-marker candidates, not accepted run identities. Attempts and authority must be resolved separately before deeper native evidence acquisition; no acquisition is authorized.",
  missingProducerEndpoints: [
    { fact: "independent complete recorded-AIC ledger", endpoint: null, status: "not-discovered-not-implemented" },
    { fact: "complete agent/provider inference audit", endpoint: null, status: "not-discovered-not-implemented" },
    { fact: "authenticated activation/conclusion producer receipts", endpoint: null, status: "not-discovered-not-implemented" },
  ],
  transitiveSourceClosure: "Incomplete. Missing compiled/checker bodies prevent resolving their complete pinned dependency closure. Available bodies are retained, not summarized as headings.",
  historyReconstruction: "Unknown, not exhausted. Missing adoption/checker bodies and native ledgers prevent historical contract validation; no current predicates are backdated." });
write("native.json.gz", { schemaVersion: 1, kind: "daily-credit-limit-test-native-v1",
  repository, repositoryId: 1036865607, revision, synthetic: false,
  producerStatus: "not-implemented-not-released", opportunities: [], coverage: [],
  limitation: "No native observations acquired. Shared issue/PR lineage is not an activation inventory." });
console.log(JSON.stringify({ retainedSources: sources.filter(row => row.status === "retained").length,
  missingSources: missing.length, selectedDiscoveryEntities: selected.length,
  verifiedPartitions: verified.index.partitions.length, verifiedEntities: verified.entities.length }));
