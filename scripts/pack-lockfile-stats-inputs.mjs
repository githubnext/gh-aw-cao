import { readdirSync, readFileSync, unlinkSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import { censusDigest, readCensusJson, writeCensusJson } from "./operational-value-census-io.mjs";
import { readLockfileInputs, writeLockfileInputs } from "./lockfile-stats-inputs.mjs";

const directory = "docs/operational-value/proof/lockfile-stats";
const inputs = `${directory}/inputs`;
for (const name of readdirSync(inputs).filter(name => /^[a-f0-9]{40}\.json\.gz$/.test(name))) {
  const native = readCensusJson(`${inputs}/${name}`);
  if (native.inputBlobs) continue;
  const original = readLockfileInputs(inputs, native);
  const inputBlobs = writeLockfileInputs(inputs, native.commit, original);
  const updated = { ...native, inputBlobs };
  delete updated.inputParts;
  if (censusDigest(readLockfileInputs(inputs, updated)) !== censusDigest(original)) throw new Error("Storage conversion changed original bytes");
  writeCensusJson(`${inputs}/${name}`, updated);
  for (const observation of readdirSync(`${directory}/observations`).filter(name => /^\d+\.json\.gz$/.test(name))) {
    const row = readCensusJson(`${directory}/observations/${observation}`);
    if (row.headSha !== native.commit) continue;
    row.nativeInputSha256 = censusDigest(updated);
    writeCensusJson(`${directory}/observations/${observation}`, row);
  }
  for (const part of native.inputParts) {
    if (!new RegExp(`^${native.commit}-inputs-\\d{3}\\.json\\.gz$`).test(part.file)) throw new Error("Unsafe obsolete part");
    const raw = JSON.parse(gunzipSync(readFileSync(`${inputs}/${part.file}`)));
    if (raw.kind === "partitioned-census-json") {
      for (const child of raw.parts) {
        if (!new RegExp(`^${native.commit}-inputs-\\d{3}-part-\\d{3}\\.json\\.gz$`).test(child.file)) throw new Error("Unsafe obsolete nested part");
        unlinkSync(`${inputs}/${child.file}`);
      }
    }
    unlinkSync(`${inputs}/${part.file}`);
  }
}
console.log("Verified lossless content-addressed native input conversion.");
