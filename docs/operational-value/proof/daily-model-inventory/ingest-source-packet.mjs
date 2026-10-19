import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readJsonArchive, writeJsonArchive } from "../../../../.github/skills/add-operational-value/scripts/json-archive.mjs";

const [packet, gitDirectory] = process.argv.slice(2);
if (!packet || !gitDirectory || process.argv.length !== 4) {
  throw new Error("usage: node ingest-source-packet.mjs AUTHORIZED_PACKET READ_ONLY_GIT_DIRECTORY");
}
const root = path.dirname(fileURLToPath(import.meta.url));
const hash = bytes => createHash("sha256").update(bytes).digest("hex");
const blobHash = bytes => createHash("sha1").update(`blob ${bytes.length}\0`).update(bytes).digest("hex");
const index = readJsonArchive(path.join(root, "retained.json"));
const sources = readJsonArchive(path.join(root, "sources.json.gz"));
const manifestBytes = readFileSync(path.join(packet, "manifest.json"));
const manifest = JSON.parse(manifestBytes);
if (manifest.repository !== "github/gh-aw" || manifest.repositoryId !== 1036865607
  || !manifest.complete || manifest.receipts.length !== 2) throw new Error("Packet authority mismatch");
const selected = {
  "6d74a0a78cff60c618da7b3b7eb37c1683ba4432": {
    revision: index.sourceAddition.commit, path: ".github/workflows/daily-model-inventory.md",
  },
  e59422ca7af808a73c507f4bb312ace31a7ca18b: {
    revision: index.revision, path: ".github/workflows/daily-model-inventory.lock.yml",
  },
};
const originals = [];
for (const receipt of manifest.receipts) {
  if (!selected[receipt.sha] || receipt.response !== `${receipt.sha}.response.json`
    || receipt.blob !== `${receipt.sha}.blob` || receipt.status !== 200
    || receipt.endpoint !== `repos/github/gh-aw/git/blobs/${receipt.sha}`) throw new Error("Unexpected packet member");
  const responseBytes = readFileSync(path.join(packet, receipt.response));
  const bytes = readFileSync(path.join(packet, receipt.blob));
  const response = JSON.parse(responseBytes);
  if (hash(responseBytes) !== receipt.bodySha256 || responseBytes.length !== receipt.bodyBytes
    || hash(bytes) !== receipt.blobSha256 || bytes.length !== receipt.blobBytes
    || blobHash(bytes) !== receipt.sha || response.sha !== receipt.sha
    || response.encoding !== "base64" || !Buffer.from(response.content, "base64").equals(bytes)) {
    throw new Error("Original provider response/blob integrity mismatch");
  }
  originals.push({ file: receipt.response, body: responseBytes.toString(), sha256: hash(responseBytes) });
  sources.records.push({ repository: index.repository, repositoryId: index.repositoryId,
    ...selected[receipt.sha], gitBlob: receipt.sha, sha256: hash(bytes), bytes: bytes.length,
    body: bytes.toString() });
}
const git = args => execFileSync("git", [`--git-dir=${gitDirectory}`, ...args], {
  env: { ...process.env, GIT_NO_LAZY_FETCH: "1", GIT_OPTIONAL_LOCKS: "0" },
  maxBuffer: 4 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"],
});
for (const name of [".github/workflows/shared/otel.md",
  ".github/workflows/shared/observability-otlp.md", "pkg/workflow/model_aliases.go"]) {
  const ref = index.sourceAddition.commit;
  const entry = git(["ls-tree", ref, "--", name]).toString().trim();
  if (!entry) throw new Error(`Required adoption context absent: ${name}`);
  const blob = entry.split(/\s+/)[2];
  let bytes;
  try {
    bytes = git(["cat-file", "blob", blob]);
  } catch (error) {
    if (!String(error.stderr).includes("bad file")) throw error;
    sources.unavailable.push({ revision: ref, path: name, gitBlob: blob,
      reason: "Exact adoption dependency blob unavailable offline; does not block current-source contract." });
    continue;
  }
  if (blobHash(bytes) !== blob) throw new Error("Adoption context blob mismatch");
  sources.records.push({ repository: index.repository, repositoryId: index.repositoryId,
    revision: ref, path: name, gitBlob: blob, sha256: hash(bytes), bytes: bytes.length, body: bytes.toString() });
}
const moduleFile = path.join(root, "../functions/daily-model-inventory.mjs");
writeJsonArchive(path.join(root, "predecessor-contract.json.gz"), {
  reason: "Source-only readiness correction before native outcome evidence: complete adoption workflow and frozen lock became available. No provider outcomes acquired.",
  moduleSha256: hash(readFileSync(moduleFile)), moduleBody: readFileSync(moduleFile, "utf8"),
  retained: index, sources,
});
sources.unavailable = sources.unavailable.filter(item => !selected[item.gitBlob]
  && item.path !== ".github/workflows/shared/otlp.md");
index.sourceAddition.adoptionSourceAvailable = true;
index.sourceAddition.adoptionImports = ["shared/otel.md", "shared/observability-otlp.md"];
index.sourceRecords = sources.records.map(({ body, ...identity }) => identity);
index.unavailable = sources.unavailable;
index.packetManifestSha256 = hash(manifestBytes);
index.openScopes[0].needed = "Baseline source tree is available; contemporaneous complete provider inventory remains absent. Current predicates are not backdated.";
writeJsonArchive(path.join(root, "source-packet.json.gz"), {
  manifestOriginal: manifestBytes.toString(), manifestSha256: hash(manifestBytes), originals,
});
writeJsonArchive(path.join(root, "sources.json.gz"), sources);
writeJsonArchive(path.join(root, "retained.json"), index);
console.log(JSON.stringify({ retainedSha256: hash(readFileSync(path.join(root, "retained.json"))),
  sourcesArchiveSha256: hash(readFileSync(path.join(root, "sources.json.gz"))),
  records: sources.records.length, packetManifestSha256: hash(manifestBytes) }));
