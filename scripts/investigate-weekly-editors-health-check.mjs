import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { readOutputHistory } from "../.github/skills/add-operational-value/scripts/collect-output-history.mjs";
import { writeJsonArchive } from "../.github/skills/add-operational-value/scripts/json-archive.mjs";

export const scope = {
  repository: "github/gh-aw",
  repositoryId: 1036865607,
  revision: "c86377ec47b38f0b5af463277ee55d1d03d08da8",
  cutoff: "2026-10-18T15:00:12Z",
  workflow: "weekly-editors-health-check",
  sourceBlob: "e7d3355795fb9c5b79e6201300fc35d3e09c4e4b",
};

const sha256 = bytes => createHash("sha256").update(bytes).digest("hex");

function suppliedBlob(directory, blob) {
  if (!directory || !existsSync(path.join(directory, `${blob}.blob`))) return null;
  const bytes = readFileSync(path.join(directory, `${blob}.blob`));
  const providerBytes = readFileSync(path.join(directory, `${blob}.response.json`));
  const provider = JSON.parse(providerBytes);
  const manifest = JSON.parse(readFileSync(path.join(directory, "manifest.json")));
  const receipt = manifest.receipts.find(row => row.workflow === scope.workflow && row.sha === blob);
  if (createHash("sha1").update(`blob ${bytes.length}\0`).update(bytes).digest("hex") !== blob
    || provider.sha !== blob || provider.encoding !== "base64" || provider.size !== bytes.length
    || !Buffer.from(provider.content, "base64").equals(bytes)
    || receipt?.sha !== blob || receipt.sha256 !== sha256(bytes) || receipt.bytes !== bytes.length
    || receipt.status !== 200 || receipt.endpoint !== `repos/${scope.repository}/git/blobs/${blob}`) {
    throw new Error("Supplied source/provider identity mismatch");
  }
  return { blob, available: true, sha256: sha256(bytes), content: bytes.toString("base64"),
    provider: { sha256: sha256(providerBytes), content: providerBytes.toString("base64") }, receipt };
}

