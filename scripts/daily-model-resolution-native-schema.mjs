import { createHash } from "node:crypto";
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { inspectNativeBindingSchema } from "../docs/operational-value/proof/daily-model-resolution/native-schema-decoder.mjs";

const packet = process.argv[2];
if (!packet) throw new Error("Supply the explicitly authorized read-only native schema packet");
const root = "docs/operational-value/proof/daily-model-resolution";
const manifestBytes = readFileSync(path.join(packet, "manifest.json"));
const manifest = JSON.parse(manifestBytes);
const expected = ["235e45b977f4e12a88b53efc70adc9f1a5f5fab1", "9ceaea6a74b40d3d9c051af1d56a7e884ddb0e95"];
if (manifest.repository !== "github/gh-aw" || manifest.repositoryId !== 1036865607
  || manifest.receipts?.length !== 2 || manifest.complete !== true
  || !expected.every(sha => manifest.receipts.some(row => row.sha === sha))) {
  throw new Error("Native source packet is outside the authorized exact fixture scope");
}
const retained = new Map();
for (const receipt of manifest.receipts) {
  if (receipt.workflow !== "daily-model-resolution" || receipt.status !== 200 || receipt.method !== "GET"
    || receipt.blob !== `${receipt.sha}.blob` || receipt.response !== `${receipt.sha}.response.json`) {
    throw new Error("Invalid native source receipt");
  }
  const response = readFileSync(path.join(packet, receipt.response));
  const blob = readFileSync(path.join(packet, receipt.blob));
  const decoded = JSON.parse(response);
  if (response.length !== receipt.bodyBytes || blob.length !== receipt.blobBytes
    || createHash("sha256").update(response).digest("hex") !== receipt.bodySha256
    || createHash("sha256").update(blob).digest("hex") !== receipt.blobSha256
    || createHash("sha1").update(`blob ${blob.length}\0`).update(blob).digest("hex") !== receipt.sha
    || decoded.sha !== receipt.sha || decoded.encoding !== "base64"
    || !Buffer.from(decoded.content, "base64").equals(blob)) {
    throw new Error("Native source packet bytes/response/Git identity disagree");
  }
  retained.set(receipt.sha, blob);
}
const originalDirectory = path.join(root, "native-schema-source");
mkdirSync(originalDirectory, { recursive: true });
copyFileSync(path.join(packet, "manifest.json"), path.join(originalDirectory, "manifest.json"));
for (const receipt of manifest.receipts) {
  for (const file of [receipt.blob, receipt.response]) {
    copyFileSync(path.join(packet, file), path.join(originalDirectory, file));
  }
}
const review = {
  ...inspectNativeBindingSchema(retained.get(expected[0]).toString(), retained.get(expected[1]).toString()),
  fixtureOnly: true,
  nativeHistory: false,
  acceptedOperationalObservations: null,
  manifestSha256: createHash("sha256").update(manifestBytes).digest("hex"),
  sourceFixtureHashes: manifest.receipts.map(row => ({
    gitBlob: row.sha, sha256: row.blobSha256, bytes: row.blobBytes,
  })),
  nativeCodeGrounding: [
    {
      gitBlob: "35735346f37c634efd07b19b67131074bb734706",
      path: "pkg/cli/token_usage_subagent_session.go",
      lines: "17-66,575-639,695-799",
      finding: "Structured child lifecycle keys exist; final retry/source scope matters. Request usage objects do not independently establish a proxy-to-child identity bridge.",
    },
    {
      gitBlob: "063eac1e413ce93a6377bf39dcbe1d9be5b48586",
      path: "pkg/cli/token_usage_subagent.go",
      lines: "337-369,402-442",
      finding: "The inspected per-request proxy credit matcher is Pi-only and uses first matching model/token quartet in observed order. It is not unique native child-dispatch identity proof and is not ported as such.",
    },
  ],
  decision: "Do not implement an accepting proxy-to-child decoder from these formats. Keep the operational collector fail-closed and all retained outcomes unknown.",
  readiness: {
    fixtureSchemaDecoderImplemented: true,
    nativeProducerDecoderReady: false,
    functionReady: false,
    nativeEvidenceReady: false,
    nativePlotReady: false,
  },
  scope: "The two fixture requests are resolved. No three-run metadata, history acquisition or further network access was authorized or performed.",
  predecessor: {
    members: 53,
    archiveSha256: "160baa49257f5b645f269cb95fb0be2af22ea7b2a1c0e4d5d71d54449bacccd0",
    manifestSha256: "0bbc41cd3b09624a4ffaf31a9f166e20fec4f47ca41e2ae5bc54eb69af9d158a",
    functionSha256: "cfd556cc3367577d09b9318ec2c0f56fa98e3e0523c7cd9bb98f049f04ccd306",
    timelineSha256: "ecbe1c04175432a8f7173574d6194af5962c7b010d259b656091dff2bc2c9006",
    retention: "All original 53 members remain byte-identical. The original verified owned-only tar, manifest and extraction receipt are retained unchanged; this extension is an additive delta.",
  },
};
writeFileSync(path.join(root, "native-schema-review.json"), `${JSON.stringify(review, null, 2)}\n`);
console.log(JSON.stringify(review, null, 2));
