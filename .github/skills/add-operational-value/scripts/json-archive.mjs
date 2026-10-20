import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { gunzipSync } from "node:zlib";

const digest = bytes => createHash("sha256").update(bytes).digest("hex");
const kind = "partitioned-census-json";

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