export function investigate({ cache, historyDirectory, adoptionDirectory, closureDirectory }) {
  const git = args => execFileSync("git", [`--git-dir=${cache}`, ...args], {
    env: { ...process.env, GIT_NO_LAZY_FETCH: "1", GIT_TERMINAL_PROMPT: "0" },
    timeout: 45000,
    maxBuffer: 4 * 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (git(["remote", "get-url", "origin"]).toString().trim() !== `https://github.com/${scope.repository}.git`) {
    throw new Error("Unexpected offline repository identity");
  }
  const history = readOutputHistory(historyDirectory);
  if (history.index.repository !== scope.repository || history.index.repositoryId !== scope.repositoryId
    || history.index.until !== scope.cutoff || history.index.sourceRevision !== scope.revision) {
    throw new Error("Output inventory scope mismatch");
  }
  const candidates = history.entities.filter(row =>
    row.workflowReference?.workflowId === scope.workflow || row.unverifiedWorkflowId === scope.workflow);
  const references = [
    `.github/workflows/${scope.workflow}.md`,
    "docs/src/content/docs/reference/editors.mdx",
    `.github/workflows/${scope.workflow}.lock.yml`,
    ".github/workflows/shared/otlp.md",
    ".github/workflows/shared/noop-reminder.md",
  ];
  const sources = references.map(file => {
    const entry = git(["ls-tree", scope.revision, "--", file]).toString().trim();
    const match = entry.match(/^100644 blob ([a-f0-9]{40})\t(.+)$/);
    if (!match || match[2] !== file) throw new Error(`Missing authoritative tree entry: ${file}`);
    if (file === references[0] && match[1] !== scope.sourceBlob) throw new Error("Workflow blob mismatch");
    const blob = match[1];
    try {
      const bytes = git(["cat-file", "blob", blob]);
      const actual = createHash("sha1").update(`blob ${bytes.length}\0`).update(bytes).digest("hex");
      if (actual !== blob) throw new Error("Offline Git blob integrity failure");
      return { path: file, revision: scope.revision, blob, available: true,
        sha256: sha256(bytes), content: bytes.toString("base64") };
    } catch (error) {
      if (error.status !== 128 || !/could not get object info|Not a valid object name|bad file/.test(String(error.stderr))) {
        throw error;
      }
      const supplied = suppliedBlob(closureDirectory, blob);
      if (supplied) return { path: file, revision: scope.revision, ...supplied };
      return { path: file, revision: scope.revision, blob, available: false,
        missingReason: "Exact tree entry exists but content is absent from read-only offline cache.",
        pendingEndpoint: `repos/${scope.repository}/git/blobs/${blob}` };
    }
  });
  const introductionCandidates = git(["log", "--format=%H %P %cI", "--diff-filter=A", scope.revision,
    "--", references[0]]).toString().trim().split("\n").filter(Boolean);
  const adoptionCommit = "b3d55d8233a71fe28cfb26ec0fcc1427b246ab16";
  const parent = "89c787bd741db726454c4881c8946b934eddb870";
  const addition = git(["ls-tree", adoptionCommit, "--", references[0], references[2]]).toString();
  const predecessor = git(["ls-tree", parent, "--", references[0], references[2]]).toString();
  const metadata = git(["show", "-s", "--format=%H %P %cI", adoptionCommit]).toString().trim();
  if (predecessor || !addition.includes("8031eea07e2c2e113d9c13703262b6b8db057725")
    || !addition.includes("e4cb8c15678f827c1a8f3b9c880b27ee6f5fd989")
    || !metadata.startsWith(`${adoptionCommit} ${parent} `)) throw new Error("Actual workflow adoption verification failed");
  const adoptionSource = suppliedBlob(adoptionDirectory, "8031eea07e2c2e113d9c13703262b6b8db057725");
  const adoptionCompiled = suppliedBlob(closureDirectory, "e4cb8c15678f827c1a8f3b9c880b27ee6f5fd989");
  const changes = git(["log", "--first-parent", "--format=%H %cI", scope.revision,
    "--", references[1]]).toString().trim().split("\n").filter(Boolean);
  if (changes.length > 200) throw new Error("Editor inventory history exceeds bounded offline budget");
  const inventoryHistory = changes.map(line => {
    const [revision, committedAt] = line.split(" ");
    const entry = git(["ls-tree", revision, "--", references[1]]).toString().trim();
    const blob = entry.match(/^100644 blob ([a-f0-9]{40})\t/)?.[1];
    if (!blob) return { revision, committedAt, available: false, reason: "Inventory absent at revision." };
    try {
      const bytes = git(["cat-file", "blob", blob]);
      if (createHash("sha1").update(`blob ${bytes.length}\0`).update(bytes).digest("hex") !== blob) {
        throw new Error("Historical inventory blob identity mismatch");
      }
      return { revision, committedAt, blob, available: true, sha256: sha256(bytes),
        content: bytes.toString("base64") };
    } catch (error) {
      if (error.status !== 128 || !/could not get object info|Not a valid object name|bad file/.test(String(error.stderr))) throw error;
      const supplied = suppliedBlob(closureDirectory, blob);
      if (supplied) return { revision, committedAt, ...supplied };
      return { revision, committedAt, blob, available: false,
        pendingEndpoint: `repos/${scope.repository}/git/blobs/${blob}` };
    }
  });
  const indexBytes = readFileSync(path.join(historyDirectory, "history.json.gz"));
  return {
    schemaVersion: 1, scope, sources, inventoryHistory,
    introductionCandidates,
    introductionStatus: "Actual source/compiled-workflow pair is present at addition and absent at its real parent.",
    adoption: { commit: adoptionCommit, parent, metadata, addition, predecessor,
      source: adoptionSource, compiled: adoptionCompiled },
    httpCheckpoints: [],
    outputHistory: {
      indexSha256: sha256(indexBytes), index: history.index,
      inspectedEntities: history.entities.length, candidates,
      interpretation: "Candidate identities only; editable markers and observed terminal state are not historical HTTP receipts.",
    },
    readiness: {
      sourceClosure: sources.every(row => row.available) && adoptionSource && adoptionCompiled
        && inventoryHistory.every(row => row.available) ? "complete-frozen-and-adoption-source-imports-and-inventory-history"
          : "source-closure-incomplete",
      function: "independent-function-verification-required",
      nativeHttpReceipts: 0,
      nativeOutcomeCount: null,
      historicalCoverage: "unknown",
      evaluation: "native-http-evidence-unavailable; original-receipt-acquisition-open",
    },
    pending: [
      ...sources.filter(row => !row.available).map(row => ({
        endpoint: row.pendingEndpoint, method: "GET", reason: `Read authoritative ${row.path}`,
        approval: "required-before-network",
      })),
      ...inventoryHistory.filter(row => row.pendingEndpoint).map(row => ({
        endpoint: row.pendingEndpoint, method: "GET", reason: "Resolve historical editor inventory without current-state backdating.",
        approval: "required-before-network",
      })),
      ...(!adoptionCompiled ? [{ endpoint: `repos/${scope.repository}/git/blobs/e4cb8c15678f827c1a8f3b9c880b27ee6f5fd989`,
        method: "GET", reason: "Read adoption compiled-workflow body; its tree addition is verified.",
        approval: "required-before-network" }] : []),
      ...(!adoptionSource ? [{ endpoint: `repos/${scope.repository}/git/blobs/8031eea07e2c2e113d9c13703262b6b8db057725`,
        method: "GET", reason: "Read adoption workflow source.", approval: "required-before-network" }] : []),
      { endpoint: `repos/${scope.repository}/actions/workflows/${scope.workflow}.lock.yml/runs?created=2026-02-21T22%3A11%3A11Z..2026-10-18T15%3A00%3A12Z&per_page=100&page=1`,
        method: "GET", reason: "Full-period run discovery, including runs with no surviving issues or pull requests; continue provider pagination.",
        approval: "required-before-network" },
      ...candidates.filter(row => row.workflowReference?.runId).map(row => ({
        endpoint: `repos/${scope.repository}/actions/runs/${row.workflowReference.runId}`,
        method: "GET", reason: "Resolve immutable run/head/attempt identity before inspecting original HTTP evidence.",
        approval: "required-before-network", attempt: "Unverified; enumerate actual attempts and original response artifacts after this metadata.",
      })),
      ...candidates.filter(row => row.workflowReference?.runId).flatMap(row => [
        { endpoint: `repos/${scope.repository}/actions/runs/${row.workflowReference.runId}/artifacts?per_page=100&page=1`,
          method: "GET", reason: "Resolve original producer artifacts, hashes, expiry and pagination after run identity verification.",
          approval: "required-before-network" },
        { endpoint: `repos/${scope.repository}/actions/runs/${row.workflowReference.runId}/jobs?filter=all&per_page=100&page=1`,
          method: "GET", reason: "Resolve all original producer jobs and attempts; workflow success alone is not HTTP evidence.",
          approval: "required-before-network" },
        { endpoint: `repos/${scope.repository}/actions/runs/${row.workflowReference.runId}/logs`,
          method: "GET", reason: "Inspect protected original tool request/response pairs after attempt binding; provider redirect destinations require separate validation.",
          approval: "required-before-network" },
      ]),
    ],
    originalReceiptScope: {
      runIdentity: "Verify repository id, workflow path, immutable head SHA, actual run attempt and producer job before accepting any response.",
      frozenArtifacts: [
        { name: "agent", files: ["agent-session.jsonl", "agent-stdio.log", "sandbox/agent/logs/", "mcp-logs/", "agent_execution.json"],
          retention: "GH_AW_DEFAULT_ARTIFACT_RETENTION_DAYS or 0; actual retention and expiry must come from the provider." },
        { name: "info", files: ["aw_info.json"], role: "Producer identity, not response acceptance." },
        { name: "activation", files: ["aw_info.json", "aw-prompts/prompt-import-tree.json"], role: "Source/import identity, not HTTP acceptance." },
      ],
      adoptionArtifacts: [
        { name: "agent-artifacts", files: ["aw_info.json", "mcp-logs/", "sandbox/firewall/logs/", "agent-stdio.log"] },
        { name: "agent_outputs", files: ["sandbox/agent/logs/", "redacted-urls.log"] },
      ],
      matching: "Bind each original HTTP GET tool request and response to the immutable inventory and resolved URL at that run's head. Keep retries/attempts and captures distinct.",
      safeguards: [
        "Agent narrative, PR status table, successful run and screenshot do not substitute for an original independently attributable response.",
        "Preserve original command and stdout/stderr, raw event bytes, timestamps, immutable artifact identity, provider digest and producer binding.",
        "Retain ancillary documentation responses and all attempted editor endpoints even when outside the three-editor constrained facet.",
        "Source-defined curl GET does not follow redirects; redirected 200 responses cannot replace the original URL's actual status.",
        "Classify expired or absent artifacts as missing instrumentation; distinguish reliable recorded connection failures from collector/setup failures.",
        "No original HTTP data has been acquired by this offline investigator.",
      ],
    },
    limitations: [
      "Source/import closure and editor URL resolution must be read before freezing a reachability facet.",
      "No original HTTP response was present in the normalized issue/PR identity inventory.",
      "Missing HTTP instrumentation is not a service failure; zero discovered editors is not perfect availability.",
      "Screenshots, report claims and current HTTP requests cannot establish past reachability.",
      "Reachability cannot establish functionality, freshness, costs or causal workflow contribution.",
      "No network, fetched source execution, workflow dispatch, policy change, PR or commit is authorized.",
    ],
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const [cache, historyDirectory, output, adoptionDirectory, closureDirectory] = process.argv.slice(2);
  if (!cache || !historyDirectory || !output) throw new Error("usage: CACHE HISTORY_DIRECTORY OUTPUT");
  const report = investigate({ cache, historyDirectory, adoptionDirectory, closureDirectory });
  mkdirSync(path.dirname(output), { recursive: true });
  writeJsonArchive(output, report);
  console.log(JSON.stringify({ output, candidates: report.outputHistory.candidates.length,
    inspectedEntities: report.outputHistory.inspectedEntities, readiness: report.readiness }));
}
