import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { readJsonArchive, writeJsonArchive } from "../.github/skills/add-operational-value/scripts/json-archive.mjs";

const repository = "github/gh-aw";
const revision = "c86377ec47b38f0b5af463277ee55d1d03d08da8";
const adoption = "aa36291c042c40d6f46e86f0b8604ec1d671a77c";
const parent = "ad364429f1c9100b8b35926b4e58084f5c18b8ce";
const sourcePath = ".github/workflows/daily-observability-report.md";
const missingBlob = "6e4ad427297f871e3a16e62d1cf19847634102e5";
const output = "docs/operational-value/proof/daily-observability-report";
const cache = process.argv[2];
if (!cache) throw new Error("usage: node scripts/daily-observability-report-readiness.mjs BARE_GIT_CACHE");
const git = (...args) => execFileSync("git", ["--git-dir", path.resolve(cache), ...args], {
  env: { ...process.env, GIT_NO_LAZY_FETCH: "1" },
  maxBuffer: 16 * 1024 * 1024,
});
const sha256 = bytes => createHash("sha256").update(bytes).digest("hex");
const gitBlob = bytes => createHash("sha1").update(`blob ${bytes.length}\0`).update(bytes).digest("hex");
const paths = [
  sourcePath,
  ".github/workflows/daily-observability-report.lock.yml",
  ".github/workflows/shared/daily-report-worker.md",
  ".github/workflows/shared/meta-analysis-base.md",
  ".github/workflows/shared/daily-audit-base.md",
  ".github/workflows/shared/daily-audit-discussion.md",
  ".github/workflows/shared/reporting.md",
  ".github/workflows/shared/otlp.md",
  "scratchpad/metrics-glossary.md",
  "pkg/cli/gateway_logs_rpc.go",
  "pkg/cli/gateway_logs_parsing.go",
  "pkg/cli/gateway_logs_types.go",
  "docs/adr/53256-normalize-rpc-messages-jsonl-schema-across-versions.md",
];
const unavailable = [];
const sources = paths.flatMap(file => {
  const tree = git("ls-tree", revision, file).toString().trim();
  const blob = tree.split(/\s+/)[2];
  const available = execFileSync("git", ["--git-dir", path.resolve(cache), "cat-file", "--batch-check"], {
    input: `${blob}\n`, env: { ...process.env, GIT_NO_LAZY_FETCH: "1" },
  }).toString().trim();
  if (available.endsWith(" missing")) {
    unavailable.push({ revision, path: file, gitBlob: blob });
    return [];
  }
  const bytes = git("show", `${revision}:${file}`);
  return [{
    revision, path: file, gitBlob: gitBlob(bytes), sha256: sha256(bytes),
    bytes: bytes.length, encoding: "base64", content: bytes.toString("base64"),
  }];
});
if (sources[0].gitBlob !== "96a8de8af62e2e84d0a1f54c6e0cfdafc132daf1") {
  throw new Error("Frozen workflow identity mismatch");
}
const additionTree = git("ls-tree", adoption, sourcePath).toString().trim();
if (!additionTree.includes(`blob ${missingBlob}\t${sourcePath}`)) {
  throw new Error("Adoption tree no longer matches missing-source request");
}
if (git("ls-tree", parent, sourcePath, sourcePath.replace(".md", ".lock.yml")).length !== 0) {
  throw new Error("Adoption parent already contains workflow");
}
const lockPath = sourcePath.replace(".md", ".lock.yml");
unavailable.push({ revision: adoption, path: lockPath, gitBlob: "00a32d5c50bc0fa581a5a22088b2c1038b3a8e83" });
const absence = execFileSync("git", ["--git-dir", path.resolve(cache), "cat-file", "--batch-check"], {
  input: `${missingBlob}\n`, env: { ...process.env, GIT_NO_LAZY_FETCH: "1" },
}).toString().trim();
if (absence !== `${missingBlob} missing`) {
  throw new Error("Adoption source is now available: resume source review instead of emitting blocked readiness");
}
mkdirSync(output, { recursive: true });
const modulePath = "docs/operational-value/proof/functions/daily-observability-report.mjs";
const collectorVerification = execFileSync(process.execPath, [
  ".github/skills/add-operational-value/scripts/verify-value-function.mjs", "--collector", modulePath,
], { encoding: "utf8" }).trim();
const supplement = readJsonArchive(`${output}/source-supplement.json.gz`);
if (supplement.sources.length !== 3) throw new Error("Required verified source supplement missing");
const adoptionImport = readJsonArchive(`${output}/adoption-reporting-import.json`);
if (adoptionImport.gitBlob !== "77e16fa313dea04900d1b798b80498c1d971be1d"
  || adoptionImport.blobSha256 !== "6a4e09cefde06d6bcb8b9501e0b24ec9b071dced89add449492b42722c47fc1d") {
  throw new Error("Verified shared adoption reporting import missing");
}
writeJsonArchive(`${output}/source-closure.json.gz`, {
  schemaVersion: 1, repository, revision, sources, unavailable,
  adoptionMetadata: git("show", "-s", "--format=%H %cI %P", adoption, parent).toString(),
  additionTree,
  optionalRuntimeImport: {
    path: ".github/shared-instructions.md",
    present: git("ls-tree", revision, ".github/shared-instructions.md").length > 0,
    optional: true,
  },
});
writeJsonArchive(`${output}/readiness.json`, {
  schemaVersion: 1, repository, repositoryId: 1036865607,
  workflow: "daily-observability-report", revision, cutoff: "2026-10-18T15:00:12Z",
  status: "current-native-function-evidence-blocked",
  adoption: {
    commit: adoption, adoptedAt: "2026-01-17T21:13:11Z",
    baselineCommit: parent, baselineAt: "2026-01-17T20:22:18Z",
    additionVerifiedAgainstRealParent: true, sourceBytesAvailable: true,
    compiledBytesAvailable: true, importClosureAvailable: true,
  },
  ready: {
    sourceClosure: true, currentIntentImportsAndNativeSchema: true,
    historicalSourceClosure: true, historicalMetricCompatibility: false,
    acceptanceFrozen: true, function: true,
    nativeEvidence: false,
    evaluation: existsSync(`${output}/reports/github-gh-aw/daily-observability-report-timeline.json`),
    plot: existsSync(`${output}/reports/github-gh-aw/daily-observability-report-pulse.html`),
    collectorVerified: true,
  },
  verification: {
    collector: collectorVerification,
    functionSha256: sha256(readFileSync(modulePath)),
    sourceSha256: sources[0].sha256,
    timelineSha256: existsSync(`${output}/reports/github-gh-aw/daily-observability-report-timeline.json`)
      ? sha256(readFileSync(`${output}/reports/github-gh-aw/daily-observability-report-timeline.json`)) : null,
    focusedTests: "node --test tests/unit/daily-observability-report-native.test.mjs tests/unit/daily-observability-report-readiness.test.mjs",
    lint: "ESLint unavailable locally; dependency installation not authorized",
  },
  boundaries: {
    acceptance: "Frozen current-profile independent structural MCP telemetry prerequisite, not full debugging or firewall acceptance.",
    nativeDiagnostic: "Usable raw MCP telemetry is separate from firewall coverage and effective debugging.",
    sample: "The source caps analysis at 20 runs; no fleet-wide coverage may be inferred.",
    fullAcceptance: null, contribution: null, nativeValue: null,
    costs: "not measured", decision: "not rated",
    historicalClassification: "unresolved; missing baseline evidence is not exhausted reconstruction",
    outcomesInspectedBeforeFreeze: false, syntheticObservations: false,
  },
  resolvedSourceRequests: [...supplement.sources.map(({ receipt }) => ({
    gitBlob: receipt.sha, blobSha256: receipt.blobSha256, originalResponseSha256: receipt.bodySha256,
    receivedAt: receipt.receivedAt,
  })), {
    gitBlob: adoptionImport.gitBlob, blobSha256: adoptionImport.blobSha256,
    originalResponseSha256: adoptionImport.originalResponseSha256,
    receivedAt: adoptionImport.receipt.receivedAt,
  }],
  acquisitionRequests: [{
    kind: "native-producer",
    endpoint: "GET /repos/github/gh-aw/actions/runs?created=WINDOW_START..WINDOW_END&per_page=100",
    followupEndpoints: [
      "GET /repos/github/gh-aw/actions/runs/{run_id}",
      "GET /repos/github/gh-aw/git/blobs/{immutable_configuration_blob}",
      "GET /repos/github/gh-aw/actions/runs/{run_id}/artifacts",
      "GET /repos/github/gh-aw/actions/artifacts/{artifact_id}/zip",
    ],
    allowedNow: false,
    reason: "Independently establish complete candidate inventory, declared capped selection, immutable MCP eligibility and recursive raw telemetry bytes; templates are not resolved run identities.",
  }],
  openScopes: [
    "Preserve reviewed source-era differences: adoption gateway-only broad population versus current capped cohort plus RPC fallback.",
    "Probe retained pre-adoption run inventories, immutable configurations and raw artifacts; do not invent a baseline or classification.",
    "Acquire native evidence under the frozen current profile; do not backdate predicates into unverified historical source eras.",
    "Only after freeze, use production readOutputHistory for lineage discovery, never raw telemetry acceptance.",
    "After source review, request bounded run/configuration/artifact manifests and raw payloads with immutable provenance and cohort binding.",
    "Resolve unavailable native observations; a verified missing-evidence collector or empty plot is not a native measurement.",
  ],
  limitations: [
    "No network acquisition, fetched-code execution, deployment, policy change, commit or campaign enrollment.",
    "Adoption source, compiled bytes and sole import are retained; historical source readiness does not establish compatible native evidence.",
    "No report statement, MCP status 200, successful workflow or synthetic fixture is an observed raw telemetry outcome.",
    "Original adoption source is now available; its predicates differ from the current-only function and are not silently reinterpreted.",
  ],
});
console.log(JSON.stringify({ status: "current-native-function-evidence-blocked", output, sources: sources.length }));
