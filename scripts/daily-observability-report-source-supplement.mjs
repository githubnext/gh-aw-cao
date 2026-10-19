import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { writeJsonArchive } from "../.github/skills/add-operational-value/scripts/json-archive.mjs";

const root = process.argv[2];
if (!root) throw new Error("usage: node scripts/daily-observability-report-source-supplement.mjs SOURCE_PACKET_ROOT");
const manifestBytes = readFileSync(path.join(root, "manifest.json"));
const manifest = JSON.parse(manifestBytes);
const sha256 = bytes => createHash("sha256").update(bytes).digest("hex");
const expected = new Set([
  "6e4ad427297f871e3a16e62d1cf19847634102e5",
  "00a32d5c50bc0fa581a5a22088b2c1038b3a8e83",
  "528fea7c90c422fd2a5c112c520b7083bbc1364b",
]);
const receipts = manifest.receipts.filter(receipt => receipt.workflow === "daily-observability-report");
if (manifest.repository !== "github/gh-aw" || manifest.repositoryId !== 1036865607
  || receipts.length !== 3 || new Set(receipts.map(receipt => receipt.sha)).size !== 3) {
  throw new Error("Incorrect immutable source packet scope");
}
const sources = receipts.map(receipt => {
  if (!expected.has(receipt.sha) || receipt.status !== 200
    || receipt.blob !== `${receipt.sha}.blob` || receipt.response !== `${receipt.sha}.response.json`) {
    throw new Error("Unexpected source receipt or unsafe packet member");
  }
  const response = readFileSync(path.join(root, receipt.response));
  const blob = readFileSync(path.join(root, receipt.blob));
  const decoded = JSON.parse(response);
  if (response.length !== receipt.bodyBytes || sha256(response) !== receipt.bodySha256
    || blob.length !== receipt.blobBytes || sha256(blob) !== receipt.blobSha256
    || decoded.sha !== receipt.sha || decoded.encoding !== "base64"
    || !Buffer.from(decoded.content, "base64").equals(blob)
    || createHash("sha1").update(`blob ${blob.length}\0`).update(blob).digest("hex") !== receipt.sha) {
    throw new Error("Source packet response, decoded bytes or Git identity mismatch");
  }
  return {
    receipt, originalResponse: response.toString("base64"), originalBlob: blob.toString("base64"), encoding: "base64",
  };
});
writeJsonArchive("docs/operational-value/proof/daily-observability-report/source-supplement.json.gz", {
  schemaVersion: 1, repository: "github/gh-aw", sourceManifestSha256: sha256(manifestBytes), sources,
  review: {
    adoption: "Actual source addition and parent already verified. Original adoption Markdown uses gateway.jsonl only and encourages broad seven-day fetches; it has no current 20-run cohort cap or RPC fallback acceptance.",
    adoptionImports: "shared/reporting.md blob 77e16fa313dea04900d1b798b80498c1d971be1d remains unavailable locally; optional .github/shared-instructions.md absent at adoption.",
    current: "Current source retains a capped sample, recursive filename discovery and documented RPC fallback. Native types normalize nonempty legacy type before event. No source-derived correction to the current-only structural telemetry predicate.",
    compiled: "Both original compiled workflows safely parsed, never executed. Agent jobs have read-only actions/contents/discussions/issues/pull-requests. Compiled parsing/summary/upload steps operate on the reporting run's own logs; they do not independently prove telemetry in its selected target run cohort. Current evals ask whether analysis/reporting happened, not whether target telemetry is structurally usable.",
    fullAcceptance: "MCP telemetry remains only one prerequisite. Firewall coverage, debugging usefulness, per-server metrics completeness and workflow contribution remain separate and unmeasured.",
    historicalCompatibility: false,
    decision: "Do not backdate current fallback or capped-cohort predicates into adoption-era observations. All retained native results remain unknown.",
  },
});
console.log(JSON.stringify({ verifiedSourceBlobs: sources.length, historicalCompatibility: false }));
