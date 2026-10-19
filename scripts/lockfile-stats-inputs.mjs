import { createHash } from "node:crypto";
import { existsSync, mkdirSync } from "node:fs";
import { censusDigest, readCensusJson, writeCensusJson } from "./operational-value-census-io.mjs";

export function writeLockfileInputs(directory, commit, files) {
  if (!/^[a-f0-9]{40}$/.test(commit) || !Array.isArray(files) || files.length > 1000) throw new Error("Invalid native input archive");
  mkdirSync(`${directory}/blobs`, { recursive: true });
  return files.map(row => {
    const bytes = Buffer.from(row.content, "base64");
    if (createHash("sha1").update(`blob ${bytes.length}\0`).update(bytes).digest("hex") !== row.gitBlob) {
      throw new Error("Native input Git identity mismatch");
    }
    const file = `${directory}/blobs/${row.gitBlob}.json.gz`;
    const value = { gitBlob: row.gitBlob, content: row.content };
    if (existsSync(file)) {
      if (censusDigest(readCensusJson(file)) !== censusDigest(value)) throw new Error("Conflicting immutable input blob");
    } else writeCensusJson(file, value);
    return { path: row.path, gitBlob: row.gitBlob, sha256: censusDigest(value) };
  });
}

export function readLockfileInputs(directory, native) {
  if (!native.inputBlobs) {
    return native.inputParts.flatMap(part => {
      if (!new RegExp(`^${native.commit}-inputs-\\d{3}\\.json\\.gz$`).test(part.file)) throw new Error("Unsafe input partition");
      const files = readCensusJson(`${directory}/${part.file}`);
      if (files.length !== part.count || censusDigest(files) !== part.sha256) throw new Error("Native input partition changed");
      return files;
    });
  }
  if (!Array.isArray(native.inputBlobs) || native.inputBlobs.length > 1000) throw new Error("Invalid native input manifest");
  return native.inputBlobs.map(ref => {
    if (!/^[a-f0-9]{40}$/.test(ref.gitBlob)) throw new Error("Unsafe native input blob");
    const row = readCensusJson(`${directory}/blobs/${ref.gitBlob}.json.gz`);
    if (row.gitBlob !== ref.gitBlob || censusDigest(row) !== ref.sha256) throw new Error("Native input blob changed");
    return { path: ref.path, gitBlob: ref.gitBlob, content: row.content };
  });
}
