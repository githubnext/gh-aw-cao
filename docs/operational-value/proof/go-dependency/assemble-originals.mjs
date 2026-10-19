import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { brotliCompressSync, constants } from "node:zlib";
import { cutoff, repository, repositoryId, revision, sha256 } from "./custody.mjs";
import { publicScope, response } from "./evidence.mjs";

const [manifestFile, root, output, ...extras] = process.argv.slice(2);
if (!manifestFile || !root || !output || extras.length % 2) {
  throw new Error("usage: assemble-originals.mjs MANIFEST ROOT OUTPUT [EXTRA_MANIFEST EXTRA_ROOT ...]");
}
const files = [], responses = [], acquisition = [];
for (const [manifestPath, directory] of [[manifestFile, root],
  ...Array.from({ length: extras.length / 2 }, (_, index) => [extras[2 * index], extras[2 * index + 1]])]) {
  const manifestBytes = readFileSync(manifestPath), external = JSON.parse(manifestBytes);
  if (external.repository !== repository || external.repositoryId !== repositoryId
    || (!Array.isArray(external.files) && !Array.isArray(external.receipts))) {
    throw new Error("Wrong external acquisition manifest");
  }
  acquisition.push({ bytes: manifestBytes.length, sha256: sha256(manifestBytes), contentBase64: manifestBytes.toString("base64") });
  const packetFiles = new Map();
  const batchName = path.basename(path.dirname(manifestPath));
  const fileRows = external.files ?? [
    { path: `${batchName}/manifest.json`, bytes: manifestBytes.length, sha256: sha256(manifestBytes) },
    ...external.receipts.flatMap(row => [
      { path: `${batchName}/${row.response}`, bytes: row.bodyBytes, sha256: row.bodySha256 },
      { path: `${batchName}/${row.blob}`, bytes: row.blobBytes, sha256: row.blobSha256 },
    ]),
  ];
  for (const row of fileRows) {
    if (!/^[a-z0-9-]+\/[a-f0-9a-z.-]+$/.test(row.path)) throw new Error("Unsafe original packet path");
    const bytes = readFileSync(path.join(directory, row.path));
    if (bytes.length !== row.bytes || sha256(bytes) !== row.sha256) throw new Error(`Raw packet mismatch: ${row.path}`);
    const text = bytes.toString("utf8");
    if (!Buffer.from(text).equals(bytes)) throw new Error("Original is not losslessly UTF8");
    const stored = { ...row, contentUtf8: text };
    if (files.some(prior => prior.path === row.path)) throw new Error("Repeated original packet path");
    files.push(stored);
    packetFiles.set(row.path, bytes);
  }
  for (const [file, bytes] of packetFiles) {
    if (!file.endsWith("/manifest.json")) continue;
    const batch = file.split("/")[0], manifest = JSON.parse(bytes);
    const receipts = manifest.receipts ?? manifest.requests;
    if (!Array.isArray(receipts)) throw new Error("Missing original request receipts");
    for (const row of receipts) {
      if (row.method !== "GET" || typeof row.endpoint !== "string"
        || !row.endpoint.startsWith(`repos/${repository}/`)) throw new Error("Out-of-scope original request receipt");
      const rawFile = `${batch}/${row.file ?? row.response}`;
      const raw = packetFiles.get(rawFile);
      if (!raw || raw.length !== (row.bytes ?? row.bodyBytes)
        || sha256(raw) !== (row.sha256 ?? row.bodySha256)) throw new Error("Original receipt/file mismatch");
      responses.push({ endpoint: row.endpoint, status: row.status, receivedAt: row.receivedAt,
        file: rawFile, bytes: raw.length, sha256: sha256(raw),
        paginationComplete: row.paginationComplete ?? null });
    }
  }
}
if (new Set(responses.map(row => row.endpoint)).size !== responses.length) throw new Error("Repeated acquired endpoint");
const originals = { schemaVersion: 1, repository, repositoryId, revision, cutoff,
  observedAt: responses.map(row => row.receivedAt).sort().at(-1), acquisition, files, responses };
publicScope(originals);
for (const row of responses) response(originals, row.endpoint);
const compressed = brotliCompressSync(Buffer.from(`${JSON.stringify(originals)}\n`),
  { params: { [constants.BROTLI_PARAM_QUALITY]: 11, [constants.BROTLI_PARAM_LGWIN]: 24 } });
writeFileSync(output, compressed);
console.log(JSON.stringify({ output, bytes: compressed.length, sha256: sha256(compressed),
  originalPaths: files.length, responses: responses.length, failures: responses.filter(row => row.status !== 200) }, null, 2));
