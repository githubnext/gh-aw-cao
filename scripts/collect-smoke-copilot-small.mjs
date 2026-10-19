import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { gzipSync } from "node:zlib";
import { readOutputHistory } from "../.github/skills/add-operational-value/scripts/collect-output-history.mjs";

export const revision = "c86377ec47b38f0b5af463277ee55d1d03d08da8";
export const cutoff = "2026-10-18T15:00:12Z";
export const sourcePath = ".github/workflows/smoke-copilot-small.md";
export const adoption = "9c0ce8fcde9f1851a0a072bc0c2dd4e63f43a4df";
export const parent = "adb344b16f741da11a367e06d099653147eadc43";
export const hash = bytes => createHash("sha256").update(bytes).digest("hex");
export const gitHash = (type, bytes) => createHash("sha1").update(`${type} ${bytes.length}\0`).update(bytes).digest("hex");

export function retain(root, bytes) {
  const sha256 = hash(bytes), parts = [];
  mkdirSync(path.join(root, "originals"), { recursive: true });
  for (let start = 0; start < bytes.length || start === 0; start += 192 * 1024) {
    const file = `originals/${sha256}-${parts.length}.gz`;
    const compressed = gzipSync(bytes.subarray(start, start + 192 * 1024), { level: 9, mtime: 0 });
    if (compressed.length > 256 * 1024) throw new Error("Original part exceeds handoff bound");
    writeFileSync(path.join(root, file), compressed);
    parts.push({ file, bytes: compressed.length, sha256: hash(compressed) });
  }
  return { bytes: bytes.length, sha256, parts };
}

export function discover(history) {
  const { index, entities } = readOutputHistory(history);
  if (index.repository !== "github/gh-aw" || index.repositoryId !== 1036865607
    || index.until !== cutoff || index.sourceRevision !== revision || !index.complete
    || index.partitions.length !== 346 || entities.length !== 58048) throw new Error("Frozen history scope mismatch");
  const direct = entities.filter(row => row.workflowReference?.workflowId === "smoke-copilot-small"
    || row.unverifiedWorkflowId === "smoke-copilot-small");
  const selected = new Set(direct.map(row => row.number));
  let changed = true;
  while (changed) {
    changed = false;
    for (const row of entities) {
      if (selected.has(row.number) || row.relatedCandidates.some(number => selected.has(number))) {
        for (const number of [row.number, ...row.relatedCandidates]) {
          if (!selected.has(number)) { selected.add(number); changed = true; }
        }
      }
    }
  }
  const byNumber = new Map(entities.map(row => [row.number, row]));
  return {
    history: index,
    direct,
    related: [...selected].filter(number => byNumber.has(number) && !direct.some(row => row.number === number))
      .sort((a, b) => a - b).map(number => byNumber.get(number)),
    absentReferences: [...selected].filter(number => !byNumber.has(number)).sort((a, b) => a - b),
    interpretation: "Complete bidirectional body-reference closure over all supplied identities; references and issues are not accepted outcomes.",
  };
}

export function captureSources(cache, output, extra = []) {
  const git = args => execFileSync("git", [`--git-dir=${cache}`, ...args], {
    env: { ...process.env, GIT_NO_LAZY_FETCH: "1", GIT_TERMINAL_PROMPT: "0" },
    maxBuffer: 32 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"],
  });
  if (git(["remote", "get-url", "origin"]).toString().trim() !== "https://github.com/github/gh-aw.git") {
    throw new Error("Wrong public Git identity");
  }
  const records = new Map(), missing = [];
  const object = (type, id) => {
    if (records.has(id)) return records.get(id).bytes;
    let bytes;
    try { bytes = git(["cat-file", type, id]); }
    catch (error) {
      if (error.status !== 128) throw error;
      missing.push({ type, id, endpoint: `repos/github/gh-aw/git/${type === "blob" ? "blobs" : `${type}s`}/${id}` });
      return null;
    }
    if (gitHash(type, bytes) !== id) throw new Error("Git object custody mismatch");
    records.set(id, { type, id, bytes, original: retain(output, bytes) });
    return bytes;
  };
  const resolve = (commit, file) => {
    const original = object("commit", commit);
    if (!original) return { status: "missing-commit" };
    let tree = original.toString().match(/^tree ([a-f0-9]{40})\n/)?.[1];
    if (!tree) throw new Error("Invalid commit tree");
    const parts = file.split("/");
    for (let depth = 0; depth < parts.length; depth++) {
      const bytes = object("tree", tree);
      if (!bytes) return { status: "missing-tree" };
      let offset = 0, entry;
      while (offset < bytes.length) {
        const space = bytes.indexOf(32, offset), nul = bytes.indexOf(0, space);
        if (space < 0 || nul < 0 || nul + 21 > bytes.length) throw new Error("Invalid Git tree");
        const name = bytes.subarray(space + 1, nul).toString();
        if (name === parts[depth]) entry = { mode: bytes.subarray(offset, space).toString(),
          id: bytes.subarray(nul + 1, nul + 21).toString("hex") };
        offset = nul + 21;
      }
      if (!entry) return { status: "absent" };
      if (depth === parts.length - 1) {
        if (entry.mode !== "100644") throw new Error("Unsupported source mode");
        return { status: object("blob", entry.id) ? "retained" : "missing-blob", id: entry.id };
      }
      if (entry.mode !== "40000") throw new Error("Unsupported source tree mode");
      tree = entry.id;
    }
    throw new Error("Empty source path");
  };
  const history = git(["log", revision, "--format=%H", "--", sourcePath]).toString().trim().split("\n");
  const commits = [...new Set([revision, adoption, parent, ...history, ...extra])];
  const files = [sourcePath, sourcePath.replace(".md", ".lock.yml"),
    ...["smoke-test-brevity", "reporting", "playwright-title-test", "session-artifact-check"]
      .map(name => `.github/workflows/shared/${name}.md`)];
  const profiles = commits.map(commit => ({ commit, paths: Object.fromEntries(files.map(file => [file, resolve(commit, file)])) }));
  return { revision, sourcePath, adoption, parent, history, profiles,
    objects: [...records.values()].map(({ bytes: _bytes, ...row }) => row), missing };
}

