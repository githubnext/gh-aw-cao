import { createHash } from "node:crypto";
import { copyFileSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { censusDigest, readCensusJson } from "./operational-value-census-io.mjs";
import { writeJsonArchive } from "../.github/skills/add-operational-value/scripts/json-archive.mjs";

export function archiveNativeValueVersion(directory, workflowId, interpreter, producer, packed = false) {
  if (!/^docs\/operational-value\/proof\/[a-z0-9-]+$/.test(directory) || !/^[a-z0-9-]+$/.test(workflowId)
    || ![interpreter, producer].every(file => /^scripts\/[a-z0-9-]+\.mjs$/.test(file))) {
    throw new Error("Unsafe native-value archive scope");
  }
  const modulePath = `docs/operational-value/proof/functions/${workflowId}.mjs`;
  const sha = file => createHash("sha256").update(readFileSync(file)).digest("hex");
  const [contract] = readCensusJson(`${directory}/contracts.json`), index = readCensusJson(`${directory}/index.json`);
  if (!index.complete || index.workflowId !== workflowId || index.contractSha256 !== censusDigest(contract)
    || index.factsSha256 !== censusDigest(readCensusJson(`${directory}/facts.json.gz`))
    || contract.interpreterSha256 !== sha(interpreter) || index.producer.sha256 !== sha(producer)) {
    throw new Error("Cannot archive mismatched native-value evidence or interpreter");
  }
  const archive = `${directory}/versions/${sha(modulePath)}`;
  const files = [[modulePath, "function.txt"], [interpreter, "interpreter.txt"], [producer, "producer.txt"]];
  const collect = (folder, prefix = "") => {
    for (const entry of readdirSync(folder, { withFileTypes: true })) {
      if (!prefix && ["versions", "preflight"].includes(entry.name)) continue;
      const file = path.join(folder, entry.name), destination = path.join(prefix, entry.name);
      if (entry.isDirectory()) collect(file, destination);
      else if (entry.isFile()) files.push([file, destination]);
      else throw new Error("Unsafe native-value archive entry");
    }
  };
  collect(directory);
  const reports = "docs/operational-value/proof/reports/github-gh-aw";
  for (const file of readdirSync(reports)) {
    if (file.startsWith(`${workflowId}-`)) files.push([`${reports}/${file}`, `reports/${file}`]);
  }
  let bytes = 0;
  for (const [source, destination] of files) {
    bytes += lstatSync(source).size;
    if (bytes > 128 * 1024 * 1024 || files.length > (packed ? 20000 : 1000)) throw new Error("Native-value archive budget exhausted");
    const target = `${archive}/${destination}`;
    if (existsSync(target) && !readFileSync(source).equals(readFileSync(target))) throw new Error("Cannot overwrite a frozen native-value archive");
  }
  if (packed) {
    const hash = bytes => createHash("sha256").update(bytes).digest("hex");
    const bundle = { schemaVersion: 1, kind: "native-value-version-archive",
      files: files.sort((a, b) => a[1].localeCompare(b[1])).map(([source, file]) => {
        const bytes = readFileSync(source);
        return { path: file, sha256: hash(bytes), content: bytes.toString("base64") };
      }) };
    const file = `${archive}/archive.json.gz`, limits = { maxDecodedBytes: 128 * 1024 * 1024, maxParts: 1024 };
    if (existsSync(file) && censusDigest(readCensusJson(file, limits)) !== censusDigest(bundle)) {
      throw new Error("Cannot overwrite a frozen packed native-value archive");
    }
    if (!existsSync(file)) {
      mkdirSync(archive, { recursive: true });
      writeJsonArchive(file, bundle, { ...limits, spacing: 0 });
    }
    return { archive, packed: true, files: files.length, bytes };
  }
  for (const [source, destination] of files) {
    const target = `${archive}/${destination}`;
    mkdirSync(path.dirname(target), { recursive: true });
    copyFileSync(source, target);
  }
  return { archive, files: files.length, bytes };
}

if (process.argv[1] === import.meta.filename) {
  const [directory, workflow, interpreter, producer, flag, ...extra] = process.argv.slice(2);
  if (!producer || extra.length || flag && flag !== "--packed") {
    throw new Error("usage: archive-native-value-version.mjs DIRECTORY WORKFLOW INTERPRETER PRODUCER [--packed]");
  }
  console.log(JSON.stringify(archiveNativeValueVersion(directory, workflow, interpreter, producer, flag === "--packed")));
}
