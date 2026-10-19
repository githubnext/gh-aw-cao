import path from "node:path";
import { readFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import { base, contract, gitId, readJson, sha256 } from "./objects.mjs";

export function publicOriginals(directory = path.join(base, "public")) {
  const manifest = readJson(path.join(directory, "manifest.json"));
  if (manifest.repository !== contract.repository || manifest.repositoryId !== contract.repositoryId) {
    throw new Error("Public original repository mismatch");
  }
  const read = (receipt, field, length, digest) => {
    const parts = receipt[`${field}Parts`];
    const safeFile = file => {
      if (typeof file !== "string" || path.basename(file) !== file) throw new Error("Unsafe public original path");
      return readFileSync(path.join(directory, file));
    };
    const bytes = parts ? Buffer.concat(parts.map(part => {
      const raw = safeFile(part.file);
      if (sha256(raw) !== part.sha256 || raw.length !== part.bytes) throw new Error("Public original part mismatch");
      return gunzipSync(raw);
    })) : safeFile(receipt[field]);
    if (bytes.length !== length || sha256(bytes) !== digest) throw new Error("Public original digest mismatch");
    return bytes;
  };
  const requests = manifest.groups.flatMap(group => group.requests);
  const result = new Map();
  for (const receipt of requests) {
    if (receipt.status !== 200 || !receipt.startedAt || !receipt.receivedAt
      || Date.parse(receipt.receivedAt) < Date.parse(receipt.startedAt)) throw new Error("Invalid public acquisition receipt");
    const bytes = receipt.response
      ? read(receipt, "response", receipt.bodyBytes, receipt.bodySha256)
      : read(receipt, "file", receipt.bytes, receipt.sha256);
    const body = JSON.parse(bytes);
    if (receipt.blob) {
      const blob = read(receipt, "blob", receipt.blobBytes, receipt.blobSha256);
      if (body.sha !== receipt.sha || gitId("blob", blob) !== receipt.sha
        || body.encoding !== "base64" || !Buffer.from(body.content, "base64").equals(blob)) {
        throw new Error("Provider source bytes do not match immutable original");
      }
    }
    result.set(receipt.endpoint, { receipt, body });
  }
  for (const [endpoint, original] of result) {
    if (!/^repos\/github\/gh-aw\/pulls\/[0-9]+$/.test(endpoint)) continue;
    const metadata = original.body, files = result.get(`${endpoint}/files?per_page=100`);
    if (metadata.base.repo.id !== contract.repositoryId || metadata.base.repo.private !== false
      || metadata.merged !== true || metadata.merged_at >= contract.cutoff
      || !files?.receipt.paginationComplete || files.body.length !== metadata.changed_files) {
      throw new Error("Incomplete or out-of-scope native PR discovery");
    }
  }
  return { manifest, requests, originals: result };
}
