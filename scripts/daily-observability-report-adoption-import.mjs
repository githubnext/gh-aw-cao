import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { writeJsonArchive } from "../.github/skills/add-operational-value/scripts/json-archive.mjs";

const root = process.argv[2];
if (!root) throw new Error("usage: node scripts/daily-observability-report-adoption-import.mjs SOURCE_PACKET_ROOT");
const gitBlob = "77e16fa313dea04900d1b798b80498c1d971be1d";
const expectedSha256 = "6a4e09cefde06d6bcb8b9501e0b24ec9b071dced89add449492b42722c47fc1d";
const hash = bytes => createHash("sha256").update(bytes).digest("hex");
const manifestBytes = readFileSync(path.join(root, "manifest.json"));
const manifest = JSON.parse(manifestBytes);
const receipts = manifest.receipts.filter(receipt => receipt.sha === gitBlob);
if (receipts.length !== 1) throw new Error("Expected exactly one matching shared-source receipt");
const receipt = receipts[0];
const response = readFileSync(path.join(root, `${gitBlob}.response.json`));
const blob = readFileSync(path.join(root, `${gitBlob}.blob`));
const decoded = JSON.parse(response);
if (receipt.status !== 200 || receipt.endpoint !== `repos/github/gh-aw/git/blobs/${gitBlob}`
  || receipt.bytes !== 458 || blob.length !== receipt.bytes || receipt.sha256 !== expectedSha256
  || hash(blob) !== expectedSha256 || decoded.sha !== gitBlob || decoded.encoding !== "base64"
  || !Buffer.from(decoded.content, "base64").equals(blob)
  || createHash("sha1").update(`blob ${blob.length}\0`).update(blob).digest("hex") !== gitBlob) {
  throw new Error("Shared adoption import receipt, decoded content or immutable Git identity mismatch");
}
if (/\bimports\s*:|\{\{#(?:runtime-)?import/.test(blob.toString("utf8"))) {
  throw new Error("Unexpected transitive import: review locally available closure before declaring readiness");
}
writeJsonArchive("docs/operational-value/proof/daily-observability-report/adoption-reporting-import.json", {
  schemaVersion: 1, repository: "github/gh-aw",
  adoptionCommit: "aa36291c042c40d6f46e86f0b8604ec1d671a77c",
  path: ".github/workflows/shared/reporting.md", gitBlob,
  sourceManifestSha256: hash(manifestBytes),
  receipt, originalResponseSha256: hash(response), blobSha256: hash(blob),
  encoding: "base64", originalResponse: response.toString("base64"), originalBlob: blob.toString("base64"),
  review: {
    scope: "Reporting format only: overview/details layout, run links and footer guidance. No tools, permissions, telemetry predicates or transitive imports.",
    originalReceiptWorkflowTag: receipt.workflow,
    applicability: "Shared source is joined by immutable Git blob identity at the verified adoption tree, not by receipt workflow tag.",
    sourceReadiness: "Adoption source, compiled workflow and its sole import are retained; optional runtime import was absent.",
    changesAcceptance: false, historicalCompatibility: false,
    nativeEvidence: "Unknown; resolving source bytes supplies no cohort/configuration/raw-telemetry receipts.",
  },
});
console.log(JSON.stringify({ gitBlob, blobSha256: hash(blob), sourceReadiness: true, changesAcceptance: false }));
