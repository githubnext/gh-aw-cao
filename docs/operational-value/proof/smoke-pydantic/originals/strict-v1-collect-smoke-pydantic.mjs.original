import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readOutputHistory } from "../.github/skills/add-operational-value/scripts/collect-output-history.mjs";
import { writeJsonArchive } from "../.github/skills/add-operational-value/scripts/json-archive.mjs";

export const proofRoot = fileURLToPath(new URL("../docs/operational-value/proof/smoke-pydantic/", import.meta.url));
export const sha256 = bytes => createHash("sha256").update(bytes).digest("hex");
export const gitDigest = (type, bytes) => createHash("sha1")
  .update(`${type} ${bytes.length}\0`).update(bytes).digest("hex");
export const writeJson = (file, value) => {
  mkdirSync(path.dirname(file), { recursive: true });
  writeJsonArchive(file, value, { spacing: 0, maxDecodedBytes: 64 * 1024 * 1024, maxParts: 512 });
};

export function retainOriginal(bytes, name, root = proofRoot) {
  if (!Buffer.isBuffer(bytes) || !/^[A-Za-z0-9_.-]+$/.test(name)) {
    throw new Error("Invalid original bytes or custody name");
  }
  const reference = { path: `originals/${name}`, bytes: bytes.length, sha256: sha256(bytes) };
  mkdirSync(path.join(root, "originals"), { recursive: true });
  const persist = (relative, content) => {
    const file = path.join(root, relative);
    if (existsSync(file) && !readFileSync(file).equals(content)) {
      throw new Error("Refusing to replace a retained original");
    }
    writeFileSync(file, content);
  };
  if (bytes.length <= 240 * 1024) {
    persist(reference.path, bytes);
  } else {
    reference.parts = [];
    for (let start = 0, index = 0; start < bytes.length; start += 240 * 1024, index++) {
      const part = bytes.subarray(start, start + 240 * 1024);
      const file = `${reference.path}.part-${String(index).padStart(4, "0")}`;
      persist(file, part);
      reference.parts.push({ path: file, bytes: part.length, sha256: sha256(part) });
    }
    delete reference.path;
  }
  return reference;
}

export function ingestSourcePacket(directory, expectedSha) {
  const manifestBytes = readFileSync(path.join(directory, "manifest.json"));
  if (sha256(manifestBytes) !== expectedSha) throw new Error("Source packet manifest mismatch");
  const packet = JSON.parse(manifestBytes);
  const file = path.join(proofRoot, "source-originals.json");
  const index = existsSync(file) ? JSON.parse(readFileSync(file, "utf8"))
    : { schemaVersion: 1, packets: [], blobs: [] };
  const records = packet.receipts
    ? packet.receipts.filter(row => row.workflow === "smoke-pydantic").map(row => ({
      ...row, repository: packet.repository, gitBlob: row.sha, responseBytes: row.bodyBytes,
      responseSha256: row.bodySha256,
    })) : [{ ...packet }];
  const manifest = retainOriginal(manifestBytes, `${expectedSha}.manifest.json`);
  for (const row of records) {
    if (row.status !== 200 || !/^[a-f0-9]{40}$/.test(row.gitBlob)
      || ![row.response, row.blob].every(name => /^[A-Za-z0-9_.-]+$/.test(name))) {
      throw new Error("Unsafe or unsuccessful source packet");
    }
    const response = readFileSync(path.join(directory, row.response));
    const blob = readFileSync(path.join(directory, row.blob));
    if (response.length !== row.responseBytes || sha256(response) !== row.responseSha256
      || blob.length !== row.blobBytes || sha256(blob) !== row.blobSha256
      || gitDigest("blob", blob) !== row.gitBlob) throw new Error("Source original byte or Git identity mismatch");
    const native = JSON.parse(response);
    if (native.sha !== row.gitBlob || native.encoding !== "base64"
      || !Buffer.from(native.content, "base64").equals(blob)) throw new Error("Source response does not contain its blob");
    if (!index.blobs.some(entry => entry.gitBlob === row.gitBlob)) index.blobs.push({
      repository: row.repository, revision: row.revision ?? null, path: row.path ?? null,
      gitBlob: row.gitBlob, manifestSha256: expectedSha, endpoint: row.endpoint,
      response: retainOriginal(response, `${row.gitBlob}.response.json`),
      blob: retainOriginal(blob, `${row.gitBlob}.blob`),
    });
  }
  if (!index.packets.some(row => row.sha256 === expectedSha)) index.packets.push(manifest);
  writeJson(file, index);
  return index;
}

