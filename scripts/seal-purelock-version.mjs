import { copyFileSync, existsSync, mkdirSync, readdirSync } from "node:fs";
import { censusDigest, readCensusJson } from "./operational-value-census-io.mjs";
import { purelockFileSha256 as digest } from "./partition-purelock-archives.mjs";
import { writeJsonArchive } from "../.github/skills/add-operational-value/scripts/json-archive.mjs";

const base = "docs/operational-value/proof/purelock";
const functionFile = "docs/operational-value/proof/functions/purelock.mjs";
const version = digest(functionFile), destination = `${base}/versions/${version}`;
const prepared = process.argv.includes("--prepared");
const [contract] = readCensusJson(`${base}/contracts.json`), index = readCensusJson(`${base}/index.json`);
if (!prepared && (index.contractSha256 !== censusDigest(contract)
  || index.factsSha256 !== censusDigest(readCensusJson(`${base}/facts.json.gz`)))
  || contract.producerSha256 !== digest("scripts/collect-purelock-history.mjs")
  || contract.ciInterpreterSha256 !== digest("scripts/purelock-ci-coverage.mjs")
  || contract.interpreterSha256 !== digest("scripts/native-purelock-value.mjs")) throw new Error("Cannot seal mismatched PureLock predecessor");
const files = [[functionFile, "function.txt"], ["scripts/native-purelock-value.mjs", "interpreter.txt"],
  ["scripts/collect-purelock-history.mjs", "producer.txt"], ["scripts/purelock-ci-coverage.mjs", "ci-interpreter.txt"]];
for (const entry of readdirSync(base, { withFileTypes: true })) {
  if (entry.isFile() && (!prepared || entry.name === "contracts.json")) files.push([`${base}/${entry.name}`, entry.name]);
}
const reports = "docs/operational-value/proof/reports/github-gh-aw";
if (!prepared) {
  for (const name of readdirSync(reports).filter(name => name.startsWith("purelock-"))) files.push([`${reports}/${name}`, `reports/${name}`]);
}
const manifest = [];
for (const [source, target] of files) {
  const file = `${destination}/${target}`;
  if (existsSync(file) && digest(file) !== digest(source)) throw new Error("Cannot overwrite frozen PureLock predecessor");
  mkdirSync(file.slice(0, file.lastIndexOf("/")), { recursive: true });
  copyFileSync(source, file);
  manifest.push({ path: target, sha256: digest(source) });
}
writeJsonArchive(`${destination}/closure.json`, { version, prepared, files: manifest,
  sharedImmutableSources: { directory: "../../sources", sources: index.sources } });
console.log(JSON.stringify({ version, files: files.length, sharedSources: index.sources.length }));