export function capturePacket(directory, output) {
  const manifestBytes = readFileSync(path.join(directory, "manifest.json"));
  const manifest = JSON.parse(manifestBytes);
  const receipts = [...(manifest.requests ?? []), ...(manifest.receipts ?? [])].filter(row =>
    row && !Array.isArray(row) && typeof row === "object");
  const verified = [];
  for (const [manifestIndex, receipt] of receipts.entries()) {
    const originals = {};
    const owned = receipt.workflow === "smoke-copilot-small";
    for (const [fileKey, sizeKey, hashKey] of [
      ["file", "bytes", "sha256"], ["response", "bodyBytes", "bodySha256"], ["blob", "blobBytes", "blobSha256"],
    ]) {
      if (!receipt[fileKey]) continue;
      const file = path.isAbsolute(receipt[fileKey]) ? receipt[fileKey] : path.join(directory, receipt[fileKey]);
      const bytes = readFileSync(file);
      if (bytes.length !== receipt[sizeKey] || hash(bytes) !== receipt[hashKey]) throw new Error("Packet original mismatch");
      if (owned) originals[fileKey] = { bytes, reference: retain(output, bytes) };
    }
    if (owned) verified.push({ receipt, originals, manifestIndex });
  }
  return { manifest: retain(output, manifestBytes), verified };
}

function main() {
  const args = process.argv.slice(2);
  const options = {};
  while (args.length) {
    const flag = args.shift();
    if (!["--history", "--git", "--output", "--packet", "--head"].includes(flag)) throw new Error(`Unknown option ${flag}`);
    const value = args.shift();
    if (!value) throw new Error(`Missing ${flag}`);
    if (["--packet", "--head"].includes(flag)) (options[flag] ??= []).push(value);
    else options[flag] = value;
  }
  const output = options["--output"];
  if (!output) throw new Error("--output required");
  mkdirSync(output, { recursive: true });
  const write = (file, value) => {
    const bytes = Buffer.from(`${JSON.stringify(value, null, 2)}\n`);
    writeFileSync(path.join(output, file), file.endsWith(".gz") ? gzipSync(bytes, { level: 9 }) : bytes);
  };
  if (options["--history"]) write("discovery.json.gz", discover(options["--history"]));
  if (options["--git"]) write("sources.json", captureSources(options["--git"], output, options["--head"]));
  if (options["--packet"]) {
    const packets = options["--packet"].map(directory => {
      const { manifest, verified } = capturePacket(directory, output);
      return { manifest, receipts: verified.map(({ receipt, originals, manifestIndex }) => ({
        ...receipt, manifestIndex, originals: Object.fromEntries(Object.entries(originals).map(([key, value]) => [key, value.reference])),
      })) };
    });
    write("packets.json", packets);
    const sourceFile = path.join(output, "sources.json");
    if (existsSync(sourceFile)) {
      const sources = JSON.parse(readFileSync(sourceFile));
      for (const packet of packets) for (const receipt of packet.receipts) {
        if (receipt.status !== 200 || !/^repos\/github\/gh-aw\/git\/blobs\/[a-f0-9]{40}$/.test(receipt.endpoint)) continue;
        const original = receipt.originals.blob;
        if (!original || sources.objects.some(row => row.id === receipt.sha)) continue;
        sources.objects.push({ type: "blob", id: receipt.sha, original });
      }
      const retained = new Set(sources.objects.map(row => row.id));
      sources.missing = sources.missing.filter(row => !retained.has(row.id));
      for (const profile of sources.profiles) for (const entry of Object.values(profile.paths)) {
        if (entry.status === "missing-blob" && retained.has(entry.id)) entry.status = "retained";
      }
      write("sources.json", sources);
    }
  }
  if (!existsSync(path.join(output, "acceptance.json"))) throw new Error("Freeze acceptance before acquisition");
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) main();