export function ingestRequestPacket(directory, expectedSha) {
  const manifestBytes = readFileSync(path.join(directory, "manifest.json"));
  if (sha256(manifestBytes) !== expectedSha) throw new Error("Request packet manifest mismatch");
  const packet = JSON.parse(manifestBytes);
  if (packet.repository !== "github/gh-aw" || packet.repositoryId !== 1036865607
    || !Array.isArray(packet.requests)) throw new Error("Wrong request packet authority");
  const file = path.join(proofRoot, "request-originals.json");
  const index = existsSync(file) ? JSON.parse(readFileSync(file, "utf8"))
    : { schemaVersion: 1, packets: [], requests: [] };
  const manifest = retainOriginal(manifestBytes, `${expectedSha}.manifest.json`);
  for (const row of packet.requests.filter(row => row.workflow === "smoke-pydantic")) {
    if (row.status !== 200 || !/^[A-Za-z0-9_.-]+$/.test(row.file)
      || !Number.isSafeInteger(row.bytes) || !/^[a-f0-9]{64}$/.test(row.sha256)) {
      throw new Error("Unsafe or unsuccessful original request");
    }
    const bytes = readFileSync(path.join(directory, row.file));
    if (bytes.length !== row.bytes || sha256(bytes) !== row.sha256) throw new Error("Original request custody mismatch");
    if (!index.requests.some(entry => entry.endpoint === row.endpoint && entry.original.sha256 === row.sha256)) {
      index.requests.push({ endpoint: row.endpoint, manifestSha256: expectedSha,
        receivedAt: row.receivedAt, original: retainOriginal(bytes, row.file) });
    }
  }
  if (!index.packets.some(row => row.sha256 === expectedSha)) index.packets.push(manifest);
  writeJson(file, index);
  return index;
}

export function discover(historyDirectory) {
  const { index, entities } = readOutputHistory(historyDirectory);
  if (index.repository !== "github/gh-aw" || index.repositoryId !== 1036865607
    || index.sourceRevision !== "c86377ec47b38f0b5af463277ee55d1d03d08da8"
    || index.until !== "2026-10-18T15:00:12Z" || index.complete !== true
    || !Object.values(index.connections).every(connection => connection.complete)) {
    throw new Error("Wrong or incomplete frozen discovery inventory");
  }
  const seeds = entities.filter(row => row.workflowReference?.workflowId === "smoke-pydantic"
    || row.unverifiedWorkflowId === "smoke-pydantic");
  const byNumber = new Map(entities.map(row => [row.number, row]));
  const selected = new Set(seeds.map(row => row.number));
  let changed = true;
  while (changed) {
    changed = false;
    for (const row of entities) {
      if (!Array.isArray(row.relatedCandidates)) throw new Error("Missing discovery references");
      if (selected.has(row.number) || row.relatedCandidates.some(number => selected.has(number))) {
        for (const number of [row.number, ...row.relatedCandidates]) {
          if (!selected.has(number)) { selected.add(number); changed = true; }
        }
      }
    }
  }
  return {
    schemaVersion: 1, repository: index.repository, repositoryId: index.repositoryId,
    until: index.until, sourceRevision: index.sourceRevision,
    inventory: { complete: index.complete, partitions: index.partitions.length,
      entities: entities.length, observedAt: index.completedAt,
      sha256: sha256(readFileSync(path.join(historyDirectory, "history.json.gz"))) },
    seedNumbers: seeds.map(row => row.number).sort((a, b) => a - b),
    closure: [...selected].sort((a, b) => a - b).map(number =>
      byNumber.get(number) ?? { number, status: "absent-reference", acceptedOutcome: null }),
    limitations: index.limitations,
    interpretation: "Complete forward/reverse body-reference discovery closure over surviving issues/PRs, not native outcome or creation proof.",
  };
}

