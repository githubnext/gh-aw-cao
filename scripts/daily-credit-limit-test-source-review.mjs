import { createHash } from "node:crypto";
import { readFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { readJson } from "../.github/skills/add-operational-value/scripts/common.mjs";
import { writeJsonArchive } from "../.github/skills/add-operational-value/scripts/json-archive.mjs";

const repository = "github/gh-aw";
const revision = "c86377ec47b38f0b5af463277ee55d1d03d08da8";
const cutoff = "2026-10-18T15:00:12Z";
const root = "docs/operational-value/proof/daily-credit-limit-test";
const sha256 = bytes => createHash("sha256").update(bytes).digest("hex");
const gitBlob = bytes => createHash("sha1").update(`blob ${bytes.length}\0`).update(bytes).digest("hex");
const sha = value => typeof value === "string" && /^[a-f0-9]{40}$/.test(value);
const currentChecker = "63160a3c91d4b5a472bdcea120878dfd2c5852a4";
const currentCompiled = "11aa7a405433b0dff64461a4b4f5b26f637c351d";

function safeFile(name, suffix) {
  if (typeof name !== "string" || !new RegExp(`^[a-f0-9]{40}\\.${suffix}$`).test(name)) {
    throw new Error("Unsafe retained acquisition member");
  }
  return name;
}

export function verifySupplement(archive) {
  if (archive?.schemaVersion !== 1 || archive.repository !== repository
    || archive.revision !== revision || archive.cutoff !== cutoff
    || archive.repositoryId !== 1036865607 || !Array.isArray(archive.originals)
    || archive.originals.length !== 13 || !Array.isArray(archive.predecessorFiles)
    || archive.predecessorFiles.length !== 14 || !Array.isArray(archive.manifest?.receipts)
    || archive.manifest.receipts.length !== 13) throw new Error("Invalid source supplement scope");
  if (archive.manifest.repository !== repository || archive.manifest.repositoryId !== 1036865607
    || archive.manifestSha256 !== "423419233e63d4fa026cfafada370e2475ed8503fc0b400a54fdbf9628bc7146"
    || sha256(Buffer.from(archive.manifestOriginal, "base64")) !== archive.manifestSha256
    || JSON.stringify(JSON.parse(Buffer.from(archive.manifestOriginal, "base64").toString("utf8")))
      !== JSON.stringify(archive.manifest)) throw new Error("Source transport manifest mismatch");
  const predecessorBytes = Buffer.from(archive.predecessorManifestOriginal, "base64");
  if (sha256(predecessorBytes) !== "192d729f471920d0b754518d9b5fc650650b4fcf7ae47b22a796156d7c51d6f7"
    || archive.predecessorManifestSha256 !== sha256(predecessorBytes)
    || JSON.stringify(JSON.parse(predecessorBytes.toString("utf8")).files)
      !== JSON.stringify(archive.predecessorFiles)) throw new Error("Predecessor preservation manifest mismatch");
  const expected = new Map(archive.manifest.receipts.map(row => [row.sha, row]));
  if (expected.size !== 13) throw new Error("Repeated source receipt");
  const sources = new Map();
  for (const row of archive.originals) {
    const receipt = expected.get(row.sha);
    if (!receipt || !sha(row.sha) || receipt.workflow !== "daily-credit-limit-test"
      || receipt.status !== 200 || receipt.method !== "GET"
      || receipt.endpoint !== `repos/${repository}/git/blobs/${row.sha}`) {
      throw new Error("Out-of-scope source receipt");
    }
    safeFile(receipt.blob, "blob");
    safeFile(receipt.response, "response\\.json");
    const bytes = Buffer.from(row.blobBase64, "base64");
    const responseBytes = Buffer.from(row.responseBase64, "base64");
    if (bytes.toString("base64") !== row.blobBase64
      || responseBytes.toString("base64") !== row.responseBase64
      || bytes.length !== receipt.blobBytes || responseBytes.length !== receipt.bodyBytes
      || sha256(bytes) !== receipt.blobSha256 || sha256(responseBytes) !== receipt.bodySha256
      || gitBlob(bytes) !== row.sha) throw new Error("Acquired source original identity mismatch");
    const response = JSON.parse(responseBytes.toString("utf8"));
    if (response.sha !== row.sha || response.encoding !== "base64"
      || response.size !== bytes.length || typeof response.content !== "string"
      || !Buffer.from(response.content, "base64").equals(bytes)) throw new Error("Original response disagrees with blob");
    if (sources.has(row.sha)) throw new Error("Repeated acquired source original");
    sources.set(row.sha, bytes.toString("utf8"));
  }
  if (sources.size !== expected.size) throw new Error("Incomplete acquired source originals");
  return sources;
}

function excerpt(text, needle, label) {
  const lines = text.split("\n");
  const at = lines.findIndex(line => line.includes(needle));
  if (at < 0) throw new Error(`Pinned source assertion failed: ${label}`);
  return { line: at + 1, text: lines[at] };
}

export function produceSourceReview(archive) {
  const sources = verifySupplement(archive);
  const checker = sources.get(currentChecker);
  const compiled = sources.get(currentCompiled);
  const cache = sources.get("b612aa0736735b9f1a01d31525966d56acc50aa9");
  const ledger = sources.get("9da7b5594b554c2e8522602756d1e267301cd479");
  const adoption = sources.get("60a2ab2fa1ff3f49efabcc82628b1efd3507482e");
  if (![checker, compiled, cache, ledger, adoption].every(value => typeof value === "string")) {
    throw new Error("Required pinned source missing");
  }
  const references = [
    { blob: currentChecker, ...excerpt(checker, "// Existing behavior: dispatch-routed runs with aw_context bypass", "all dispatch bypass") },
    { blob: currentChecker, ...excerpt(checker, "if (totalAIC < threshold)", "equality is exceeded") },
    { blob: "b612aa0736735b9f1a01d31525966d56acc50aa9", ...excerpt(cache, "entry.coverage_version !== 3", "cache coverage version") },
    { blob: "9da7b5594b554c2e8522602756d1e267301cd479", ...excerpt(ledger, "Failed to read daily AIC repo-memory ledger", "ledger unreadable error") },
    { blob: currentCompiled, ...excerpt(compiled, "if: needs.activation.outputs.daily_ai_credits_exceeded != 'true'", "agent gate") },
    { blob: currentCompiled, ...excerpt(compiled, 'GH_AW_DAILY_AI_CREDITS_CONTINUE_ON_ERROR: "false"', "fail-closed configuration") },
    { blob: currentCompiled, ...excerpt(compiled, 'GH_AW_MAX_DAILY_AI_CREDITS: "1"', "current cap") },
    { blob: "60a2ab2fa1ff3f49efabcc82628b1efd3507482e", ...excerpt(adoption, "max-daily-ai-credits: 10", "adoption cap") },
  ];
  const directDependencies = [];
  for (const [blob, text] of sources) {
    for (const match of text.matchAll(/require\(["'](\.\/[a-zA-Z0-9_./-]+\.cjs)["']\)/g)) {
      directDependencies.push({ importerBlob: blob, relativePath: match[1],
        status: "source dependency reference only; no code executed or dependency acquired" });
    }
  }
  const bypassStart = checker.indexOf('if (eventName === "workflow_dispatch") {');
  const bypassEnd = checker.indexOf("if (hasSlashCommand", bypassStart);
  const bypassText = checker.slice(bypassStart, bypassEnd);
  if (bypassStart < 0 || bypassEnd < 0 || !bypassText.includes("return true;\n  }")
    || !compiled.includes('GH_AW_DAILY_AI_CREDITS_EXCEEDED: ${{ needs.activation.outputs.daily_ai_credits_exceeded }}')) {
    throw new Error("Source-bound bypass or conclusion-wiring assertion failed");
  }
  return {
    schemaVersion: 1, repository, repositoryId: 1036865607, revision, cutoff,
    measurementKind: "immutable-source-facet-not-runtime-outcome",
    currentSourceClosure: {
      priorMissingEntriesResolved: 13,
      completeRuntimeTransitiveClosure: false,
      acquiredBodiesStatus: "All thirteen exact missing source originals now retained losslessly and identity-verified.",
      limitations: [
        "Literal require discovery is a dependency inventory, not a complete dynamic dependency graph.",
        "The lock checks out github/gh-aw actions without an explicit ref. A runtime checkout receipt is needed to bind the executed checker to an actual commit/blob; a frozen workflow head alone is insufficient.",
        "Action pins and container digests identify intended dependencies, not proof of executed runtime or authenticated provider coverage.",
      ],
    },
    predecessor: {
      preservedFiles: archive.predecessorFiles, status: "all fourteen bytes preserved; not admitted as a native-ready function",
      invalidatedAssumption: "Non-command routed workflow_dispatch was included as an eligible activation. The actual pinned checker bypasses every workflow_dispatch.",
      contractDisposition: "Needs separately reviewed replacement identity; never mutate or silently rescore predecessor reports.",
      authenticationDisposition: "Digest integrity and caller-supplied authentication=verified/producerStatus flags are not authenticated native evidence. The predecessor collector must not be a production native admission boundary.",
    },
    sourceFacts: {
      currentDailyCapAic: 1, currentEngine: "pi", currentModel: "copilot/gpt-5-mini",
      adoptionDailyCapAic: 10, adoptionEngine: "copilot",
      eligibleTriggerScopeUnderActualCurrentChecker: ["schedule"],
      workflowDispatch: "all bypassed by actual checker, including routed non-command, malformed, empty and command contexts",
      thresholdComparison: "recorded-plus-estimated guardrail accounting >= cap; independent recorded-only eligibility remains a stricter proposed measurement, not runtime's own total",
      componentCoverageVersion: 3,
      notification: "Conclusion wiring passes daily guardrail fields and fail-closed mode to handler; source declaration does not prove a published message.",
      executionEvidence: "Compiled agent execution evidence and token_usage files do not establish a complete independent provider-request audit. Empty accounting can mean no billable response, not no request.",
      repoMemoryRead: "Missing shards are ignored; unreadable non-ENOENT reads throw in the actual ledger code.",
    },
    specificationDrift: [
      { subject: "dispatch", specification: "Section 9.8 enumerates bypass cases; implementation bypasses every dispatch.", disposition: "Use actual pinned checker scope for a reviewed replacement; retain spec discrepancy." },
      { subject: "cache", specification: "Section 9.10 says component-coverage version 2; implementation requires 3.", disposition: "Do not replay version 2 as accepted current cache." },
      { subject: "repo-memory", specification: "Section 9.15 says unreadable shards are ignored; implementation throws except ENOENT.", disposition: "No repo-memory acquisition authorized; do not assume equivalent behavior." },
    ],
    sourceReferences: references, directDependencies,
    historicalReadiness: {
      actualSourceAddition: "0fb669049b80755074f3891de4a85c848acdd167",
      actualParent: "29e09fa8f846b7e86bdecb541405f39238a06e07",
      adoptionSourceBody: "Now available; cap 10 and copilot, different from cap 1/pi current source.",
      status: "unknown-not-exhausted",
      limitation: "No per-era runtime checkout identity, historical native ledger, activation inventory or authenticated inference/publication evidence is retained. Newly acquired historical contents do not authorize backdating current predicates.",
    },
    nativeProducer: {
      status: "blocked-not-implemented",
      admittedNativeObservations: null, eligibleCount: null, outcome: null, contribution: null,
      costs: "not-measured", decision: "not-rated",
      reason: "Only immutable source acquisition is authorized and present. No actual runtime activation/run metadata, accounting artifacts, trusted provider audit or publication receipts were released. A truthful full native producer cannot be implemented from source declarations or digest-shaped trust flags.",
      acceptingVerifiedFlags: false,
      requiredAuthority: "A separately authenticated acquisition channel plus exact raw runtime identity/completeness facts; integrity hashes alone cannot supply authenticity.",
      acquisitionReleased: false, automaticResumption: false,
    },
    portfolio: {
      cutoff, reportPublished: false,
      prospectivePredecessorReport: "Retained separately, endpoint 2026-10-19T09:46:04Z, after cutoff; excluded from frozen portfolio.",
      retrospectiveEvaluationCreated: false,
    },
  };
}

export function classifyReviewedTrigger(event, archive) {
  produceSourceReview(archive);
  if (!["schedule", "workflow_dispatch"].includes(event)) throw new Error("Outside selected compiled trigger scope");
  return event === "schedule" ? "guardrail-applicable-not-proven-eligible" : "bypassed";
}

function acquireLocalSupplement(directory, predecessorManifest) {
  const manifestBytes = readFileSync(path.join(directory, "manifest.json"));
  const manifest = JSON.parse(manifestBytes);
  if (sha256(manifestBytes) !== "423419233e63d4fa026cfafada370e2475ed8503fc0b400a54fdbf9628bc7146") {
    throw new Error("Unapproved acquired-source manifest identity");
  }
  const predecessorBytes = readFileSync(predecessorManifest);
  if (sha256(predecessorBytes) !== "192d729f471920d0b754518d9b5fc650650b4fcf7ae47b22a796156d7c51d6f7") {
    throw new Error("Predecessor manifest identity changed");
  }
  const predecessor = JSON.parse(predecessorBytes);
  for (const row of predecessor.files) {
    const bytes = readFileSync(row.path);
    if (bytes.length !== row.bytes || sha256(bytes) !== row.sha256) throw new Error(`Predecessor changed: ${row.path}`);
  }
  const originals = manifest.receipts.map(receipt => ({
    sha: receipt.sha,
    blobBase64: readFileSync(path.join(directory, safeFile(receipt.blob, "blob"))).toString("base64"),
    responseBase64: readFileSync(path.join(directory, safeFile(receipt.response, "response\\.json"))).toString("base64"),
  }));
  const supplement = { schemaVersion: 1, repository, repositoryId: 1036865607, revision, cutoff,
    manifest, manifestOriginal: manifestBytes.toString("base64"), manifestSha256: sha256(manifestBytes),
    originals, predecessorManifestSha256: sha256(predecessorBytes),
    predecessorManifestOriginal: predecessorBytes.toString("base64"), predecessorFiles: predecessor.files };
  const review = produceSourceReview(supplement);
  const output = path.join(root, "source-review-v2");
  mkdirSync(output, { recursive: true });
  writeJsonArchive(path.join(output, "sources-supplement.json.gz"), supplement, {
    maxDecodedBytes: 64 * 1024 * 1024, maxParts: 512,
  });
  writeJsonArchive(path.join(output, "review.json"), review);
  return { supplement, review };
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  const args = process.argv.slice(2);
  if (args[0] === "--verify" && args.length === 1) {
    const file = new URL("../docs/operational-value/proof/daily-credit-limit-test/source-review-v2/sources-supplement.json.gz", import.meta.url);
    const archive = readJson(fileURLToPath(file));
    console.log(JSON.stringify(produceSourceReview(archive)));
  } else if (args.length === 2) {
    const { review } = acquireLocalSupplement(args[0], args[1]);
    console.log(JSON.stringify({ sourceOriginalsVerified: 13, predecessorFilesPreserved: 14,
      nativeProducer: review.nativeProducer.status, portfolioCutoff: cutoff }));
  } else throw new Error("usage: node scripts/daily-credit-limit-test-source-review.mjs SOURCE_BATCH PREDECESSOR_MANIFEST | --verify");
}
