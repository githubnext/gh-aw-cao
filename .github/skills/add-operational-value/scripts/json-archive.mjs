import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { gunzipSync, gzipSync } from "node:zlib";

const digest = bytes => createHash("sha256").update(bytes).digest("hex");
const kind = "partitioned-census-json";
const fileLimit = 256 * 1024;

export function readJsonArchive(file, { maxDecodedBytes = 16 * 1024 * 1024, maxParts = 128 } = {}) {
  const read = filename => {
    const input = readFileSync(filename);
    const bytes = filename.endsWith(".gz") ? gunzipSync(input, { maxOutputLength: maxDecodedBytes }) : input;
    if (bytes.length > maxDecodedBytes) throw new Error("JSON archive exceeds decoded size limit");
    return JSON.parse(bytes.toString("utf8"));
  };
  const value = read(file);
  if (value?.kind !== kind) return value;
  if (value.schemaVersion !== 1 || value.encoding !== "base64-json-utf8"
    || !Array.isArray(value.parts) || !value.parts.length || value.parts.length > maxParts) {
    throw new Error("Invalid partitioned census archive");
  }
  let length = 0;
  const chunks = value.parts.map(part => {
    if (typeof part.file !== "string" || !/^[\w.-]+-part-\d{3}\.json\.gz$/.test(part.file)
      || part.file !== path.basename(part.file)) throw new Error("Unsafe census archive partition");
    const encoded = read(path.join(path.dirname(file), part.file));
    if (typeof encoded !== "string") throw new Error("Invalid census archive partition");
    const bytes = Buffer.from(encoded, "base64");
    length += bytes.length;
    if (length > maxDecodedBytes || bytes.toString("base64") !== encoded || digest(bytes) !== part.sha256) {
      throw new Error("Census archive partition digest or size mismatch");
    }
    return bytes;
  });
  const bytes = Buffer.concat(chunks);
  if (digest(bytes) !== value.sha256) throw new Error("Census archive digest mismatch");
  return JSON.parse(bytes.toString("utf8"));
}

export function writeJsonArchive(file, value, { spacing = 2, gzipLevel, partitionPlain = true,
  maxDecodedBytes = 16 * 1024 * 1024, maxParts = 128 } = {}) {
  const bytes = Buffer.from(`${JSON.stringify(value, null, spacing)}\n`);
  if ((partitionPlain || file.endsWith(".gz")) && bytes.length > maxDecodedBytes) {
    throw new Error("Census archive exceeds decoded size limit");
  }
  const compress = input => gzipSync(input, gzipLevel === undefined ? undefined : { level: gzipLevel });
  const compressed = file.endsWith(".gz") ? compress(bytes) : null;
  if ((compressed?.length ?? bytes.length) <= fileLimit || !compressed && !partitionPlain) {
    writeFileSync(file, compressed ?? bytes);
    return [file];
  }
  if (bytes.length > maxDecodedBytes || Math.ceil(bytes.length / (192 * 1024)) > maxParts) {
    throw new Error("Census archive exceeds decoded size limit");
  }
  const parts = [], files = [], prefix = path.basename(file).replace(/\.json(?:\.gz)?$/, "");
  for (let offset = 0; offset < bytes.length; offset += 192 * 1024) {
    const chunk = bytes.subarray(offset, offset + 192 * 1024);
    const name = `${prefix}-part-${String(parts.length + 1).padStart(3, "0")}.json.gz`;
    const target = path.join(path.dirname(file), name);
    writeFileSync(target, compress(JSON.stringify(chunk.toString("base64"))));
    files.push(target);
    parts.push({ file: name, sha256: digest(chunk) });
  }
  const manifest = JSON.stringify({ schemaVersion: 1, kind, encoding: "base64-json-utf8", sha256: digest(bytes), parts });
  writeFileSync(file, compressed ? compress(manifest) : manifest);
  return [...files, file];
}