export function captureGit(cache, revision, files) {
  const objects = new Map();
  const git = args => execFileSync("git", [`--git-dir=${cache}`, ...args], {
    env: { ...process.env, GIT_NO_LAZY_FETCH: "1", GIT_TERMINAL_PROMPT: "0" },
    maxBuffer: 16 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"],
  });
  const retain = (type, id) => {
    const bytes = git(["cat-file", type, id]);
    if (gitDigest(type, bytes) !== id) throw new Error("Git object custody mismatch");
    objects.set(id, { type, id, bytes: bytes.length, content: bytes.toString("base64") });
    return bytes;
  };
  const commit = retain("commit", revision);
  const tree = commit.toString("utf8").match(/^tree ([a-f0-9]{40})$/m)?.[1];
  if (!tree) throw new Error("Missing commit tree");
  const captured = files.map(file => {
    let current = tree;
    const chain = [];
    for (const component of file.split("/")) {
      retain("tree", current);
      chain.push(current);
      const rows = git(["ls-tree", current]).toString("utf8").trim().split("\n");
      const match = rows.map(row => row.match(/^(\d+) (blob|tree) ([a-f0-9]{40})\t(.+)$/))
        .find(row => row?.[4] === component);
      if (!match) return { path: file, status: "absent", chain };
      if (match[2] === "tree") current = match[3];
      else {
        const entry = { path: file, status: "present", id: match[3], mode: match[1], chain };
        try { retain("blob", entry.id); entry.contentStatus = "available"; }
        catch (error) {
          if (error.status !== 128) throw error;
          entry.contentStatus = "missing-local-object";
        }
        return entry;
      }
    }
    throw new Error("Expected file, not directory");
  });
  return { revision, files: captured, objects: [...objects.values()] };
}

export function retainGitClosure(record) {
  const refs = record.objects.map(object => {
    const file = `git/${object.id}.json`;
    writeJson(path.join(proofRoot, file), object);
    return { file, sha256: sha256(readFileSync(path.join(proofRoot, file))) };
  });
  writeJson(path.join(proofRoot, `git/${record.revision}-closure.json`), { ...record, objects: refs });
}

export function collectLocal({ cache, history }) {
  const destination = path.join(proofRoot, "discovery");
  const discovery = discover(history);
  mkdirSync(destination, { recursive: true });
  const { index } = readOutputHistory(history);
  for (const file of ["history.json.gz", ...index.partitions.map(part => part.file)]) {
    const source = path.join(history, file);
    if (readFileSync(source).length > 256 * 1024) throw new Error("Discovery partition exceeds owned size budget");
    copyFileSync(source, path.join(destination, file));
  }
  writeJson(path.join(proofRoot, "discovery.json"), discovery);
  const files = [".github/workflows/smoke-pydantic.md", ".github/workflows/smoke-pydantic.lock.yml"];
  for (const revision of [
    "c86377ec47b38f0b5af463277ee55d1d03d08da8",
    "0e301e6777bef1d23305c8031dcd161a642836f5",
    "cc3330af665107c4e4e1b8dbff618ae23b792314",
  ]) {
    const record = captureGit(cache, revision, revision.startsWith("c863") ? [
      ...files, ".github/workflows/shared/smoke-test-brevity.md", ".github/workflows/shared/reporting.md",
    ] : files);
    retainGitClosure(record);
  }
  return discovery;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv[2] === "--requests") {
    const result = ingestRequestPacket(process.argv[3], process.argv[4]);
    console.log(JSON.stringify({ originalRequests: result.requests.length }));
    process.exit(0);
  }
  if (process.argv[2] === "--source") {
    const result = ingestSourcePacket(process.argv[3], process.argv[4]);
    console.log(JSON.stringify({ sourceBlobs: result.blobs.length }));
    process.exit(0);
  }
  const [cache, history] = process.argv.slice(2);
  if (!cache || !history) throw new Error("usage: node scripts/collect-smoke-pydantic.mjs READ_ONLY_GIT_CACHE HISTORY_DIRECTORY");
  const result = collectLocal({ cache, history });
  console.log(JSON.stringify({ seeds: result.seedNumbers.length, closure: result.closure.length,
    absent: result.closure.filter(row => row.status === "absent-reference").length }));
}
