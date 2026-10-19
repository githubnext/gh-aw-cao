import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { censusDigest, readCensusJson } from "../../../../scripts/operational-value-census-io.mjs";
import { crossRepoCreationModule } from "../../../../scripts/native-cross-repo-creation-value.mjs";

const contract = readCensusJson(fileURLToPath(new URL("../cross-repo-creation/contract.json", import.meta.url)));
if (censusDigest(contract) !== "5dbbfc2da6bd3b9624c7101bd8d3d8e7709ff5e6d1986131dfd78d1b46a421ce"
  || createHash("sha256").update(readFileSync(new URL("../../../../scripts/native-cross-repo-creation-value.mjs", import.meta.url))).digest("hex") !== "b2ac8b606742f62e39e8a947c4844334348e359ea754a1dc57696eda3ea43fa9") {
  throw new Error("Frozen cross-repository contract/interpreter changed");
}
export const { definition, collectBatch, scoreMetric } = crossRepoCreationModule(contract, "a1e20f7e9efa02eaa493be4ad32137d23a03106bafc031ea209cb75af35b1e7a");
